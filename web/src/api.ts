import type { AppSnapshot } from './types';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export const api = {
  state: () => request<AppSnapshot>('/api/state'),

  setupHost: (input: {
    name?: string;
    connectionType?: 'ssh' | 'azure-bastion';
    host: string;
    port: number;
    username: string;
    password: string;
  }) => request<{ host: unknown }>('/api/hosts', 'POST', input),

  activateHost: (id: string) => request<{ ok: boolean }>(`/api/hosts/${id}/activate`, 'POST'),
  connect: (id: string) => request<{ ok: boolean }>(`/api/hosts/${id}/connect`, 'POST'),
  disconnect: (id: string) => request<{ ok: boolean }>(`/api/hosts/${id}/disconnect`, 'POST'),
  testHost: (id: string) => request<{ ok: boolean; message: string }>(`/api/hosts/${id}/test`, 'POST'),
  renameHost: (id: string, name: string) => request<{ ok: boolean }>(`/api/hosts/${id}`, 'PATCH', { name }),
  updateHostConnection: (
    id: string,
    input: { connectionType: 'ssh' | 'azure-bastion'; host?: string; port?: number },
  ) => request<{ ok: boolean }>(`/api/hosts/${id}/connection`, 'PUT', input),
  removeHost: (id: string) => request<{ ok: boolean }>(`/api/hosts/${id}`, 'DELETE'),

  saveBastion: (input: Record<string, unknown>) => request<{ profile: unknown }>('/api/bastion', 'PUT', input),
  resetBastion: () => request<{ ok: boolean }>('/api/bastion', 'DELETE'),
  startBastionTunnel: () => request<{ ok: boolean }>('/api/bastion/tunnel/start', 'POST'),
  stopBastionTunnel: () => request<{ ok: boolean }>('/api/bastion/tunnel/stop', 'POST'),
  killBastionPortOwner: () => request<{ ok: boolean }>('/api/bastion/tunnel/kill-owner', 'POST'),
  openRdp: () => request<{ id: string; localPort: number }>('/api/bastion/rdp', 'POST'),

  createMapping: (input: Record<string, unknown>) =>
    request<{ mapping: unknown }>('/api/mappings', 'POST', input),
  updateMapping: (id: string, input: Record<string, unknown>) =>
    request<{ mapping: unknown }>(`/api/mappings/${id}`, 'PATCH', input),
  deleteMapping: (id: string) => request<{ ok: boolean }>(`/api/mappings/${id}`, 'DELETE'),
  freePort: (preferred: number) =>
    request<{ port: number }>(`/api/ports/available?port=${preferred}`),

  updateProxy: (input: Record<string, unknown>) => request<{ proxy: unknown }>('/api/proxy', 'PUT', input),
  testProxy: (url: string) =>
    request<{ ok: boolean; status: number | null; ms: number; note: string }>('/api/proxy/test', 'POST', { url }),
  syncFirewall: () => request<{ added: number; removed: number }>('/api/firewall/sync', 'POST'),

  updateSettings: (input: Record<string, unknown>) => request<{ settings: unknown }>('/api/settings', 'PUT', input),
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function formatClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 0) return '刚刚';
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  return `${Math.floor(delta / 3_600_000)} 小时前`;
}
