import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppConfig,
  AppSnapshot,
  HostConfig,
  MappingConfig,
  ProxySettings,
} from './types.js';
import { ConfigStore, clampPort, defaultConfig, ensureAppDirs, sanitizeProxy } from './config/store.js';
import { Logger } from './util/logger.js';
import { appDataDir, keysDir, newId } from './util/paths.js';
import { isPortFree, isValidHostname, isValidPort } from './util/net.js';
import { SshLink } from './ssh/link.js';
import { provisionHost, verifyKeyLogin } from './ssh/provision.js';
import { FirewallManager, type FirewallDesiredPort } from './firewall/manager.js';
import { ForwardManager } from './forward/manager.js';
import { HttpProxyServer } from './proxy/httpProxy.js';

export interface SetupHostInput {
  name?: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface MappingInput {
  name?: string;
  hostId: string;
  bindAddress?: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
  enabled?: boolean;
  syncFirewall?: boolean;
  autoStart?: boolean;
}

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Application service: owns configuration, the SSH link, both businesses and
 * the aggregated runtime state consumed by the console UI.
 */
export class App extends EventEmitter {
  readonly logger = new Logger();
  readonly store = new ConfigStore();
  readonly link: SshLink;
  readonly forward: ForwardManager;
  readonly firewall: FirewallManager;
  readonly proxy: HttpProxyServer;
  readonly startedAt = Date.now();

  private ticker: NodeJS.Timeout | null = null;
  private previous = new Map<string, { bytesIn: number; bytesOut: number }>();
  private previousProxy = { bytesIn: 0, bytesOut: 0 };
  private rates = new Map<string, { rateIn: number; rateOut: number }>();
  private proxyRate = { rateIn: 0, rateOut: 0 };

  constructor() {
    super();
    this.link = new SshLink(this.logger);
    this.forward = new ForwardManager(this.link, this.logger);
    this.firewall = new FirewallManager(this.link, this.logger);
    const settings = defaultConfig().proxy;
    this.proxy = new HttpProxyServer(this.link, this.logger, settings);

    this.link.on('state', () => this.emit('change'));
    this.link.on('online', () => {
      void this.handleOnline();
    });
    this.store.on('warning', (message: string) => this.logger.warn('config', message));
  }

  async init(): Promise<void> {
    ensureAppDirs();
    const config = await this.store.load();
    this.link.setAutoReconnect(config.settings.reconnect);
    await this.forward.sync(config.mappings);

    if (config.proxy.enabled) {
      await this.proxy.apply(config.proxy);
    }

    const host = this.store.getActiveHost();
    if (host && config.settings.reconnect) {
      this.logger.info('app', `正在连接 ${host.name} (${host.host}:${host.port})`);
      this.link.connect(host).catch(() => undefined);
    }

    this.ticker = setInterval(() => this.tick(), 1000);
    this.ticker.unref();
  }

  async shutdown(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.link.disconnect();
    await this.proxy.stop();
    await this.forward.stopAll();
  }

  snapshot(): AppSnapshot {
    const config = this.store.get();
    const host = this.store.getHost(config.activeHostId);
    const mappings = config.mappings.map((mapping) => ({
      ...mapping,
      runtime: {
        ...this.forward.runtimeFor(mapping.id),
        rateIn: this.rates.get(mapping.id)?.rateIn ?? 0,
        rateOut: this.rates.get(mapping.id)?.rateOut ?? 0,
      },
    }));
    return {
      serverTime: new Date().toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      dataDir: appDataDir(),
      settings: config.settings,
      link: { ...this.link.info(), hostLabel: host?.name ?? null },
      host,
      mappings,
      proxy: {
        ...config.proxy,
        runtime: {
          ...this.proxy.runtime,
          rateIn: this.proxyRate.rateIn,
          rateOut: this.proxyRate.rateOut,
        },
      },
      firewall: {
        rules: this.firewall.rules,
        lastReconciledAt: this.firewall.lastReconciledAt,
        lastError: this.firewall.lastError,
        removedOrphans: this.firewall.removedOrphans,
      },
      proxyLogs: this.proxy.logs.slice(0, 60),
      logs: this.logger.list().slice(-80),
    };
  }

  getConfig(): AppConfig {
    return this.store.get();
  }

  // ---------------------------------------------------------------- hosts

  async setupHost(input: SetupHostInput): Promise<HostConfig> {
    const host = String(input.host ?? '').trim();
    const username = String(input.username ?? '').trim();
    const port = clampPort(input.port, 22);
    if (!isValidHostname(host)) throw new AppError('主机地址不合法');
    if (!username) throw new AppError('请填写 SSH 用户名');
    if (!input.password) throw new AppError('请填写 SSH 密码');
    if (
      this.store.get().hosts.some(
        (item) => item.host === host && item.username === username && item.port === port,
      )
    ) {
      throw new AppError('该主机已存在，请直接连接或先删除旧配置');
    }

    const id = newId('host');
    const comment = `tunneldesk@${id}`;
    this.logger.info('host', `开始为 ${username}@${host}:${port} 配置密钥登录`);

    let provisioned;
    try {
      provisioned = await provisionHost({
        id,
        name: input.name ?? host,
        host,
        port,
        username,
        password: input.password,
        keysDir: keysDir(),
      });
    } catch (error) {
      throw new AppError(`SSH 配置失败：${(error as Error).message}`, 502);
    }

    const now = new Date().toISOString();
    const record: HostConfig = {
      id,
      name: (input.name ?? host).trim() || host,
      host,
      port,
      username,
      keyPath: provisioned.keyPath,
      keyComment: comment,
      hostKeyFingerprint: provisioned.hostKeyFingerprint,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.update((draft) => {
      draft.hosts.push(record);
      draft.activeHostId = record.id;
    });

    this.logger.info('host', `密钥登录已配置完成：${record.name}`);
    await this.link.connect(record).catch((error: Error) => {
      this.logger.warn('host', `首次连接失败：${error.message}`);
    });
    return record;
  }

  async activateHost(id: string): Promise<void> {
    const host = this.store.getHost(id);
    if (!host) throw new AppError('主机不存在', 404);
    this.link.disconnect();
    this.firewall.reset();
    await this.store.update((draft) => {
      draft.activeHostId = id;
    });
    await this.link.connect(host).catch(() => undefined);
  }

  async renameHost(id: string, name: string): Promise<void> {
    if (!name.trim()) throw new AppError('名称不能为空');
    await this.store.update((draft) => {
      const host = draft.hosts.find((item) => item.id === id);
      if (!host) throw new AppError('主机不存在', 404);
      host.name = name.trim();
      host.updatedAt = new Date().toISOString();
    });
  }

  async removeHost(id: string): Promise<void> {
    const config = this.store.get();
    const isActive = config.activeHostId === id;
    const ownedMappings = config.mappings.filter((mapping) => mapping.hostId === id);
    if (isActive) {
      if (this.link.isOnline()) {
        for (const mapping of ownedMappings) {
          await this.firewall.removeMapping(mapping.id).catch(() => undefined);
        }
      }
      this.link.disconnect();
    }
    await this.store.update((draft) => {
      draft.hosts = draft.hosts.filter((host) => host.id !== id);
      draft.mappings = draft.mappings.filter((mapping) => mapping.hostId !== id);
      if (draft.activeHostId === id) draft.activeHostId = draft.hosts[0]?.id ?? null;
    });
    this.firewall.reset();
    await this.forward.sync(this.store.get().mappings);
    this.emit('change');
  }

  async connect(): Promise<void> {
    const host = this.store.getActiveHost();
    if (!host) throw new AppError('尚未配置主机');
    this.link.setAutoReconnect(this.store.get().settings.reconnect);
    await this.link.connect(host);
  }

  async disconnect(): Promise<void> {
    this.link.disconnect();
  }

  async testHost(id: string): Promise<{ ok: boolean; message: string }> {
    const host = this.store.getHost(id);
    if (!host) throw new AppError('主机不存在', 404);
    const ok = await verifyKeyLogin(host);
    return {
      ok,
      message: ok ? '密钥登录正常，SSH 通道可用' : '密钥登录失败，请检查 B 的 OpenSSH 配置或重新配置密钥',
    };
  }

  // ------------------------------------------------------------- mappings

  async createMapping(input: MappingInput): Promise<MappingConfig> {
    const config = this.store.get();
    const localPort = clampPort(input.localPort, 0);
    const targetPort = clampPort(input.targetPort, 0);
    const bindAddress = input.bindAddress ?? '127.0.0.1';
    const targetHost = String(input.targetHost ?? '').trim() || '127.0.0.1';
    const hostId = input.hostId || config.activeHostId || '';

    if (!hostId || !config.hosts.some((host) => host.id === hostId)) throw new AppError('请选择目标主机');
    if (!isValidPort(localPort)) throw new AppError('本地端口不合法');
    if (!isValidPort(targetPort)) throw new AppError('目标端口不合法');
    if (!isValidHostname(targetHost)) throw new AppError('目标地址不合法');
    if (
      config.mappings.some(
        (mapping) => mapping.localPort === localPort && mapping.bindAddress === bindAddress,
      )
    ) {
      throw new AppError(`本地端口 ${localPort} 已被其他映射占用`);
    }
    if (!(await isPortFree(localPort, bindAddress))) {
      throw new AppError(`本地端口 ${localPort} 已被系统其他程序占用`);
    }

    const now = new Date().toISOString();
    const mapping: MappingConfig = {
      id: newId('map'),
      name: (input.name ?? '').trim() || `${targetHost}:${targetPort}`,
      hostId,
      bindAddress,
      localPort,
      targetHost,
      targetPort,
      enabled: input.enabled ?? true,
      autoStart: input.autoStart ?? true,
      syncFirewall: input.syncFirewall ?? true,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.update((draft) => {
      draft.mappings.push(mapping);
    });
    await this.forward.sync(this.store.get().mappings);
    await this.syncFirewall().catch(() => undefined);
    this.emit('change');
    return mapping;
  }

  async updateMapping(id: string, input: Partial<MappingInput>): Promise<MappingConfig> {
    const config = this.store.get();
    const existing = config.mappings.find((mapping) => mapping.id === id);
    if (!existing) throw new AppError('映射不存在', 404);

    const localPort =
      input.localPort !== undefined ? clampPort(input.localPort, existing.localPort) : existing.localPort;
    const targetPort =
      input.targetPort !== undefined ? clampPort(input.targetPort, existing.targetPort) : existing.targetPort;
    const bindAddress = input.bindAddress ?? existing.bindAddress;
    const targetHost = input.targetHost ? String(input.targetHost).trim() : existing.targetHost;
    if (!isValidPort(localPort) || !isValidPort(targetPort)) throw new AppError('端口不合法');
    if (!isValidHostname(targetHost)) throw new AppError('目标地址不合法');
    if (
      config.mappings.some(
        (mapping) =>
          mapping.id !== id &&
          mapping.localPort === localPort &&
          mapping.bindAddress === bindAddress,
      )
    ) {
      throw new AppError(`本地端口 ${localPort} 已被其他映射占用`);
    }
    if (localPort !== existing.localPort && !(await isPortFree(localPort, bindAddress))) {
      throw new AppError(`本地端口 ${localPort} 已被系统其他程序占用`);
    }

    const portChanged = targetPort !== existing.targetPort && existing.syncFirewall;
    if (portChanged) await this.firewall.removeMapping(id).catch(() => undefined);

    await this.store.update((draft) => {
      const mapping = draft.mappings.find((item) => item.id === id);
      if (!mapping) return;
      if (input.name !== undefined) mapping.name = input.name.trim() || mapping.name;
      mapping.bindAddress = bindAddress;
      mapping.localPort = localPort;
      mapping.targetHost = targetHost;
      mapping.targetPort = targetPort;
      if (input.enabled !== undefined) mapping.enabled = input.enabled;
      if (input.syncFirewall !== undefined) mapping.syncFirewall = input.syncFirewall;
      if (input.autoStart !== undefined) mapping.autoStart = input.autoStart;
      mapping.updatedAt = new Date().toISOString();
    });

    await this.forward.sync(this.store.get().mappings);
    await this.syncFirewall().catch(() => undefined);
    this.emit('change');
    return this.store.get().mappings.find((mapping) => mapping.id === id) as MappingConfig;
  }

  async deleteMapping(id: string): Promise<void> {
    const mapping = this.store.get().mappings.find((item) => item.id === id);
    if (!mapping) throw new AppError('映射不存在', 404);
    await this.store.update((draft) => {
      draft.mappings = draft.mappings.filter((item) => item.id !== id);
    });
    await this.forward.sync(this.store.get().mappings);
    if (this.link.isOnline()) {
      await this.firewall.removeMapping(id).catch(() => undefined);
    }
    await this.syncFirewall().catch(() => undefined);
    this.logger.info('mapping', `已删除映射 ${mapping.name}，并清理 B 侧防火墙规则`);
    this.emit('change');
  }

  async findFreePort(preferred: number): Promise<number> {
    const used = new Set(this.store.get().mappings.map((mapping) => mapping.localPort));
    for (let port = clampPort(preferred, 10000); port < 65535; port += 1) {
      if (used.has(port)) continue;
      if (await isPortFree(port, '127.0.0.1')) return port;
    }
    throw new AppError('找不到可用本地端口', 500);
  }

  // --------------------------------------------------------------- proxy

  async updateProxy(input: Partial<ProxySettings>): Promise<ProxySettings> {
    const config = this.store.get();
    const next = sanitizeProxy(input, config.proxy);
    await this.store.update((draft) => {
      draft.proxy = next;
    });
    await this.proxy.apply(next);
    this.emit('change');
    return next;
  }

  async testProxy(url: string): Promise<{ ok: boolean; status: number | null; ms: number; note: string }> {
    if (!this.link.isOnline()) throw new AppError('隧道未连接', 409);
    return this.proxy.probe(url);
  }

  async syncFirewall(): Promise<{ added: number; removed: number }> {
    if (!this.link.isOnline()) return { added: 0, removed: 0 };
    const desired: FirewallDesiredPort[] = this.store
      .get()
      .mappings.filter((mapping) => mapping.enabled && mapping.syncFirewall)
      .map((mapping) => ({ mappingId: mapping.id, port: mapping.targetPort }));
    return this.firewall.sync(desired);
  }

  async updateSettings(input: Partial<AppConfig['settings']>): Promise<AppConfig['settings']> {
    await this.store.update((draft) => {
      draft.settings = { ...draft.settings, ...input };
    });
    this.link.setAutoReconnect(this.store.get().settings.reconnect);
    this.emit('change');
    return this.store.get().settings;
  }

  dataDir(): string {
    return appDataDir();
  }

  private async handleOnline(): Promise<void> {
    this.logger.info('app', '隧道在线，正在恢复业务');
    await this.forward.sync(this.store.get().mappings);
    try {
      const result = await this.syncFirewall();
      if (result.added || result.removed) {
        this.logger.info('firewall', `规则已同步（新增 ${result.added}，清理 ${result.removed}）`);
      }
    } catch (error) {
      this.logger.warn('firewall', `规则同步失败：${(error as Error).message}`);
    }
    this.emit('change');
  }

  private tick(): void {
    for (const mapping of this.store.get().mappings) {
      const runtime = this.forward.runtimeFor(mapping.id);
      const before = this.previous.get(mapping.id);
      const rateIn = before ? Math.max(0, runtime.bytesIn - before.bytesIn) : 0;
      const rateOut = before ? Math.max(0, runtime.bytesOut - before.bytesOut) : 0;
      this.rates.set(mapping.id, { rateIn, rateOut });
      this.previous.set(mapping.id, { bytesIn: runtime.bytesIn, bytesOut: runtime.bytesOut });
    }

    const proxyRuntime = this.proxy.runtime;
    this.proxyRate = {
      rateIn: Math.max(0, proxyRuntime.bytesIn - this.previousProxy.bytesIn),
      rateOut: Math.max(0, proxyRuntime.bytesOut - this.previousProxy.bytesOut),
    };
    this.previousProxy = { bytesIn: proxyRuntime.bytesIn, bytesOut: proxyRuntime.bytesOut };

    this.emit('tick', Date.now());
  }

  resolveWebDist(): string | null {
    return findWebDist();
  }
}

function findWebDist(): string | null {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, 'web', 'dist');
      if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}
