import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AppConfig, BastionProfile, HostConfig, MappingConfig, ProxySettings } from '../types.js';
import { writeFileAtomicAsync } from '../util/atomic.js';
import { appDataDir, ensureDir } from '../util/paths.js';
import { validateBastionInput } from '../bastion/validate.js';
import { BASTION_LOCAL_PORT } from '../bastion/command.js';

const CONFIG_VERSION = 2;

export function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    activeHostId: null,
    hosts: [],
    mappings: [],
    proxy: {
      enabled: false,
      bindAddress: '127.0.0.1',
      port: 8888,
      allowLan: false,
      logLimit: 200,
      routingMode: 'all',
      whitelist: [],
    },
    bastion: null,
    settings: {
      theme: 'dark',
      startProxyOnBoot: false,
      startMappingsOnBoot: true,
      reconnect: true,
    },
  };
}

export function configPath(): string {
  return path.join(appDataDir(), 'config.json');
}

function coerceConfig(raw: unknown): AppConfig {
  const fallback = defaultConfig();
  if (!raw || typeof raw !== 'object') return fallback;
  const input = raw as Partial<AppConfig>;
  return {
    version: CONFIG_VERSION,
    activeHostId: typeof input.activeHostId === 'string' ? input.activeHostId : null,
    hosts: Array.isArray(input.hosts) ? input.hosts.map(coerceHost).filter(Boolean) as HostConfig[] : [],
    mappings: Array.isArray(input.mappings)
      ? (input.mappings.map(coerceMapping).filter(Boolean) as MappingConfig[])
      : [],
    proxy: sanitizeProxy((input.proxy ?? {}) as Partial<ProxySettings>, fallback.proxy),
    bastion: coerceBastion(input.bastion),
    settings: { ...fallback.settings, ...(input.settings ?? {}) },
  };
}

function coerceHost(value: unknown): HostConfig | null {
  if (!value || typeof value !== 'object') return null;
  const host = value as Partial<HostConfig>;
  if (!host.id || !host.host || !host.username || !host.keyPath) return null;
  const connectionType = host.connectionType === 'azure-bastion' ? 'azure-bastion' : 'ssh';
  return {
    id: String(host.id),
    name: String(host.name ?? host.host),
    connectionType,
    // Bastion 主机固定走本地隧道，旧配置里即使写错了地址也纠正回来。
    host: connectionType === 'azure-bastion' ? '127.0.0.1' : String(host.host),
    port: connectionType === 'azure-bastion' ? BASTION_LOCAL_PORT : Number(host.port ?? 22),
    username: String(host.username),
    keyPath: String(host.keyPath),
    keyComment: String(host.keyComment ?? 'tunneldesk'),
    hostKeyFingerprint: host.hostKeyFingerprint ?? null,
    createdAt: String(host.createdAt ?? new Date().toISOString()),
    updatedAt: String(host.updatedAt ?? new Date().toISOString()),
  };
}

export function coerceBastion(value: unknown): BastionProfile | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<BastionProfile>;
  let validated: ReturnType<typeof validateBastionInput>;
  try {
    validated = validateBastionInput({
      name: input.name,
      resourceGroup: input.resourceGroup,
      targetResourceId: input.targetResourceId,
      rdpUsername: input.rdpUsername,
    });
  } catch {
    // 配置被手工改坏时宁可不加载，也不把可疑值拼进 az 命令。
    return null;
  }
  const cipher = typeof input.rdpPasswordCipher === 'string' && input.rdpPasswordCipher.trim()
    ? input.rdpPasswordCipher.trim()
    : null;
  return {
    ...validated,
    rdpPasswordCipher: cipher,
    autoStartTunnel: input.autoStartTunnel === undefined ? true : Boolean(input.autoStartTunnel),
    updatedAt: String(input.updatedAt ?? new Date().toISOString()),
  };
}


function coerceMapping(value: unknown): MappingConfig | null {
  if (!value || typeof value !== 'object') return null;
  const mapping = value as Partial<MappingConfig>;
  if (!mapping.id || !mapping.localPort || !mapping.targetPort) return null;
  return {
    id: String(mapping.id),
    name: String(mapping.name ?? `映射 ${mapping.localPort}`),
    hostId: String(mapping.hostId ?? ''),
    bindAddress: String(mapping.bindAddress ?? '127.0.0.1'),
    localPort: Number(mapping.localPort),
    targetHost: String(mapping.targetHost ?? '127.0.0.1'),
    targetPort: Number(mapping.targetPort),
    enabled: Boolean(mapping.enabled ?? true),
    autoStart: Boolean(mapping.autoStart ?? true),
    syncFirewall: Boolean(mapping.syncFirewall ?? true),
    createdAt: String(mapping.createdAt ?? new Date().toISOString()),
    updatedAt: String(mapping.updatedAt ?? new Date().toISOString()),
  };
}

/**
 * Config store: single writer, atomic persistence, change notifications.
 * Writes are serialized so concurrent API calls cannot interleave.
 */
export class ConfigStore extends EventEmitter {
  private config: AppConfig = defaultConfig();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  async load(): Promise<AppConfig> {
    if (this.loaded) return this.config;
    const file = configPath();
    try {
      const text = await fs.promises.readFile(file, 'utf8');
      this.config = coerceConfig(JSON.parse(text));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        const backup = `${file}.corrupt-${Date.now()}`;
        await fs.promises.rename(file, backup).catch(() => undefined);
      }
      this.config = defaultConfig();
      if (code !== 'ENOENT') {
        this.emit('warning', `配置文件读取失败，已重置（备份：${file}.corrupt-*）`);
      }
    }
    this.loaded = true;
    return this.config;
  }

  get(): AppConfig {
    return this.config;
  }

  getHost(id: string | null): HostConfig | null {
    if (!id) return null;
    return this.config.hosts.find((host) => host.id === id) ?? null;
  }

  getActiveHost(): HostConfig | null {
    return this.getHost(this.config.activeHostId);
  }

  async update(mutator: (draft: AppConfig) => void): Promise<AppConfig> {
    mutator(this.config);
    this.loaded = true;
    await this.persist();
    this.emit('change', this.config);
    return this.config;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.config, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => writeFileAtomicAsync(configPath(), snapshot));
    return this.writeChain;
  }
}

const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isValidIPv4(value: string): boolean {
  return IPV4_PATTERN.test(value);
}

/** 接受字符串（换行/逗号/空格分隔）或数组，返回去重后的合法 IPv4 列表。 */
export function normalizeWhitelist(input: unknown): string[] {
  const items = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,;，；]+/)
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const ip = String(item ?? '').trim();
    if (!isValidIPv4(ip) || seen.has(ip)) continue;
    seen.add(ip);
    result.push(ip);
    if (result.length >= 200) break;
  }
  return result;
}

export function sanitizeProxy(input: Partial<ProxySettings>, current: ProxySettings): ProxySettings {
  const allowLan = input.allowLan ?? current.allowLan;
  const port = clampPort(input.port ?? current.port, current.port);
  return {
    enabled: input.enabled ?? current.enabled,
    bindAddress: allowLan ? '0.0.0.0' : (input.bindAddress ?? current.bindAddress),
    port,
    allowLan,
    logLimit: Math.min(1000, Math.max(20, input.logLimit ?? current.logLimit)),
    routingMode:
      input.routingMode === 'all' || input.routingMode === 'whitelist'
        ? input.routingMode
        : current.routingMode,
    whitelist: input.whitelist === undefined ? current.whitelist : normalizeWhitelist(input.whitelist),
  };
}

export function clampPort(value: number, fallback: number): number {
  const port = Math.round(Number(value));
  if (!Number.isFinite(port) || port < 1 || port > 65535) return fallback;
  return port;
}

export function ensureAppDirs(): void {
  ensureDir(appDataDir());
  ensureDir(path.join(appDataDir(), 'keys'));
  ensureDir(path.join(appDataDir(), 'rdp'));
}
