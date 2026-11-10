import type { BastionProfile } from '../types.js';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** 三个敏感值（Bastion 名 / 资源组 / VM 资源 ID）。 */
export function bastionSecrets(profile: Pick<BastionProfile, 'name' | 'resourceGroup' | 'targetResourceId'> | null): string[] {
  if (!profile) return [];
  return [profile.targetResourceId, profile.name, profile.resourceGroup]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** 在任何出口（日志、错误、诊断面板）替换掉三个敏感值。 */
export function maskSecrets(text: string, profile: Pick<BastionProfile, 'name' | 'resourceGroup' | 'targetResourceId'> | null): string {
  let result = stripAnsi(String(text ?? ''));
  for (const secret of bastionSecrets(profile)) {
    result = result.split(secret).join('***');
  }
  return result;
}

/** 配置卡片里的打码展示。 */
export function maskValue(value: string): string {
  const text = String(value ?? '');
  if (!text) return '未填写';
  if (text.length <= 8) return '••••••';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}
