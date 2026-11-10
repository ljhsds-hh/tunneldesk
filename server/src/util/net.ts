import net from 'node:net';

/** Returns true when the TCP port can be bound on the given address. */
export function isPortFree(port: number, address = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (free: boolean) => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(free));
    };
    server.once('error', () => done(false));
    server.listen({ port, host: address, exclusive: true }, () => done(true));
  });
}

/** Resolves true when a TCP connection to host:port succeeds within the timeout. */
export function probeTcp(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Finds the first free port at or above the preferred port (max 200 attempts). */
export async function findFreePort(preferred: number, address = '127.0.0.1'): Promise<number | null> {
  for (let offset = 0; offset < 200; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65535) break;
    if (await isPortFree(candidate, address)) return candidate;
  }
  return null;
}

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function isValidHostname(value: string): boolean {
  if (!value || value.length > 253) return false;
  if (value === 'localhost') return true;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  const hostname = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return hostname.test(value);
}
