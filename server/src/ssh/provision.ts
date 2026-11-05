import fs from 'node:fs';
import type { HostConfig } from '../types.js';
import { generateHostKey, openSshPublicKey } from './keys.js';
import { connectClient, execOnClient, powershell } from './client.js';

export interface ProvisionInput {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  keysDir: string;
}

export interface ProvisionResult {
  keyPath: string;
  publicKey: string;
  keyFingerprint: string;
  hostKeyFingerprint: string | null;
}

/**
 * Builds the remote one-time bootstrap script.
 *
 * Important: Windows PowerShell 5.1 writes a UTF-8 BOM with
 * `Add-Content -Encoding utf8`, and OpenSSH then rejects the first
 * authorized_keys line. Use File.AppendAllText with UTF8Encoding(false).
 * Members of Administrators also need administrators_authorized_keys.
 */
export function buildProvisionScript(publicKeyLine: string): string {
  const encodedKey = Buffer.from(publicKeyLine, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$key = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedKey}'))`,
    "$utf8 = New-Object Text.UTF8Encoding($false)",
    "$userFile = Join-Path $env:USERPROFILE '.ssh\\authorized_keys'",
    "$userDir = Split-Path -Parent $userFile",
    "if (-not (Test-Path -LiteralPath $userDir)) { New-Item -ItemType Directory -Path $userDir -Force | Out-Null }",
    "$existing = ''",
    "if (Test-Path -LiteralPath $userFile) { $existing = [IO.File]::ReadAllText($userFile) }",
    "$existing = $existing.TrimStart([char]0xFEFF)",
    'if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) { $existing += "`r`n" }',
    'if ($existing.IndexOf($key) -lt 0) { $existing += $key + "`r`n" }',
    "[IO.File]::WriteAllText($userFile, $existing, $utf8)",
    "$adminAccount = $false",
    "try { $adminAccount = [bool]([Security.Principal.WindowsIdentity]::GetCurrent().Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }) } catch {}",
    "if (-not $adminAccount) { try { $adminAccount = [bool](& whoami /groups 2>$null | Select-String -SimpleMatch 'S-1-5-32-544') } catch {} }",
    "if ($adminAccount) {",
    "  try {",
    "    $adminDir = Join-Path $env:ProgramData 'ssh'",
    "    $adminFile = Join-Path $adminDir 'administrators_authorized_keys'",
    "    if (-not (Test-Path -LiteralPath $adminDir)) { New-Item -ItemType Directory -Path $adminDir -Force | Out-Null }",
    "    $adminExisting = ''",
    "    if (Test-Path -LiteralPath $adminFile) { $adminExisting = [IO.File]::ReadAllText($adminFile) }",
    "    $adminExisting = $adminExisting.TrimStart([char]0xFEFF)",
    '    if ($adminExisting.Length -gt 0 -and -not $adminExisting.EndsWith("`n")) { $adminExisting += "`r`n" }',
    '    if ($adminExisting.IndexOf($key) -lt 0) { $adminExisting += $key + "`r`n" }',
    "    [IO.File]::WriteAllText($adminFile, $adminExisting, $utf8)",
    "    icacls $adminFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { throw ('icacls failed: ' + $LASTEXITCODE) }",
    "  } catch { Write-Output ('ADMIN_FILE_ERROR=' + $_.Exception.Message) }",
    "}",
    "Write-Output 'KEY_OK'",
    "if ($adminAccount) { Write-Output 'ADMIN=yes' } else { Write-Output 'ADMIN=no' }",
    "Write-Output ('USER=' + $env:USERNAME)",
    "Write-Output ('PROFILE=' + $env:USERPROFILE)",
  ].join('\n');
}

/**
 * One-time bootstrap:
 *  1. authenticate with the password,
 *  2. generate a local RSA key pair,
 *  3. append the public key to the remote ~/.ssh/authorized_keys (idempotent),
 *  4. verify that key-only authentication now works.
 *
 * The password is never persisted.
 */
export async function provisionHost(input: ProvisionInput): Promise<ProvisionResult> {
  const comment = `tunneldesk@${input.id}`;
  const key = generateHostKey(input.keysDir, input.id, comment);
  const publicKeyLine = key.publicKey;

  let session: Awaited<ReturnType<typeof connectClient>>;
  try {
    session = await connectClient({
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
    });
  } catch (error) {
    // Do not leave an unused private key behind when the password is rejected.
    fs.rmSync(key.privateKeyPath, { force: true });
    throw error;
  }

  try {
    const script = buildProvisionScript(publicKeyLine);

    const result = await execOnClient(session.client, powershell(script), 25000);
    if (result.code !== 0 || !result.stdout.includes('KEY_OK')) {
      throw new Error(
        `写入 authorized_keys 失败：${(result.stderr || result.stdout).trim().slice(0, 400) || `退出码 ${result.code}`}`,
      );
    }

    // Close the password session before opening the verification session.
    session.client.end();

    // Fail fast if the server did not actually accept the generated key.
    try {
      const verify = await connectClient({
        host: input.host,
        port: input.port,
        username: input.username,
        privateKeyPath: key.privateKeyPath,
        readyTimeoutMs: 15000,
      });
      verify.client.end();
    } catch (error) {
      const detail = result.stdout.includes('ADMIN_FILE_ERROR=')
        ? ` 管理员公钥文件写入失败：${result.stdout.split('ADMIN_FILE_ERROR=')[1]?.split('\n')[0] ?? ''}`
        : '';
      throw new Error(
        `公钥已写入，但密钥登录验证失败：${(error as Error).message}。${detail} 请确认 B 的 OpenSSH 允许公钥登录。`,
      );
    }

    // The public key file used for display and for the fingerprint shown in the UI.
    const { fingerprint } = openSshPublicKey(fs.readFileSync(key.privateKeyPath, 'utf8'), comment);

    return {
      keyPath: key.privateKeyPath,
      publicKey: publicKeyLine,
      keyFingerprint: fingerprint,
      hostKeyFingerprint: session.hostKeyFingerprint,
    };
  } catch (error) {
    fs.rmSync(key.privateKeyPath, { force: true });
    throw error;
  } finally {
    session.client.end();
  }
}

/** Confirms that key-only authentication is accepted by the server. */
export async function verifyKeyLogin(host: Pick<HostConfig, 'host' | 'port' | 'username' | 'keyPath'>): Promise<boolean> {
  try {
    const session = await connectClient({
      host: host.host,
      port: host.port,
      username: host.username,
      privateKeyPath: host.keyPath,
      readyTimeoutMs: 15000,
    });
    session.client.end();
    return true;
  } catch {
    return false;
  }
}
