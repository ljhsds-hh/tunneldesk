import type { BastionProfile } from '../types.js';

export const BASTION_LOCAL_PORT = 50022;
export const BASTION_RESOURCE_PORT = 22;
export const RDP_RESOURCE_PORT = 3389;

type Target = Pick<BastionProfile, 'name' | 'resourceGroup' | 'targetResourceId'>;

/**
 * 只拼参数数组，不拼 shell 字符串。三个配置值在保存时已限制字符集，
 * 因此不会把 option 注入到 az 命令里。
 */
export function buildTunnelArgs(target: Target, localPort: number, resourcePort: number): string[] {
  return [
    'network',
    'bastion',
    'tunnel',
    '--name',
    target.name,
    '--resource-group',
    target.resourceGroup,
    '--target-resource-id',
    target.targetResourceId,
    '--resource-port',
    String(resourcePort),
    '--port',
    String(localPort),
  ];
}
