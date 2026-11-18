import { describe, expect, it } from 'vitest';
import { Logger } from '../src/util/logger.js';
import { clampText, summarizeError, toSingleLine } from '../src/util/text.js';

describe('text helpers', () => {
  it('flattens colored multi-line command output into one line', () => {
    const raw = [
      '\u001b[31mAt line:1 char:1',
      '+ New-NetFirewallRule -DisplayName ...',
      '\u001b[0m+ CategoryInfo : PermissionDenied',
      '',
    ].join('\r\n');
    expect(toSingleLine(raw)).toBe(
      'At line:1 char:1 / + New-NetFirewallRule -DisplayName ... / + CategoryInfo : PermissionDenied',
    );
  });

  it('clamps text to the limit and marks the cut', () => {
    const clamped = clampText('x'.repeat(50), 20);
    expect(clamped).toHaveLength(20);
    expect(clamped.endsWith('…')).toBe(true);
  });

  it('summarizes an error on one line', () => {
    expect(summarizeError(new Error('first\nsecond'))).toBe('first / second');
    expect(summarizeError(undefined)).toBe('未知错误');
  });
});

describe('Logger hardening', () => {
  it('stores one bounded line even for huge multi-line remote output', () => {
    const logger = new Logger({ mirrorToConsole: false });
    const raw = Array.from({ length: 200 }, (_, index) => `line ${index} ${'y'.repeat(80)}`).join('\r\n');
    logger.error('firewall', raw);

    const message = logger.list()[0]?.message ?? '';
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(600);
    expect(message).toContain('已截断');
  });

  it('redacts assignment values, CLI flags and bearer tokens', () => {
    const logger = new Logger({ mirrorToConsole: false });
    logger.info(
      'host',
      'password=hunter2 "secret": "abc" --password azpass Authorization: Bearer eyJhbGciOi token=xyz',
    );

    const message = logger.list()[0]?.message ?? '';
    for (const secret of ['hunter2', 'abc', 'azpass', 'eyJhbGciOi', 'xyz']) {
      expect(message).not.toContain(secret);
    }
    expect(message).toContain('[redacted]');
  });

  it('normalizes the scope and keeps the ring buffer bounded', () => {
    const logger = new Logger({ limit: 3, mirrorToConsole: false });
    for (let index = 0; index < 5; index += 1) logger.info(` scope\n${index} `, `m${index}`);

    expect(logger.list()).toHaveLength(3);
    expect(logger.list()[0]?.scope).toBe('scope / 2');
  });
});
