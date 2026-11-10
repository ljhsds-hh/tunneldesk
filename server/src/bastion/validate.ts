export interface BastionProfileInput {
  name: string;
  resourceGroup: string;
  targetResourceId: string;
  rdpUsername: string;
}

const BASTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RESOURCE_GROUP = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/;
// /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Compute/virtualMachines/<vm>
const TARGET_RESOURCE_ID =
  /^\/subscriptions\/[A-Za-z0-9-]+\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/[A-Za-z0-9.]+\/[A-Za-z0-9.]+\/[A-Za-z0-9._-]+$/i;

export function validateBastionInput(input: Partial<BastionProfileInput>): BastionProfileInput {
  const name = String(input.name ?? '').trim();
  const resourceGroup = String(input.resourceGroup ?? '').trim();
  const targetResourceId = String(input.targetResourceId ?? '').trim().replace(/\/+$/, '');
  const rdpUsername = String(input.rdpUsername ?? '').trim();

  if (!name) throw new Error('请填写 Bastion 名称');
  if (!BASTION_NAME.test(name)) {
    throw new Error('Bastion 名称只能包含字母、数字、点、下划线和连字符');
  }
  if (!resourceGroup) throw new Error('请填写资源组名称');
  if (!RESOURCE_GROUP.test(resourceGroup)) {
    throw new Error('资源组名称只能包含字母、数字、点、下划线、括号和连字符');
  }
  if (!targetResourceId) throw new Error('请填写 VM 资源 ID');
  if (targetResourceId.length > 600) throw new Error('VM 资源 ID 过长');
  if (!TARGET_RESOURCE_ID.test(targetResourceId)) {
    throw new Error('VM 资源 ID 格式不正确，应形如 /subscriptions/…/resourceGroups/…/providers/Microsoft.Compute/virtualMachines/…');
  }
  if (rdpUsername.length > 128 || /[\u0000-\u001f\u007f]/.test(rdpUsername)) {
    throw new Error('RDP 账号不合法');
  }

  return { name, resourceGroup, targetResourceId, rdpUsername };
}
