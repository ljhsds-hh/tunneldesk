import { describe, expect, it } from 'vitest';
import { buildProvisionScript } from '../src/ssh/provision.js';

describe('provision script', () => {
  const script = buildProvisionScript('ssh-rsa AAAA test@tunneldesk');

  it('rewrites authorized_keys without the PowerShell UTF-8 BOM', () => {
    expect(script).toContain('UTF8Encoding($false)');
    expect(script).toContain('[IO.File]::WriteAllText');
    expect(script).toContain('TrimStart([char]0xFEFF)');
    expect(script).not.toContain('Add-Content');
    expect(script).not.toContain('AppendAllText');
  });

  it('also handles administrators_authorized_keys', () => {
    expect(script).toContain('administrators_authorized_keys');
    expect(script).toContain('S-1-5-32-544');
    expect(script).toContain('S-1-5-18');
    expect(script).toContain('whoami /groups');
    expect(script).toContain('icacls failed');
  });

  it('embeds the public key as base64 without interpolating shell characters', () => {
    expect(script).toContain(Buffer.from('ssh-rsa AAAA test@tunneldesk', 'utf8').toString('base64'));
  });
});
