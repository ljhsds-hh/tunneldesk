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

export interface FirewallDesiredPort {
  mappingId: string;
  port: number;
  targetHost: string;
}

/**
 * A mapping needs a B-side firewall rule whenever it opts in and targets B
 * itself. `enabled` is deliberately not part of this test: disabling a mapping
 * only stops the local listener, it does not invalidate the B-side rule. The
 * rule is removed only when the mapping record disappears, sync is turned off,
 * or the target becomes a third-party address.
 */
export function firewallEligible(
  mapping: Pick<MappingConfig, 'syncFirewall' | 'targetHost'>,
): boolean {
  return mapping.syncFirewall && isBLocalTarget(mapping.targetHost);
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
    const name = ruleNameFor(mapping.id);
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$n = '${name}'`,
      `Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue`,
      `New-NetFirewallRule -DisplayName $n -Group '${RULE_GROUP}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${mapping.targetPort} -Profile Any -Description 'TunnelDesk managed rule' | Out-Null`,
      `New-NetFirewallRule -DisplayName $n -Group '${RULE_GROUP}' -Direction Outbound -Action Allow -Protocol TCP -LocalPort ${mapping.targetPort} -Profile Any -Description 'TunnelDesk managed rule' | Out-Null`,
      `Write-Output 'RULE_OK'`,
    ].join('; ');

    try {
      const result = await this.link.exec(powershell(script), 20000);
      if (result.code !== 0 || !result.stdout.includes('RULE_OK')) {
        this.handleFailure(result.stderr || result.stdout, mapping);
        return false;
      }
      this.privilege = 'elevated';
      this.logger.info('firewall', `已放行 B 端口 ${mapping.targetPort}（映射 ${mapping.name}）`);
      await this.refresh();
      return true;
    } catch (error) {
      this.handleFailure((error as Error).message, mapping);
      return false;
    }
  }

  async removeMapping(mappingId: string): Promise<void> {
    const name = ruleNameFor(mappingId);
    const script = [
      `Remove-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue`,
      `Write-Output 'DELETED'`,
    ].join('; ');
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
   * Reconciles the B-side rules with the desired set: creates what is missing
   * or out of date (port / direction / protocol / enabled), deletes orphans
   * (rules whose mapping record no longer exists, sync was turned off, or the
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

    let added = 0;
    for (const [name, item] of desiredByName) {
      const rules = existingByName.get(name) ?? [];
      if (this.rulesAreCurrent(rules, item)) continue;
      const mapping = {
        id: item.mappingId,
        targetPort: item.port,
        targetHost: item.targetHost,
        enabled: true,
        syncFirewall: true,
        name: item.mappingId,
      } as MappingConfig;
      if (await this.applyMapping(mapping)) added += 1;
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
      `$rules = @(Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.Group -eq '${RULE_GROUP}' })`,
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
