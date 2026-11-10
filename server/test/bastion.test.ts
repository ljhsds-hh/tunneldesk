import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { BASTION_LOCAL_PORT, BASTION_RESOURCE_PORT, buildTunnelArgs } from '../src/bastion/command.js';
import { scanPortOwner } from '../src/bastion/manager.js';
import { cipherToRdpHex, decryptPassword, encryptPassword } from '../src/bastion/dpapi.js';
import { bastionSecrets, maskSecrets, maskValue } from '../src/bastion/mask.js';
import { buildRdpFile } from '../src/bastion/rdp.js';
import { validateBastionInput } from '../src/bastion/validate.js';

const PROFILE = {
  name: 'bastion-demo',
  resourceGroup: 'rg-demo',
  targetResourceId:
    '/subscriptions/example-subscription/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm-demo',
};

describe('az tunnel command', () => {
  it('builds the exact argument array', () => {
    expect(buildTunnelArgs(PROFILE, BASTION_LOCAL_PORT, BASTION_RESOURCE_PORT)).toEqual([
      'network',
      'bastion',
      'tunnel',
      '--name',
      'bastion-demo',
      '--resource-group',
      'rg-demo',
      '--target-resource-id',
      PROFILE.targetResourceId,
      '--resource-port',
      '22',
      '--port',
      '50022',
    ]);
  });

  it('keeps the RDP resource port configurable', () => {
    expect(buildTunnelArgs(PROFILE, 51234, 3389)).toContain('3389');
    expect(buildTunnelArgs(PROFILE, 51234, 3389)).toContain('51234');
  });
});

describe('bastion input validation', () => {
  it('accepts a standard profile', () => {
    expect(validateBastionInput(PROFILE)).toEqual({ ...PROFILE, rdpUsername: '' });
  });

  it('rejects values that could inject extra az options', () => {
    expect(() => validateBastionInput({ ...PROFILE, name: '--help' })).toThrow();
    expect(() => validateBastionInput({ ...PROFILE, name: 'a b' })).toThrow();
    expect(() => validateBastionInput({ ...PROFILE, targetResourceId: 'vm-demo' })).toThrow();
  });

  it('rejects control characters in the RDP username', () => {
    expect(() => validateBastionInput({ ...PROFILE, rdpUsername: 'demo\r\nEvil' })).toThrow();
    expect(() => validateBastionInput({ ...PROFILE, rdpUsername: 'demo\u0000' })).toThrow();
  });
});

describe('secret masking', () => {
  it('lists the three values longest-first', () => {
    const secrets = bastionSecrets(PROFILE);
    expect(secrets[0]).toBe(PROFILE.targetResourceId);
    expect(secrets).toContain(PROFILE.name);
    expect(secrets).toContain(PROFILE.resourceGroup);
  });

  it('replaces every value in diagnostics', () => {
    const text = `az tunnel ${PROFILE.name} ${PROFILE.resourceGroup} ${PROFILE.targetResourceId} failed`;
    const masked = maskSecrets(text, PROFILE);
    expect(masked).not.toContain(PROFILE.name);
    expect(masked).not.toContain(PROFILE.resourceGroup);
    expect(masked).not.toContain(PROFILE.targetResourceId);
    expect(masked).toContain('***');
  });

  it('strips ANSI escape sequences', () => {
    expect(maskSecrets('\u001b[31merror\u001b[0m', null)).toBe('error');
  });

  it('masks short and long values for display', () => {
    expect(maskValue('short')).toBe('••••••');
    expect(maskValue('abcdefghijklmnop')).toBe('abcd…mnop');
  });
});

describe('rdp file generation', () => {
  const cipher = Buffer.from('fake-dpapi-blob').toString('base64');

  it('prefills the address, username and DPAPI password', () => {
    const content = buildRdpFile({ localPort: 51234, username: 'demo\\user', passwordCipher: cipher });
    expect(content).toContain('full address:s:127.0.0.1:51234');
    expect(content).toContain('username:s:demo\\user');
    expect(content).toContain(`password 51:b:${Buffer.from('fake-dpapi-blob').toString('hex')}`);
    expect(content).toContain('prompt for credentials:i:0');
  });

  it('asks Windows to prompt when no password is saved', () => {
    const content = buildRdpFile({ localPort: 51234, username: '' });
    expect(content).not.toContain('password 51:b:');
    expect(content).not.toContain('username:s:');
    expect(content).toContain('prompt for credentials:i:1');
  });

  it('rejects an invalid local port', () => {
    expect(() => buildRdpFile({ localPort: 0 })).toThrow();
  });

  it('rejects a username containing a line break', () => {
    expect(() => buildRdpFile({ localPort: 51234, username: 'demo\r\npassword 51:b:xx' })).toThrow();
  });

  it('rejects a malformed stored cipher', () => {
    expect(() => cipherToRdpHex('not base64 ***')).toThrow();
  });
});

describe.skipIf(process.platform !== 'win32')('DPAPI round-trip', () => {
  it('encrypts and decrypts a password with quotes and Chinese characters', async () => {
    const password = 'P@ss "中文" \'x\'';
    const cipher = await encryptPassword(password);
    expect(cipher).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(await decryptPassword(cipher)).toBe(password);
    // mstsc 的 password 51:b: 需要标准 DPAPI blob（固定头部），而不是任意密文。
    expect(cipherToRdpHex(cipher).startsWith('01000000d08c9ddf0115d1118c7a00c04fc297eb')).toBe(true);
  });
});

describe.skipIf(process.platform !== 'win32')('port owner detection', () => {
  it('reports the process listening on a port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    try {
      const owner = await scanPortOwner(address.port);
      expect(owner?.pid).toBe(process.pid);
      expect(owner?.name.toLowerCase()).toContain('node');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
