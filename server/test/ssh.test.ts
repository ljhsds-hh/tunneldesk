import { describe, expect, it } from 'vitest';
import { openSshPublicKey } from '../src/ssh/keys.js';
import { generateKeyPairSync } from 'node:crypto';
import { powershell } from '../src/ssh/client.js';

describe('ssh key encoding', () => {
  it('produces a parseable OpenSSH public key line', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const { publicKey, fingerprint } = openSshPublicKey(privateKey, 'tunneldesk@test');
    expect(publicKey.startsWith('ssh-rsa AAAA')).toBe(true);
    expect(publicKey.endsWith('tunneldesk@test')).toBe(true);
    expect(fingerprint.startsWith('SHA256:')).toBe(true);
  });
});

describe('powershell encoder', () => {
  it('wraps scripts in -EncodedCommand', () => {
    const command = powershell("Write-Output 'ok'");
    expect(command).toContain('-EncodedCommand');
    const encoded = command.split(' ').at(-1) ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("Write-Output 'ok'");
  });
});
