import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { App, AppError } from '../app.js';
import { buildPacScript } from '../proxy/pac.js';

const MAX_BODY = 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

export interface ServerOptions {
  port: number;
  host?: string;
}

export function startConsoleServer(app: App, options: ServerOptions): Promise<http.Server> {
  const host = options.host ?? '127.0.0.1';
  const webDist = app.resolveWebDist();

  const server = http.createServer((req, res) => {
    void handle(app, webDist, req, res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function handle(app: App, webDist: string | null, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/proxy.pac') {
      if (!isLocalRequest(req)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
        return;
      }
      const script = buildPacScript(app.getConfig().proxy);
      res.writeHead(200, {
        'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Length': Buffer.byteLength(script),
      });
      res.end(req.method === 'HEAD' ? undefined : script);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: '仅允许本机访问' });
        return;
      }
      await handleApi(app, req, res, url);
      return;
    }
    serveStatic(webDist, pathname, res);
  } catch (error) {
    if (error instanceof AppError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    const message = (error as Error).message ?? '服务器内部错误';
    app.logger.error('api', message);
    sendJson(res, 500, { error: message });
  }
}

async function handleApi(app: App, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = url.pathname;

  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && !isTrustedOrigin(req)) {
    throw new AppError('请求来源不被信任', 403);
  }

  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, app.snapshot());
    return;
  }

  if (method === 'GET' && pathname === '/api/events') {
    openEventStream(app, req, res);
    return;
  }

  if (method === 'GET' && pathname === '/api/logs') {
    sendJson(res, 200, { logs: app.logger.list(), proxyLogs: app.proxy.logs });
    return;
  }

  if (method === 'GET' && pathname === '/api/ports/available') {
    const preferred = Number(url.searchParams.get('port') ?? '10000');
    const port = await app.findFreePort(preferred);
    sendJson(res, 200, { port });
    return;
  }

  if (method === 'POST' && pathname === '/api/hosts') {
    const body = await readJson(req);
    const host = await app.setupHost({
      name: asString(body.name),
      connectionType:
        body.connectionType === 'azure-bastion'
          ? 'azure-bastion'
          : body.connectionType === 'ssh'
            ? 'ssh'
            : undefined,
      host: asString(body.host),
      port: Number(body.port ?? 22),
      username: asString(body.username),
      password: asString(body.password),
    });
    sendJson(res, 201, { host });
    return;
  }

  const hostConnectionMatch = pathname.match(/^\/api\/hosts\/([^/]+)\/connection$/);
  if (hostConnectionMatch && method === 'PUT') {
    const id = decodeURIComponent(hostConnectionMatch[1] ?? '');
    const body = await readJson(req);
    if (body.connectionType !== 'ssh' && body.connectionType !== 'azure-bastion') {
      throw new AppError('连接方式不合法');
    }
    await app.updateHostConnection(id, {
      connectionType: body.connectionType,
      host: body.host === undefined ? undefined : asString(body.host),
      port: body.port === undefined ? undefined : Number(body.port),
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  const hostMatch = pathname.match(/^\/api\/hosts\/([^/]+)(?:\/(activate|connect|disconnect|test))?$/);
  if (hostMatch) {
    const id = decodeURIComponent(hostMatch[1] ?? '');
    const action = hostMatch[2];
    if (method === 'PATCH' && !action) {
      const body = await readJson(req);
      await app.renameHost(id, asString(body.name));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'DELETE' && !action) {
      const result = await app.removeHost(id);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (method === 'POST' && action === 'activate') {
      await app.activateHost(id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && action === 'connect') {
      await app.connect();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && action === 'disconnect') {
      await app.disconnect();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && action === 'test') {
      sendJson(res, 200, await app.testHost(id));
      return;
    }
  }

  if (method === 'POST' && pathname === '/api/mappings') {
    const body = await readJson(req);
    const mapping = await app.createMapping({
      name: asString(body.name),
      hostId: asString(body.hostId),
      bindAddress: asString(body.bindAddress) || '127.0.0.1',
      localPort: Number(body.localPort),
      targetHost: asString(body.targetHost) || '127.0.0.1',
      targetPort: Number(body.targetPort),
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      syncFirewall: body.syncFirewall === undefined ? true : Boolean(body.syncFirewall),
      group: asString(body.group),
    });
    sendJson(res, 201, { mapping });
    return;
  }

  const mappingMatch = pathname.match(/^\/api\/mappings\/([^/]+)$/);
  if (mappingMatch) {
    const id = decodeURIComponent(mappingMatch[1] ?? '');
    if (method === 'PATCH') {
      const body = await readJson(req);
      const mapping = await app.updateMapping(id, {
        name: body.name === undefined ? undefined : asString(body.name),
        bindAddress: body.bindAddress === undefined ? undefined : asString(body.bindAddress),
        localPort: body.localPort === undefined ? undefined : Number(body.localPort),
        targetHost: body.targetHost === undefined ? undefined : asString(body.targetHost),
        targetPort: body.targetPort === undefined ? undefined : Number(body.targetPort),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
        syncFirewall: body.syncFirewall === undefined ? undefined : Boolean(body.syncFirewall),
        group: body.group === undefined ? undefined : asString(body.group),
      });
      sendJson(res, 200, { mapping });
      return;
    }
    if (method === 'DELETE') {
      await app.deleteMapping(id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (method === 'PUT' && pathname === '/api/mapping-groups') {
    const body = await readJson(req);
    sendJson(res, 200, await app.setMappingGroupOrder(body.order));
    return;
  }

  const groupMatch = pathname.match(/^\/api\/mapping-groups\/([^/]+)$/);
  if (groupMatch) {
    const name = decodeURIComponent(groupMatch[1] ?? '');
    if (method === 'PATCH') {
      const body = await readJson(req);
      sendJson(res, 200, await app.renameMappingGroup(name, asString(body.name)));
      return;
    }
    if (method === 'DELETE') {
      sendJson(res, 200, await app.deleteMappingGroup(name));
      return;
    }
  }

  if (method === 'PUT' && pathname === '/api/proxy') {
    const body = await readJson(req);
    const proxy = await app.updateProxy({
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      port: body.port === undefined ? undefined : Number(body.port),
      allowLan: body.allowLan === undefined ? undefined : Boolean(body.allowLan),
      logLimit: body.logLimit === undefined ? undefined : Number(body.logLimit),
      routingMode:
        body.routingMode === 'all' || body.routingMode === 'whitelist' ? body.routingMode : undefined,
      whitelist: body.whitelist === undefined ? undefined : (body.whitelist as string[]),
    });
    sendJson(res, 200, { proxy });
    return;
  }

  if (method === 'POST' && pathname === '/api/proxy/test') {
    const body = await readJson(req);
    const result = await app.testProxy(asString(body.url));
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/firewall/sync') {
    sendJson(res, 200, await app.syncFirewall());
    return;
  }

  if (method === 'PUT' && pathname === '/api/settings') {
    const body = await readJson(req);
    const settings = await app.updateSettings({
      theme: body.theme === 'light' ? 'light' : body.theme === 'dark' ? 'dark' : undefined,
      reconnect: body.reconnect === undefined ? undefined : Boolean(body.reconnect),
    });
    sendJson(res, 200, { settings });
    return;
  }

  if (method === 'PUT' && pathname === '/api/bastion') {
    const body = await readJson(req);
    const profile = await app.saveBastion({
      name: body.name === undefined ? undefined : asString(body.name),
      resourceGroup: body.resourceGroup === undefined ? undefined : asString(body.resourceGroup),
      targetResourceId:
        body.targetResourceId === undefined ? undefined : asString(body.targetResourceId),
      rdpUsername: body.rdpUsername === undefined ? undefined : asString(body.rdpUsername),
      rdpPassword: body.rdpPassword === undefined ? undefined : asString(body.rdpPassword),
      clearRdpPassword: body.clearRdpPassword === undefined ? undefined : Boolean(body.clearRdpPassword),
      autoStartTunnel: body.autoStartTunnel === undefined ? undefined : Boolean(body.autoStartTunnel),
    });
    sendJson(res, 200, { profile });
    return;
  }

  if (method === 'DELETE' && pathname === '/api/bastion') {
    await app.resetBastion();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/bastion/tunnel/start') {
    await app.startBastionTunnel();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/bastion/tunnel/stop') {
    await app.stopBastionTunnel();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/bastion/tunnel/kill-owner') {
    await app.killBastionPortOwner();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/bastion/rdp') {
    sendJson(res, 200, await app.openRdp());
    return;
  }

  throw new AppError('接口不存在', 404);
}

function openEventStream(app: App, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = () => {
    if (res.writableEnded) return;
    res.write(`data: ${app.snapshotFrame()}\n\n`);
  };
  send();
  app.on('tick', send);
  const onClose = () => {
    app.off('tick', send);
  };
  req.on('close', onClose);
  res.on('close', onClose);
}

function serveStatic(webDist: string | null, pathname: string, res: http.ServerResponse): void {
  if (!webDist) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>TunnelDesk</title><body style="font-family:Segoe UI;background:#0b0f14;color:#e8eef6;display:grid;place-items:center;height:100vh;margin:0"><div><h1>TunnelDesk 控制台未构建</h1><p>请先运行 <code>npm run build:web</code>。</p></div></body>',
    );
    return;
  }

  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = path.resolve(webDist, relative);
  if (!candidate.startsWith(path.resolve(webDist))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    const ext = path.extname(candidate).toLowerCase();
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    };
    res.writeHead(200, headers);
    fs.createReadStream(candidate).pipe(res);
    return;
  }

  const index = path.join(webDist, 'index.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(index).pipe(res);
}

function isLocalRequest(req: http.IncomingMessage): boolean {
  const hostHeader = (req.headers.host ?? '').toLowerCase();
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function isTrustedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, scripts)
  try {
    const parsed = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AppError('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        reject(new AppError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}
