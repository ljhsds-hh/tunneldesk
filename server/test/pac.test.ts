import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { buildPacScript } from '../src/proxy/pac.js';
import { defaultConfig, normalizeWhitelist, sanitizeProxy } from '../src/config/store.js';

const base = defaultConfig().proxy;

describe('PAC generation', () => {
  it('returns PROXY for every host in all mode', () => {
    const pac = buildPacScript({ ...base, routingMode: 'all', port: 8888 });
    expect(pac).toContain('var TD_PROXY = "PROXY 127.0.0.1:8888";');
    expect(pac).toContain('return TD_PROXY;');
    expect(pac).not.toContain('TD_WHITELIST');
  });

  it('returns PROXY only for exact whitelist IPv4 addresses', () => {
    const pac = buildPacScript({
      ...base,
      routingMode: 'whitelist',
      port: 8899,
      whitelist: ['10.1.2.3', '192.168.1.50'],
    });
    expect(pac).toContain('var TD_PROXY = "PROXY 127.0.0.1:8899";');
    expect(pac).toContain('"10.1.2.3": true');
    expect(pac).toContain('"192.168.1.50": true');
    expect(pac).toContain('Object.prototype.hasOwnProperty.call(TD_WHITELIST, key)');
    expect(pac).toContain('return "DIRECT";');
  });

  it('does not treat object prototype keys as whitelist matches', () => {
    const pac = buildPacScript({ ...base, routingMode: 'whitelist', whitelist: ['10.1.2.3'] });
    const context: { FindProxyForURL?: (url: string, host: string) => string } = {};
    vm.createContext(context);
    vm.runInContext(pac, context);
    const find = context.FindProxyForURL;
    if (!find) throw new Error('PAC did not define FindProxyForURL');
    expect(find('http://10.1.2.3/', '10.1.2.3')).toBe('PROXY 127.0.0.1:8888');
    expect(find('http://__proto__/', '__proto__')).toBe('DIRECT');
    expect(find('http://constructor/', 'constructor')).toBe('DIRECT');
  });

  it('produces valid script with an empty whitelist', () => {
    const pac = buildPacScript({ ...base, routingMode: 'whitelist', whitelist: [] });
    expect(pac).toContain('var TD_WHITELIST = {\n};');
    expect(pac).toContain('return "DIRECT";');
  });
});

describe('whitelist normalisation', () => {
  it('accepts newline, comma and whitespace separated input', () => {
    expect(normalizeWhitelist('10.1.2.3\n10.1.2.4, 10.1.2.5；10.1.2.3')).toEqual([
      '10.1.2.3',
      '10.1.2.4',
      '10.1.2.5',
    ]);
  });

  it('drops domains, CIDR ranges, ports and malformed values', () => {
    expect(
      normalizeWhitelist(['wiki.corp.local', '10.1.2.0/24', '10.1.2.3:8080', '999.1.1.1', '10.1.2.3']),
    ).toEqual(['10.1.2.3']);
  });

  it('persists routing mode and whitelist through sanitiseProxy', () => {
    const next = sanitizeProxy(
      { routingMode: 'whitelist', whitelist: ['10.1.2.3', 'bad', '10.1.2.3'] },
      base,
    );
    expect(next.routingMode).toBe('whitelist');
    expect(next.whitelist).toEqual(['10.1.2.3']);
  });
});
