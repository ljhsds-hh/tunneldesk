import { spawn, type ChildProcess } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Windows 下 `.cmd` / `.bat` 需要经 cmd.exe 启动。 */
  shell?: boolean;
}

/** cmd 元字符最少转义：az 参数已在保存配置时限制为安全字符。 */
function quoteCmdArg(value: string): string {
  const text = String(value);
  if (!/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** 把 `az ...` 变成 `cmd.exe /d /s /c "az ..."`，避免 shell:true + args 的弃用告警。 */
export function toShellCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file, args };
  const command = [file, ...args.map(quoteCmdArg)].join(' ');
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', command],
  };
}

export function spawnCommand(
  file: string,
  args: string[],
  options: { shell?: boolean; windowsHide?: boolean } = {},
): ChildProcess {
  const target = options.shell ? toShellCommand(file, args) : { file, args };
  return spawn(target.file, target.args, {
    windowsHide: options.windowsHide ?? true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Runs a short-lived command and collects stdout/stderr.
 * Long-running processes (az tunnel, mstsc) must not use this helper.
 */
export function runCommand(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnCommand(file, args, { shell: options.shell });
    } catch (error) {
      reject(error as Error);
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void killProcessTree(child.pid);
      reject(new Error(`命令执行超时（${options.timeoutMs ?? 15000}ms）`));
    }, options.timeoutMs ?? 15000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Runs Windows PowerShell with -EncodedCommand to avoid quoting problems. */
export async function runPowerShell(script: string, timeoutMs = 20000): Promise<CommandResult> {
  const wrapped = `$ProgressPreference = 'SilentlyContinue'; ${script}`;
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  return runCommand(
    process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeoutMs },
  );
}

/** Kills a process together with its children (az.cmd spawns a Python child). */
export function killProcessTree(pid: number | undefined, timeoutMs = 8000): Promise<void> {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return runCommand('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs })
      .then(() => undefined)
      .catch(() => undefined);
  }
  return Promise.resolve().then(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  });
}
