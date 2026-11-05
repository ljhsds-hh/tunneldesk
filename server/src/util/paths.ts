import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const APP_NAME = 'TunnelDesk';

export function appDataDir(): string {
  const base =
    process.env.TUNNELDESK_DATA_DIR ??
    (process.platform === 'win32'
      ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));
  return path.join(base, APP_NAME);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function keysDir(): string {
  return path.join(appDataDir(), 'keys');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export const IS_WINDOWS = process.platform === 'win32';
