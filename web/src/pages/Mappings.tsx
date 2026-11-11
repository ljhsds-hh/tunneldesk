import { useMemo, useState } from 'react';
import { api, formatBytes, formatRate } from '../api';
import {
  IconArrow,
  IconBolt,
  IconEdit,
  IconPlus,
  IconPorts,
  IconSearch,
  IconShield,
  IconTrash,
} from '../icons';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Sparkline,
  Toggle,
} from '../ui';
import { useApp } from '../App';
import type { Mapping } from '../types';

interface FormState {
  name: string;
  localPort: string;
  targetHost: string;
  targetPort: string;
  enabled: boolean;
  syncFirewall: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  localPort: '13389',
  targetHost: '127.0.0.1',
  targetPort: '3389',
  enabled: true,
  syncFirewall: true,
};

const B_LOCAL_TARGETS = new Set(['localhost', '127.0.0.1', '::1']);

/** Mirrors server/src/util/net.ts isBLocalTarget - keep the two in sync. */
function isBLocalTarget(targetHost: string): boolean {
  return B_LOCAL_TARGETS.has(targetHost.trim().toLowerCase());
}

export function MappingsPage() {
  const { snap, refresh, toast, history } = useApp();
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Mapping | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Mapping | null>(null);
  const [busy, setBusy] = useState(false);

  const targetIsBLocal = isBLocalTarget(form.targetHost);
  const mappings = snap?.mappings ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return mappings;
    return mappings.filter(
      (mapping) =>
        mapping.name.toLowerCase().includes(needle) ||
        String(mapping.localPort).includes(needle) ||
        String(mapping.targetPort).includes(needle) ||
        mapping.targetHost.toLowerCase().includes(needle),
    );
  }, [mappings, query]);

  const openCreate = async () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setDrawerOpen(true);
    try {
      const { port } = await api.freePort(13389);
      setForm((prev) => ({ ...prev, localPort: String(port) }));
    } catch {
      /* keep the default value */
    }
  };

  const openEdit = (mapping: Mapping) => {
    setEditing(mapping);
    setForm({
      name: mapping.name,
      localPort: String(mapping.localPort),
      targetHost: mapping.targetHost,
      targetPort: String(mapping.targetPort),
      enabled: mapping.enabled,
      syncFirewall: mapping.syncFirewall,
    });
    setFormError(null);
    setDrawerOpen(true);
  };

  const submit = async () => {
    const localPort = Number(form.localPort);
    const targetPort = Number(form.targetPort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      setFormError('本地端口需为 1–65535 的整数');
      return;
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      setFormError('目标端口需为 1–65535 的整数');
      return;
    }
    if (!form.targetHost.trim()) {
      setFormError('请填写 B 侧目标地址');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name.trim(),
        localPort,
        targetHost: form.targetHost.trim(),
        targetPort,
        enabled: form.enabled,
        syncFirewall: form.syncFirewall,
      };
      if (editing) {
        await api.updateMapping(editing.id, payload);
        toast('映射已更新', 'ok');
      } else {
        await api.createMapping({ ...payload, hostId: snap?.host?.id ?? '' });
        toast('映射已创建，正在建立监听', 'ok');
      }
      setDrawerOpen(false);
      await refresh();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (mapping: Mapping, enabled: boolean) => {
    try {
      await api.updateMapping(mapping.id, { enabled });
      toast(enabled ? `已启用「${mapping.name}」` : `已停用「${mapping.name}」`, 'info');
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteMapping(deleting.id);
      toast('映射已删除，B 侧防火墙规则同步清理', 'ok');
      setDeleting(null);
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="MODULE 01"
        title="端口映射"
        description="把 B 上的服务端口映射到 A 的本地回环地址。监听只在 127.0.0.1，不对外暴露。"
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => void openCreate()} disabled={!snap?.host}>
            新建映射
          </Button>
        }
      />

      {!snap?.host ? (
        <Card className="notice">
          <IconShield />
          <div>
            <strong>还没有配置主机</strong>
            <p>端口映射依赖 SSH 隧道，请先在「连接管理」中完成主机配置。</p>
          </div>
          <Button onClick={() => (window.location.hash = '#/connection')}>去配置</Button>
        </Card>
      ) : null}

      <div className="toolbar">
        <div className="search">
          <IconSearch size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、端口或目标地址"
            aria-label="搜索映射"
          />
        </div>
        <div className="toolbar__meta">
          <span className="muted small">
            {mappings.filter((mapping) => mapping.enabled).length} 条启用 · {mappings.length} 条总计
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconPorts size={26} />}
            title={mappings.length === 0 ? '还没有端口映射' : '没有匹配的映射'}
            description={
              mappings.length === 0
                ? '例如：把 B 的 3389 映射到本机 13389，然后用远程桌面连接 127.0.0.1:13389。'
                : '换一个关键词试试，或清空搜索。'
            }
            action={
              mappings.length === 0 ? (
                <Button variant="primary" icon={<IconPlus />} onClick={() => void openCreate()} disabled={!snap?.host}>
                  创建第一条映射
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="mapping-grid">
          {filtered.map((mapping) => {
            const runtime = mapping.runtime;
            const series = history.mappings[mapping.id] ?? { down: [], up: [] };
            const tone = !mapping.enabled
              ? 'neutral'
              : runtime.listening
                ? 'ok'
                : runtime.lastError
                  ? 'danger'
                  : 'warn';
            return (
              <Card key={mapping.id} className={`mapping${mapping.enabled ? '' : ' mapping--off'}`}>
                <div className="mapping__head">
                  <span className={`dot dot--${tone === 'ok' ? 'ok' : tone === 'danger' ? 'danger' : 'idle'}`} />
                  <h3>{mapping.name}</h3>
                  <div className="mapping__actions">
                    <IconButton label="编辑" onClick={() => openEdit(mapping)}>
                      <IconEdit size={15} />
                    </IconButton>
                    <IconButton label="删除" tone="danger" onClick={() => setDeleting(mapping)}>
                      <IconTrash size={15} />
                    </IconButton>
                  </div>
                </div>

                <div className="mapping__route">
                  <div className="route-node">
                    <span className="route-node__label">A 本机</span>
                    <code>127.0.0.1:{mapping.localPort}</code>
                  </div>
                  <span className="route-arrow"><IconArrow size={16} /></span>
                  <div className="route-node route-node--target">
                    <span className="route-node__label">B 侧目标</span>
                    <code>
                      {mapping.targetHost}:{mapping.targetPort}
                    </code>
                  </div>
                </div>

                <div className="mapping__spark">
                  <Sparkline series={series.down} secondary={series.up} height={38} tone={mapping.enabled ? 'accent' : 'ok'} />
                </div>

                <div className="mapping__stats">
                  <div>
                    <span>连接</span>
                    <strong>{runtime.activeConnections}</strong>
                  </div>
                  <div>
                    <span>下行</span>
                    <strong>{formatRate(runtime.rateIn)}</strong>
                  </div>
                  <div>
                    <span>累计</span>
                    <strong>{formatBytes(runtime.bytesIn + runtime.bytesOut)}</strong>
                  </div>
                </div>

                {runtime.lastError ? <p className="inline-error">{runtime.lastError}</p> : null}

                <div className="mapping__foot">
                  <span className={`mapping__state${mapping.enabled && runtime.listening ? ' mapping__state--live' : ''}`}>
                    {mapping.enabled
                      ? runtime.listening
                        ? '监听中'
                        : '等待隧道'
                      : '已停用'}
                  </span>
                  <div className="mapping__badges">
                    {mapping.syncFirewall && isBLocalTarget(mapping.targetHost) ? (
                      <Badge tone="neutral">
                        <IconShield size={12} /> 防火墙同步
                      </Badge>
                    ) : null}
                    <Toggle
                      checked={mapping.enabled}
                      onChange={(next) => void toggle(mapping, next)}
                      label={`启用 ${mapping.name}`}
                    />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Drawer
        open={drawerOpen}
        title={editing ? '编辑映射' : '新建端口映射'}
        subtitle={editing ? `映射 ID ${editing.id}` : '保存后立即生效，无需重启'}
        onClose={() => setDrawerOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              {editing ? '保存修改' : '创建映射'}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="名称" hint="用于在列表中识别，例如「远程桌面」">
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="远程桌面"
            />
          </Field>

          <div className="form__row">
            <Field label="A 本地端口" hint="访问 127.0.0.1:该端口">
              <input
                className="input input--mono"
                value={form.localPort}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, localPort: event.target.value })}
              />
            </Field>
            <Field label="B 侧端口" hint="B 上服务实际监听的端口">
              <input
                className="input input--mono"
                value={form.targetPort}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, targetPort: event.target.value })}
              />
            </Field>
          </div>

          <Field label="B 侧目标地址" hint="仅 localhost / 127.0.0.1 / ::1 视为 B 本机会同步防火墙；填其它 IP 或域名时不会在 B 上创建规则">
            <input
              className="input input--mono"
              value={form.targetHost}
              onChange={(event) => setForm({ ...form, targetHost: event.target.value })}
              placeholder="127.0.0.1"
            />
          </Field>

          <div className="form__switch">
            <div>
              <strong>创建后立即启用</strong>
              <p>关闭后仅保存配置，稍后可手动启用。</p>
            </div>
            <Toggle checked={form.enabled} onChange={(next) => setForm({ ...form, enabled: next })} label="启用映射" />
          </div>

          <div className="form__switch">
            <div>
              <strong>在 B 上同步防火墙规则</strong>
              {!targetIsBLocal ? (
                <p>目标地址不是 B 本机，B 上不需要开放端口，同步会被忽略（不会创建规则）。若这确实是 B 本机，请改填 127.0.0.1。</p>
              ) : form.syncFirewall ? (
                <p>自动为 {form.targetPort || '目标端口'} 创建 / 修复入站 + 出站 TCP 规则；删除映射时一并清理，避免规则堆积。</p>
              ) : (
                <p>已关闭同步：现有规则保留，但不会自动补建或修复；删除映射时仍会清理对应规则。</p>
              )}
            </div>
            <Toggle
              checked={form.syncFirewall && targetIsBLocal}
              disabled={!targetIsBLocal}
              onChange={(next) => setForm({ ...form, syncFirewall: next })}
              label="同步防火墙"
            />
          </div>

          {formError ? <p className="form__error">{formError}</p> : null}

          <p className="form__note">
            <IconBolt size={14} /> 本地端口会被立即占用；若冲突，程序会提示具体端口并保留原配置。
          </p>
        </div>
      </Drawer>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除这条映射？"
        description={
          <>
            将停止本地监听，并删除 B 上对应的 <code>TunnelDesk-{deleting?.id}</code> 入站/出站防火墙规则。
          </>
        }
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
