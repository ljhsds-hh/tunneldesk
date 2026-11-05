import { describe, expect, it } from 'vitest';
import { splitHostPort } from '../src/proxy/httpProxy.js';
import { ruleNameFor, mappingIdFromRuleName } from '../src/firewall/manager.js';
import { clampPort, sanitizeProxy, defaultConfig } from '../src/config/store.js';
import { cleanPowerShellError, powershell } from '../src/ssh/client.js';

describe('splitHostPort', () => {
  it('parses host:port', () => {
    expect(splitHostPort('example.local:8080', 80)).toEqual({ host: 'example.local', port: 8080 });
  });

  it('falls back to the default port', () => {
    expect(splitHostPort('intranet.local', 443)).toEqual({ host: 'intranet.local', port: 443 });
  });

  it('handles IPv6 literals', () => {
    expect(splitHostPort('[::1]:8443', 443)).toEqual({ host: '::1', port: 8443 });
  });

  it('keeps hostnames with dots intact', () => {
    expect(splitHostPort('a.b.c:1234', 80)).toEqual({ host: 'a.b.c', port: 1234 });
  });
});

describe('firewall rule naming', () => {
  it('round-trips a mapping id', () => {
    const name = ruleNameFor('map_abc123');
    expect(name).toBe('TunnelDesk-map_abc123');
    expect(mappingIdFromRuleName(name)).toBe('map_abc123');
  });

  it('ignores foreign rules', () => {
    expect(mappingIdFromRuleName('Allow-RDP')).toBeNull();
  });
});

describe('PowerShell output handling', () => {
  it('strips CLIXML progress noise from error text', () => {
    const raw = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" /></Objs>\r\n实际错误';
    expect(cleanPowerShellError(raw)).toBe('实际错误');
    expect(cleanPowerShellError('#< CLIXML\n<Objs></Objs>')).toBe('');
  });

  it('extracts real errors from CLIXML', () => {
    const raw =
      '#< CLIXML\r\n<Objs><S S="Error">拒绝访问。_x000D__x000A_</S><S S="Error">位置 行:1 字符:1</S></Objs>';
    expect(cleanPowerShellError(raw)).toContain('拒绝访问');
    expect(cleanPowerShellError(raw)).toContain('位置 行:1 字符:1');
    expect(cleanPowerShellError(raw)).not.toContain('<S S=');
  });

  it('suppresses progress records in remote commands', () => {
    const command = powershell('Write-Output 1');
    const encoded = command.split(' ').pop() as string;
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("$ProgressPreference = 'SilentlyContinue'");
  });
});

describe('config sanitising', () => {
  it('clamps invalid ports to the fallback', () => {
    expect(clampPort(0, 22)).toBe(22);
    expect(clampPort(70000, 22)).toBe(22);
    expect(clampPort(3389, 22)).toBe(3389);
  });

  it('forces localhost binding unless LAN access is enabled', () => {
    const current = defaultConfig().proxy;
    const updated = sanitizeProxy({ allowLan: false, bindAddress: '0.0.0.0' }, current);
    expect(updated.bindAddress).toBe('0.0.0.0');
    const lan = sanitizeProxy({ allowLan: true }, current);
    expect(lan.bindAddress).toBe('0.0.0.0');
  });
});
