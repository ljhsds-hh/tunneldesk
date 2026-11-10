import { runPowerShell } from '../util/process.js';

function assertWindows(feature: string): void {
  if (process.platform !== 'win32') {
    throw new Error(`${feature} 仅支持 Windows`);
  }
}

function firstOutputLine(result: { stdout: string; stderr: string; code: number }, action: string): string {
  const value = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line))
    .pop();
  if (result.code !== 0 || !value) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).pop() ?? `退出码 ${result.code}`;
    throw new Error(`${action}失败：${detail.slice(0, 200)}`);
  }
  return value;
}

/**
 * 用 DPAPI（CurrentUser）加密密码，返回 base64 密文。
 * 密文换机器/换账号后无法解密，这是预期的安全边界。
 */
export async function encryptPassword(password: string): Promise<string> {
  assertWindows('DPAPI 加密');
  if (!password) throw new Error('密码不能为空');
  const payload = Buffer.from(password, 'utf8').toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$bytes = [Text.Encoding]::Unicode.GetBytes($plain)',
    "$blob = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    '[Convert]::ToBase64String($blob)',
  ].join('\n');
  const result = await runPowerShell(script, 20000);
  return firstOutputLine(result, 'DPAPI 加密');
}

/** 解密仅用于自测/往返校验，界面不提供明文查看。 */
export async function decryptPassword(cipher: string): Promise<string> {
  assertWindows('DPAPI 解密');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cipher)) throw new Error('密码密文格式不正确');
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$blob = [Convert]::FromBase64String('${cipher}')`,
    "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    '$plain = [Text.Encoding]::Unicode.GetString($bytes)',
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))',
  ].join('\n');
  const result = await runPowerShell(script, 20000);
  return Buffer.from(firstOutputLine(result, 'DPAPI 解密'), 'base64').toString('utf8');
}

/**
 * `.rdp` 的 `password 51:b:` 需要 DPAPI blob 的十六进制形式。
 * 配置里存的就是同一个 blob 的 base64，直接转换即可，无需经过明文。
 */
export function cipherToRdpHex(cipher: string): string {
  const text = String(cipher ?? '').trim();
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new Error('已保存的 RDP 密码密文无效，请重新填写密码');
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length === 0) throw new Error('已保存的 RDP 密码密文无效，请重新填写密码');
  return bytes.toString('hex');
}
