import { useState } from 'react';
import { api, formatRelative } from '../api';
import {
  IconBolt,
  IconEdit,
  IconKey,
  IconLock,
  IconMonitor,
  IconPower,
  IconRefresh,
  IconShield,
  IconTrash,
} from '../icons';
import { Badge, Button, Card, ConfirmDialog, Drawer, Field, Toggle } from '../ui';
import { useApp } from '../App';
import type { TunnelPhase } from '../types';

const TUNNEL_LABEL: Record<TunnelPhase, string> = {
  idle: '未启动',
  starting: '启动中',
  ready: '就绪',
  restarting: '重连中',
  failed: '失败',
};

const TUNNEL_TONE: Record<TunnelPhase, 'neutral' | 'ok' | 'warn' | 'danger'> = {
  idle: 'neutral',
  starting: 'warn',
  ready: 'ok',
  restarting: 'warn',
  failed: 'danger',
};

function maskText(value: string): string {
  if (!value) return '未填写';
  if (value.length <= 8) return '••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

interface FormState {
  name: string;
  resourceGroup: string;
  targetResourceId: string;
  rdpUsername: string;
  rdpPassword: string;
  autoStartTunnel: boolean;
  clearRdpPassword: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  resourceGroup: '',
  targetResourceId: '',
  rdpUsername: '',
  rdpPassword: '',
  autoStartTunnel: true,
  clearRdpPassword: false,
};

function BastionFields({
  value,
  onChange,
  hasSavedPassword,
}: {
  value: FormState;
  onChange: (patch: Partial<FormState>) => void;
  hasSavedPassword: boolean;
}) {
  return (
    <div className="form">
      <Field label="Bastion 名称" hint="Azure 门户里 Bastion 资源的名称">
        <input
          className="input"
          value={value.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="例如 my-bastion"
          spellCheck={false}
        />
      </Field>
      <Field label="资源组" hint="Bastion 资源所在的资源组">
        <input
          className="input"
          value={value.resourceGroup}
          onChange={(event) => onChange({ resourceGroup: event.target.value })}
          placeholder="例如 rg-demo"
          spellCheck={false}
        />
      </Field>
      <Field label="VM 资源 ID" hint="Azure 门户 → VM → 属性 → 资源 ID，整行粘贴">
        <input
          className="input input--mono"
          value={value.targetResourceId}
          onChange={(event) => onChange({ targetResourceId: event.target.value })}
          placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Compute/virtualMachines/…"
          spellCheck={false}
        />
      </Field>
      <div className="form__row">
        <Field label="RDP 账号" hint="可留空，留空时由 Windows 弹窗要求输入">
          <input
            className="input"
            value={value.rdpUsername}
            onChange={(event) => onChange({ rdpUsername: event.target.value })}
            placeholder="B 的 Windows 账号"
            spellCheck={false}
          />
        </Field>
        <Field
          label="RDP 密码"
          hint={hasSavedPassword ? '已加密保存；留空表示不修改' : 'DPAPI 加密保存，仅用于远程桌面'}
        >
          <input
            className="input"
            type="password"
            value={value.rdpPassword}
            onChange={(event) => onChange({ rdpPassword: event.target.value })}
            placeholder={hasSavedPassword ? '••••••••' : '可留空'}
          />
        </Field>
      </div>
      {hasSavedPassword ? (
        <label className="check-inline">
          <input
            type="checkbox"
            checked={value.clearRdpPassword}
            onChange={(event) => onChange({ clearRdpPassword: event.target.checked })}
          />
          <span>清除已保存的 RDP 密码</span>
        </label>
      ) : null}
      <div className="form__switch">
        <div>
          <strong>程序启动时自动拉起 50022 隧道</strong>
          <p>关闭后不会自动启动隧道，也不会自动连接 SSH；需要手动点「启动 50022」。</p>
        </div>
        <Toggle
          checked={value.autoStartTunnel}
          onChange={(next) => onChange({ autoStartTunnel: next })}
          label="自动启动 50022"
        />
      </div>
    </div>
  );
}

export function BastionCard() {
  const { snap, refresh, toast } = useApp();
  const profile = snap?.bastion.profile ?? null;
  const tunnel = snap?.bastion.tunnel;
  const rdpSessions = snap?.bastion.rdpSessions ?? [];

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [busy, setBusy] = useState<'start' | 'stop' | 'rdp' | 'kill' | 'reset' | 'toggle' | null>(null);

  const phase = tunnel?.phase ?? 'idle';
  const ready = phase === 'ready';

  const openEdit = () => {
    if (!profile) {
      setForm(EMPTY_FORM);
    } else {
      setForm({
        name: profile.name,
        resourceGroup: profile.resourceGroup,
        targetResourceId: profile.targetResourceId,
        rdpUsername: profile.rdpUsername,
        rdpPassword: '',
        autoStartTunnel: profile.autoStartTunnel,
        clearRdpPassword: false,
      });
    }
    setError(null);
    setEditOpen(true);
  };

  const save = async () => {
    const targetChanged =
      profile !== null &&
      (form.name.trim() !== profile.name ||
        form.resourceGroup.trim() !== profile.resourceGroup ||
        form.targetResourceId.trim() !== profile.targetResourceId);
    if (targetChanged) {
      setConfirmSave(true);
      return;
    }
    await doSave();
  };

  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveBastion({
        name: form.name,
        resourceGroup: form.resourceGroup,
        targetResourceId: form.targetResourceId,
        rdpUsername: form.rdpUsername,
        rdpPassword: form.rdpPassword || undefined,
        clearRdpPassword: form.clearRdpPassword,
        autoStartTunnel: form.autoStartTunnel,
      });
      toast('Azure Bastion 配置已保存', 'ok');
      setEditOpen(false);
      setConfirmSave(false);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleAutoStart = async (next: boolean) => {
    setBusy('toggle');
    try {
      await api.saveBastion({ autoStartTunnel: next });
      toast(next ? '已开启自动启动 50022' : '已关闭自动启动 50022', 'ok');
      await refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const run = async (
    key: 'start' | 'stop' | 'rdp' | 'kill' | 'reset',
    action: () => Promise<unknown>,
    message: string,
  ) => {
    setBusy(key);
    try {
      await action();
      if (message) toast(message, 'ok');
      await refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    await run('reset', () => api.resetBastion(), 'Azure Bastion 配置已重置');
    setConfirmReset(false);
  };

  return (
    <Card className="panel bastion-card">
      <div className="card-head">
        <div>
          <h3>Azure Bastion</h3>
          <p>全局唯一配置，只保存在本机配置目录；地址与端口由程序固定为 127.0.0.1:50022</p>
        </div>
        <div className="card-head__actions">
          <Badge tone={profile ? 'accent' : 'neutral'} dot>
            {profile ? '已配置' : '未配置'}
          </Badge>
          {profile ? (
            <Button variant="ghost" size="sm" onClick={() => setReveal((prev) => !prev)}>
              {reveal ? '隐藏' : '显示'}
            </Button>
          ) : null}
        </div>
      </div>

      {!profile ? (
        <>
          <div className="callout bastion-hint">
            <IconKey size={15} />
            <p>
              选择「Azure Bastion」连接方式前，需要先在这里保存 Bastion 名称、资源组与 VM 资源 ID。
              三个值不会出现在仓库或日志里。
            </p>
          </div>
          <BastionFields value={form} onChange={(patch) => setForm({ ...form, ...patch })} hasSavedPassword={false} />
          {error ? <p className="form__error">{error}</p> : null}
          <div className="form__actions">
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              保存配置
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="kv-grid bastion-grid">
            <div>
              <span>Bastion 名称</span>
              <strong className="mono">{reveal ? profile.name : maskText(profile.name)}</strong>
            </div>
            <div>
              <span>资源组</span>
              <strong className="mono">{reveal ? profile.resourceGroup : maskText(profile.resourceGroup)}</strong>
            </div>
            <div className="bastion-grid__wide">
              <span>VM 资源 ID</span>
              <strong className="mono ellipsis">{reveal ? profile.targetResourceId : maskText(profile.targetResourceId)}</strong>
            </div>
            <div>
              <span>RDP 账号</span>
              <strong>{profile.rdpUsername ? (reveal ? profile.rdpUsername : maskText(profile.rdpUsername)) : '未填写'}</strong>
            </div>
            <div>
              <span>RDP 密码</span>
              <strong>{profile.hasRdpPassword ? '已加密保存' : '未保存（Windows 弹窗输入）'}</strong>
            </div>
            <div>
              <span>更新时间</span>
              <strong>{formatRelative(profile.updatedAt)}</strong>
            </div>
          </div>

          <div className="bastion-toolbar">
            <div className="bastion-toolbar__auto">
              <Toggle
                checked={profile.autoStartTunnel}
                onChange={(next) => void toggleAutoStart(next)}
                disabled={busy === 'toggle'}
                label="自动启动 50022"
              />
              <span className="muted small">程序启动时自动拉起 50022</span>
            </div>
            <div className="bastion-toolbar__actions">
              <Button variant="ghost" size="sm" icon={<IconEdit size={14} />} onClick={openEdit}>
                修改配置
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconTrash size={14} />}
                onClick={() => setConfirmReset(true)}
              >
                重置
              </Button>
            </div>
          </div>

          <div className="tunnel-box">
            <div className="tunnel-box__head">
              <div>
                <strong>50022 隧道</strong>
                <span className="mono muted small">
                  127.0.0.1:{tunnel?.localPort ?? 50022} → B:22
                </span>
              </div>
              <Badge tone={TUNNEL_TONE[phase]} dot>
                {TUNNEL_LABEL[phase]}
                {phase === 'restarting' && tunnel?.restartAttempt
                  ? `（第 ${tunnel.restartAttempt} 次）`
                  : ''}
              </Badge>
            </div>

            {tunnel?.lastError ? (
              <div className="callout callout--warn">
                <IconShield size={15} />
                <p>{tunnel.lastError}</p>
              </div>
            ) : null}

            {tunnel?.portOwner ||
            (phase === 'failed' && tunnel?.lastError?.includes('占用')) ? (
              <div className="callout callout--danger">
                <IconPower size={15} />
                <div>
                  <strong>
                    {tunnel?.portOwner
                      ? `端口 50022 被 ${tunnel.portOwner.name}(PID ${tunnel.portOwner.pid}) 占用`
                      : '端口 50022 被其他程序占用'}
                  </strong>
                  <p>可以先结束该进程再重新拉起隧道；请确认它不是正在使用的其他程序。</p>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === 'kill'}
                    onClick={() => void run('kill', () => api.killBastionPortOwner(), '已停止占用进程并重新拉起隧道')}
                  >
                    一键停止并重连
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="tunnel-box__actions">
              {ready ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPower size={14} />}
                  loading={busy === 'stop'}
                  onClick={() => void run('stop', () => api.stopBastionTunnel(), '50022 隧道已停止')}
                >
                  停止 50022
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconBolt size={14} />}
                  loading={busy === 'start'}
                  onClick={() => void run('start', () => api.startBastionTunnel(), '50022 隧道已就绪')}
                >
                  启动 50022
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                icon={<IconMonitor size={14} />}
                loading={busy === 'rdp'}
                onClick={() => void run('rdp', () => api.openRdp(), '远程桌面窗口已启动')}
              >
                远程桌面
              </Button>
            </div>

            {!profile.autoStartTunnel && !ready ? (
              <p className="muted small">
                自动启动已关闭：请先点「启动 50022」，SSH 与测试登录都依赖这条隧道。
              </p>
            ) : null}

            {rdpSessions.length > 0 ? (
              <div className="tunnel-sessions">
                {rdpSessions.map((session) => (
                  <div key={session.id} className="tunnel-session">
                    <IconMonitor size={14} />
                    <span className="mono">127.0.0.1:{session.localPort}</span>
                    <Badge tone={session.state === 'ready' ? 'ok' : 'warn'}>{session.state === 'ready' ? '已打开' : '启动中'}</Badge>
                  </div>
                ))}
              </div>
            ) : null}

            <details className="diag">
              <summary>
                <IconRefresh size={13} /> az 诊断输出（最近 {tunnel?.diagnostics.length ?? 0} 行）
              </summary>
              <pre>{tunnel?.diagnostics.length ? tunnel.diagnostics.join('\n') : '暂无输出'}</pre>
            </details>
          </div>
        </>
      )}

      <Drawer
        open={editOpen}
        title="修改 Azure Bastion 配置"
        subtitle="修改 Bastion / 资源组 / VM 资源 ID 会重启隧道，并需要重新测试登录"
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              保存修改
            </Button>
          </>
        }
      >
        <BastionFields
          value={form}
          onChange={(patch) => setForm({ ...form, ...patch })}
          hasSavedPassword={profile?.hasRdpPassword ?? false}
        />
        {error ? <p className="form__error">{error}</p> : null}
        <div className="callout">
          <IconLock size={15} />
          <p>RDP 密码只以 Windows DPAPI 密文保存，换机器或换 Windows 账号后无法解密。</p>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmSave}
        title="修改 Bastion 目标配置？"
        description="修改 Bastion 名称、资源组或 VM 资源 ID 会停止现有 50022 隧道、关闭远程桌面，并需要重新测试 SSH 登录。确定保存？"
        confirmText="保存并重启隧道"
        busy={saving}
        onCancel={() => setConfirmSave(false)}
        onConfirm={() => void doSave()}
      />

      <ConfirmDialog
        open={confirmReset}
        title="重置 Azure Bastion 配置？"
        description="将停止 50022 与所有远程桌面隧道、删除本次生成的 .rdp，并清除已保存的配置。主机记录会保留，但需要重新配置后才能连接。"
        confirmText="重置配置"
        busy={busy === 'reset'}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void reset()}
      />
    </Card>
  );
}
