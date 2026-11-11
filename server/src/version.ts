import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the displayed version: the repository root
 * `package.json`. Both `src/` (tsx) and `dist/` (tsc output) resolve to the same
 * file with `../../package.json`, so no build-time codegen is needed.
 *
 * Never hardcode the version in UI strings - import this constant instead so the
 * sidebar, the "about" panel and the outbound User-Agent cannot drift apart.
 */
function readVersion(): string {
  const candidates = ['../../package.json', '../package.json'];
  for (const relative of candidates) {
    try {
      const file = fileURLToPath(new URL(relative, import.meta.url));
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Try the next candidate; a missing package.json must not break startup.
    }
  }
  return '0.0.0';
}

export const APP_VERSION = readVersion();
