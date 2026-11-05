import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { findFreePort, isPortFree } from '../src/util/net.js';

const opened: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('port helpers', () => {
  it('detects a free port', async () => {
    expect(await isPortFree(0, '127.0.0.1')).toBe(true);
  });

  it('detects an occupied port', async () => {
    const server = net.createServer();
    opened.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    expect(await isPortFree(address.port, '127.0.0.1')).toBe(false);
  });

  it('finds the next free port', async () => {
    const server = net.createServer();
    opened.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const free = await findFreePort(address.port + 1);
    expect(free).toBe(address.port + 1);
  });
});
