import { describe, expect, it, vi } from 'vitest';
import { isBLocalTarget, isValidHostname } from '../src/util/net.js';
import { FirewallManager, firewallEligible, ruleNameFor } from '../src/firewall/manager.js';
import { Logger } from '../src/util/logger.js';
import type { SshLink } from '../src/ssh/link.js';
import type { MappingConfig } from '../src/types.js';

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
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

/** Decodes the -EncodedCommand payload so the fake SSH link can branch on script content. */
function decode(command: string): string {
  const encoded = command.split(' ').pop() ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

function makeManager(existingRules: string[] = []) {
  const scripts: string[] = [];
  const link = {
    isOnline: () => true,
    exec: async (command: string) => {
      const script = decode(command);
      scripts.push(script);
      if (script.includes('Get-NetFirewallRule')) {
        return { code: 0, stdout: existingRules.join('\r\n'), stderr: '' };
      }
      if (script.includes('New-NetFirewallRule')) {
        return { code: 0, stdout: 'RULE_OK\r\n', stderr: '' };
      }
      if (script.includes('Remove-NetFirewallRule')) {
        return { code: 0, stdout: 'CLEANED\r\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  } as unknown as SshLink;
  return { manager: new FirewallManager(link, new Logger()), scripts };
}

describe('isBLocalTarget', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['LOCALHOST', true],
    ['  LocalHost  ', true],
    ['127.0.0.2', false],
    ['192.168.1.10', false],
    ['10.0.0.8', false],
    ['db.corp.local', false],
    ['WIN-BASTION', false],
    ['::2', false],
    ['', false],
  ])('%s -> %s', (value, expected) => {
    expect(isBLocalTarget(value)).toBe(expected);
  });
});

describe('isValidHostname IPv6 loopback', () => {
  it('accepts ::1 and still rejects other IPv6 literals', () => {
    expect(isValidHostname('::1')).toBe(true);
    expect(isValidHostname('localhost')).toBe(true);
    expect(isValidHostname('::2')).toBe(false);
    expect(isValidHostname('2001:db8::1')).toBe(false);
  });
});

describe('firewallEligible', () => {
  it('requires enabled, syncFirewall and a B-local target', () => {
    expect(firewallEligible(makeMapping())).toBe(true);
    expect(firewallEligible(makeMapping({ enabled: false }))).toBe(false);
    expect(firewallEligible(makeMapping({ syncFirewall: false }))).toBe(false);
    expect(firewallEligible(makeMapping({ targetHost: '192.168.1.10' }))).toBe(false);
    expect(firewallEligible(makeMapping({ targetHost: 'LOCALHOST' }))).toBe(true);
  });

  it('produces the desired set used by App.syncFirewall()', () => {
    const mappings = [
      makeMapping({ id: 'map_b', targetHost: '127.0.0.1' }),
      makeMapping({ id: 'map_third', targetHost: 'db.corp.local' }),
      makeMapping({ id: 'map_off', enabled: false }),
      makeMapping({ id: 'map_optout', syncFirewall: false }),
    ];
    expect(mappings.filter(firewallEligible).map((m) => m.id)).toEqual(['map_b']);
  });
});

describe('FirewallManager.applyMapping hard guard', () => {
  it('does not issue any PowerShell for a third-party target', async () => {
    const { manager, scripts } = makeManager();
    const ok = await manager.applyMapping(makeMapping({ targetHost: '192.168.1.10' }));
    expect(ok).toBe(true);
    expect(scripts).toHaveLength(0);
  });

  it('does not issue any PowerShell when syncFirewall is off', async () => {
    const { manager, scripts } = makeManager();
    await manager.applyMapping(makeMapping({ syncFirewall: false }));
    expect(scripts).toHaveLength(0);
  });

  it('still creates inbound and outbound TCP rules for a B-local target', async () => {
    const { manager, scripts } = makeManager();
    const ok = await manager.applyMapping(makeMapping());
    expect(ok).toBe(true);
    const created = scripts.find((s) => s.includes('New-NetFirewallRule')) ?? '';
    expect(created).toContain('Direction Inbound');
    expect(created).toContain('Direction Outbound');
    expect(created).toContain('Protocol TCP');
    expect(created).toContain(ruleNameFor('map_test'));
  });
});

describe('FirewallManager.sync reconciliation', () => {
  it('treats a rule for a non-eligible mapping as an orphan and removes it', async () => {
    const { manager, scripts } = makeManager([
      'TunnelDesk-map_third|Inbound|True',
      'TunnelDesk-map_third|Outbound|True',
      'Allow-RDP|Inbound|True',
    ]);
    const result = await manager.sync([]);
    expect(result.removed).toBe(1);
    const cleanup = scripts.find((s) => s.includes('Remove-NetFirewallRule')) ?? '';
    expect(cleanup).toContain(ruleNameFor('map_third'));
    expect(cleanup).not.toContain('Allow-RDP');
  });

  it('creates missing rules for eligible desired entries only', async () => {
    const { manager, scripts } = makeManager();
    const result = await manager.sync([{ mappingId: 'map_b', port: 3389, targetHost: '127.0.0.1' }]);
    expect(result.added).toBe(1);
    expect(scripts.some((s) => s.includes('New-NetFirewallRule'))).toBe(true);
  });
});

describe('App.syncFirewall serialization', () => {
  it('never runs two reconciliations concurrently', async () => {
    const { App } = await import('../src/app.js');
    const app = new App();
    vi.spyOn(app.link, 'isOnline').mockReturnValue(true);
    let active = 0;
    let peak = 0;
    vi.spyOn(app.firewall, 'sync').mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { added: 0, removed: 0 };
    });
    await Promise.all([app.syncFirewall(), app.syncFirewall(), app.syncFirewall()]);
    expect(peak).toBe(1);
  });

  it('serializes every B-side firewall command through the same chain', async () => {
    const { App } = await import('../src/app.js');
    const app = new App();
    const queue = app as unknown as {
      enqueueFirewall: (fn: () => Promise<number>) => Promise<number>;
    };
    let active = 0;
    let peak = 0;
    const gate = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return 0;
    };
    await Promise.all([
      queue.enqueueFirewall(gate),
      queue.enqueueFirewall(gate),
      queue.enqueueFirewall(gate),
    ]);
    expect(peak).toBe(1);
  });
});
