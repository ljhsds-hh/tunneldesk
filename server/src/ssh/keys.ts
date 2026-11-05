import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../util/paths.js';

export interface GeneratedKeyPair {
  privateKeyPath: string;
  publicKey: string;
  fingerprint: string;
}

function sshString(value: Buffer | string): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buf.length, 0);
  return Buffer.concat([length, buf]);
}

function sshMpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length && value[start] === 0) start += 1;
  let body = value.subarray(start);
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0] ?? 0) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return sshString(body);
}

/** Builds an OpenSSH `ssh-rsa AAAA...` public key line from an RSA key. */
export function openSshPublicKey(privateKeyPem: string, comment: string): { publicKey: string; fingerprint: string } {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  const jwk = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string };
  if (!jwk.n || !jwk.e) throw new Error('无法导出 RSA 公钥参数');
  const modulus = Buffer.from(jwk.n, 'base64url');
  const exponent = Buffer.from(jwk.e, 'base64url');
  const blob = Buffer.concat([
    sshString('ssh-rsa'),
    sshMpint(exponent),
    sshMpint(modulus),
  ]);
  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return {
    publicKey: `ssh-rsa ${blob.toString('base64')} ${comment}`,
    fingerprint,
  };
}

/**
 * Generates an RSA-3072 key pair in PKCS#1 PEM form, which both OpenSSH and
 * ssh2 parse reliably. The private key is written with owner-only permissions.
 */
export function generateHostKey(keysDir: string, id: string, comment: string): GeneratedKeyPair {
  ensureDir(keysDir);
  const privateKeyPath = path.join(keysDir, `${id}_rsa`);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  fs.writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(privateKeyPath, 0o600);
  } catch {
    // Windows: chmod is a no-op, ACL inheritance applies.
  }
  const { publicKey, fingerprint } = openSshPublicKey(privateKey, comment);
  return { privateKeyPath, publicKey, fingerprint };
}
