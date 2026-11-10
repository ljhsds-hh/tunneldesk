import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-bastion-test-'));
process.env.TUNNELDESK_DATA_DIR = sandbox;

const { ConfigStore, configPath } = await import('../src/config/store.js');

const TARGET =
  '/subscriptions/example-subscription/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm-demo';

function writeConfig(raw: unknown): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(raw, null, 2), 'utf8');
}

function legacyHost(id: string, connectionType?: string) {
  return {
    id,
    name: 'demo',
    connectionType,
    host: '20.0.0.10',
    port: 22,
    username: 'demo',
    keyPath: 'C:\\keys\\demo',
    keyComment: 'tunneldesk@demo',
    hostKeyFingerprint: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('bastion config migration', () => {
  beforeAll(() => {
    fs.rmSync(path.join(sandbox, 'TunnelDesk'), { recursive: true, force: true });
  });

  it('treats old hosts as ssh and defaults bastion to null', async () => {
    writeConfig({ version: 1, hosts: [legacyHost('host_old')] });
    const store = new ConfigStore();
    const config = await store.load();
    expect(config.version).toBe(2);
    expect(config.bastion).toBeNull();
    expect(config.hosts[0]?.connectionType).toBe('ssh');
  });

  it('forces azure-bastion hosts onto 127.0.0.1:50022', async () => {
    writeConfig({
      version: 1,
      hosts: [legacyHost('host_bastion', 'azure-bastion')],
    });
    const store = new ConfigStore();
    const config = await store.load();
    expect(config.hosts[0]?.connectionType).toBe('azure-bastion');
    expect(config.hosts[0]?.host).toBe('127.0.0.1');
    expect(config.hosts[0]?.port).toBe(50022);
  });

  it('loads a valid bastion profile without exposing the cipher', async () => {
    writeConfig({
      version: 2,
      bastion: {
        name: 'bastion-demo',
        resourceGroup: 'rg-demo',
        targetResourceId: TARGET,
        rdpUsername: 'demo',
        rdpPasswordCipher: 'ZmFrZQ==',
        autoStartTunnel: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const store = new ConfigStore();
    const config = await store.load();
    expect(config.bastion?.name).toBe('bastion-demo');
    expect(config.bastion?.autoStartTunnel).toBe(false);
    expect(config.bastion?.rdpPasswordCipher).toBe('ZmFrZQ==');
  });

  it('drops a tampered profile instead of feeding it to az', async () => {
    writeConfig({
      version: 2,
      bastion: {
        name: 'bastion-demo --help',
        resourceGroup: 'rg-demo',
        targetResourceId: TARGET,
      },
    });
    const store = new ConfigStore();
    const config = await store.load();
    expect(config.bastion).toBeNull();
  });
});
