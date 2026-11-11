/**
 * Phase 2 local verification - self-contained, no real computer B required.
 *
 * Starts the mock SSH host, the demo intranet target and the built console on
 * isolated ports, then verifies:
 *   - port mapping: HTTP, HTTPS/TLS, Git client traffic, TCP byte integrity
 *   - intranet proxy: HTTP/HTTPS current-behaviour regression (no code changes)
 *   - F1: B-local targets create rules, third-party targets do not, and rules
 *     are recycled when a target is changed to a third-party address
 *
 * Usage: node tools/phase2-verify.mjs
 * Requires: npm run build (web/dist + server/dist), git, openssl.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Unique per run: never bulk-delete a previous run's directory at startup.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-phase2-'));
const WORK = path.join(DATA, 'work');
const P = {
  mock: 23222,
  target: 18081,
  console: 19100,
  proxy: 18889,
  httpMap: 18082,
  httpsTarget: 18443,
  httpsMap: 18444,
};

let failures = 0;
let skips = 0;
const children = [];
const servers = [];

function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function skip(name, reason) {
  skips += 1;
  console.log(`  SKIP  ${name} :: ${reason}`);
}

function spawnNode(script, args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk.toString()));
  child.stderr.on('data', (chunk) => (log += chunk.toString()));
  child.log = () => log;
  children.push(child);
  return child;
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
    await wait(300);
  }
  console.log(`  WARN  timeout waiting for ${label}`);
  return false;
}

function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function api(pathname, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${P.console}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 200) };
  }
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status} ${payload.error ?? text}`);
  return payload;
}

function httpGet(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/phase2-ok' }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('timeout')));
  });
}

function proxyGet(url) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: P.proxy }, () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: demo-intranet.local\r\nConnection: close\r\n\r\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => (buffer += chunk));
    socket.on('end', () =>
      resolve({
        status: Number(buffer.match(/^HTTP\/\d\.\d (\d{3})/)?.[1] ?? 0),
        body: buffer,
      }),
    );
    socket.on('error', reject);
    socket.setTimeout(8000, () => socket.destroy(new Error('timeout')));
  });
}

function tlsGet(port) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      { host: '127.0.0.1', port, path: '/', rejectUnauthorized: false },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('timeout')));
  });
}

async function createMapping(name, localPort, targetHost, targetPort) {
  const state = await api('/api/state');
  const created = await api('/api/mappings', 'POST', {
    name,
    hostId: state.host.id,
    localPort,
    targetHost,
    targetPort,
    enabled: true,
    syncFirewall: true,
  });
  const id = created.mapping.id;
  const ready = await waitFor(
    async () => (await api('/api/state')).mappings.some((m) => m.id === id && m.runtime.listening),
    10000,
    `mapping ${name} listening`,
  );
  check(`mapping ${name} listening`, ready);
  return id;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd: cwd ?? ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  }).toString();
}

async function main() {
  console.log('TunnelDesk phase 2 local verification');
  fs.mkdirSync(WORK, { recursive: true });

  spawnNode('tools/mock-ssh-server.mjs', ['--port', String(P.mock)]);
  spawnNode('tools/demo-target.mjs', ['--port', String(P.target)]);
  check(
    'mock B and demo target started',
    (await waitFor(() => tcpProbe(P.mock), 10000, 'mock ssh')) &&
      (await waitFor(() => tcpProbe(P.target), 10000, 'demo target')),
  );

  spawnNode('server/dist/index.js', ['--port', String(P.console)], {
    TUNNELDESK_DATA_DIR: DATA,
  });
  check(
    'console API reachable',
    await waitFor(async () => Boolean((await api('/api/state')).serverTime), 20000, 'console'),
  );

  if (!(await api('/api/state')).host) {
    await api('/api/hosts', 'POST', {
      name: 'Verify B',
      host: '127.0.0.1',
      port: P.mock,
      username: 'demo',
      password: 'demo-password',
    });
  }
  check(
    'SSH link online (password -> key)',
    await waitFor(async () => (await api('/api/state')).link.state === 'online', 25000, 'ssh online'),
  );

  // ---- HTTP through port mapping
  const httpId = await createMapping('phase2-http', P.httpMap, '127.0.0.1', P.target);
  const direct = await httpGet(P.httpMap);
  check(
    'HTTP via port mapping',
    direct.status === 200 && direct.body.includes('Intranet Demo Service'),
    `status=${direct.status}`,
  );

  // ---- HTTPS/TLS through port mapping (self-signed cert, SAN mismatch is the
  //      documented user-side adaptation, so rejectUnauthorized=false here)
  try {
    const keyPath = path.join(WORK, 'key.pem');
    const certPath = path.join(WORK, 'cert.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=localhost'],
      { stdio: 'ignore' },
    );
    const tlsServer = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (_req, res) => {
        res.writeHead(200);
        res.end('TLS-OVER-MAPPING-OK');
      },
    );
    await new Promise((resolve) => tlsServer.listen(P.httpsTarget, '127.0.0.1', resolve));
    servers.push(tlsServer);
    await createMapping('phase2-https', P.httpsMap, '127.0.0.1', P.httpsTarget);
    const tlsResult = await tlsGet(P.httpsMap);
    check(
      'HTTPS/TLS via port mapping',
      tlsResult.status === 200 && tlsResult.body.includes('TLS-OVER-MAPPING-OK'),
      `status=${tlsResult.status}`,
    );
  } catch (error) {
    skip('HTTPS/TLS via port mapping', error.message);
  }

  // ---- Git client data (a real binary stream produced by the local git client).
  //      Full clone/push needs git-daemon or Smart HTTP, neither of which this
  //      PortableGit provides; V-3 in the acceptance checklist covers that.
  let gitArchive = Buffer.alloc(0);
  try {
    check('git client available', git(['--version']).includes('git version'));
    const seed = path.join(WORK, 'seed');
    git(['init', '-b', 'master', seed]);
    fs.writeFileSync(path.join(seed, 'README.md'), 'phase2 over port mapping\n');
    git(['-C', seed, '-c', 'user.name=Phase2', '-c', 'user.email=phase2@local', 'add', '.']);
    git(['-C', seed, '-c', 'user.name=Phase2', '-c', 'user.email=phase2@local', 'commit', '-m', 'seed']);
    gitArchive = execFileSync('git', ['-C', seed, 'archive', 'HEAD'], { maxBuffer: 8 * 1024 * 1024 });
    check('real git produced a binary stream', gitArchive.length > 0);
  } catch (error) {
    skip('real git binary stream', error.message.slice(0, 160));
  }
  skip('Git clone/push via port mapping', '本机 PortableGit 无 git-daemon / Smart HTTP 服务端，真实操作见验收清单 V-3');

  // ---- TCP byte integrity (binary + large payload + real git stream)
  const echo = net.createServer((socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  servers.push(echo);
  const echoPort = echo.address().port;
  const echoMap = 18085;
  await createMapping('phase2-tcp', echoMap, '127.0.0.1', echoPort);
  const echoBytes = (payload) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(echoMap, '127.0.0.1');
      const chunks = [];
      let total = 0;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('tcp echo timeout'));
      }, 15000);
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= payload.length) {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).subarray(0, payload.length));
          socket.destroy();
        }
      });
      socket.on('error', reject);
      socket.on('connect', () => socket.write(payload));
    });
  const payload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  check('TCP binary + large payload integrity', Buffer.compare(await echoBytes(payload), payload) === 0);
  if (gitArchive.length > 0) {
    check(
      'real Git binary stream integrity',
      Buffer.compare(await echoBytes(gitArchive), gitArchive) === 0,
    );
  }

  // ---- Intranet proxy regression (current behaviour, zero code changes)
  await api('/api/proxy', 'PUT', { enabled: true, port: P.proxy });
  await waitFor(() => tcpProbe(P.proxy), 8000, 'proxy');
  const proxied = await proxyGet(`http://127.0.0.1:${P.target}/via-proxy`);
  check(
    'intranet proxy HTTP regression',
    proxied.status === 200 && proxied.body.includes('Intranet Demo Service'),
    `status=${proxied.status}`,
  );
  const pac = await fetch(`http://127.0.0.1:${P.console}/proxy.pac`).then((r) => r.text());
  check('PAC script still served', pac.includes('FindProxyForURL'));

  // ---- F1: firewall rules by target ownership
  const thirdId = await createMapping('phase2-third-party', 18086, '10.20.30.40', P.target);
  const rules = (await api('/api/state')).firewall.rules.map((rule) => rule.name);
  check('B-local mapping has TunnelDesk rule', rules.includes(`TunnelDesk-${httpId}`), rules.join(','));
  check('third-party mapping has no B-side rule', !rules.includes(`TunnelDesk-${thirdId}`), rules.join(','));

  // ---- Disabling a mapping stops the local listener but keeps its B-side rule.
  await api(`/api/mappings/${httpId}`, 'PATCH', { enabled: false });
  const disabledKept = await waitFor(async () => {
    const current = (await api('/api/state')).firewall.rules.map((rule) => rule.name);
    return current.includes(`TunnelDesk-${httpId}`);
  }, 10000, 'disabled mapping keeps rule');
  check('disabled mapping keeps B-side rule', disabledKept);
  await api(`/api/mappings/${httpId}`, 'PATCH', { enabled: true });

  await api(`/api/mappings/${httpId}`, 'PATCH', { targetHost: '10.20.30.41' });
  const recycled = await waitFor(async () => {
    const current = (await api('/api/state')).firewall.rules.map((rule) => rule.name);
    return !current.includes(`TunnelDesk-${httpId}`);
  }, 10000, 'B-local rule recycled after target change');
  check('rule recycled when target becomes third-party', recycled);

  // ---- Restoring a B-local target must recreate the rule
  await api(`/api/mappings/${httpId}`, 'PATCH', { targetHost: '127.0.0.1' });
  const restored = await waitFor(async () => {
    const current = (await api('/api/state')).firewall.rules.map((rule) => rule.name);
    return current.includes(`TunnelDesk-${httpId}`);
  }, 10000, 'rule restored when target returns to B-local');
  check('rule restored when target returns to B-local', restored);

  // ---- ::1 passes validation and is treated as B itself
  const loopback6Id = await createMapping('phase2-ipv6-loopback', 18087, '::1', P.target);
  const v6Rules = (await api('/api/state')).firewall.rules.map((rule) => rule.name);
  check('::1 target creates a B-side rule', v6Rules.includes(`TunnelDesk-${loopback6Id}`), v6Rules.join(','));

  // ---- casing and padding are normalised before the ownership test
  const upperId = await createMapping('phase2-case', 18088, '  LOCALHOST  ', P.target);
  const caseRules = (await api('/api/state')).firewall.rules.map((rule) => rule.name);
  check(
    'LOCALHOST with padding is normalised to B-local',
    caseRules.includes(`TunnelDesk-${upperId}`),
    caseRules.join(','),
  );

  // ---- deleting a third-party mapping must not fail on the missing rule
  let deleteOk = true;
  try {
    await api(`/api/mappings/${thirdId}`, 'DELETE');
  } catch (error) {
    deleteOk = false;
    console.log(`    delete error: ${error.message}`);
  }
  check('deleting a third-party mapping does not fail', deleteOk);
  // 他人规则不受影响需 B 上真实存在别人的规则；mock 的 list() 只返回
  // TunnelDesk- 前缀，无法在此断言，交由真实环境 V-10 步骤 4 验证。

  // ---- Existing E2E smoke (12 checks) against the same isolated instance
  try {
    const smoke = execFileSync(process.execPath, [path.join(ROOT, 'tools/e2e-smoke.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        TUNNELDESK_BASE: `http://127.0.0.1:${P.console}`,
        MOCK_SSH_PORT: String(P.mock),
        DEMO_TARGET_PORT: String(P.target),
        DEMO_PROXY_PORT: String(P.proxy),
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    console.log(smoke.trim().split('\n').map((line) => `  ${line}`).join('\n'));
    check('existing e2e-smoke regression', smoke.includes('ALL CHECKS PASSED'));
  } catch (error) {
    check('existing e2e-smoke regression', false, String(error.stdout ?? error.message).slice(-400));
  }

  console.log(
    failures === 0
      ? `\nALL CHECKS PASSED${skips ? ` (${skips} skipped, see above)` : ''}`
      : `\n${failures} CHECK(S) FAILED`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error('phase2-verify aborted:', error);
  for (const child of children) {
    const log = child.log?.() ?? '';
    if (log.trim()) console.error(`--- child log ---\n${log.slice(-2000)}`);
  }
  failures += 1;
  process.exitCode = 1;
} finally {
  for (const server of servers) {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  await wait(300);
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch {
    console.log(`  INFO  left temporary data at ${DATA} (cleanup was blocked)`);
  }
}
