import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BastionProfile,
  BastionPublicProfile,
  BastionSnapshot,
  BastionTunnelState,
  PortOwnerInfo,
  RdpSessionInfo,
  TunnelPhase,
} from '../types.js';
import { newId } from '../util/paths.js';
import { findFreePort, isPortFree } from '../util/net.js';
import { killProcessTree, runCommand, runPowerShell } from '../util/process.js';
import { Logger } from '../util/logger.js';
import { BASTION_LOCAL_PORT, BASTION_RESOURCE_PORT, RDP_RESOURCE_PORT } from './command.js';
import { buildRdpFile, writeRdpFile } from './rdp.js';
import { maskSecrets } from './mask.js';
import { AzTunnel, type TunnelExitInfo } from './tunnel.js';

const MAX_RESTARTS = 5;
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const DIAGNOSTIC_LIMIT = 200;

interface RdpSession {
  info: RdpSessionInfo;
  tunnel: AzTunnel;
  mstsc: ChildProcess | null;
  mstscExited: boolean;
  rdpFile: string | null;
}

export interface BastionManagerOptions {
  logger: Logger;
  profile: () => BastionProfile | null;
  dataDir: () => string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function publicBastionProfile(profile: BastionProfile | null): BastionPublicProfile | null {
  if (!profile) return null;
  return {
    name: profile.name,
    resourceGroup: profile.resourceGroup,
    targetResourceId: profile.targetResourceId,
    rdpUsername: profile.rdpUsername,
    hasRdpPassword: Boolean(profile.rdpPasswordCipher),
    autoStartTunnel: profile.autoStartTunnel,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Owns the program-managed 50022 tunnel plus every manual RDP tunnel.
 * No sensitive value may leave this class unmasked.
 */
export class BastionManager extends EventEmitter {
  private tunnel: AzTunnel | null = null;
  private phase: TunnelPhase = 'idle';
  private since: string | null = null;
  private lastError: string | null = null;
  private restartAttempt = 0;
  private portOwner: PortOwnerInfo | null = null;
  private diagnostics: string[] = [];
  private lastProfile: BastionProfile | null = null;
  private restarting = false;
  private starting = false;
  private shuttingDown = false;
  private manualStop = true;
  private epoch = 0;
  private startPromise: Promise<void> | null = null;
  private startPromiseEpoch = -1;
  private opChain: Promise<void> = Promise.resolve();
  private readonly rdpSessions = new Map<string, RdpSession>();

  constructor(private readonly options: BastionManagerOptions) {
    super();
  }

  snapshot(): BastionSnapshot {
    const profile = this.options.profile();
    const maskProfile = profile ?? this.lastProfile;
    const tunnel: BastionTunnelState = {
      phase: this.phase,
      localPort: BASTION_LOCAL_PORT,
      resourcePort: BASTION_RESOURCE_PORT,
      pid: this.tunnel?.isReady() ? this.tunnel.pid : null,
      since: this.since,
      lastError: this.lastError ? maskSecrets(this.lastError, maskProfile) : null,
      restartAttempt: this.restartAttempt,
      portOwner: this.portOwner,
      diagnostics: this.diagnostics.slice(-DIAGNOSTIC_LIMIT).map((line) => maskSecrets(line, maskProfile)),
    };
    return {
      profile: publicBastionProfile(profile),
      tunnel,
      rdpSessions: [...this.rdpSessions.values()].map((session) => ({ ...session.info })),
    };
  }

  isReady(): boolean {
    return this.phase === 'ready' && this.tunnel?.isReady() === true;
  }

  /** 幂等启动：已就绪时直接返回。 */
  async start(): Promise<void> {
    if (this.isReady()) return;
    if (this.startPromise && this.startPromiseEpoch === this.epoch) return this.startPromise;
    const epoch = ++this.epoch;
    const promise = this.queueStart(true, epoch).then(() => undefined);
    this.startPromise = promise;
    this.startPromiseEpoch = epoch;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) {
        this.startPromise = null;
        this.startPromiseEpoch = -1;
      }
    }
  }

  async ensure(): Promise<void> {
    if (this.isReady()) return;
    await this.start();
    if (!this.isReady()) throw new Error('Azure Bastion 隧道未就绪');
  }

  async stop(): Promise<void> {
    this.epoch += 1;
    this.manualStop = true;
    const tunnel = this.tunnel;
    this.tunnel = null;
    this.phase = 'idle';
    this.since = null;
    this.lastError = null;
    this.restartAttempt = 0;
    this.portOwner = null;
    if (tunnel) await tunnel.stop();
    this.options.logger.info('bastion', '50022 隧道已停止');
    this.emit('change');
  }

  /** 「一键停止并重连」：结束占用 50022 的进程后重新拉起隧道。 */
  async killPortOwner(): Promise<void> {
    const owner = this.portOwner ?? (await scanPortOwner(BASTION_LOCAL_PORT));
    if (!owner) throw new Error('未检测到占用 50022 的进程');
    this.options.logger.warn('bastion', `正在结束占用 50022 的进程 ${owner.name}(PID ${owner.pid})`);
    await killProcessTree(owner.pid, 10000);
    for (let i = 0; i < 20; i += 1) {
      if (await isPortFree(BASTION_LOCAL_PORT)) break;
      await delay(250);
    }
    if (!(await isPortFree(BASTION_LOCAL_PORT))) {
      throw new Error('占用进程已结束，但 50022 仍被占用，请手动检查');
    }
    this.portOwner = null;
    await this.ensure();
  }

  async openRdp(): Promise<RdpSessionInfo> {
    const profile = this.options.profile();
    if (!profile) throw new Error('尚未配置 Azure Bastion');
    if (process.platform !== 'win32') throw new Error('远程桌面仅支持 Windows');

    const id = newId('rdp');
    const localPort = await findFreePort(40000 + Math.floor(Math.random() * 20000), '127.0.0.1');
    if (!localPort) throw new Error('找不到可用的本地端口');

    const session: RdpSession = {
      info: {
        id,
        localPort,
        pid: null,
        state: 'starting',
        startedAt: new Date().toISOString(),
        lastError: null,
      },
      tunnel: this.makeTunnel(profile, localPort, RDP_RESOURCE_PORT, `RDP:${localPort}`),
      mstsc: null,
      mstscExited: false,
      rdpFile: null,
    };
    this.rdpSessions.set(id, session);
    session.tunnel.on('exit', (info: TunnelExitInfo) => {
      if (info.expected) return;
      this.pushDiagnostic(`[RDP:${localPort}] 隧道意外退出`);
      void this.failRdp(id, 'RDP 隧道意外退出，请重新打开远程桌面');
    });

    try {
      await this.checkAzureCli(profile);
      await session.tunnel.start();
      if (!session.tunnel.isReady()) throw new Error('az 进程在就绪后立即退出');
      session.info.pid = session.tunnel.pid;

      const file = path.join(this.options.dataDir(), 'rdp', `${id}.rdp`);
      writeRdpFile(
        file,
        buildRdpFile({
          localPort,
          username: profile.rdpUsername,
          passwordCipher: profile.rdpPasswordCipher,
        }),
      );
      session.rdpFile = file;

      const child = spawn('mstsc.exe', [file], { windowsHide: false, stdio: 'ignore' });
      session.mstsc = child;
      child.once('error', (error: Error) => {
        void this.failRdp(id, `启动 mstsc 失败：${error.message}`);
      });
      child.once('exit', () => {
        session.mstscExited = true;
        void this.closeRdp(id);
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', (error: Error) => reject(error));
      });

      session.info.state = 'ready';
      this.options.logger.info('bastion', `远程桌面已启动（本地端口 ${localPort}）`);
      this.emit('change');
      return { ...session.info };
    } catch (error) {
      const message = this.describeTunnelError(error as Error, profile);
      await this.failRdp(id, message);
      throw new Error(message);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.epoch += 1;
    await Promise.all([...this.rdpSessions.keys()].map((id) => this.closeRdp(id)));
    const tunnel = this.tunnel;
    this.tunnel = null;
    this.phase = 'idle';
    if (tunnel) await tunnel.stop();
  }

  /** 配置被修改/重置时清理全部隧道，但不把管理器标记为“正在退出”。 */
  async stopAll(): Promise<void> {
    await Promise.all([...this.rdpSessions.keys()].map((id) => this.closeRdp(id)));
    await this.stop();
  }

  private queueStart(manual: boolean, epoch: number): Promise<boolean> {
    const task = this.opChain.then(
      () => this.runStart(manual, epoch),
      () => this.runStart(manual, epoch),
    );
    this.opChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private describeTunnelError(error: Error, profile: BastionProfile): string {
    let message = maskSecrets(error.message, profile);
    if (/提前退出/.test(message)) {
      message += '。请查看 az 诊断输出，并确认已执行 az login、订阅与 VM 资源 ID 正确';
    }
    return message;
  }

  private async runStart(manual: boolean, epoch: number): Promise<boolean> {
    if (this.isReady()) return true;
    const profile = this.options.profile();
    if (!profile) throw new Error('尚未配置 Azure Bastion');
    if (this.shuttingDown) throw new Error('程序正在退出');
    if (epoch !== this.epoch) return false;

    this.manualStop = false;
    this.starting = true;
    if (manual) this.restartAttempt = 0;
    this.phase = 'starting';
    this.lastError = null;
    this.portOwner = null;
    this.emit('change');

    let started: AzTunnel | null = null;
    try {
      await this.checkAzureCli(profile);

      if (!(await isPortFree(BASTION_LOCAL_PORT))) {
        this.portOwner = await scanPortOwner(BASTION_LOCAL_PORT);
        const owner = this.portOwner
          ? `${this.portOwner.name}(PID ${this.portOwner.pid})`
          : '未知进程';
        throw new Error(`连接失败：端口 ${BASTION_LOCAL_PORT} 被 ${owner} 占用`);
      }

      if (epoch !== this.epoch || this.shuttingDown) return false;
      const tunnel = this.makeTunnel(profile, BASTION_LOCAL_PORT, BASTION_RESOURCE_PORT, '50022');
      started = tunnel;
      this.tunnel = tunnel;
      tunnel.on('exit', (info: TunnelExitInfo) => {
        void this.handleExit(tunnel, info);
      });

      this.options.logger.info('bastion', '正在启动 50022 隧道');
      await tunnel.start();
      if (!tunnel.isReady()) throw new Error('az 进程在就绪后立即退出');

      if (epoch !== this.epoch || this.shuttingDown) {
        await tunnel.stop();
        if (this.tunnel === tunnel) this.tunnel = null;
        return false;
      }

      this.phase = 'ready';
      this.since = new Date().toISOString();
      this.restartAttempt = 0;
      this.lastError = null;
      this.portOwner = null;
      this.options.logger.info('bastion', '50022 隧道已就绪');
      this.emit('ready');
      this.emit('change');
      return true;
    } catch (error) {
      if (epoch !== this.epoch || this.shuttingDown) {
        if (started) {
          await started.stop().catch(() => undefined);
          if (this.tunnel === started) this.tunnel = null;
        }
        return false;
      }
      const message = this.describeTunnelError(error as Error, profile);
      this.lastError = message;
      this.phase = manual ? 'failed' : 'restarting';
      this.since = null;
      if (started) {
        await started.stop().catch(() => undefined);
        if (this.tunnel === started) this.tunnel = null;
      }
      this.options.logger.error('bastion', message);
      this.emit('change');
      if (manual) throw new Error(message);
      return false;
    } finally {
      this.starting = false;
    }
  }

  private async handleExit(tunnel: AzTunnel, info: TunnelExitInfo): Promise<void> {
    if (this.tunnel !== tunnel) return;
    this.tunnel = null;
    this.since = null;
    // 启动阶段就退出的话，让 runStart 抛错并决定后续状态，避免双重重连。
    if (this.starting) return;
    if (info.expected || this.manualStop || this.shuttingDown) {
      this.phase = 'idle';
      this.emit('change');
      return;
    }
    this.options.logger.warn('bastion', '50022 隧道意外退出，准备自动重连');
    this.phase = 'restarting';
    this.lastError = '隧道意外退出，正在自动重连';
    this.emit('change');
    this.emit('down');
    void this.restartLoop();
  }

  private async restartLoop(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    const epoch = this.epoch;
    try {
      for (let attempt = 1; attempt <= MAX_RESTARTS; attempt += 1) {
        this.restartAttempt = attempt;
        this.phase = 'restarting';
        this.lastError = `隧道已退出，正在第 ${attempt}/${MAX_RESTARTS} 次重连`;
        this.emit('change');
        await delay(RESTART_DELAYS[Math.min(attempt - 1, RESTART_DELAYS.length - 1)] ?? 30000);
        if (epoch !== this.epoch) return;
        if (this.manualStop || this.shuttingDown) {
          this.phase = 'idle';
          this.emit('change');
          return;
        }
        if (await this.queueStart(false, epoch)) return;
      }
      this.phase = 'failed';
      this.restartAttempt = 0;
      this.lastError = `隧道连续 ${MAX_RESTARTS} 次重连失败，已停止自动重试`;
      this.options.logger.error('bastion', this.lastError);
      this.emit('change');
    } finally {
      this.restarting = false;
    }
  }

  private async checkAzureCli(profile: BastionProfile): Promise<void> {
    if (!(await this.locateAzureCli())) {
      throw new Error('未找到 Azure CLI（az），请确认已安装且在 PATH 中');
    }
    let result;
    try {
      result = await runCommand('az', ['account', 'show', '--output', 'none'], {
        shell: process.platform === 'win32',
        timeoutMs: 20000,
      });
    } catch (error) {
      throw new Error(`Azure CLI 无法执行：${(error as Error).message}`);
    }
    if (result.code === 0) return;
    const text = maskSecrets(`${result.stderr}\n${result.stdout}`, profile);
    if (/not recognized|不是内部或外部命令|command not found|ENOENT/i.test(text)) {
      throw new Error('未找到 Azure CLI（az），请确认已安装且在 PATH 中');
    }
    throw new Error('Azure CLI 未登录或不可用，请先在命令行执行 az login');
  }

  /** 不解析本地化错误文本：直接让 where/which 判断 az 是否存在。 */
  private async locateAzureCli(): Promise<boolean> {
    try {
      const result =
        process.platform === 'win32'
          ? await runCommand('where.exe', ['az'], { timeoutMs: 10000 })
          : await runCommand('which', ['az'], { timeoutMs: 10000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private makeTunnel(profile: BastionProfile, localPort: number, resourcePort: number, label: string): AzTunnel {
    const tunnel = new AzTunnel(profile, localPort, resourcePort, label);
    tunnel.on('line', (line: string) => this.pushDiagnostic(line));
    return tunnel;
  }

  private pushDiagnostic(line: string): void {
    const profile = this.options.profile() ?? this.lastProfile;
    if (profile) this.lastProfile = profile;
    const text = maskSecrets(line, profile).slice(0, 1000);
    this.diagnostics.push(text);
    if (this.diagnostics.length > DIAGNOSTIC_LIMIT) {
      this.diagnostics.splice(0, this.diagnostics.length - DIAGNOSTIC_LIMIT);
    }
  }

  private async closeRdp(id: string): Promise<void> {
    const session = this.rdpSessions.get(id);
    if (!session) return;
    this.rdpSessions.delete(id);
    if (session.mstsc?.pid && !session.mstscExited) {
      await killProcessTree(session.mstsc.pid);
      session.mstscExited = true;
    }
    await session.tunnel.stop().catch(() => undefined);
    if (session.rdpFile) fs.rmSync(session.rdpFile, { force: true });
    this.options.logger.info('bastion', `远程桌面已关闭（本地端口 ${session.info.localPort}）`);
    this.emit('change');
  }

  private async failRdp(id: string, message: string): Promise<void> {
    const session = this.rdpSessions.get(id);
    if (!session) return;
    session.info.state = 'failed';
    session.info.lastError = maskSecrets(message, this.options.profile() ?? this.lastProfile);
    this.pushDiagnostic(`[RDP] ${message}`);
    await this.closeRdp(id);
  }
}

/**
 * 找出监听指定端口的进程。固定脚本、只拼接数字端口，不接触用户输入。
 */
export async function scanPortOwner(port: number): Promise<PortOwnerInfo | null> {
  if (process.platform !== 'win32') return null;
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${Math.round(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($null -eq $c) { Write-Output 'NONE'; exit 0 }",
    '$p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue',
    'if ($null -eq $p) { Write-Output ("{0}|unknown" -f $c.OwningProcess) }',
    'else { Write-Output ("{0}|{1}" -f $c.OwningProcess, $p.ProcessName) }',
  ].join('\n');
  try {
    const result = await runPowerShell(script, 15000);
    if (result.code !== 0) return null;
    const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    if (!line || line === 'NONE') return null;
    const [pidText, name] = line.split('|');
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, name: (name || 'unknown').trim() || 'unknown' };
  } catch {
    return null;
  }
}
