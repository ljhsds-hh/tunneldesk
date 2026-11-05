/**
 * Development-only target service that stands in for an intranet HTTP server.
 * Usage: node tools/demo-target.mjs [--port 18080]
 */
import http from 'node:http';

const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 18080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Intranet Demo</title></head>
<body style="font-family:Segoe UI;background:#0b1220;color:#e8eef8;padding:48px">
<h1>Intranet Demo Service</h1>
<p>这个响应来自「电脑 B」所在的内网，路径：<code>${req.url}</code></p>
<p>如果你在 A 的浏览器里看到这段文字，说明 HTTP 代理链路是通的。</p>
</body></html>`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo-target] listening on http://127.0.0.1:${PORT}`);
});
