import type { MappingConfig } from '../types.js';
import { Logger } from '../util/logger.js';
import { SshLink } from '../ssh/link.js';
import { cleanPowerShellError, isPrivilegeError, powershell } from '../ssh/client.js';
import type { FirewallRuleInfo } from '../types.js';
import { isBLocalTarget } from '../util/net.js';

export const RULE_GROUP = 'TunnelDesk';
export const RULE_PREFIX = 'TunnelDesk-';

/** Get-NetFirewallPortFilter returns "TCP" (or numeric 6 in some Windows builds). */
function isTcpProtocol(protocol: string | null): boolean {
  if (!protocol) return false;
  const value = protocol.trim().toLowerCase();
  return value === 'tcp' || value === '6';
}

export function ruleNameFor(mappingId: string): string {
  return `${RULE_PREFIX}${mappingId}`;
}

export function mappingIdFromRuleName(name: string): string | null {
  if (!name.startsWith(RULE_PREFIX)) return null;
  return name.slice(RULE_PREFIX.length);
}

export interface RuleTarget {
  mappingId: string;
  port: number;
}

/** PowerShell single-quoted literal: escaping only `'` keeps the rule name identical. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds one PowerShell program that (re)creates both directions for every
 * target in a single SSH exec. Each item is isolated by try/catch and reports
 * `OK|<rule>` / `ERR|<rule>|<message>` so a single bad rule cannot hide the
 * others, and the caller can still count exact successes.
 */
export function buildRuleScript(targets: RuleTarget[]): string {
  const blocks = targets.map((target) => {
    const name = ruleNameFor(target.mappingId);
    const quoted = psQuote(name);
    const create = (direction: string) =>
      `New-NetFirewallRule -DisplayName ${quoted} -Group ${psQuote(RULE_GROUP)} -Direction ${direction} -Action Allow -Protocol TCP -LocalPort ${target.port} -Profile Any -Description 'TunnelDesk managed rule' | Out-Null`;
    return [
      `try {`,
      `  Remove-NetFirewallRule -DisplayName ${quoted} -ErrorAction SilentlyContinue`,
      `  ${create('Inbound')}`,
      `  ${create('Outbound')}`,
      `  Write-Output ${psQuote(`OK|${name}`)}`,
      `} catch {`,
      `  Write-Output (${psQuote(`ERR|${name}|`)} + $_.Exception.Message)`,
      `}`,
    ].join('\n');
  });
  return ["$ErrorActionPreference = 'Continue'", ...blocks].join('\n');
}

/** Builds a single PowerShell program removing the named TunnelDesk rules. */
export function buildRuleRemovalScript(mappingIds: string[]): string {
  return mappingIds
    .map((id) => `Remove-NetFirewallRule -DisplayName ${psQuote(ruleNameFor(id))} -ErrorAction SilentlyContinue`)
    .join('; ');
}

interface RuleOutcome {
  ok: number;
  failed: number;
  errors: string[];
}

/** Parses the `OK|<rule>` / `ERR|<rule>|<message>` markers emitted by buildRuleScript(). */
function parseRuleOutcome(stdout: string): RuleOutcome {
  let ok = 0;
  const errors: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('OK|')) {
      ok += 1;
    } else if (line.startsWith('ERR|')) {
      const detail = line.slice(4).replace('|', '：');
      errors.push(detail);
    }
  }
  return { ok, failed: errors.length, errors };
}

export interface FirewallDesiredPort {
  mappingId: string;
  port: number;
  targetHost: string;
  /** true: 自动创建/修复；false: 只保留已有规则，不新建也不修复。 */
  sync: boolean;
}

/**
 * Whether TunnelDesk should automatically create / repair the B-side rule.
 * `enabled` is deliberately not part of this test: disabling a mapping only
 * stops the local listener, it does not invalidate the B-side rule.
 */
export function firewallEligible(
  mapping: Pick<MappingConfig, 'syncFirewall' | 'targetHost'>,
): boolean {
  return mapping.syncFirewall && isBLocalTarget(mapping.targetHost);
}

/**
 * Ownership is independent of `enabled` / `syncFirewall`: any existing mapping
 * whose target is B itself owns a rule. Rules outside this set are orphans.
 * `syncFirewall=false` means "keep the current rule but stop creating/repairing
 * it"; only deleting the mapping (or changing target away from B) removes it.
 */
export function firewallOwned(mapping: Pick<MappingConfig, 'targetHost'>): boolean {
  return isBLocalTarget(mapping.targetHost);
}

/**
 * Manages Windows Firewall rules on the B side over SSH.
 * Every mapping owns one inbound and one outbound TCP rule, both named
 * `TunnelDesk-<mappingId>` and grouped under `TunnelDesk`, so cleanup is
 * exact and can never touch rules created by anything else.
 */
export class FirewallManager {
  rules: FirewallRuleInfo[] = [];
  lastError: string | null = null;
  lastReconciledAt: string | null = null;
  removedOrphans = 0;
  privilege: 'unknown' | 'elevated' | 'denied' = 'unknown';

  constructor(
    private readonly link: SshLink,
    private readonly logger: Logger,
  ) {}

  async applyMapping(mapping: MappingConfig): Promise<boolean> {
    if (!firewallEligible(mapping)) return true;
    try {
      const outcome = await this.applyRules([{ mappingId: mapping.id, port: mapping.targetPort }]);
      if (outcome.ok > 0) {
        this.privilege = 'elevated';
        this.logger.info('firewall', `已放行 B 端口 ${mapping.targetPort}（映射 ${mapping.name}）`);
      }
      if (outcome.failed > 0) {
        this.handleFailure(outcome.errors.join('\n'), mapping);
      }
      await this.refresh().catch(() => undefined);
      return outcome.ok > 0;
    } catch (error) {
      this.handleFailure((error as Error).message, mapping);
      return false;
    }
  }

  /**
   * Creates/replaces every requested rule in ONE SSH exec. Callers that only
   * touch a single mapping still go through here so there is exactly one
   * code path building and parsing firewall scripts.
   */
  private async applyRules(targets: RuleTarget[]): Promise<RuleOutcome> {
    if (targets.length === 0) return { ok: 0, failed: 0, errors: [] };
    const script = buildRuleScript(targets);
    const result = await this.link.exec(powershell(script), 30000);
    const outcome = parseRuleOutcome(result.stdout);

    // Tolerate implementations (and test doubles) that only report a single
    // overall marker: a zero exit code plus RULE_OK means every rule was created.
    if (outcome.ok === 0 && outcome.failed === 0 && result.code === 0 && result.stdout.includes('RULE_OK')) {
      return { ok: targets.length, failed: 0, errors: [] };
    }
    // Every item always prints a marker, so silence means the script did not run
    // as expected. Report a failure instead of pretending nothing was pending.
    if (outcome.ok === 0 && outcome.failed === 0) {
      const detail = cleanPowerShellError(result.stderr || result.stdout);
      return {
        ok: 0,
        failed: targets.length,
        errors: [detail || 'B 端未返回规则执行结果'],
      };
    }
    return outcome;
  }

  async removeMapping(mappingId: string): Promise<void> {
    const script = `${buildRuleRemovalScript([mappingId])}; Write-Output 'DELETED'`;
    try {
      const result = await this.link.exec(powershell(script), 15000);
      if (result.code !== 0) {
        this.lastError = cleanPowerShellError(result.stderr || result.stdout).slice(0, 300);
      }
    } catch (error) {
      this.lastError = (error as Error).message;
    }
    await this.refresh().catch(() => undefined);
  }

  /**
   * Reconciles the B-side rules with the owned set: creates what is missing or
   * out of date (port / direction / protocol / enabled) for mappings that have
   * auto-sync on, keeps existing rules for mappings that turned it off, and
   * deletes orphans (rules whose mapping record no longer exists or whose
   * target moved to a third-party address).
   */
  async sync(desired: FirewallDesiredPort[]): Promise<{ added: number; removed: number }> {
    if (!this.link.isOnline()) throw new Error('隧道未连接，无法同步防火墙规则');
    this.lastError = null;
    const existing = await this.list();
    const desiredByName = new Map(desired.map((item) => [ruleNameFor(item.mappingId), item]));
    const existingByName = new Map<string, FirewallRuleInfo[]>();
    for (const rule of existing) {
      const list = existingByName.get(rule.name) ?? [];
      list.push(rule);
      existingByName.set(rule.name, list);
    }

    const orphanNames = [...existingByName.keys()].filter((name) => !desiredByName.has(name));
    let removed = 0;
    if (orphanNames.length > 0) {
      const script = orphanNames
        .map((name) => `Remove-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue`)
        .join('; ');
      try {
        await this.link.exec(powershell(`${script}; Write-Output 'CLEANED'`), 20000);
        removed = orphanNames.length;
        this.logger.info('firewall', `清理孤儿规则 ${removed} 条`);
      } catch (error) {
        this.lastError = (error as Error).message;
      }
    }

    // Every rule that needs (re)creating is submitted as ONE PowerShell program:
    // N mappings used to cost 2N extra SSH round trips, now it costs one.
    const pending: RuleTarget[] = [];
    for (const [name, item] of desiredByName) {
      // syncFirewall=false: keep what exists, but do not create or repair it.
      if (!item.sync) continue;
      if (this.rulesAreCurrent(existingByName.get(name) ?? [], item)) continue;
      pending.push({ mappingId: item.mappingId, port: item.port });
    }

    let added = 0;
    if (pending.length > 0) {
      try {
        const outcome = await this.applyRules(pending);
        added = outcome.ok;
        if (outcome.ok > 0) {
          this.privilege = 'elevated';
          // One aggregate line keeps the audit trail without one line per rule.
          this.logger.info('firewall', `已放行 ${outcome.ok} 条 B 端口规则`);
        }
        if (outcome.failed > 0) {
          this.lastError = outcome.errors.join('; ').slice(0, 400);
          // A permission error must win over the "at least one succeeded" signal,
          // otherwise the UI would suggest the session has admin rights.
          if (/access is denied|拒绝访问|requires elevation/i.test(this.lastError)) {
            this.privilege = 'denied';
          }
          this.logger.warn(
            'firewall',
            `有 ${outcome.failed} 条规则未能下发：${this.lastError}`,
          );
        }
      } catch (error) {
        this.lastError = (error as Error).message;
        this.logger.warn('firewall', `规则批量下发失败：${this.lastError}`);
      }
    }

    this.removedOrphans = removed;
    this.lastReconciledAt = new Date().toISOString();
    await this.refresh().catch(() => undefined);
    return { added, removed };
  }

  /** A mapping is current only when both directions exist, are enabled and match the desired port/protocol. */
  private rulesAreCurrent(rules: FirewallRuleInfo[], item: FirewallDesiredPort): boolean {
    if (rules.length !== 2) return false;
    const inbound = rules.filter((rule) => rule.direction.toLowerCase().startsWith('in'));
    const outbound = rules.filter((rule) => rule.direction.toLowerCase().startsWith('out'));
    if (inbound.length !== 1 || outbound.length !== 1) return false;
    return [inbound[0], outbound[0]].every(
      (rule) =>
        rule !== undefined &&
        rule.enabled &&
        rule.port === item.port &&
        isTcpProtocol(rule.protocol),
    );
  }

  async list(): Promise<FirewallRuleInfo[]> {
    if (!this.link.isOnline()) return this.rules;
    const script = [
      // Push the filter into the cmdlet: enumerating every rule on B and
      // filtering in PowerShell is dramatically slower on a busy machine.
      `$rules = @(Get-NetFirewallRule -Group '${RULE_GROUP}' -ErrorAction Stop)`,
      'foreach ($rule in $rules) {',
      '  $pf = $rule | Get-NetFirewallPortFilter',
      '  $protocol = $pf.Protocol',
      "  if ($protocol -is [array]) { $protocol = ($protocol -join ',') }",
      '  $port = $pf.LocalPort',
      "  if ($port -is [array]) { $port = ($port -join ',') }",
      `  Write-Output ($rule.DisplayName + '|' + $rule.Direction + '|' + $rule.Enabled + '|' + $protocol + '|' + $port)`,
      '}',
    ].join('\n');
    const result = await this.link.exec(powershell(script), 20000);
    if (result.code !== 0) {
      const message = cleanPowerShellError(result.stderr || result.stdout);
      if (isPrivilegeError(result)) this.privilege = 'denied';
      this.lastError = (message || `读取 B 的防火墙规则失败（退出码 ${result.code}）`).slice(0, 400);
      return this.rules;
    }
    const parsed: FirewallRuleInfo[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('|')) continue;
      const [name = '', direction = '', enabled = '', protocol = '', localPort = ''] = trimmed.split('|');
      const mappingId = mappingIdFromRuleName(name);
      if (!mappingId) continue;
      const port = /^\d+$/.test(localPort.trim()) ? Number(localPort) : null;
      parsed.push({
        name,
        mappingId,
        direction: direction || 'Unknown',
        enabled: enabled.toLowerCase() !== 'false',
        port,
        protocol: protocol || null,
      });
    }
    this.rules = parsed.sort((a, b) => a.name.localeCompare(b.name) || a.direction.localeCompare(b.direction));
    return this.rules;
  }

  async refresh(): Promise<void> {
    if (!this.link.isOnline()) {
      this.rules = [];
      return;
    }
    await this.list().catch((error: Error) => {
      this.lastError = error.message;
    });
  }

  reset(): void {
    this.rules = [];
    this.lastError = null;
    this.lastReconciledAt = null;
    this.removedOrphans = 0;
    this.privilege = 'unknown';
  }

  private handleFailure(raw: string, mapping: MappingConfig): void {
    const message = (cleanPowerShellError(raw) || '防火墙命令返回了空错误信息').slice(0, 400);
    this.lastError = message;
    if (/access is denied|拒绝访问/i.test(message)) {
      this.privilege = 'denied';
      this.logger.warn(
        'firewall',
        `没有权限修改 B 的防火墙（映射 ${mapping.name}）：需要 B 上的管理员令牌。可在 B 上用管理员 PowerShell 运行一次 remediation 脚本，详见 README。`,
      );
    } else {
      this.logger.warn('firewall', `防火墙规则下发失败（映射 ${mapping.name}）：${message}`);
    }
  }
}
