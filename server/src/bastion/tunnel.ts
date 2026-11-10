import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { BastionProfile } from '../types.js';
import { probeTcp } from '../util/net.js';
import { killProcessTree, spawnCommand } from '../util/process.js';
import { buildTunnelArgs } from './command.js';

export interface TunnelExitInfo {
  code: number | null;
  signal: string | null;
  expected: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * 单个 `az network bastion tunnel` 进程。
 * 就绪判断只依赖本地端口能否建立 TCP 连接，不解析 az 输出。
 * 事件：'line'（一行输出）、'exit'（TunnelExitInfo）。
 */
export class AzTunnel extends EventEmitter {
  private child: ChildProcess | null = null;
  private childExited = false;
  private exitCode: number | null = null;
  private spawnError: Error | null = null;
  private stopping = false;
  private ready = false;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(
    private readonly target: Pick<BastionProfile, 'name' | 'resourceGroup' | 'targetResourceId'>,
    readonly localPort: number,
    readonly resourcePort: number,
    readonly label: string,
  ) {
    super();
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  isReady(): boolean {
    return this.ready && this.child !== null;
  }

  async start(timeoutMs = 40000): Promise<void> {
    if (this.child) throw new Error('隧道已在运行');
    this.childExited = false;
    this.exitCode = null;
    this.spawnError = null;
    this.stopping = false;
    this.ready = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    const args = buildTunnelArgs(this.target, this.localPort, this.resourcePort);
    const child = spawnCommand('az', args, { shell: process.platform === 'win32' });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.consume('stdout', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => this.consume('stderr', chunk.toString('utf8')));
    child.once('error', (error: Error) => {
      this.spawnError = error;
      this.emit('line', `[${this.label}] 进程错误：${error.message}`);
    });
    child.once('exit', (code, signal) => {
      this.flush();
      this.child = null;
      this.ready = false;
      this.childExited = true;
      this.exitCode = code;
      this.emit('exit', { code, signal, expected: this.stopping } satisfies TunnelExitInfo);
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.spawnError) throw this.spawnError;
      if (this.childExited) {
        throw new Error(`az 进程提前退出（退出码 ${this.exitCode ?? '未知'}）`);
      }
      if (await probeTcp(this.localPort, '127.0.0.1', 1200)) {
        this.ready = true;
        return;
      }
      await delay(400);
    }
    this.ready = false;
    throw new Error(`等待本地端口 ${this.localPort} 就绪超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    const child = this.child;
    if (!child) return;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    await killProcessTree(child.pid);
    await Promise.race([exited, delay(4000)]);
    if (this.child === child) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      this.child = null;
    }
  }

  private consume(stream: 'stdout' | 'stderr', chunk: string): void {
    const key = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    const combined = this[key] + chunk;
    const parts = combined.split(/\r\n|\n|\r/);
    this[key] = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (line) this.emit('line', `[${this.label}] ${line}`);
    }
  }

  private flush(): void {
    for (const key of ['stdoutBuffer', 'stderrBuffer'] as const) {
      const line = this[key].trim();
      this[key] = '';
      if (line) this.emit('line', `[${this.label}] ${line}`);
    }
  }
}
