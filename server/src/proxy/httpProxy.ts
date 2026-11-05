import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import type { ProxyLogEntry, ProxyRuntime, ProxySettings } from '../types.js';
import { Logger } from '../util/logger.js';
import { SshLink } from '../ssh/link.js';

const MAX_HEADER_BYTES = 64 * 1024;
const HEADER_TIMEOUT_MS = 20000;

type Channel = Awaited<ReturnType<SshLink['openStream']>>;

function emptyRuntime(): ProxyRuntime {
  return {
    running: false,
    error: null,
    activeConnections: 0,
    totalRequests: 0,
    bytesIn: 0,
    bytesOut: 0,
    rateIn: 0,
    rateOut: 0,
  };
}

export function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) throw new Error(`无法解析目标地址：${value}`);
    const host = trimmed.slice(1, end);
    const portPart = trimmed.slice(end + 1).replace(/^:/, '');
    return { host, port: portPart ? Number(portPart) : fallbackPort };
  }
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > -1 && trimmed.indexOf(':') === lastColon) {
    const host = trimmed.slice(0, lastColon);
    const portPart = trimmed.slice(lastColon + 1);
    if (portPart && /^\d+$/.test(portPart)) return { host, port: Number(portPart) };
  }
  return { host: trimmed, port: fallbackPort };
}

/**
 * HTTP proxy for the "intranet access" business.
 * Supports absolute-form requests and CONNECT. Target hostnames are resolved on
 * the B side by the SSH server, so intranet-only DNS names work.
 */
export class HttpProxyServer extends EventEmitter {
  runtime: ProxyRuntime = emptyRuntime();
  logs: ProxyLogEntry[] = [];
  private server: net.Server | null = null;
  private settings: ProxySettings;
  private logSeq = 0;
  private sockets = new Set<net.Socket>();

  constructor(
    private readonly link: SshLink,
    private readonly logger: Logger,
    settings: ProxySettings,
  ) {
    super();
    this.settings = settings;
  }

  getSettings(): ProxySettings {
    return this.settings;
  }

  async apply(settings: ProxySettings): Promise<void> {
    const previous = this.settings;
    this.settings = settings;
    const needsRestart =
      this.server !== null &&
      (previous.port !== settings.port ||
        previous.bindAddress !== settings.bindAddress ||
        previous.allowLan !== settings.allowLan);
    if (!settings.enabled) {
      await this.stop();
      return;
    }
    if (this.server && !needsRestart) return;
    if (this.server && needsRestart) await this.stop();
    await this.start();
  }

  async start(): Promise<void> {
    if (this.server) return;
    const { bindAddress, port } = this.settings;
    this.runtime = { ...this.runtime, error: null };
    const server = net.createServer((socket) => this.handle(socket));
    server.on('error', (error) => {
      this.runtime.running = false;
      this.runtime.error =
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `代理端口 ${port} 已被占用`
          : error.message;
      this.logger.error('proxy', `HTTP 代理启动失败：${this.runtime.error}`);
      this.emit('change');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: bindAddress, port, exclusive: true });
      });
      this.server = server;
      this.runtime.running = true;
      this.runtime.error = null;
      this.logger.info('proxy', `HTTP 代理已启动 ${bindAddress}:${port}`);
      this.emit('change');
    } catch (error) {
      this.runtime.error = (error as Error).message;
      server.close();
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.runtime.running = false;
    this.runtime.activeConnections = 0;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 1000).unref();
      });
      this.logger.info('proxy', 'HTTP 代理已停止');
    }
    this.emit('change');
  }

  private handle(client: net.Socket): void {
    client.setNoDelay(true);
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());

    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      this.reject(client, 408, '请求头读取超时');
    }, HEADER_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HEADER_BYTES) {
        clearTimeout(timer);
        client.removeListener('data', onData);
        this.reject(client, 431, '请求头过大');
        return;
      }
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      clearTimeout(timer);
      client.removeListener('data', onData);
      const header = buffer.subarray(0, headerEnd).toString('latin1');
      const rest = buffer.subarray(headerEnd + 4);
      void this.dispatch(client, header, rest);
    };

    client.on('data', onData);
  }

  private async dispatch(client: net.Socket, header: string, rest: Buffer): Promise<void> {
    const [requestLine = ''] = header.split('\r\n');
    const [method = '', target = '', version = 'HTTP/1.1'] = requestLine.split(' ');
    if (!method || !target) {
      this.reject(client, 400, '无法解析请求行');
      return;
    }

    if (method.toUpperCase() === 'CONNECT') {
      let parsed: { host: string; port: number };
      try {
        parsed = splitHostPort(target, 443);
      } catch (error) {
        this.reject(client, 400, (error as Error).message);
        return;
      }
      const started = Date.now();
      try {
        const channel = await this.link.openStream(parsed.host, parsed.port, 20000);
        if (client.destroyed) {
          channel.destroy();
          return;
        }
        this.runtime.totalRequests += 1;
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: TunnelDesk\r\n\r\n');
        this.bridge(client, channel, { method, target, started, settledBytes: 0 });
      } catch (error) {
        this.record({
          method,
          target,
          status: 502,
          bytes: 0,
          durationMs: Date.now() - started,
          outcome: 'error',
          error: (error as Error).message,
        });
        this.reject(client, 502, `无法通过 B 访问 ${parsed.host}:${parsed.port}`);
      }
      return;
    }

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      this.reject(client, 400, '请把浏览器/客户端配置为使用 HTTP 代理（需要绝对 URL）');
      return;
    }
    if (url.protocol !== 'http:') {
      this.reject(client, 405, '首版仅支持 HTTP 与 CONNECT(HTTPS)');
      return;
    }

    const port = Number(url.port || 80);
    const started = Date.now();
    const lines = header.split('\r\n').slice(1);
    const filtered = lines.filter((line) => {
      const name = line.split(':', 1)[0]?.toLowerCase() ?? '';
      return !['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'].includes(name);
    });
    if (!filtered.some((line) => line.toLowerCase().startsWith('host:'))) {
      filtered.unshift(`Host: ${url.host}`);
    }
    filtered.push('Connection: close');
    const outbound = Buffer.from(
      `${method} ${url.pathname}${url.search} ${version}\r\n${filtered.join('\r\n')}\r\n\r\n`,
      'latin1',
    );

    try {
      const channel = await this.link.openStream(url.hostname, port, 20000);
      if (client.destroyed) {
        channel.destroy();
        return;
      }
      this.runtime.totalRequests += 1;
      channel.write(outbound);
      if (rest.length > 0) channel.write(rest);
      this.bridge(client, channel, {
        method,
        target: url.host,
        started,
        settledBytes: outbound.length + rest.length,
      });
    } catch (error) {
      this.record({
        method,
        target: url.host,
        status: 502,
        bytes: 0,
        durationMs: Date.now() - started,
        outcome: 'error',
        error: (error as Error).message,
      });
      this.reject(client, 502, `无法通过 B 访问 ${url.host}`);
    }
  }

  private bridge(
    client: net.Socket,
    channel: Channel,
    meta: { method: string; target: string; started: number; settledBytes: number },
  ): void {
    let bytesUp = meta.settledBytes;
    let bytesDown = 0;
    let status: number | null = null;
    let finished = false;

    this.runtime.activeConnections += 1;
    this.sockets.add(client);

    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      this.runtime.activeConnections = Math.max(0, this.runtime.activeConnections - 1);
      this.runtime.bytesIn += bytesUp;
      this.runtime.bytesOut += bytesDown;
      this.record({
        method: meta.method,
        target: meta.target,
        status,
        bytes: bytesDown,
        durationMs: Date.now() - meta.started,
        outcome: error ? 'error' : 'ok',
        error,
      });
      client.destroy();
      channel.destroy();
    };

    client.on('data', (chunk: Buffer) => {
      bytesUp += chunk.length;
    });
    channel.on('data', (chunk: Buffer) => {
      bytesDown += chunk.length;
      if (status === null && isHttpResponse(chunk)) {
        const match = chunk
          .toString('latin1', 0, Math.min(chunk.length, 64))
          .match(/^HTTP\/\d\.\d (\d{3})/);
        if (match) status = Number(match[1]);
      }
    });

    client.pipe(channel);
    channel.pipe(client);
    channel.on('error', (error: Error) => finish(error.message));
    client.on('error', (error: Error) => finish(error.message));
    client.on('close', () => finish());
    channel.on('close', () => finish());
  }

  private reject(client: net.Socket, status: number, message: string): void {
    if (client.destroyed) return;
    const body = `TunnelDesk: ${message}\n`;
    client.end(
      `HTTP/1.1 ${status} ${statusText(status)}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  private record(entry: Omit<ProxyLogEntry, 'id' | 'at'>): void {
    const record: ProxyLogEntry = {
      id: ++this.logSeq,
      at: new Date().toISOString(),
      ...entry,
    };
    this.logs.unshift(record);
    const limit = Math.max(20, this.settings.logLimit);
    if (this.logs.length > limit) this.logs.length = limit;
    this.emit('log', record);
  }

  /** Verifies that a URL is reachable through the tunnel, from the B side. */
  async probe(rawUrl: string): Promise<{ ok: boolean; status: number | null; ms: number; note: string }> {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, status: null, ms: 0, note: 'URL 格式不正确' };
    }
    const port = Number(
      url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0),
    );
    if (!port) return { ok: false, status: null, ms: 0, note: '仅支持 http/https' };

    let channel: Channel;
    try {
      channel = await this.link.openStream(url.hostname, port, 15000);
    } catch (error) {
      return { ok: false, status: null, ms: Date.now() - started, note: (error as Error).message };
    }

    if (url.protocol === 'https:') {
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          channel.destroy();
          resolve({ ok: false, status: null, ms: Date.now() - started, note: 'TLS 握手超时' });
        }, 15000);
        const socket = tls.connect(
          { socket: channel as unknown as net.Socket, servername: url.hostname },
          () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.destroy();
            channel.destroy();
            resolve({
              ok: true,
              status: null,
              ms: Date.now() - started,
              note: 'TLS 握手成功（B 侧可达）',
            });
          },
        );
        socket.on('error', (error: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          channel.destroy();
          resolve({ ok: false, status: null, ms: Date.now() - started, note: error.message });
        });
      });
    }

    return new Promise((resolve) => {
      let buffer = '';
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        channel.destroy();
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ ok: false, status: null, ms: Date.now() - started, note: '响应超时' });
      }, 15000);

      channel.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: TunnelDesk/0.1\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
      channel.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1', 0, Math.min(chunk.length, 256));
        const match = buffer.match(/^HTTP\/\d\.\d (\d{3})/);
        if (!match || done) return;
        done = true;
        cleanup();
        const status = Number(match[1]);
        resolve({
          ok: status < 500,
          status,
          ms: Date.now() - started,
          note: status < 500 ? 'B 侧可达且返回正常响应' : `B 侧返回 ${status}`,
        });
      });
      channel.on('error', (error: Error) => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ ok: false, status: null, ms: Date.now() - started, note: error.message });
      });
    });
  }
}

function isHttpResponse(chunk: Buffer): boolean {
  return (
    chunk.length >= 5 &&
    chunk[0] === 0x48 &&
    chunk[1] === 0x54 &&
    chunk[2] === 0x54 &&
    chunk[3] === 0x50
  );
}

function statusText(status: number): string {
  const table: Record<number, string> = {
    400: 'Bad Request',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    431: 'Request Header Fields Too Large',
    502: 'Bad Gateway',
  };
  return table[status] ?? 'Error';
}
