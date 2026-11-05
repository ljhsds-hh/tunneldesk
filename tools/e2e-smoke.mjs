/**
 * End-to-end smoke test against the mock B (tools/mock-ssh-server.mjs) and the
 * demo intranet target (tools/demo-target.mjs).
 *
 * Verifies: password->key provisioning, SSH link, port mapping forwarding,
 * HTTP proxy forwarding, firewall rule creation/cleanup and deletion cleanup.
 */
import http from 'node:http';
import net from 'node:net';

const BASE = process.env.TUNNELDESK_BASE ?? 'http://127.0.0.1:19000';
const MOCK_PORT = Number(process.env.MOCK_SSH_PORT ?? 2222);
const TARGET_PORT = Number(process.env.DEMO_TARGET_PORT ?? 18080);
const MAPPING_PORT = 13389;
const PROXY_PORT = Number(process.env.DEMO_PROXY_PORT ?? 18888);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

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

function httpGet(port, path = '/', hostHeader = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers: { Host: hostHeader } }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('timeout')));
  });
}

/** Sends an absolute-form request to the proxy over a raw socket. */
function proxyGet(port, url) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: demo-intranet.local\r\nConnection: close\r\n\r\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => (buffer += chunk));
    socket.on('end', () => {
      const status = Number(buffer.match(/^HTTP\/\d\.\d (\d{3})/)?.[1] ?? 0);
      resolve({ status, body: buffer });
    });
    socket.on('error', reject);
    socket.setTimeout(8000, () => socket.destroy(new Error('timeout')));
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await wait(500);
  }
  console.log(`  WARN  wait timeout: ${label}`);
  return false;
}

async function main() {
  console.log('TunnelDesk E2E smoke');

  let state = await json('/api/state');
  check('console API reachable', Boolean(state.serverTime));

  if (!state.host) {
    await json('/api/hosts', 'POST', {
      name: 'Demo B',
      host: '127.0.0.1',
      port: MOCK_PORT,
      username: 'demo',
      password: 'demo-password',
    });
    check('host provisioned (password -> key)', true);
  } else {
    console.log('  INFO  host already configured, reusing');
  }

  const online = await waitFor(
    async () => (await json('/api/state')).link.state === 'online',
    20000,
    'SSH link online',
  );
  check('SSH link online (key auth)', online);

  state = await json('/api/state');
  const hostId = state.host?.id;
  check('host record saved', Boolean(hostId));

  let mappingId = null;
  const existing = state.mappings.find((mapping) => mapping.localPort === MAPPING_PORT);
  if (existing) {
    mappingId = existing.id;
  } else {
    const created = await json('/api/mappings', 'POST', {
      name: 'Demo mapping',
      hostId,
      localPort: MAPPING_PORT,
      targetHost: '127.0.0.1',
      targetPort: TARGET_PORT,
      enabled: true,
      syncFirewall: true,
    });
    mappingId = created.mapping.id;
  }
  check('mapping created', Boolean(mappingId));

  const mappingReady = await waitFor(
    async () => {
      const current = await json('/api/state');
      return current.mappings.some((mapping) => mapping.id === mappingId && mapping.runtime.listening);
    },
    15000,
    'mapping listening',
  );
  check('local mapping listener bound', mappingReady);

  const direct = await httpGet(MAPPING_PORT, '/port-mapping-ok');
  check('traffic through port mapping', direct.status === 200 && direct.body.includes('Intranet Demo Service'), `status=${direct.status}`);

  await json('/api/proxy', 'PUT', { enabled: true, port: PROXY_PORT });
  const proxied = await proxyGet(PROXY_PORT, `http://127.0.0.1:${TARGET_PORT}/via-proxy`);
  check('traffic through HTTP proxy', proxied.status === 200 && proxied.body.includes('Intranet Demo Service'), `status=${proxied.status}`);

  const probe = await json('/api/proxy/test', 'POST', { url: `http://127.0.0.1:${TARGET_PORT}/probe` });
  check('B-side probe reports reachable', probe.ok === true, probe.note);

  state = await json('/api/state');
  const ruleNames = state.firewall.rules.map((rule) => rule.name);
  check('firewall rule created for mapping', ruleNames.includes(`TunnelDesk-${mappingId}`), ruleNames.join(','));

  if (!process.env.KEEP_MAPPING) {
    await json(`/api/mappings/${mappingId}`, 'DELETE');
    const after = await waitFor(async () => {
      const current = await json('/api/state');
      return !current.mappings.some((mapping) => mapping.id === mappingId);
    }, 8000, 'mapping removed');
    check('mapping removed', after);
    check('firewall rule cleaned up', !(await json('/api/state')).firewall.rules.some((rule) => rule.name === `TunnelDesk-${mappingId}`));
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('E2E failed:', error);
  process.exitCode = 1;
});
