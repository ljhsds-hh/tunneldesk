import fs from 'node:fs';
import path from 'node:path';
import { cipherToRdpHex } from './dpapi.js';

export interface RdpFileInput {
  localPort: number;
  username?: string;
  passwordCipher?: string | null;
}

/**
 * 生成最小可用的 .rdp 内容。
 * - 关闭凭据提示，账号与 DPAPI 密码都已预填
 * - 密码只以密文形式进入文件，不出现明文
 */
export function buildRdpFile(input: RdpFileInput): string {
  const port = Math.round(Number(input.localPort));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('RDP 本地端口不合法');
  }

  const lines = [
    `full address:s:127.0.0.1:${port}`,
    'screen mode id:i:2',
    'use multimon:i:0',
    'authentication level:i:2',
    input.passwordCipher ? 'prompt for credentials:i:0' : 'prompt for credentials:i:1',
    'promptcredentialonce:i:0',
    'enablecredsspsupport:i:1',
    'redirectclipboard:i:1',
    'audiomode:i:0',
  ];

  const username = String(input.username ?? '').trim();
  if (username) {
    if (/[\u0000-\u001f\u007f]/.test(username)) throw new Error('RDP 账号不合法');
    lines.push(`username:s:${username}`);
  }
  if (input.passwordCipher) {
    lines.push(`password 51:b:${cipherToRdpHex(input.passwordCipher)}`);
  }

  return `${lines.join('\r\n')}\r\n`;
}

/** mstsc 对 Unicode .rdp 支持最好；带 BOM 的 UTF-16LE 可正确显示中文账号。 */
export function writeRdpFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(`\uFEFF${content}`, 'utf16le'));
}

/** 清理上次异常退出遗留的 .rdp；程序单实例运行，不会误删别的会话。 */
export function cleanRdpDir(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase().endsWith('.rdp')) {
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch {
    // directory may not exist yet
  }
}

