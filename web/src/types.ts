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

export interface Mapping {
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
  runtime: MappingRuntime;
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

export type ProxyRoutingMode = 'all' | 'whitelist';

export interface ProxySettings {
  enabled: boolean;
  bindAddress: string;
  port: number;
  allowLan: boolean;
  logLimit: number;
  routingMode: ProxyRoutingMode;
  whitelist: string[];
  runtime: ProxyRuntime;
}

export interface FirewallRule {
  name: string;
  mappingId: string;
  direction: string;
  enabled: boolean;
}

export interface ProxyLog {
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
  bastion: BastionSnapshot;
  mappings: Mapping[];
  proxy: ProxySettings;
  firewall: {
    rules: FirewallRule[];
    lastReconciledAt: string | null;
    lastError: string | null;
    removedOrphans: number;
  };
  proxyLogs: ProxyLog[];
  logs: LogEntry[];
}
