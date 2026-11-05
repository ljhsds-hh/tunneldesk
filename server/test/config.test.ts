import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-test-'));
process.env.TUNNELDESK_DATA_DIR = sandbox;

const { ConfigStore, configPath } = await import('../src/config/store.js');

describe('ConfigStore', () => {
  beforeAll(() => {
    fs.rmSync(path.join(sandbox, 'TunnelDesk'), { recursive: true, force: true });
  });

  it('starts from defaults when no file exists', async () => {
    const store = new ConfigStore();
    const config = await store.load();
    expect(config.hosts).toEqual([]);
    expect(config.proxy.port).toBe(8888);
    expect(config.proxy.routingMode).toBe('all');
    expect(config.proxy.whitelist).toEqual([]);
  });

  it('persists updates atomically and reloads them', async () => {
    const store = new ConfigStore();
    await store.load();
    await store.update((draft) => {
      draft.proxy.port = 8899;
      draft.mappings.push({
        id: 'map_test',
        name: '测试映射',
        hostId: 'host_test',
        bindAddress: '127.0.0.1',
        localPort: 13389,
        targetHost: '127.0.0.1',
        targetPort: 3389,
        enabled: true,
        autoStart: true,
        syncFirewall: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });
    expect(fs.existsSync(configPath())).toBe(true);
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { proxy: { port: number } };
    expect(raw.proxy.port).toBe(8899);

    const reloaded = new ConfigStore();
    const config = await reloaded.load();
    expect(config.mappings).toHaveLength(1);
    expect(config.mappings[0]?.name).toBe('测试映射');
  });

  it('sanitises PAC routing settings when reloading', async () => {
    const store = new ConfigStore();
    await store.load();
    await store.update((draft) => {
      draft.proxy.routingMode = 'whitelist';
      draft.proxy.whitelist = ['10.1.2.3', 'bad-host', '10.1.2.3'];
    });

    const reloaded = new ConfigStore();
    const config = await reloaded.load();
    expect(config.proxy.routingMode).toBe('whitelist');
    expect(config.proxy.whitelist).toEqual(['10.1.2.3']);
  });
});
