import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FirewallManager,
  buildRuleRemovalScript,
  buildRuleScript,
  ruleNameFor,
} from '../src/firewall/manager.js';
import { describeMappingChanges, describeProxyChanges } from '../src/app.js';
import { Logger } from '../src/util/logger.js';
import { APP_VERSION } from '../src/version.js';
import type { SshLink } from '../src/ssh/link.js';
import type { HostConfig, MappingConfig, ProxySettings } from '../src/types.js';

/** Decodes the -EncodedCommand payload so the fake link can branch on content. */
function decode(command: string): string {
  const encoded = command.split(' ').pop() ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

function ruleLine(name: string, direction: 'Inbound' | 'Outbound', port: number, enabled = true): string {
  return `${name}|${direction}|${enabled ? 'True' : 'False'}|TCP|${port}`;
}

/**
 * Fake B side: answers Get-NetFirewallRule with the given rules, and answers a
 * creation script with one marker per rule it asked for, minus `failNames`.
 */
function makeLink(
  rules: string[] = [],
  failNames: string[] = [],
  applyStdout?: (names: string[]) => string,
) {
  const scripts: string[] = [];
  const link = {
    isOnline: () => true,
    exec: async (command: string) => {
      const script = decode(command);
      scripts.push(script);
      if (script.includes('Get-NetFirewallRule')) {
        return { code: 0, stdout: rules.join('\r\n'), stderr: '' };
      }
      if (script.includes('New-NetFirewallRule')) {
        const names = [...script.matchAll(/Write-Output 'OK\|([^']+)'/g)].map((match) => match[1] ?? '');
        if (applyStdout) return { code: 0, stdout: applyStdout(names), stderr: '' };
        const stdout = names
          .map((name) => (failNames.includes(name) ? `ERR|${name}|Access is denied` : `OK|${name}`))
          .join('\r\n');
        return { code: 0, stdout, stderr: '' };
      }
      return { code: 0, stdout: 'CLEANED', stderr: '' };
    },
  } as unknown as SshLink;
  return { link, scripts };
}

function makeMapping(overrides: Partial<MappingConfig> = {}): MappingConfig {
  return {
    id: 'map_test',
    name: 'test',
    hostId: 'host_1',
    bindAddress: '127.0.0.1',
    localPort: 13389,
    targetHost: '127.0.0.1',
    targetPort: 3389,
    enabled: true,
    autoStart: true,
    syncFirewall: true,
    group: '',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildRuleScript', () => {
  it('emits one program for many rules with per-rule outcome markers', () => {
    const script = buildRuleScript([
      { mappingId: 'map_a', port: 3389 },
      { mappingId: 'map_b', port: 5432 },
    ]);
    expect(script.match(/New-NetFirewallRule/g)).toHaveLength(4);
    expect(script).toContain("Write-Output 'OK|TunnelDesk-map_a'");
    expect(script).toContain("Write-Output ('ERR|TunnelDesk-map_b|'");
    expect(script).toContain('-LocalPort 5432');
    expect(script).toContain("$ErrorActionPreference = 'Continue'");
  });

  it('isolates each rule in its own try/catch so one failure cannot hide the rest', () => {
    const script = buildRuleScript([
      { mappingId: 'map_a', port: 3389 },
      { mappingId: 'map_b', port: 5432 },
    ]);
    expect(script.match(/try \{/g)).toHaveLength(2);
    expect(script.match(/catch \{/g)).toHaveLength(2);
  });

  it('escapes a single quote in the rule name instead of breaking the whole batch', () => {
    const script = buildRuleScript([{ mappingId: "map'_x", port: 1 }]);
    expect(script).toContain("'TunnelDesk-map''_x'");
    expect(script).not.toContain("'TunnelDesk-map'_x'");
  });
});

describe('buildRuleRemovalScript', () => {
  it('only ever targets TunnelDesk-prefixed display names', () => {
    expect(buildRuleRemovalScript(['map_a'])).toBe(
      `Remove-NetFirewallRule -DisplayName '${ruleNameFor('map_a')}' -ErrorAction SilentlyContinue`,
    );
    const two = buildRuleRemovalScript(['map_a', 'map_b']);
    expect(two).toContain(ruleNameFor('map_a'));
    expect(two).toContain(ruleNameFor('map_b'));
    expect(two).not.toContain('Allow-RDP');
  });
});

describe('FirewallManager.sync batching', () => {
  it('pushes the group filter into Get-NetFirewallRule', async () => {
    const { link, scripts } = makeLink();
    const manager = new FirewallManager(link, new Logger({ mirrorToConsole: false }));
    await manager.sync([]);
    const list = scripts.find((script) => script.includes('Get-NetFirewallRule')) ?? '';
    expect(list).toContain("-Group 'TunnelDesk'");
    expect(list).not.toContain('Where-Object');
  });

  it('creates N missing rules with a single PowerShell program', async () => {
    const { link, scripts } = makeLink();
    const manager = new FirewallManager(link, new Logger({ mirrorToConsole: false }));
    const result = await manager.sync([
      { mappingId: 'map_a', port: 3389, targetHost: '127.0.0.1', sync: true },
      { mappingId: 'map_b', port: 5432, targetHost: '127.0.0.1', sync: true },
      { mappingId: 'map_c', port: 1433, targetHost: '127.0.0.1', sync: true },
    ]);
    expect(result.added).toBe(3);
    expect(scripts.filter((script) => script.includes('New-NetFirewallRule'))).toHaveLength(1);
    expect(manager.lastError).toBeNull();
  });

  it('counts only the rules that actually succeeded and records the failure', async () => {
    const { link } = makeLink([], [ruleNameFor('map_b')]);
    const manager = new FirewallManager(link, new Logger({ mirrorToConsole: false }));
    const result = await manager.sync([
      { mappingId: 'map_a', port: 3389, targetHost: '127.0.0.1', sync: true },
      { mappingId: 'map_b', port: 5432, targetHost: '127.0.0.1', sync: true },
    ]);
    expect(result.added).toBe(1);
    expect(manager.lastError).toContain('map_b');
    expect(manager.lastError).toContain('denied');
    expect(manager.privilege).not.toBe('elevated');
  });

  it('does not recreate rules that are already current', async () => {
    const { link, scripts } = makeLink([
      ruleLine(ruleNameFor('map_a'), 'Inbound', 3389),
      ruleLine(ruleNameFor('map_a'), 'Outbound', 3389),
    ]);
    const manager = new FirewallManager(link, new Logger({ mirrorToConsole: false }));
    const result = await manager.sync([
      { mappingId: 'map_a', port: 3389, targetHost: '127.0.0.1', sync: true },
    ]);
    expect(result).toEqual({ added: 0, removed: 0 });
    expect(scripts.some((script) => script.includes('New-NetFirewallRule'))).toBe(false);
  });

  it('logs one aggregate success line instead of one per rule', async () => {
    const { link } = makeLink();
    const logger = new Logger({ mirrorToConsole: false });
    const manager = new FirewallManager(link, logger);
    await manager.sync([
      { mappingId: 'map_a', port: 3389, targetHost: '127.0.0.1', sync: true },
      { mappingId: 'map_b', port: 5432, targetHost: '127.0.0.1', sync: true },
    ]);
    const firewallLines = logger.list().filter((entry) => entry.scope === 'firewall');
    expect(firewallLines).toHaveLength(1);
    expect(firewallLines[0]?.message).toContain('已放行 2 条');
  });

  it('treats a silent batch response as a failure instead of "nothing to do"', async () => {
    const { link } = makeLink([], [], () => '');
    const manager = new FirewallManager(link, new Logger({ mirrorToConsole: false }));
    const result = await manager.sync([
      { mappingId: 'map_a', port: 3389, targetHost: '127.0.0.1', sync: true },
    ]);
    expect(result.added).toBe(0);
    expect(manager.lastError).toContain('未返回规则执行结果');
  });
});

describe('Logger file sink', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-log-'));
    created.push(dir);
    return dir;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  it('stays memory-only when no directory is configured', () => {
    const logger = new Logger({ mirrorToConsole: false });
    logger.info('test', 'hello');
    expect(logger.directory()).toBeNull();
    expect(logger.list()).toHaveLength(1);
  });

  it('appends redacted lines to a daily file', async () => {
    const dir = tempDir();
    const logger = new Logger({ fileDir: dir, mirrorToConsole: false });
    logger.info('test', 'connecting with password=super-secret');
    logger.error('test', 'boom');
    logger.close();
    await settle();

    expect(logger.directory()).toBe(dir);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^tunneldesk-\d{4}-\d{2}-\d{2}\.log$/);
    const content = fs.readFileSync(path.join(dir, files[0] as string), 'utf8');
    expect(content).toContain('INFO');
    expect(content).toContain('ERROR');
    expect(content).toContain('[redacted]');
    expect(content).not.toContain('super-secret');
  });

  it('prunes daily files beyond the retention window', async () => {
    const dir = tempDir();
    for (const day of ['2020-01-01', '2020-01-02', '2020-01-03']) {
      fs.writeFileSync(path.join(dir, `tunneldesk-${day}.log`), 'old\n');
    }
    const logger = new Logger({ fileDir: dir, fileRetentionDays: 2, mirrorToConsole: false });
    logger.info('test', 'rotate');
    logger.close();
    await settle();

    const names = fs.readdirSync(dir);
    expect(names).not.toContain('tunneldesk-2020-01-01.log');
    expect(names).toContain('tunneldesk-2020-01-02.log');
    expect(names).toContain('tunneldesk-2020-01-03.log');
  });
});

describe('version source of truth', () => {
  it('matches the repository root package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });
});

describe('audit helpers', () => {
  it('describes mapping changes in the order a user made them', () => {
    const before = makeMapping();
    const after = makeMapping({ name: 'RDP', enabled: false, group: '远程桌面', localPort: 23389 });
    expect(describeMappingChanges(before, after)).toEqual([
      '名称「test」→「RDP」',
      '已停用监听',
      '本地监听 127.0.0.1:13389 → 127.0.0.1:23389',
      '分组「未分组」→「远程桌面」',
    ]);
  });

  it('reports no changes for an identical mapping', () => {
    expect(describeMappingChanges(makeMapping(), makeMapping())).toEqual([]);
  });

  it('describes proxy changes', () => {
    const base: ProxySettings = {
      enabled: false,
      bindAddress: '127.0.0.1',
      port: 8888,
      allowLan: false,
      logLimit: 200,
      routingMode: 'all',
      whitelist: [],
    };
    expect(describeProxyChanges(base, { ...base, enabled: true, port: 8899 })).toEqual([
      '已启用',
      '端口 8888 → 8899',
    ]);
  });
});

describe('App.removeHost firewall cleanup', () => {
  it('cleans the rules of a non-active host instead of leaking them', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-data-'));
    process.env.TUNNELDESK_DATA_DIR = dataDir;
    const { App } = await import('../src/app.js');
    const app = new App();

    const hostA = { id: 'host_a', name: 'A', host: '10.0.0.1', port: 22, username: 'u' } as HostConfig;
    const hostB = { id: 'host_b', name: 'B', host: '10.0.0.2', port: 22, username: 'u' } as HostConfig;
    await app.store.update((draft) => {
      draft.hosts = [hostA, hostB];
      draft.activeHostId = 'host_a';
      draft.mappings = [
        makeMapping({ id: 'map_b1', hostId: 'host_b', enabled: false, localPort: 45001 }),
        makeMapping({ id: 'map_b2', hostId: 'host_b', enabled: false, localPort: 45002 }),
      ];
    });

    const purge = vi
      .spyOn(app as unknown as { purgeRules: (...args: unknown[]) => Promise<number> }, 'purgeRules')
      .mockResolvedValue(2);

    const result = await app.removeHost('host_b');
    expect(purge).toHaveBeenCalledWith(expect.objectContaining({ id: 'host_b' }), ['map_b1', 'map_b2'], false);
    expect(result).toEqual({ mappingsRemoved: 2, rulesCleaned: 2, cleanupNote: null });
    expect(app.store.get().hosts.map((host) => host.id)).toEqual(['host_a']);
    expect(app.store.get().mappings).toHaveLength(0);

    await app.shutdown();
    delete process.env.TUNNELDESK_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the host removal even when rule cleanup fails, and reports it', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-data-'));
    process.env.TUNNELDESK_DATA_DIR = dataDir;
    const { App } = await import('../src/app.js');
    const app = new App();

    await app.store.update((draft) => {
      draft.hosts = [{ id: 'host_a', name: 'A', host: '10.0.0.1', port: 22, username: 'u' } as HostConfig];
      draft.activeHostId = 'host_a';
      draft.mappings = [makeMapping({ id: 'map_a1', hostId: 'host_a', enabled: false, localPort: 45003 })];
    });

    vi.spyOn(
      app as unknown as { purgeRules: (...args: unknown[]) => Promise<number> },
      'purgeRules',
    ).mockRejectedValue(new Error('SSH 连接超时'));

    const result = await app.removeHost('host_a');
    expect(result.mappingsRemoved).toBe(1);
    expect(result.rulesCleaned).toBe(0);
    expect(result.cleanupNote).toContain('SSH 连接超时');
    expect(app.store.get().hosts).toHaveLength(0);

    await app.shutdown();
    delete process.env.TUNNELDESK_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('App.updateMapping audit trail', () => {
  it('logs a field-level diff even though ConfigStore mutates in place', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-data-'));
    process.env.TUNNELDESK_DATA_DIR = dataDir;
    const { App } = await import('../src/app.js');
    const app = new App();

    await app.store.update((draft) => {
      draft.hosts = [
        { id: 'host_a', name: 'A', host: '10.0.0.1', port: 22, username: 'u' } as HostConfig,
      ];
      draft.activeHostId = 'host_a';
      draft.mappings = [makeMapping({ id: 'map_x', hostId: 'host_a', enabled: false, localPort: 45010 })];
    });

    await app.updateMapping('map_x', { name: '数据库', group: '数据', targetPort: 1433 });
    const line = app.logger
      .list()
      .map((entry) => entry.message)
      .find((message) => message.includes('已更新映射'));
    expect(line).toBeDefined();
    expect(line).toContain('名称「test」→「数据库」');
    expect(line).toContain('B 侧目标 127.0.0.1:3389 → 127.0.0.1:1433');
    expect(line).toContain('分组「未分组」→「数据」');

    // A no-op save must not spam the log.
    const before = app.logger.list().length;
    await app.updateMapping('map_x', { name: '数据库' });
    expect(app.logger.list().length).toBe(before);

    await app.shutdown();
    delete process.env.TUNNELDESK_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('App.snapshotFrame', () => {
  it('reuses the serialized body for clients arriving in the same window', async () => {
    const { App } = await import('../src/app.js');
    const app = new App();
    const first = app.snapshotFrame();
    const second = app.snapshotFrame();
    expect(second).toBe(first);
    expect(JSON.parse(first).version).toBe(APP_VERSION);
  });
});
