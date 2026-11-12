import type { Mapping } from './types';

type EndpointSource = Pick<Mapping, 'bindAddress' | 'localPort'>;

/**
 * Binds that are reachable through IPv4 loopback. `::` is a dual-stack
 * wildcard and is treated as such; `::1` is intentionally absent because a
 * service bound only to IPv6 loopback cannot be reached through 127.0.0.1.
 */
const LOOPBACK_BINDS = new Set(['', '0.0.0.0', '::', '127.0.0.1', 'localhost']);
const LOOPBACK_HOST = '127.0.0.1';
const WILDCARD_HOST = '0.0.0.0';

/** Formats host:port, bracketing IPv6 literals so the result is pasteable. */
function formatEndpoint(host: string, port: number): string {
  const value = host.trim() || WILDCARD_HOST;
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]:${port}`;
  return `${value}:${port}`;
}

/** The address column shows the real bind address, verbatim. */
export function displayEndpoint(mapping: EndpointSource): string {
  return formatEndpoint(mapping.bindAddress, mapping.localPort);
}

/** Copying a local bind collapses it to 127.0.0.1; other binds stay as-is. */
export function copyEndpoint(mapping: EndpointSource): string {
  const bind = mapping.bindAddress.trim();
  const host = LOOPBACK_BINDS.has(bind.toLowerCase()) ? LOOPBACK_HOST : bind;
  return formatEndpoint(host, mapping.localPort);
}
