import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { LogEntry } from '../types.js';
import { toSingleLine } from './text.js';

export interface LoggerOptions {
  /** In-memory ring buffer size exposed to the console UI. */
  limit?: number;
  mirrorToConsole?: boolean;
  /**
   * When set, every entry is also appended to `<fileDir>/tunneldesk-YYYY-MM-DD.log`.
   * Omit it (as unit tests do) to keep the logger purely in memory.
   */
  fileDir?: string;
  /** Daily files kept on disk, oldest removed first. */
  fileRetentionDays?: number;
}

const LEVEL_LABEL: Record<LogEntry['level'], string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

/**
 * Hard ceiling for a single message. Remote command output (PowerShell CLIXML,
 * `az` failures) can be tens of thousands of characters; every entry is also
 * copied into SSE snapshot frames, so unbounded text would flood the UI.
 */
const MAX_MESSAGE_LENGTH = 600;
const MAX_SCOPE_LENGTH = 24;

/**
 * Leveled logger with an in-memory ring buffer for the console UI and an
 * optional daily-rotated file sink for post-mortem debugging.
 * Secrets must still be avoided; the redaction below is only a safety net.
 */
export class Logger extends EventEmitter {
  private readonly entries: LogEntry[] = [];
  private readonly limit: number;
  private readonly mirror: boolean;
  private readonly fileDir: string | null;
  private readonly retentionDays: number;
  private counter = 0;
  private stream: fs.WriteStream | null = null;
  private streamDate: string | null = null;

  constructor(options: LoggerOptions = {}) {
    super();
    this.limit = options.limit ?? 400;
    this.mirror = options.mirrorToConsole ?? true;
    this.fileDir = options.fileDir ?? null;
    this.retentionDays = Math.max(1, options.fileRetentionDays ?? 7);
  }

  info(scope: string, message: string): void {
    this.push('info', scope, message);
  }

  warn(scope: string, message: string): void {
    this.push('warn', scope, message);
  }

  error(scope: string, message: string): void {
    this.push('error', scope, message);
  }

  list(): LogEntry[] {
    return [...this.entries];
  }

  /** Directory receiving the daily log files, or null when file logging is off. */
  directory(): string | null {
    return this.fileDir;
  }

  /** Flushes and closes the file sink; safe to call more than once. */
  close(): void {
    const stream = this.stream;
    this.stream = null;
    this.streamDate = null;
    if (!stream) return;
    try {
      stream.end();
    } catch {
      stream.destroy();
    }
  }

  private push(level: LogEntry['level'], scope: string, message: string): void {
    const now = new Date();
    const entry: LogEntry = {
      id: ++this.counter,
      at: now.toISOString(),
      level,
      scope: normalizeScope(scope),
      message: formatMessage(message),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    this.writeFile(now, entry);
    if (this.mirror) this.writeConsole(now, entry);
    this.emit('entry', entry);
  }

  private writeConsole(now: Date, entry: LogEntry): void {
    const color = process.stdout.isTTY && !process.env.NO_COLOR;
    const level = LEVEL_LABEL[entry.level];
    const line = `${stamp(now)} ${level.padEnd(5)} ${entry.scope.padEnd(10)} ${entry.message}`;
    const painted = color
      ? `${DIM}${stamp(now)}${RESET} ${LEVEL_COLOR[entry.level]}${level.padEnd(5)}${RESET} ${entry.scope.padEnd(10)} ${entry.message}`
      : line;
    if (entry.level === 'error') console.error(painted);
    else if (entry.level === 'warn') console.warn(painted);
    else console.log(painted);
  }

  private writeFile(now: Date, entry: LogEntry): void {
    if (!this.fileDir) return;
    try {
      const date = dateKey(now);
      if (!this.stream || this.streamDate !== date) this.rotate(date);
      this.stream?.write(`${stamp(now)} ${LEVEL_LABEL[entry.level].padEnd(5)} ${entry.scope.padEnd(10)} ${entry.message}\n`);
    } catch {
      // Logging must never break the application.
      this.stream = null;
      this.streamDate = null;
    }
  }

  private rotate(date: string): void {
    const previous = this.stream;
    this.stream = null;
    this.streamDate = null;
    try {
      previous?.end();
    } catch {
      previous?.destroy();
    }
    fs.mkdirSync(this.fileDir as string, { recursive: true });
    const stream = fs.createWriteStream(path.join(this.fileDir as string, `tunneldesk-${date}.log`), {
      flags: 'a',
    });
    stream.on('error', () => {
      if (this.stream === stream) {
        this.stream = null;
        this.streamDate = null;
      }
      stream.destroy();
    });
    this.stream = stream;
    this.streamDate = date;
    this.prune(date);
  }

  /** Removes daily files older than the retention window; called once per rotation. */
  private prune(today: string): void {
    try {
      const dir = this.fileDir as string;
      const files = fs
        .readdirSync(dir)
        .filter((name) => /^tunneldesk-\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort();
      const keepFrom = Math.max(0, files.length - this.retentionDays);
      for (const name of files.slice(0, keepFrom)) {
        if (name.includes(today)) continue;
        fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      // Retention is best-effort.
    }
  }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD HH:mm:ss.SSS` in the machine's local time. */
function stamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(
    at.getMinutes(),
  )}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

function dateKey(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function normalizeScope(scope: string): string {
  const text = toSingleLine(String(scope ?? '')).replace(/\s+/g, ' ').trim();
  return (text || 'app').slice(0, MAX_SCOPE_LENGTH);
}

/**
 * Turns an arbitrary message into exactly one bounded line. Redaction happens
 * before truncation so a cut can never leave a partial secret behind.
 */
function formatMessage(message: string): string {
  const text = redact(toSingleLine(String(message ?? ''))) || '(空消息)';
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const suffix = `…（已截断，原 ${text.length} 字符）`;
  return `${text.slice(0, Math.max(0, MAX_MESSAGE_LENGTH - suffix.length))}${suffix}`;
}

function redact(message: string): string {
  return message
    .replace(/"?(password|passwd|pwd|secret|token|api[-_]?key)"?\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[redacted]')
    .replace(/((?:--|-)(?:password|passwd|pwd|secret|token|api[-_]?key)\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-key]');
}
