import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Client, type ClientChannel } from 'ssh2';
import type { HostConfig, LinkState } from '../types.js';
import { Logger } from '../util/logger.js';
import { connectClient, execOnClient, type ExecResult } from './client.js';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export interface LinkInfo {
  state: LinkState;
  hostId: string | null;
  endpoint: string | null;
  since: string | null;
  lastError: string | null;
  reconnectAttempt: number;
  fingerprint: string | null;
}

/**
 * Owns the single SSH connection to the target host.
 * Emits: 'state' (LinkInfo), 'online', 'offline'.
 */
export class SshLink extends EventEmitter {
  private client: Client | null = null;
  private host: HostConfig | null = null;
  private state: LinkState = 'idle';
  private lastError: string | null = null;
  private since: string | null = null;
  private attempt = 0;
  private manualStop = true;
  private autoReconnect = true;
  private timer: NodeJS.Timeout | null = null;
  private fingerprint: string | null = null;
  private generation = 0;

  constructor(private readonly logger: Logger) {
    super();
  }

  info(): LinkInfo {
    return {
      state: this.state,
      hostId: this.host?.id ?? null,
      endpoint: this.host ? `${this.host.host}:${this.host.port}` : null,
      since: this.since,
      lastError: this.lastError,
      reconnectAttempt: this.attempt,
      fingerprint: this.fingerprint,
    };
  }

  isOnline(): boolean {
    return this.state === 'online' && this.client !== null;
  }

  setAutoReconnect(enabled: boolean): void {
    this.autoReconnect = enabled;
    if (!enabled) this.clearTimer();
  }

  async connect(host: HostConfig): Promise<void> {
    this.host = host;
    this.manualStop = false;
    this.attempt = 0;
    const generation = ++this.generation;
    const existing = this.client;
    this.client = null;
    if (existing) {
      try {
        existing.end();
      } catch {
        existing.destroy();
      }
    }
    await this.open(generation);
  }

  disconnect(): void {
    this.generation += 1;
    this.manualStop = true;
    this.clearTimer();
    const client = this.client;
    this.client = null;
    this.since = null;
    this.attempt = 0;
    if (client) {
      try {
        client.end();
      } catch {
        client.destroy();
      }
    }
    this.setState('offline');
  }

  async openStream(targetHost: string, targetPort: number, timeoutMs = 15000): Promise<ClientChannel> {
    const client = this.client;
    if (!client || this.state !== 'online') throw new Error('隧道未连接');
    return new Promise<ClientChannel>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`建立通道超时：${targetHost}:${targetPort}`));
      }, timeoutMs);
      client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, channel) => {
        if (settled) {
          channel?.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) reject(new Error(`无法连接 ${targetHost}:${targetPort}（${error.message}）`));
        else resolve(channel);
      });
    });
  }

  async exec(command: string, timeoutMs = 15000): Promise<ExecResult> {
    const client = this.client;
    if (!client || this.state !== 'online') throw new Error('隧道未连接，无法执行远程命令');
    return execOnClient(client, command, timeoutMs);
  }

  private async open(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.clearTimer();
    const host = this.host;
    if (!host) throw new Error('未配置主机');

    this.setState(this.attempt > 0 ? 'reconnecting' : 'connecting');
    if (this.attempt === 0) this.lastError = null;

    let privateKey: Buffer;
    try {
      privateKey = fs.readFileSync(host.keyPath);
    } catch {
      this.lastError = '找不到私钥文件，请重新配置主机';
      this.setState('error');
      throw new Error(this.lastError);
    }

    let resolved = false;
    try {
      const result = await connectClient({
        host: host.host,
        port: host.port,
        username: host.username,
        privateKeyPem: privateKey.toString('utf8'),
      });
      // 连接期间用户可能已断开或切换到别的主机；丢弃过期连接，避免双连接与泄漏。
      if (generation !== this.generation || this.manualStop) {
        result.client.end();
        return;
      }
      this.client = result.client;
      this.fingerprint = result.hostKeyFingerprint;
      resolved = true;
      this.attempt = 0;
      this.since = new Date().toISOString();
      this.lastError = null;
      this.setState('online');
      this.logger.info('ssh', `已连接 ${host.host}:${host.port}`);
      this.attachLifecycle(result.client);
      this.emit('online');
    } catch (error) {
      if (generation !== this.generation) return;
      const message = (error as Error).message;
      this.lastError = message;
      this.client = null;
      this.logger.error('ssh', `连接失败：${message}`);
      this.setState('reconnecting');
      if (!resolved) {
        this.scheduleReconnect(generation);
        throw error;
      }
    }
  }

  private attachLifecycle(client: Client): void {
    client.on('error', (error: Error) => {
      this.lastError = error.message;
      this.logger.warn('ssh', `连接异常：${error.message}`);
    });
    client.on('close', () => {
      if (this.client !== client) return;
      this.client = null;
      this.since = null;
      this.emit('offline');
      if (this.manualStop) {
        this.setState('offline');
        return;
      }
      this.logger.warn('ssh', '连接已断开');
      this.setState('reconnecting');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(generation = this.generation): void {
    if (this.manualStop || !this.autoReconnect) {
      this.setState('offline');
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30000;
    this.attempt += 1;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.open(generation).catch(() => undefined);
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setState(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', this.info());
  }
}
