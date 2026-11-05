/**
 * Seeds a demo host state for visual review against tools/mock-ssh-server.mjs.
 * Safe to run repeatedly; skips mappings that already exist.
 */
const BASE = process.env.TUNNELDESK_BASE ?? 'http://127.0.0.1:19000';

async function json(path, method = 'GET', body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${payload.error ?? text}`);
  return payload;
}

const state = await json('/api/state');
if (!state.host) {
  await json('/api/hosts', 'POST', {
    name: 'Azure 跳板机',
    host: '127.0.0.1',
    port: 2222,
    username: 'demo',
    password: 'demo-password',
  });
}
await new Promise((resolve) => setTimeout(resolve, 1200));
const current = await json('/api/state');
const hostId = current.host?.id;

const wanted = [
  { name: '远程桌面', localPort: 13389, targetHost: '127.0.0.1', targetPort: 3389 },
  { name: '内部 Wiki', localPort: 18081, targetHost: '127.0.0.1', targetPort: 18080 },
  { name: '业务数据库', localPort: 15432, targetHost: '127.0.0.1', targetPort: 5432 },
];

for (const item of wanted) {
  if (current.mappings.some((mapping) => mapping.localPort === item.localPort)) continue;
  await json('/api/mappings', 'POST', {
    ...item,
    hostId,
    enabled: true,
    syncFirewall: true,
  });
}

await json('/api/proxy', 'PUT', { enabled: true, port: 18888, allowLan: false });

const after = await json('/api/state');
console.log(
  JSON.stringify(
    {
      host: after.host?.name,
      link: after.link.state,
      mappings: after.mappings.map((mapping) => `${mapping.name}:${mapping.localPort}`),
      proxy: `${after.proxy.port} running=${after.proxy.runtime.running}`,
      rules: after.firewall.rules.length,
    },
    null,
    2,
  ),
);
