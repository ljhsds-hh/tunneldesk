import { spawn } from 'node:child_process';
import path from 'node:path';
import { App } from './app.js';
import { startConsoleServer } from './api/server.js';
import { APP_VERSION } from './version.js';

interface CliOptions {
  port: number;
  host: string;
  open: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { port: 19000, host: '127.0.0.1', open: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = Number(argv[++i]);
      if (Number.isInteger(value) && value > 0 && value < 65536) options.port = value;
    } else if (arg === '--open') {
      options.open = true;
    } else if (arg === '--host') {
      options.host = argv[++i] ?? options.host;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const app = new App();

await app.init();
const server = await startConsoleServer(app, { port: options.port, host: options.host });
const url = `http://127.0.0.1:${options.port}`;

app.logger.info('console', `TunnelDesk v${APP_VERSION} 控制台已启动：${url}`);
app.logger.info('config', `配置目录：${app.dataDir()}`);
app.logger.info('config', `运行日志：${path.join(app.dataDir(), 'logs')}`);

if (options.open) {
  openBrowser(url);
}

async function shutdown(signal: string): Promise<void> {
  app.logger.info('app', `收到 ${signal}，正在退出`);
  server.close();
  await app.shutdown().catch(() => undefined);
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => app.logger.error('process', error.stack ?? error.message));
process.on('unhandledRejection', (reason) => app.logger.error('process', String(reason)));

function openBrowser(target: string): void {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [target], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } catch {
    // Opening a browser is best-effort.
  }
}
