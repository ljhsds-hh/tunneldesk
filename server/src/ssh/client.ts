import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  privateKeyPem?: string;
  password?: string;
  readyTimeoutMs?: number;
}

export interface ConnectResult {
  client: Client;
  hostKeyFingerprint: string | null;
}

/** Connects once and resolves when the transport is ready to open channels. */
export function connectClient(options: ConnectOptions): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint: string | null = null;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ client, hostKeyFingerprint: fingerprint });
    };

    const config: ConnectConfig = {
      host: options.host,
      port: options.port,
      username: options.username,
      readyTimeout: options.readyTimeoutMs ?? 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        return true;
      },
    };

    if (options.privateKeyPem) config.privateKey = options.privateKeyPem;
    else if (options.privateKeyPath) config.privateKey = fs.readFileSync(options.privateKeyPath);
    if (options.password) config.password = options.password;

    client.once('ready', () => finish());
    client.once('error', (error: Error) => finish(error));
    try {
      client.connect(config);
    } catch (error) {
      finish(error as Error);
    }
  });
}

/** Runs a command and collects stdout/stderr with a hard timeout. */
export function execOnClient(client: Client, command: string, timeoutMs = 15000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`命令执行超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const settle = (error: Error | null, result?: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result as ExecResult);
    };

    client.exec(command, (error, stream: ClientChannel) => {
      if (error) {
        settle(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.once('close', (code: number | null) => {
        settle(null, { code: code ?? 0, stdout, stderr });
      });
      stream.once('error', (streamError: Error) => settle(streamError));
    });
  });
}

/**
 * Encodes a PowerShell script as -EncodedCommand, eliminating all quoting and
 * escaping problems when the command travels over SSH.
 */
export function powershell(script: string): string {
  // Progress records are serialized as CLIXML stderr when output is redirected.
  // They are not errors and would otherwise pollute the UI.
  const wrapped = `$ProgressPreference = 'SilentlyContinue'; ${script}`;
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Drops PowerShell CLIXML/progress noise, keeping real error text. */
export function cleanPowerShellError(text: string): string {
  if (!text) return '';
  const decoded = text
    .replace(/#< CLIXML\r?\n?/g, '')
    .replace(/_x000D_/g, '\r')
    .replace(/_x000A_/g, '\n')
    .replace(/_x0009_/g, '\t');
  const xmlErrors = [...decoded.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => decodeXmlText(match[1] ?? ''))
    .join('\n');
  const plain = decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('<') && !line.startsWith('#< CLIXML'))
    .join('\n');
  return [plain, xmlErrors].filter(Boolean).join('\n').trim();
}

export function isPrivilegeError(result: ExecResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    text.includes('access is denied') ||
    text.includes('拒绝访问') ||
    text.includes('requires elevation') ||
    text.includes(' administrator ')
  );
}
