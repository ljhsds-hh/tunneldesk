import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppConfig,
  AppSnapshot,
  BastionProfile,
  BastionPublicProfile,
  ConnectionType,
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
import { FirewallManager, firewallOwned, type FirewallDesiredPort } from './firewall/manager.js';
import {
  clearGroupInConfig,
  normalizeGroupName,
  normalizeGroupOrder,
  renameGroupInConfig,
} from './config/groups.js';
import { ForwardManager } from './forward/manager.js';
import { HttpProxyServer } from './proxy/httpProxy.js';
import { BastionManager, publicBastionProfile } from './bastion/manager.js';
import { BASTION_LOCAL_PORT } from './bastion/command.js';
import { encryptPassword } from './bastion/dpapi.js';
import { cleanRdpDir } from './bastion/rdp.js';
import { validateBastionInput } from './bastion/validate.js';

export interface SetupHostInput {
  name?: string;
  connectionType?: ConnectionType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface BastionInput {
  name?: string;
  resourceGroup?: string;
  targetResourceId?: string;
  rdpUsername?: string;
  rdpPassword?: string;
  clearRdpPassword?: boolean;
  autoStartTunnel?: boolean;
}

export interface HostConnectionInput {
  connectionType: ConnectionType;
  host?: string;
  port?: number;
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
  group?: string;
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
  readonly bastion: BastionManager;
  readonly startedAt = Date.now();

  private ticker: NodeJS.Timeout | null = null;
  private firewallTimer: NodeJS.Timeout | null = null;
  private firewallChain: Promise<unknown> = Promise.resolve();
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
    this.bastion = new BastionManager({
      logger: this.logger,
      profile: () => this.store.get().bastion,
      dataDir: () => appDataDir(),
    });

    this.link.on('state', () => this.emit('change'));
    this.link.on('online', () => {
      void this.handleOnline();
    });
    this.bastion.on('change', () => this.emit('change'));
    this.bastion.on('down', () => {
      // 隧道不可用时暂停 SSH 自动重连，避免对 127.0.0.1:50022 的必然失败重试。
      this.link.setAutoReconnect(false);
    });
    this.bastion.on('ready', () => {
      void this.handleBastionReady();
    });
    this.store.on('warning', (message: string) => this.logger.warn('config', message));
  }

  async init(): Promise<void> {
    ensureAppDirs();
    cleanRdpDir(path.join(appDataDir(), 'rdp'));
    const config = await this.store.load();
    this.link.setAutoReconnect(config.settings.reconnect);
    await this.forward.sync(config.mappings);

    if (config.proxy.enabled) {
      await this.proxy.apply(config.proxy);
    }

    const host = this.store.getActiveHost();
    if (host && host.connectionType === 'azure-bastion') {
      const profile = config.bastion;
      if (!profile) {
        this.logger.warn('bastion', 'Bastion 配置缺失，请在「连接管理」重新保存配置');
      } else if (profile.autoStartTunnel) {
        this.logger.info('app', `正在启动 Azure Bastion 隧道（${BASTION_LOCAL_PORT}）`);
        void this.bastion.ensure().catch((error: Error) => {
          this.logger.warn('bastion', `隧道自动启动失败：${error.message}`);
        });
      } else {
        this.logger.info('bastion', '自动启动已关闭，请先手动启动 50022 隧道');
      }
    } else if (host && config.settings.reconnect) {
      this.logger.info('app', `正在连接 ${host.name} (${host.host}:${host.port})`);
      this.link.connect(host).catch(() => undefined);
    }

    this.ticker = setInterval(() => this.tick(), 1000);
    this.ticker.unref();

    // Low-frequency reconciliation catches rules left behind after a crash or power loss.
    this.firewallTimer = setInterval(() => {
      if (!this.link.isOnline()) return;
      void this.syncFirewall().catch(() => undefined);
    }, 60 * 60 * 1000);
    this.firewallTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    if (this.firewallTimer) clearInterval(this.firewallTimer);
    this.link.disconnect();
    await this.bastion.shutdown();
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
      bastion: this.bastion.snapshot(),
      mappings,
      mappingGroupOrder: config.mappingGroupOrder,
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
    const connectionType: ConnectionType =
      input.connectionType === 'azure-bastion' ? 'azure-bastion' : 'ssh';
    const username = String(input.username ?? '').trim();
    let host = String(input.host ?? '').trim();
    let port = clampPort(input.port, 22);

    if (!username) throw new AppError('请填写 SSH 用户名');
    if (!input.password) throw new AppError('请填写 SSH 密码');

    if (connectionType === 'azure-bastion') {
      const profile = this.store.get().bastion;
      if (!profile) throw new AppError('请先完成 Azure Bastion 配置', 409);
      host = '127.0.0.1';
      port = BASTION_LOCAL_PORT;
      try {
        await this.bastion.ensure();
      } catch (error) {
        throw new AppError(`Azure Bastion 隧道不可用：${(error as Error).message}`, 502);
      }
    } else {
      if (!isValidHostname(host)) throw new AppError('主机地址不合法');
    }

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
      connectionType,
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
    this.link.disconnect();
    this.link.setAutoReconnect(this.store.get().settings.reconnect);
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
    await this.prepareBastion(host);
    this.link.setAutoReconnect(this.store.get().settings.reconnect);
    await this.link.connect(host).catch(() => undefined);
  }

  async updateHostConnection(id: string, input: HostConnectionInput): Promise<void> {
    const existing = this.store.getHost(id);
    if (!existing) throw new AppError('主机不存在', 404);
    if (input.connectionType !== 'ssh' && input.connectionType !== 'azure-bastion') {
      throw new AppError('连接方式不合法');
    }

    let host = existing.host;
    let port = existing.port;
    if (input.connectionType === 'azure-bastion') {
      if (!this.store.get().bastion) throw new AppError('请先完成 Azure Bastion 配置', 409);
      host = '127.0.0.1';
      port = BASTION_LOCAL_PORT;
    } else {
      if (input.host !== undefined) host = String(input.host).trim();
      if (input.port !== undefined) port = clampPort(input.port, existing.port);
      if (!isValidHostname(host)) throw new AppError('主机地址不合法');
      if (!isValidPort(port)) throw new AppError('SSH 端口不合法');
    }

    if (
      this.store.get().hosts.some(
        (item) =>
          item.id !== id &&
          item.host === host &&
          item.port === port &&
          item.username === existing.username,
      )
    ) {
      throw new AppError('已存在相同地址与用户名的主机，请先删除旧配置');
    }

    const wasActive = this.store.get().activeHostId === id;
    if (wasActive) this.link.disconnect();
    await this.store.update((draft) => {
      const record = draft.hosts.find((item) => item.id === id);
      if (!record) throw new AppError('主机不存在', 404);
      record.connectionType = input.connectionType;
      record.host = host;
      record.port = port;
      record.updatedAt = new Date().toISOString();
    });
    this.emit('change');

    if (!wasActive) return;
    const updated = this.store.getHost(id);
    if (!updated) return;
    try {
      await this.prepareBastion(updated);
    } catch (error) {
      this.logger.warn('host', `连接方式已切换，但隧道未就绪：${(error as Error).message}`);
      return;
    }
    await this.link.connect(updated).catch(() => undefined);
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
    await this.prepareBastion(host);
    await this.link.connect(host);
  }

  async disconnect(): Promise<void> {
    this.link.disconnect();
  }

  async testHost(id: string): Promise<{ ok: boolean; message: string }> {
    const host = this.store.getHost(id);
    if (!host) throw new AppError('主机不存在', 404);
    await this.prepareBastion(host);
    const ok = await verifyKeyLogin(host);
    return {
      ok,
      message: ok ? '密钥登录正常，SSH 通道可用' : '密钥登录失败，请检查 B 的 OpenSSH 配置或重新配置密钥',
    };
  }

  // -------------------------------------------------------------- bastion

  async saveBastion(input: BastionInput): Promise<BastionPublicProfile> {
    const existing = this.store.get().bastion;
    let validated: ReturnType<typeof validateBastionInput>;
    try {
      validated = validateBastionInput({
        name: input.name !== undefined ? input.name : existing?.name,
        resourceGroup: input.resourceGroup !== undefined ? input.resourceGroup : existing?.resourceGroup,
        targetResourceId:
          input.targetResourceId !== undefined ? input.targetResourceId : existing?.targetResourceId,
        rdpUsername: input.rdpUsername !== undefined ? input.rdpUsername : existing?.rdpUsername,
      });
    } catch (error) {
      throw new AppError((error as Error).message, 400);
    }
    if (input.rdpPassword && input.rdpPassword.length > 256) {
      throw new AppError('RDP 密码过长（最多 256 个字符）', 400);
    }

    let cipher = existing?.rdpPasswordCipher ?? null;
    if (input.clearRdpPassword) cipher = null;
    if (input.rdpPassword) {
      try {
        cipher = await encryptPassword(input.rdpPassword);
      } catch (error) {
        throw new AppError((error as Error).message, 500);
      }
    }

    const targetChanged = Boolean(
      existing &&
        (existing.name !== validated.name ||
          existing.resourceGroup !== validated.resourceGroup ||
          existing.targetResourceId !== validated.targetResourceId),
    );

    const profile: BastionProfile = {
      ...validated,
      rdpPasswordCipher: cipher,
      autoStartTunnel: input.autoStartTunnel ?? existing?.autoStartTunnel ?? true,
      updatedAt: new Date().toISOString(),
    };

    if (targetChanged) {
      this.link.disconnect();
      await this.bastion.stopAll();
    }

    await this.store.update((draft) => {
      draft.bastion = profile;
    });
    this.emit('change');

    if (targetChanged) {
      const host = this.store.getActiveHost();
      if (host?.connectionType === 'azure-bastion' && profile.autoStartTunnel) {
        void this.bastion.ensure().catch((error: Error) => {
          this.logger.warn('bastion', `隧道重新启动失败：${error.message}`);
        });
      }
    }
    return publicBastionProfile(profile) as BastionPublicProfile;
  }

  async resetBastion(): Promise<void> {
    if (!this.store.get().bastion) throw new AppError('尚未配置 Azure Bastion', 404);
    this.link.disconnect();
    await this.bastion.stopAll();
    cleanRdpDir(path.join(appDataDir(), 'rdp'));
    await this.store.update((draft) => {
      draft.bastion = null;
    });
    this.logger.info('bastion', 'Azure Bastion 配置已重置');
    this.emit('change');
  }

  async startBastionTunnel(): Promise<void> {
    if (!this.store.get().bastion) throw new AppError('尚未配置 Azure Bastion', 409);
    try {
      await this.bastion.ensure();
    } catch (error) {
      throw new AppError((error as Error).message, 502);
    }
  }

  async stopBastionTunnel(): Promise<void> {
    this.link.disconnect();
    await this.bastion.stop();
  }

  async killBastionPortOwner(): Promise<void> {
    if (!this.store.get().bastion) throw new AppError('尚未配置 Azure Bastion', 409);
    this.link.disconnect();
    try {
      await this.bastion.killPortOwner();
    } catch (error) {
      throw new AppError((error as Error).message, 502);
    }
  }

  async openRdp(): Promise<{ id: string; localPort: number }> {
    if (!this.store.get().bastion) throw new AppError('尚未配置 Azure Bastion', 409);
    try {
      const session = await this.bastion.openRdp();
      return { id: session.id, localPort: session.localPort };
    } catch (error) {
      throw new AppError((error as Error).message, 502);
    }
  }

  private async prepareBastion(host: HostConfig): Promise<void> {
    if (host.connectionType !== 'azure-bastion') return;
    const profile = this.store.get().bastion;
    if (!profile) throw new AppError('请先完成 Azure Bastion 配置', 409);
    if (!profile.autoStartTunnel) {
      if (!this.bastion.isReady()) throw new AppError('请先启动 50022 隧道', 409);
      return;
    }
    try {
      await this.bastion.ensure();
    } catch (error) {
      throw new AppError((error as Error).message, 502);
    }
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
      group: normalizeGroupName(input.group),
      createdAt: now,
      updatedAt: now,
    };

    await this.store.update((draft) => {
      draft.mappings.push(mapping);
      draft.mappingGroupOrder = normalizeGroupOrder(draft.mappingGroupOrder, draft.mappings);
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
      if (input.group !== undefined) mapping.group = normalizeGroupName(input.group);
      mapping.updatedAt = new Date().toISOString();
      draft.mappingGroupOrder = normalizeGroupOrder(draft.mappingGroupOrder, draft.mappings);
    });

    await this.forward.sync(this.store.get().mappings);
    await this.syncFirewall().catch(() => undefined);
    this.emit('change');
    return this.store.get().mappings.find((mapping) => mapping.id === id) as MappingConfig;
  }

  /**
   * Renames a mapping group and moves every mapping that belongs to it.
   * Purely a display concern: listeners, tunnels and firewall rules are untouched.
   */
  async renameMappingGroup(from: string, to: string): Promise<{ renamed: number; name: string }> {
    const fromName = normalizeGroupName(from);
    const toName = normalizeGroupName(to);
    if (!fromName) throw new AppError('分组不存在', 404);
    if (!toName) throw new AppError('分组名称不能为空（「未分组」是保留名称）');
    const config = this.store.get();
    const belongs = (name: string) => normalizeGroupName(name) === fromName;
    if (!config.mappings.some((mapping) => belongs(mapping.group))) {
      throw new AppError('分组不存在', 404);
    }
    if (
      fromName !== toName &&
      config.mappings.some((mapping) => !belongs(mapping.group) && normalizeGroupName(mapping.group) === toName)
    ) {
      throw new AppError(`分组「${toName}」已存在`);
    }
    let renamed = 0;
    await this.store.update((draft) => {
      renamed = renameGroupInConfig(draft, fromName, toName);
      draft.mappingGroupOrder = normalizeGroupOrder(draft.mappingGroupOrder, draft.mappings);
    });
    this.emit('change');
    return { renamed, name: toName };
  }

  /** Deletes a group view; its mappings fall back to "未分组" and stay untouched otherwise. */
  async deleteMappingGroup(name: string): Promise<{ moved: number }> {
    const target = normalizeGroupName(name);
    if (!target) throw new AppError('「未分组」不能删除');
    if (!this.store.get().mappings.some((mapping) => normalizeGroupName(mapping.group) === target)) {
      throw new AppError('分组不存在', 404);
    }
    let moved = 0;
    await this.store.update((draft) => {
      moved = clearGroupInConfig(draft, target);
    });
    this.emit('change');
    return { moved };
  }

  /** Persists the drag-and-drop group order after filtering out stale names. */
  async setMappingGroupOrder(order: unknown): Promise<{ order: string[] }> {
    let next: string[] = [];
    await this.store.update((draft) => {
      next = normalizeGroupOrder(order, draft.mappings);
      draft.mappingGroupOrder = next;
    });
    this.emit('change');
    return { order: next };
  }

  async deleteMapping(id: string): Promise<void> {
    const mapping = this.store.get().mappings.find((item) => item.id === id);
    if (!mapping) throw new AppError('映射不存在', 404);
    await this.store.update((draft) => {
      draft.mappings = draft.mappings.filter((item) => item.id !== id);
      draft.mappingGroupOrder = normalizeGroupOrder(draft.mappingGroupOrder, draft.mappings);
    });
    await this.forward.sync(this.store.get().mappings);
    if (this.link.isOnline()) {
      await this.enqueueFirewall(() => this.firewall.removeMapping(id)).catch(() => undefined);
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

  /** Every B-side firewall command - removal, reconciliation and the hourly sweep - shares this chain. */
  private enqueueFirewall<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.firewallChain.then(fn, fn);
    this.firewallChain = next.catch(() => undefined);
    return next;
  }

  syncFirewall(): Promise<{ added: number; removed: number }> {
    return this.enqueueFirewall(async () => {
      if (!this.link.isOnline()) return { added: 0, removed: 0 };
      const desired: FirewallDesiredPort[] = this.store
        .get()
        .mappings.filter(firewallOwned)
        .map((mapping) => ({
          mappingId: mapping.id,
          port: mapping.targetPort,
          targetHost: mapping.targetHost,
          sync: mapping.syncFirewall,
        }));
      return this.firewall.sync(desired);
    });
  }

  async updateSettings(input: Partial<AppConfig['settings']>): Promise<AppConfig['settings']> {
    await this.store.update((draft) => {
      draft.settings = { ...draft.settings, ...input };
    });
    const settings = this.store.get().settings;
    const host = this.store.getActiveHost();
    const tunnelDown = host?.connectionType === 'azure-bastion' && !this.bastion.isReady();
    this.link.setAutoReconnect(tunnelDown ? false : settings.reconnect);
    this.emit('change');
    return settings;
  }

  dataDir(): string {
    return appDataDir();
  }

  private async handleBastionReady(): Promise<void> {
    const config = this.store.get();
    const host = this.store.getActiveHost();
    if (!host || host.connectionType !== 'azure-bastion') return;
    this.link.setAutoReconnect(config.settings.reconnect);
    if (!config.settings.reconnect) return;
    if (this.link.isOnline()) return;
    this.logger.info('app', 'Bastion 隧道已就绪，正在恢复 SSH 连接');
    await this.link.connect(host).catch((error: Error) => {
      this.logger.warn('app', `SSH 连接失败：${error.message}`);
    });
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
