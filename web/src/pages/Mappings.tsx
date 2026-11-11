import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { api, formatBytes, formatRate } from '../api';
import {
  IconArrow,
  IconBolt,
  IconChevron,
  IconEdit,
  IconGrip,
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
  group: string;
  localPort: string;
  targetHost: string;
  targetPort: string;
  enabled: boolean;
  syncFirewall: boolean;
}

interface GroupSection {
  name: string;
  items: Mapping[];
}

const EMPTY_FORM: FormState = {
  name: '',
  group: '',
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

/** 分组名最大长度，与 server/src/config/groups.ts 保持一致。 */
const GROUP_NAME_MAX = 24;
const GROUP_SUGGESTIONS = ['数据库', '远程桌面', 'Web', '文件共享', '其他'];
const UNGROUPED_LABEL = '未分组';
const COLLAPSED_KEY = 'tunneldesk.mappings.collapsed-groups';

/** Mirrors server/src/config/groups.ts normalizeGroupName. */
function normalizeGroupName(value: string): string {
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text === UNGROUPED_LABEL) return '';
  return Array.from(text).slice(0, GROUP_NAME_MAX).join('').trim();
}

function groupLabel(name: string): string {
  return name || UNGROUPED_LABEL;
}

function readCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
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

  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);

  const [draggingMapping, setDraggingMapping] = useState<Mapping | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupDrop, setGroupDrop] = useState<{ name: string; before: boolean } | null>(null);

  const targetIsBLocal = isBLocalTarget(form.targetHost);
  const mappings = snap?.mappings ?? [];
  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  const filtered = useMemo(() => {
    if (!needle) return mappings;
    return mappings.filter(
      (mapping) =>
        mapping.name.toLowerCase().includes(needle) ||
        mapping.group.toLowerCase().includes(needle) ||
        String(mapping.localPort).includes(needle) ||
        String(mapping.targetPort).includes(needle) ||
        mapping.targetHost.toLowerCase().includes(needle),
    );
  }, [mappings, needle]);

  const groupSections = useMemo(() => {
    const byName = new Map<string, Mapping[]>();
    for (const mapping of mappings) {
      const name = normalizeGroupName(mapping.group);
      const bucket = byName.get(name);
      if (bucket) bucket.push(mapping);
      else byName.set(name, [mapping]);
    }
    const ordered: GroupSection[] = [];
    const seen = new Set<string>();
    for (const raw of snap?.mappingGroupOrder ?? []) {
      const name = normalizeGroupName(raw);
      const items = byName.get(name);
      if (!name || !items || seen.has(name)) continue;
      seen.add(name);
      ordered.push({ name, items });
    }
    for (const [name, items] of byName) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      ordered.push({ name, items });
    }
    return { ordered, ungrouped: byName.get('') ?? [] };
  }, [mappings, snap?.mappingGroupOrder]);

  const hasGroups = groupSections.ordered.length > 0;
  const showUngrouped =
    groupSections.ungrouped.length > 0 || draggingMapping !== null || dropGroup === '';
  const groupSuggestions = useMemo(
    () => Array.from(new Set([...groupSections.ordered.map((group) => group.name), ...GROUP_SUGGESTIONS])),
    [groupSections.ordered],
  );

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {
      /* storage may be unavailable in private mode */
    }
  }, [collapsed]);

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
      group: mapping.group,
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
        group: normalizeGroupName(form.group),
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

  const toggleCollapsed = (name: string) => {
    setCollapsed((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name],
    );
  };

  const moveMapping = async (mapping: Mapping, targetRaw: string) => {
    const target = normalizeGroupName(targetRaw);
    if (normalizeGroupName(mapping.group) === target) return;
    try {
      await api.updateMapping(mapping.id, { group: target });
      toast(
        target
          ? `「${mapping.name}」已移动到「${target}」`
          : `「${mapping.name}」已移出分组`,
        'ok',
      );
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const submitRename = async () => {
    if (!renaming) return;
    const to = normalizeGroupName(renaming.value);
    if (!to) {
      toast('分组名称不能为空（「未分组」是保留名称）', 'error');
      return;
    }
    if (to === renaming.from) {
      setRenaming(null);
      return;
    }
    setRenameBusy(true);
    try {
      const result = await api.renameMappingGroup(renaming.from, to);
      toast(
        result.renamed > 0
          ? `分组已重命名为「${result.name}」，${result.renamed} 条映射已更新`
          : `分组已重命名为「${result.name}」`,
        'ok',
      );
      setCollapsed((prev) => prev.map((name) => (name === renaming.from ? result.name : name)));
      setRenaming(null);
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDeleteGroup = async () => {
    if (!deletingGroup) return;
    setGroupBusy(true);
    try {
      const result = await api.deleteMappingGroup(deletingGroup);
      toast(`分组已删除，${result.moved} 条映射移至「${UNGROUPED_LABEL}」`, 'ok');
      setCollapsed((prev) => prev.filter((name) => name !== deletingGroup));
      setDeletingGroup(null);
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setGroupBusy(false);
    }
  };

  const reorderGroups = async (dragged: string, target: string, before: boolean) => {
    const names = groupSections.ordered.map((group) => group.name);
    const rest = names.filter((name) => name !== dragged);
    let index = rest.indexOf(target);
    if (index < 0) return;
    if (!before) index += 1;
    rest.splice(index, 0, dragged);
    if (rest.join('\u0000') === names.join('\u0000')) return;
    try {
      await api.setMappingGroupOrder(rest);
      toast('分组顺序已保存', 'ok');
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const startCardDrag = (mapping: Mapping) => (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', mapping.id);
    setDraggingMapping(mapping);
  };

  const endCardDrag = () => {
    setDraggingMapping(null);
    setDropGroup(null);
  };

  const handleSectionDragOver = (name: string) => (event: DragEvent<HTMLElement>) => {
    if (!draggingMapping) return;
    if (normalizeGroupName(draggingMapping.group) === name) {
      setDropGroup((prev) => (prev === name ? null : prev));
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropGroup !== name) setDropGroup(name);
  };

  const handleSectionDragLeave = (name: string) => (event: DragEvent<HTMLElement>) => {
    if (!draggingMapping) return;
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropGroup((prev) => (prev === name ? null : prev));
  };

  const handleSectionDrop = (name: string) => (event: DragEvent<HTMLElement>) => {
    if (!draggingMapping) return;
    event.preventDefault();
    const mapping = draggingMapping;
    setDraggingMapping(null);
    setDropGroup(null);
    void moveMapping(mapping, name);
  };

  const startGroupDrag = (name: string) => (event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', name);
    setDraggingGroup(name);
  };

  const endGroupDrag = () => {
    setDraggingGroup(null);
    setGroupDrop(null);
  };

  const handleGroupDragOver = (name: string) => (event: DragEvent<HTMLElement>) => {
    if (!draggingGroup) return;
    if (draggingGroup === name) {
      setGroupDrop(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    setGroupDrop((prev) =>
      prev && prev.name === name && prev.before === before ? prev : { name, before },
    );
  };

  const handleGroupDragLeave = (name: string) => (event: DragEvent<HTMLElement>) => {
    if (!draggingGroup) return;
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setGroupDrop((prev) => (prev?.name === name ? null : prev));
  };

  const handleGroupDrop = (name: string) => (event: DragEvent<HTMLElement>) => {
    if (!draggingGroup) return;
    event.preventDefault();
    event.stopPropagation();
    const dragged = draggingGroup;
    const before = groupDrop?.name === name ? groupDrop.before : true;
    setDraggingGroup(null);
    setGroupDrop(null);
    if (dragged === name) return;
    void reorderGroups(dragged, name, before);
  };

  const renderCard = (mapping: Mapping, showGroup: boolean, canDrag: boolean) => {
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
      <Card
        key={mapping.id}
        className={`mapping${mapping.enabled ? '' : ' mapping--off'}${canDrag ? ' mapping--draggable' : ''}${
          draggingMapping?.id === mapping.id ? ' mapping--dragging' : ''
        }`}
        draggable={canDrag}
        onDragStart={canDrag ? startCardDrag(mapping) : undefined}
        onDragEnd={canDrag ? endCardDrag : undefined}
      >
        <div className="mapping__head">
          <span className={`dot dot--${tone === 'ok' ? 'ok' : tone === 'danger' ? 'danger' : 'idle'}`} />
          <h3>{mapping.name}</h3>
          {showGroup ? <Badge tone="neutral">{groupLabel(mapping.group)}</Badge> : null}
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
          <span className="route-arrow">
            <IconArrow size={16} />
          </span>
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
            {mapping.enabled ? (runtime.listening ? '监听中' : '等待隧道') : '已停用'}
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
  };

  const renderGroup = (group: GroupSection) => {
    const isUngrouped = group.name === '';
    const isCollapsed = collapsed.includes(group.name);
    const enabled = group.items.filter((item) => item.enabled).length;
    const live = group.items.filter((item) => item.enabled && item.runtime.listening).length;
    const isDropTarget = dropGroup === group.name;
    const before = !isUngrouped && groupDrop?.name === group.name && groupDrop.before;
    const after = !isUngrouped && groupDrop?.name === group.name && !groupDrop.before;
    const className = [
      'mapping-group',
      isCollapsed ? 'mapping-group--collapsed' : '',
      isDropTarget ? 'mapping-group--drop' : '',
      draggingGroup === group.name ? 'mapping-group--dragging' : '',
      before ? 'mapping-group--drop-before' : '',
      after ? 'mapping-group--drop-after' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const isRenaming = renaming?.from === group.name;

    return (
      <section
        key={group.name || '__ungrouped'}
        className={className}
        aria-label={groupLabel(group.name)}
        onDragOver={handleSectionDragOver(group.name)}
        onDragLeave={handleSectionDragLeave(group.name)}
        onDrop={handleSectionDrop(group.name)}
      >
        <header
          className="mapping-group__head"
          onDragOver={isUngrouped ? undefined : handleGroupDragOver(group.name)}
          onDragLeave={isUngrouped ? undefined : handleGroupDragLeave(group.name)}
          onDrop={isUngrouped ? undefined : handleGroupDrop(group.name)}
        >
          {isUngrouped ? (
            <span className="mapping-group__grip mapping-group__grip--static" aria-hidden="true">
              <IconGrip size={16} />
            </span>
          ) : (
            <button
              type="button"
              className="mapping-group__grip"
              draggable
              onDragStart={startGroupDrag(group.name)}
              onDragEnd={endGroupDrag}
              aria-label={`拖动排序分组「${group.name}」`}
              title="拖动排序分组"
            >
              <IconGrip size={16} />
            </button>
          )}

          {isRenaming && renaming ? (
            <form
              className="mapping-group__rename"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void submitRename();
              }}
            >
              <input
                className="input"
                value={renaming.value}
                maxLength={GROUP_NAME_MAX}
                autoFocus
                aria-label="新的分组名称"
                onChange={(event) => setRenaming({ from: renaming.from, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(null);
                }}
              />
              <Button type="submit" size="sm" variant="primary" loading={renameBusy}>
                保存
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                取消
              </Button>
            </form>
          ) : (
            <button
              type="button"
              className="mapping-group__toggle"
              aria-expanded={!isCollapsed}
              onClick={() => toggleCollapsed(group.name)}
            >
              <span className="mapping-group__chev">
                <IconChevron size={16} />
              </span>
              <span className="mapping-group__name">{groupLabel(group.name)}</span>
              <span className="mapping-group__count">{group.items.length}</span>
              <span className="mapping-group__summary">
                {enabled} 启用 · {live} 监听中
              </span>
            </button>
          )}

          {!isUngrouped && !isRenaming ? (
            <div className="mapping-group__actions">
              <IconButton
                label={`重命名分组「${group.name}」`}
                onClick={() => setRenaming({ from: group.name, value: group.name })}
              >
                <IconEdit size={15} />
              </IconButton>
              <IconButton label={`删除分组「${group.name}」`} tone="danger" onClick={() => setDeletingGroup(group.name)}>
                <IconTrash size={15} />
              </IconButton>
            </div>
          ) : null}
        </header>

        {!isCollapsed ? (
          group.items.length > 0 ? (
            <div className="mapping-grid">{group.items.map((mapping) => renderCard(mapping, false, true))}</div>
          ) : (
            <div className="mapping-group__empty">拖到这里即可移出分组</div>
          )
        ) : null}
      </section>
    );
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
            placeholder="搜索名称、分组、端口或目标地址"
            aria-label="搜索映射"
          />
        </div>
        <div className="toolbar__meta">
          <span className="muted small">
            {mappings.filter((mapping) => mapping.enabled).length} 条启用 · {mappings.length} 条总计
          </span>
          {!searching && hasGroups ? (
            <div className="toolbar__actions">
              <Button size="sm" variant="quiet" onClick={() => setCollapsed([])}>
                全部展开
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() =>
                  setCollapsed([
                    ...groupSections.ordered.map((group) => group.name),
                    ...(groupSections.ungrouped.length > 0 ? [''] : []),
                  ])
                }
              >
                全部收起
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {mappings.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconPorts size={26} />}
            title="还没有端口映射"
            description="例如：把 B 的 3389 映射到本机 13389，然后用远程桌面连接 127.0.0.1:13389。"
            action={
              <Button variant="primary" icon={<IconPlus />} onClick={() => void openCreate()} disabled={!snap?.host}>
                创建第一条映射
              </Button>
            }
          />
        </Card>
      ) : searching ? (
        filtered.length === 0 ? (
          <Card>
            <EmptyState
              icon={<IconPorts size={26} />}
              title="没有匹配的映射"
              description="换一个关键词试试，或清空搜索。"
            />
          </Card>
        ) : (
          <div className="mapping-grid">{filtered.map((mapping) => renderCard(mapping, true, false))}</div>
        )
      ) : hasGroups ? (
        <div className="mapping-groups">
          {groupSections.ordered.map((group) => renderGroup(group))}
          {showUngrouped ? renderGroup({ name: '', items: groupSections.ungrouped }) : null}
        </div>
      ) : (
        <div className="mapping-grid">{mappings.map((mapping) => renderCard(mapping, false, false))}</div>
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

          <Field label="分组" hint="留空即为「未分组」。可以从建议中选择，也可以直接输入新的分组名。">
            <input
              className="input"
              list="mapping-group-suggestions"
              value={form.group}
              maxLength={GROUP_NAME_MAX}
              onChange={(event) => setForm({ ...form, group: event.target.value })}
              placeholder="例如：数据库"
            />
            <datalist id="mapping-group-suggestions">
              {groupSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
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

      <ConfirmDialog
        open={Boolean(deletingGroup)}
        title={`删除分组「${deletingGroup ?? ''}」？`}
        description={`组内映射会移动到「${UNGROUPED_LABEL}」，映射本身、本地监听和 B 侧防火墙规则都保持不变。`}
        confirmText="删除分组"
        busy={groupBusy}
        onCancel={() => setDeletingGroup(null)}
        onConfirm={() => void confirmDeleteGroup()}
      />
    </>
  );
}
