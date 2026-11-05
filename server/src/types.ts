export type LinkState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'error';

export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  keyPath: string;
  keyComment: string;
  hostKeyFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappingConfig {
  id: string;
  name: string;
  hostId: string;
  bindAddress: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
  autoStart: boolean;
  syncFirewall: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProxyRoutingMode = 'all' | 'whitelist';

export interface ProxySettings {
  enabled: boolean;
  bindAddress: string;
  port: number;
  allowLan: boolean;
  logLimit: number;
  /** all：所有请求走代理；whitelist：仅命中固定 IP 白名单的请求走代理。 */
  routingMode: ProxyRoutingMode;
  /** 固定 IPv4 白名单，精确匹配，不包含域名、网段或端口。 */
  whitelist: string[];
}

export interface AppConfig {
  version: number;
  activeHostId: string | null;
  hosts: HostConfig[];
  mappings: MappingConfig[];
  proxy: ProxySettings;
  settings: {
    theme: 'dark' | 'light';
    startProxyOnBoot: boolean;
    startMappingsOnBoot: boolean;
    reconnect: boolean;
  };
}

export interface MappingRuntime {
  listening: boolean;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
  rateIn: number;
  rateOut: number;
  lastError: string | null;
}

export interface ProxyRuntime {
  running: boolean;
  error: string | null;
  activeConnections: number;
  totalRequests: number;
  bytesIn: number;
  bytesOut: number;
  rateIn: number;
  rateOut: number;
}

export interface FirewallRuleInfo {
  name: string;
  mappingId: string;
  direction: string;
  enabled: boolean;
}

export interface ProxyLogEntry {
  id: number;
  at: string;
  method: string;
  target: string;
  status: number | null;
  bytes: number;
  durationMs: number;
  outcome: 'ok' | 'error';
  error?: string;
}

export interface LogEntry {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

export interface AppSnapshot {
  serverTime: string;
  uptimeMs: number;
  dataDir: string;
  settings: {
    theme: 'dark' | 'light';
    startProxyOnBoot: boolean;
    startMappingsOnBoot: boolean;
    reconnect: boolean;
  };
  link: {
    state: LinkState;
    hostId: string | null;
    hostLabel: string | null;
    endpoint: string | null;
    since: string | null;
    lastError: string | null;
    reconnectAttempt: number;
    fingerprint: string | null;
  };
  host: HostConfig | null;
  mappings: Array<MappingConfig & { runtime: MappingRuntime }>;
  proxy: ProxySettings & { runtime: ProxyRuntime };
  firewall: {
    rules: FirewallRuleInfo[];
    lastReconciledAt: string | null;
    lastError: string | null;
    removedOrphans: number;
  };
  proxyLogs: ProxyLogEntry[];
  logs: LogEntry[];
}
