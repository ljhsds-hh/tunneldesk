import { useState } from 'react';
import { api, formatRelative, formatSince } from '../api';
import {
  IconBolt,
  IconCheck,
  IconEdit,
  IconKey,
  IconLock,
  IconRefresh,
  IconServer,
  IconShield,
  IconTrash,
} from '../icons';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  Drawer,
  Field,
  IconButton,
  PageHeader,
  StatusPill,
  Toggle,
} from '../ui';
import { useApp } from '../App';
import { BastionCard } from './BastionCard';
import type { ConnectionType } from '../types';

const REMEDIATION = `# 在电脑 B 上以「管理员身份」打开 PowerShell，执行一次：
New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' \`
  -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force`;

export function ConnectionPage() {
  const { snap, refresh, toast } = useApp();
  const [form, setForm] = useState({
    name: '',
    connectionType: 'ssh' as ConnectionType,
    host: '',
    port: '22',
    username: '',
    password: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [editType, setEditType] = useState<ConnectionType>('ssh');
  const [editHost, setEditHost] = useState('');
  const [editPort, setEditPort] = useState('22');
  const [editError, setEditError] = useState<string | null>(null);

  const host = snap?.host ?? null;
  const link = snap?.link;
  const online = link?.state === 'online';
  const bastionProfile = snap?.bastion.profile ?? null;
  const bastionHost = host?.connectionType === 'azure-bastion';
  const tunnelReady = snap?.bastion.tunnel.phase === 'ready';

  const submit = async () => {
    const connectionType = form.connectionType;
    const port = Number(form.port);
    if (connectionType === 'azure-bastion' && !bastionProfile) {
      return setError('请先在下方保存 Azure Bastion 配置');
    }
    if (connectionType === 'ssh' && !form.host.trim()) return setError('请填写电脑 B 的地址');
    if (!form.username.trim()) return setError('请填写 SSH 用户名');
    if (!form.password) return setError('请填写一次性密码，用于安装公钥');
    if (connectionType === 'ssh' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return setError('SSH 端口不合法');
    }
    setSaving(true);
    setError(null);
    try {
      await api.setupHost({
        name: form.name.trim() || (connectionType === 'azure-bastion' ? 'Azure Bastion' : form.host.trim()),
        connectionType,
        host: connectionType === 'azure-bastion' ? '127.0.0.1' : form.host.trim(),
        port: connectionType === 'azure-bastion' ? 50022 : port,
        username: form.username.trim(),
        password: form.password,
      });
      setForm({ name: '', connectionType, host: '', port: '22', username: '', password: '' });
      toast('主机已配置，密钥登录生效', 'ok');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    if (!host) return;
    try {
      await api.connect(host.id);
      toast('正在建立 SSH 隧道…', 'info');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const disconnect = async () => {
    if (!host) return;
    try {
      await api.disconnect(host.id);
      toast('已断开隧道', 'info');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const test = async () => {
    if (!host) return;
    setTesting(true);
    try {
      const result = await api.testHost(host.id);
      toast(result.message, result.ok ? 'ok' : 'error');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const syncFirewall = async () => {
    setSyncing(true);
    try {
      const result = await api.syncFirewall();
      toast(`规则已对账：新增 ${result.added}，清理 ${result.removed}`, 'ok');
      await refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const remove = async () => {
    if (!host) return;
    setRemoving(true);
    try {
      const result = await api.removeHost(host.id);
      const removed = result.mappingsRemoved ? `，同时删除 ${result.mappingsRemoved} 条映射` : '';
      const cleaned = result.rulesCleaned ? `，已清理 ${result.rulesCleaned} 条 B 侧规则` : '';
      toast(`主机配置已删除${removed}${cleaned}`, 'info');
      if (result.cleanupNote) toast(result.cleanupNote, 'error');
      setConfirmDelete(false);
      await refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRemoving(false);
    }
  };

  const rename = async () => {
    if (!host) return;
    setEditError(null);
    if (editType === 'azure-bastion' && !bastionProfile) {
      setEditError('请先在下方保存 Azure Bastion 配置');
      return;
    }
    const nextPort = Number(editPort);
    if (editType === 'ssh') {
      if (!editHost.trim()) {
        setEditError('请填写 B 的地址');
        return;
      }
      if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
        setEditError('SSH 端口不合法');
        return;
      }
    }
    try {
      if (renameValue.trim() !== host.name) {
        await api.renameHost(host.id, renameValue);
      }
      const addressChanged =
        editType === 'ssh' && (editHost.trim() !== host.host || nextPort !== host.port);
      if (editType !== host.connectionType || addressChanged) {
        await api.updateHostConnection(host.id, {
          connectionType: editType,
          ...(editType === 'ssh' ? { host: editHost.trim(), port: nextPort } : {}),
        });
      }
      setRenameOpen(false);
      toast('主机设置已更新', 'ok');
      await refresh();
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  const openHostSettings = () => {
    if (!host) return;
    setRenameValue(host.name);
    setEditType(host.connectionType);
    setEditHost(host.host);
    setEditPort(String(host.port));
    setEditError(null);
    setRenameOpen(true);
  };

  const rulesByMapping = new Map<
    string,
    { inbound: boolean; inboundEnabled: boolean; outbound: boolean; outboundEnabled: boolean; port: number }
  >();
  if (snap) {
    for (const mapping of snap.mappings) {
      rulesByMapping.set(mapping.id, {
        inbound: false,
        inboundEnabled: false,
        outbound: false,
        outboundEnabled: false,
        port: mapping.targetPort,
      });
    }
    for (const rule of snap.firewall.rules) {
      const entry = rulesByMapping.get(rule.mappingId);
      if (!entry) continue;
      if (rule.direction.toLowerCase().startsWith('in')) {
        entry.inbound = true;
        entry.inboundEnabled = entry.inboundEnabled || rule.enabled;
      }
      if (rule.direction.toLowerCase().startsWith('out')) {
        entry.outbound = true;
        entry.outboundEnabled = entry.outboundEnabled || rule.enabled;
      }
    }
  }

  const firewallDenied = Boolean(snap?.firewall.lastError && /denied|拒绝访问/i.test(snap.firewall.lastError));

  return (
    <>
      <PageHeader
        eyebrow="INFRASTRUCTURE"
        title="连接管理"
        description="B 端不需要安装任何程序：SSH 直连复用系统自带 OpenSSH；Azure Bastion 方式由程序托管 50022 隧道，并可直接打开远程桌面。"
        actions={
          host ? (
            <>
              <Button variant="ghost" icon={<IconRefresh />} loading={testing} onClick={() => void test()}>
                测试登录
              </Button>
              {online ? (
                <Button icon={<IconBolt />} onClick={() => void disconnect()}>
                  断开
                </Button>
              ) : (
                <Button variant="primary" icon={<IconBolt />} onClick={() => void connect()}>
                  连接
                </Button>
              )}
            </>
          ) : null
        }
      />

      <BastionCard />

      {!host ? (
        <div className="grid grid--two grid--wide-left">
          <Card className="panel">
            <div className="card-head">
              <div>
                <h3>首次配置</h3>
                <p>密码仅用于当次安装公钥，不会保存</p>
              </div>
              <IconKey size={16} className="muted" />
            </div>
            <div className="form">
              <Field label="连接方式" hint="微软方式需要先在上方保存 Bastion 配置">
                <div className="segmented">
                  <button
                    type="button"
                    className={form.connectionType === 'ssh' ? 'is-active' : ''}
                    onClick={() => setForm({ ...form, connectionType: 'ssh' })}
                  >
                    SSH 直连
                  </button>
                  <button
                    type="button"
                    className={form.connectionType === 'azure-bastion' ? 'is-active' : ''}
                    onClick={() => setForm({ ...form, connectionType: 'azure-bastion' })}
                  >
                    Azure Bastion
                  </button>
                </div>
              </Field>
              <Field label="显示名称" hint="例如「Azure 跳板机」">
                <input
                  className="input"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="电脑 B"
                />
              </Field>
              {form.connectionType === 'azure-bastion' ? (
                <>
                  <div className="form__row">
                    <Field label="本地地址" hint="由程序固定，不允许修改">
                      <input className="input input--mono" value="127.0.0.1" readOnly />
                    </Field>
                    <Field label="本地端口" hint="50022 隧道就绪后才能登录">
                      <input className="input input--mono" value="50022" readOnly />
                    </Field>
                  </div>
                  {!bastionProfile ? (
                    <p className="form__error">尚未保存 Azure Bastion 配置，请先在上方完成配置。</p>
                  ) : null}
                </>
              ) : (
                <div className="form__row">
                  <Field label="B 的地址" hint="IP 或主机名">
                    <input
                      className="input input--mono"
                      value={form.host}
                      onChange={(event) => setForm({ ...form, host: event.target.value })}
                      placeholder="20.x.x.x"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="SSH 端口" hint="默认 22">
                    <input
                      className="input input--mono"
                      value={form.port}
                      onChange={(event) => setForm({ ...form, port: event.target.value })}
                      inputMode="numeric"
                    />
                  </Field>
                </div>
              )}
              <div className="form__row">
                <Field label="用户名" hint="B 的 Windows 登录账号">
                  <input
                    className="input"
                    value={form.username}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                    placeholder="azureuser"
                    spellCheck={false}
                  />
                </Field>
                <Field label="一次性密码" hint="仅用于本次写入公钥，不会保存">
                  <input
                    className="input"
                    type="password"
                    value={form.password}
                    onChange={(event) => setForm({ ...form, password: event.target.value })}
                    placeholder="••••••••"
                  />
                </Field>
              </div>
              {error ? <p className="form__error">{error}</p> : null}
              <div className="form__actions">
                <Button variant="primary" loading={saving} onClick={() => void submit()}>
                  配置并连接
                </Button>
              </div>
            </div>
          </Card>

          <Card className="panel panel--soft">
            <h3 className="panel__title">程序会做什么</h3>
            <ul className="check-list">
              <li>
                <IconCheck size={15} /> 使用密码登录一次，验证账号可用
              </li>
              <li>
                <IconCheck size={15} /> 在本机生成 RSA-3072 密钥对，只保留私钥
              </li>
              <li>
                <IconCheck size={15} /> <span>以无 BOM 方式写入 B 的用户公钥文件；管理员账号同时写入 <code>administrators_authorized_keys</code></span>
              </li>
              <li>
                <IconCheck size={15} /> 立即用密钥复测；失败会明确提示原因
              </li>
              <li>
                <IconCheck size={15} /> 不修改 VM 配置、不注册服务、不开新监听端口
              </li>
            </ul>
            <div className="callout">
              <IconLock size={15} />
              <p>
                若 B 的 OpenSSH 未启用密码登录，可先在 B 上放好公钥再改用「已有密钥」方式（当前版本需通过配置目录导入）。
              </p>
            </div>
          </Card>
        </div>
      ) : (
        <>
          <div className="grid grid--hero">
            <Card className="host-card">
              <div className="host-card__head">
                <span className="host-card__icon">
                  <IconServer size={22} />
                </span>
                <div>
                  <h2>{host.name}</h2>
                  <p className="mono">
                    {host.username}@{host.host}:{host.port}
                  </p>
                  <Badge tone={bastionHost ? 'accent' : 'neutral'}>
                    {bastionHost ? 'Azure Bastion' : 'SSH 直连'}
                  </Badge>
                </div>
                <StatusPill state={link?.state ?? 'idle'} detail={link?.lastError} />
                <div className="host-card__actions">
                  <IconButton label="主机设置" onClick={openHostSettings}>
                    <IconEdit size={15} />
                  </IconButton>
                  <IconButton label="删除主机" tone="danger" onClick={() => setConfirmDelete(true)}>
                    <IconTrash size={15} />
                  </IconButton>
                </div>
              </div>

              <div className="kv-grid">
                <div>
                  <span>连接状态</span>
                  <strong>{online ? '在线' : link?.state === 'reconnecting' ? '重连中' : '离线'}</strong>
                </div>
                <div>
                  <span>连接方式</span>
                  <strong>{bastionHost ? 'Azure Bastion（50022）' : 'SSH 直连'}</strong>
                </div>
                <div>
                  <span>已保持</span>
                  <strong>{formatSince(link?.since ?? null)}</strong>
                </div>
                <div>
                  <span>主机指纹</span>
                  <strong className="mono ellipsis">{link?.fingerprint ?? '尚未握手'}</strong>
                </div>
                <div>
                  <span>密钥路径</span>
                  <strong className="mono ellipsis">{host.keyPath}</strong>
                </div>
              </div>

              {bastionHost && !tunnelReady ? (
                <div className="callout callout--warn">
                  <IconBolt size={15} />
                  <p>
                    {bastionProfile?.autoStartTunnel
                      ? '50022 隧道尚未就绪，SSH 连接会在隧道启动后自动恢复。'
                      : '自动启动已关闭：请先在上方点「启动 50022」，再连接 SSH。'}
                  </p>
                </div>
              ) : null}

              {link?.lastError ? (
                <div className="callout callout--warn">
                  <IconBolt size={15} />
                  <p>{link.lastError}</p>
                </div>
              ) : null}
            </Card>

            <div className="stat-stack">
              <div className="stat stat--card">
                <span className="stat__label">隧道开关</span>
                <div className="stat__inline">
                  <Toggle
                    checked={online}
                    onChange={() => void (online ? disconnect() : connect())}
                    label="建立或断开 SSH 隧道"
                  />
                  <span className="muted small">{online ? '在线 · 点击断开' : '离线 · 点击连接'}</span>
                </div>
              </div>
              <div className="stat stat--card">
                <span className="stat__label">密钥认证</span>
                <div className="stat__inline">
                  <Badge tone="ok" dot>
                    已启用
                  </Badge>
                  <span className="muted small">密码不落盘</span>
                </div>
              </div>
              <div className="stat stat--card">
                <span className="stat__label">操作审计</span>
                <span className="stat__hint">所有命令通过 SSH exec 下发，失败会带退出码</span>
              </div>
            </div>
          </div>

          <Card className="panel">
            <div className="card-head">
              <div>
                <h3>B 侧防火墙规则</h3>
                <p>每条映射对应一组入站/出站规则，删除映射时自动清理</p>
              </div>
              <div className="card-head__actions">
                <Badge tone={snap?.firewall.lastError ? 'warn' : 'ok'} dot>
                  上次对账 {formatRelative(snap?.firewall.lastReconciledAt ?? null)}
                </Badge>
                <Button variant="secondary" icon={<IconRefresh />} loading={syncing} onClick={() => void syncFirewall()}>
                  立即对账
                </Button>
              </div>
            </div>

            {firewallDenied ? (
              <div className="callout callout--danger">
                <IconShield size={16} />
                <div>
                  <strong>B 上的 SSH 会话没有管理员令牌</strong>
                  <p>
                    Windows 的 UAC 会过滤远程登录的管理员权限，因此无法直接修改防火墙。可任选其一：在 B 上以管理员身份执行下面的
                    一次性命令，或关闭对应映射的「防火墙同步」并在 B 上手动放行。
                  </p>
                  <pre className="remediation">{REMEDIATION}</pre>
                  <CopyButton value={REMEDIATION} label="复制命令" />
                </div>
              </div>
            ) : null}

            <div className="rules">
              {(snap?.mappings ?? []).map((mapping) => {
                const rule = rulesByMapping.get(mapping.id);
                // Mirrors server/src/util/net.ts isBLocalTarget.
                const eligibleForFirewall = ['localhost', '127.0.0.1', '::1'].includes(
                  mapping.targetHost.trim().toLowerCase(),
                );
                const syncLabel = !eligibleForFirewall
                  ? '目标非 B 本机 · 不同步'
                  : mapping.syncFirewall
                    ? '自动同步'
                    : '已关闭同步';
                return (
                  <div key={mapping.id} className="rule-row">
                    <span className={`dot ${rule?.inboundEnabled && rule?.outboundEnabled ? 'dot--ok' : 'dot--idle'}`} />
                    <div className="rule-row__name">
                      <strong>{mapping.name}</strong>
                      <span className="mono muted">{mapping.targetPort}/TCP</span>
                    </div>
                    <div className="rule-row__tags">
                      <Badge tone={rule?.inboundEnabled ? 'ok' : rule?.inbound ? 'warn' : 'neutral'}>
                        入站 {rule?.inbound ? (rule.inboundEnabled ? '已放行' : '已禁用') : '未创建'}
                      </Badge>
                      <Badge tone={rule?.outboundEnabled ? 'ok' : rule?.outbound ? 'warn' : 'neutral'}>
                        出站 {rule?.outbound ? (rule.outboundEnabled ? '已放行' : '已禁用') : '未创建'}
                      </Badge>
                      <Badge tone={mapping.syncFirewall && eligibleForFirewall ? 'accent' : 'neutral'}>
                        {syncLabel}
                      </Badge>
                    </div>
                  </div>
                );
              })}
              {(snap?.mappings ?? []).length === 0 ? (
                <p className="muted small">尚无映射。创建映射时会自动在此登记规则。</p>
              ) : null}
            </div>

            {snap?.firewall.lastError && !firewallDenied ? (
              <p className="inline-error">最近错误：{snap.firewall.lastError}</p>
            ) : null}
          </Card>
        </>
      )}

      <Drawer
        open={renameOpen}
        title="主机设置"
        subtitle="可修改显示名称与连接方式；切换连接方式会断开并重连，已安装的密钥与指纹保持不变"
        onClose={() => setRenameOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void rename()}>
              保存
            </Button>
          </>
        }
      >
        <Field label="名称">
          <input className="input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
        </Field>
        <Field label="连接方式" hint="切换为 Azure Bastion 前需要先保存 Bastion 配置">
          <div className="segmented">
            <button
              type="button"
              className={editType === 'ssh' ? 'is-active' : ''}
              onClick={() => setEditType('ssh')}
            >
              SSH 直连
            </button>
            <button
              type="button"
              className={editType === 'azure-bastion' ? 'is-active' : ''}
              onClick={() => setEditType('azure-bastion')}
            >
              Azure Bastion
            </button>
          </div>
        </Field>
        {editType === 'ssh' ? (
          <div className="form__row">
            <Field label="B 的地址" hint="IP 或主机名">
              <input
                className="input input--mono"
                value={editHost}
                onChange={(event) => setEditHost(event.target.value)}
                placeholder="20.x.x.x"
                spellCheck={false}
              />
            </Field>
            <Field label="SSH 端口" hint="默认 22">
              <input
                className="input input--mono"
                value={editPort}
                onChange={(event) => setEditPort(event.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
        ) : (
          <p className="muted small">Azure Bastion 方式的地址与端口固定为 127.0.0.1:50022。</p>
        )}
        {editType === 'azure-bastion' && !bastionProfile ? (
          <p className="form__error">尚未保存 Azure Bastion 配置，请先在上方完成配置。</p>
        ) : null}
        {editError ? <p className="form__error">{editError}</p> : null}
      </Drawer>

      <ConfirmDialog
        open={confirmDelete}
        title="删除这台主机？"
        description="将断开连接并删除该主机下的所有映射配置；工具会自动清理它在 B 上创建的 TunnelDesk 防火墙规则（非当前主机时会临时建立一次连接）。"
        confirmText="删除主机"
        busy={removing}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
