export type LinkState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'error';

export type ConnectionType = 'ssh' | 'azure-bastion';

export interface HostConfig {
  id: string;
  name: string;
  /** 直连 SSH，或经 Azure Bastion 的本地 50022 隧道。 */
  connectionType: ConnectionType;
  host: string;
  port: number;
  username: string;
  keyPath: string;
  keyComment: string;
  hostKeyFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 全局唯一的 Azure Bastion 配置。`rdpPasswordCipher` 是 DPAPI 密文的
 * base64 形式，只允许留在服务端；下发给前端时会被剔除。
 */
export interface BastionProfile {
  name: string;
  resourceGroup: string;
  targetResourceId: string;
  rdpUsername: string;
  rdpPasswordCipher: string | null;
  autoStartTunnel: boolean;
  updatedAt: string;
}

/** 可安全下发给前端的 Bastion 配置（不含密文）。 */
export interface BastionPublicProfile {
  name: string;
  resourceGroup: string;
  targetResourceId: string;
  rdpUsername: string;
  hasRdpPassword: boolean;
  autoStartTunnel: boolean;
  updatedAt: string;
}

export type TunnelPhase = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed';

export interface PortOwnerInfo {
  pid: number;
  name: string;
}

export interface BastionTunnelState {
  phase: TunnelPhase;
  localPort: number;
  resourcePort: number;
  pid: number | null;
  since: string | null;
  lastError: string | null;
  restartAttempt: number;
  portOwner: PortOwnerInfo | null;
  diagnostics: string[];
}

export interface RdpSessionInfo {
  id: string;
  localPort: number;
  pid: number | null;
  state: 'starting' | 'ready' | 'failed';
  startedAt: string;
  lastError: string | null;
}

export interface BastionSnapshot {
  profile: BastionPublicProfile | null;
  tunnel: BastionTunnelState;
  rdpSessions: RdpSessionInfo[];
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
  /** 端口映射分组名；空字符串表示「未分组」。 */
  group: string;
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
  /** 分组展示顺序；只包含当前仍存在的分组，「未分组」不在其中。 */
  mappingGroupOrder: string[];
  proxy: ProxySettings;
  bastion: BastionProfile | null;
  settings: {
    theme: 'dark' | 'light';
    startProxyOnBoot: boolean;
    startMappingsOnBoot: boolean;
    reconnect: boolean;
  };
}

/**
 * Traffic counters are measured from A's point of view:
 * `bytesIn` / `rateIn` = arriving at A (下行), `bytesOut` / `rateOut` = sent by A (上行).
 */
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

/** Same counter convention as MappingRuntime: in = 下行, out = 上行. */
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
  /** 规则放行的本地端口；Any / 端口段等无法精确比较时为 null。 */
  port: number | null;
  /** TCP / UDP / Any；用于识别被改过协议的规则。 */
  protocol: string | null;
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
  /** Server version, read from the repository root package.json. */
  version: string;
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
  bastion: BastionSnapshot;
  mappings: Array<MappingConfig & { runtime: MappingRuntime }>;
  mappingGroupOrder: string[];
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
