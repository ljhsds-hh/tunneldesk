import { EventEmitter } from 'node:events';
import type { LogEntry } from '../types.js';

export interface LoggerOptions {
  limit?: number;
  mirrorToConsole?: boolean;
}

/**
 * Small leveled logger with an in-memory ring buffer for the console UI.
 * Secrets must never be passed to this logger.
 */
export class Logger extends EventEmitter {
  private readonly entries: LogEntry[] = [];
  private readonly limit: number;
  private readonly mirror: boolean;
  private counter = 0;

  constructor(options: LoggerOptions = {}) {
    super();
    this.limit = options.limit ?? 400;
    this.mirror = options.mirrorToConsole ?? true;
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

  private push(level: LogEntry['level'], scope: string, message: string): void {
    const entry: LogEntry = {
      id: ++this.counter,
      at: new Date().toISOString(),
      level,
      scope,
      message: redact(message),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    if (this.mirror) {
      const line = `[${entry.at}] ${level.toUpperCase()} ${scope}: ${entry.message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    this.emit('entry', entry);
  }
}

function redact(message: string): string {
  return message
    .replace(/(password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-key]');
}
