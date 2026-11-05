import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { MappingConfig, MappingRuntime } from '../types.js';
import { Logger } from '../util/logger.js';
import { SshLink } from '../ssh/link.js';

interface ServerEntry {
  mapping: MappingConfig;
  server: net.Server;
  sockets: Set<net.Socket>;
}

function emptyRuntime(): MappingRuntime {
  return {
    listening: false,
    activeConnections: 0,
    totalConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
    rateIn: 0,
    rateOut: 0,
    lastError: null,
  };
}

/**
 * Owns local listeners for the "port mapping" business.
 * Listeners stay bound while the tunnel is down so clients get an immediate
 * connection reset instead of a port that appears and disappears.
 */
export class ForwardManager extends EventEmitter {
  private entries = new Map<string, ServerEntry>();
  private stats = new Map<string, MappingRuntime>();
  private chain: Promise<void> = Promise.resolve();
  private lastMappings: MappingConfig[] = [];

  constructor(
    private readonly link: SshLink,
    private readonly logger: Logger,
  ) {
    super();
  }

  runtimeFor(mappingId: string): MappingRuntime {
    let runtime = this.stats.get(mappingId);
    if (!runtime) {
      runtime = emptyRuntime();
      this.stats.set(mappingId, runtime);
    }
    return runtime;
  }

  /** Serializes sync operations so quick config changes cannot race. */
  sync(mappings: MappingConfig[]): Promise<void> {
    this.lastMappings = mappings;
    this.chain = this.chain.then(() => this.apply(mappings)).catch((error: Error) => {
      this.logger.error('forward', `同步监听失败：${error.message}`);
    });
    return this.chain;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
    this.entries.clear();
  }

  private async apply(mappings: MappingConfig[]): Promise<void> {
    const desired = new Map(
      mappings.filter((mapping) => mapping.enabled).map((mapping) => [mapping.id, mapping]),
    );

    for (const [id, entry] of [...this.entries]) {
      const next = desired.get(id);
      if (!next) {
        await this.closeEntry(entry);
        this.entries.delete(id);
        continue;
      }
      if (
        next.bindAddress !== entry.mapping.bindAddress ||
        next.localPort !== entry.mapping.localPort
      ) {
        await this.closeEntry(entry);
        this.entries.delete(id);
        continue;
      }
      entry.mapping = next;
    }

    for (const [id, mapping] of desired) {
      if (this.entries.has(id)) continue;
      const entry = await this.openEntry(mapping);
      if (entry) this.entries.set(id, entry);
    }
  }

  private async openEntry(mapping: MappingConfig): Promise<ServerEntry | null> {
    const runtime = this.runtimeFor(mapping.id);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => this.handleConnection(mapping, runtime, sockets, socket));
    server.on('error', (error: NodeJS.ErrnoException) => {
      runtime.listening = false;
      runtime.lastError =
        error.code === 'EADDRINUSE'
          ? `本地端口 ${mapping.localPort} 已被占用`
          : error.message;
      this.logger.error(
        'forward',
        `监听 ${mapping.bindAddress}:${mapping.localPort} 失败：${runtime.lastError}`,
      );
      this.emit('change');
    });

    const entry: ServerEntry = { mapping, server, sockets };

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: mapping.bindAddress, port: mapping.localPort, exclusive: true });
      });
      runtime.listening = true;
      runtime.lastError = null;
      this.logger.info(
        'forward',
        `映射已就绪 ${mapping.bindAddress}:${mapping.localPort} → ${mapping.targetHost}:${mapping.targetPort}`,
      );
      return entry;
    } catch (error) {
      runtime.listening = false;
      runtime.lastError = (error as Error).message;
      server.close();
      return null;
    }
  }

  private handleConnection(
    mapping: MappingConfig,
    runtime: MappingRuntime,
    sockets: Set<net.Socket>,
    socket: net.Socket,
  ): void {
    socket.setNoDelay(true);
    runtime.totalConnections += 1;

    if (!this.link.isOnline()) {
      runtime.lastError = '隧道离线，连接被拒绝';
      socket.destroy();
      return;
    }

    sockets.add(socket);
    runtime.activeConnections += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      runtime.activeConnections = Math.max(0, runtime.activeConnections - 1);
      sockets.delete(socket);
    };

    socket.on('error', () => undefined);
    socket.on('close', finish);

    this.link
      .openStream(mapping.targetHost, mapping.targetPort)
      .then((channel) => {
        socket.on('data', (chunk: Buffer) => {
          runtime.bytesIn += chunk.length;
        });
        channel.on('data', (chunk: Buffer) => {
          runtime.bytesOut += chunk.length;
        });
        socket.pipe(channel);
        channel.pipe(socket);
        channel.on('error', () => socket.destroy());
        channel.on('close', () => socket.destroy());
        socket.on('close', () => {
          channel.destroy();
          finish();
        });
      })
      .catch((error: Error) => {
        runtime.lastError = error.message;
        finish();
        socket.destroy();
        this.logger.warn('forward', `映射 ${mapping.name} 转发失败：${error.message}`);
      });
  }

  private async closeEntry(entry: ServerEntry): Promise<void> {
    for (const socket of entry.sockets) socket.destroy();
    entry.sockets.clear();
    const runtime = this.runtimeFor(entry.mapping.id);
    runtime.listening = false;
    runtime.activeConnections = 0;
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
      setTimeout(resolve, 1500).unref();
    });
  }

  /** Rebind everything, e.g. after settings changes. */
  rebind(): Promise<void> {
    return this.sync(this.lastMappings);
  }
}
