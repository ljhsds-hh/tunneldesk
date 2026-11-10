import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForwardManager } from '../src/forward/manager.js';
import { Logger } from '../src/util/logger.js';
import { findFreePort } from '../src/util/net.js';
import type { SshLink } from '../src/ssh/link.js';
import type { MappingConfig } from '../src/types.js';

/**
 * Verifies that the existing port-mapping core is a transparent byte pipe.
 * No real SSH is needed: a fake link hands each incoming local connection a
 * socket to a local echo server, exactly like ssh2's direct-tcpip channel.
 */
let echo: net.Server;
let echoPort = 0;
let forward: ForwardManager;
let localPort = 0;

beforeAll(async () => {
  echo = net.createServer((socket) => {
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', () => resolve()));
  echoPort = (echo.address() as net.AddressInfo).port;

  const link = {
    isOnline: () => true,
    openStream: async () => {
      const channel = net.connect(echoPort, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        channel.once('connect', () => resolve());
        channel.once('error', reject);
      });
      return channel;
    },
  } as unknown as SshLink;

  localPort = (await findFreePort(23000, '127.0.0.1')) as number;
  const mapping: MappingConfig = {
    id: 'map_transparency',
    name: 'transparency',
    hostId: 'host_test',
    bindAddress: '127.0.0.1',
    localPort,
    targetHost: '127.0.0.1',
    targetPort: echoPort,
    enabled: true,
    autoStart: true,
    syncFirewall: false,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  };
  forward = new ForwardManager(link, new Logger());
  await forward.sync([mapping]);
  expect(forward.runtimeFor(mapping.id).listening).toBe(true);
});

afterAll(async () => {
  await forward?.stopAll();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

/** Writes payload and resolves as soon as the same number of bytes echoed back. */
function roundTrip(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(localPort, '127.0.0.1');
    const chunks: Buffer[] = [];
    let received = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`round trip timeout after ${received}/${payload.length} bytes`));
    }, 15000);
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= payload.length) {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).subarray(0, payload.length));
        socket.destroy();
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('connect', () => socket.write(payload));
  });
}

describe('port mapping transparency', () => {
  it('echoes small payloads byte-for-byte', async () => {
    const payload = Buffer.from('TunnelDesk HTTP/WebDAV/TDS handshake probe\r\n', 'utf8');
    expect(await roundTrip(payload)).toEqual(payload);
  });

  it('echoes binary payloads including NUL bytes', async () => {
    const payload = Buffer.from([0, 1, 2, 255, 0, 128, 0, 13, 10, 0]);
    expect(await roundTrip(payload)).toEqual(payload);
  });

  it('preserves a 1 MiB payload (large pack / BLOB)', async () => {
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    expect(await roundTrip(payload)).toEqual(payload);
  });

  it('handles 10 concurrent connections independently', async () => {
    const payloads = Array.from({ length: 10 }, (_, i) =>
      Buffer.from(`connection-${i}-${'x'.repeat(2048)}`, 'utf8'),
    );
    const results = await Promise.all(payloads.map((p) => roundTrip(p)));
    results.forEach((result, i) => expect(result).toEqual(payloads[i]));
  });

  /**
   * Node's socket.pipe() cascades end(): a client that sends a FIN on its write
   * side immediately after writing and still expects a reply loses that reply
   * through any two-pipe proxy (reproducible with a plain net proxy too).
   * Real protocols (HTTP/WebDAV/TDS/MySQL/Git) keep the write side open until
   * the response arrives, which is covered by the round-trip cases above.
   * What must hold here is that the connection is recycled without leaking.
   */
  it('recycles the connection cleanly when the client half-closes', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(localPort, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.on('close', () => resolve());
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('half-close connection was not recycled'));
      });
      socket.on('connect', () => socket.end('half-close payload'));
    });
    expect(forward.runtimeFor('map_transparency').activeConnections).toBe(0);
  });

  it('keeps an idle long-lived connection usable (database session)', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(localPort, '127.0.0.1');
      const first = Buffer.from('first-batch');
      const second = Buffer.from('second-batch');
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('idle session timeout')), 10000);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length === first.length) {
          setTimeout(() => socket.write(second), 400);
        } else if (buffer.length === first.length + second.length) {
          clearTimeout(timer);
          expect(buffer).toEqual(Buffer.concat([first, second]));
          socket.destroy();
          resolve();
        }
      });
      socket.on('error', reject);
      socket.on('connect', () => socket.write(first));
    });
  });
});
