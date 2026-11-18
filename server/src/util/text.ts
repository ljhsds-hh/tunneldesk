// CSI color/cursor sequences plus OSC sequences (window title, hyperlinks).
const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Removes ANSI escape sequences (colored CLI output). */
export function stripAnsi(text: string): string {
  return String(text ?? '').replace(ANSI_PATTERN, '');
}

/**
 * Flattens arbitrary CLI / PowerShell / stack output into one readable line:
 * strips ANSI + control characters, trims each line, drops blank lines and
 * joins the rest with ` / `. Remote command output routinely spans dozens of
 * lines; without this a single log row becomes a wall of text.
 */
export function toSingleLine(text: string): string {
  return stripAnsi(String(text ?? ''))
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(CONTROL_PATTERN, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ');
}

/** Clamps text to `limit` characters, appending an explicit marker when cut. */
export function clampText(text: string, limit: number, marker = '…'): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

/**
 * One-line, bounded error text. Safe for logs, `lastError` fields and anything
 * that is pushed to the console UI or an SSE frame.
 */
export function summarizeError(error: unknown, limit = 300): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = toSingleLine(raw);
  return clampText(text || '未知错误', limit);
}
