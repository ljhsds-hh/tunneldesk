import { useMemo } from 'react';
import { useApp } from '../App';
import { copyEndpoint, displayEndpoint } from '../endpoint';
import { buildGroupSections, groupLabel } from '../grouping';
import { IconCopy, IconEdit, IconList, IconPlus } from '../icons';
import { Button, Card, CopyButton, EmptyState, PageHeader } from '../ui';
import type { Mapping } from '../types';

function rowTone(mapping: Mapping): 'ok' | 'warn' | 'off' {
  if (!mapping.enabled) return 'off';
  return mapping.runtime.listening ? 'ok' : 'warn';
}

function rowStateLabel(mapping: Mapping): string {
  if (!mapping.enabled) return '已停用';
  if (mapping.runtime.listening) return '监听中';
  return mapping.runtime.lastError ?? '等待隧道';
}

function QuickRow({ mapping, onCopyError }: { mapping: Mapping; onCopyError: () => void }) {
  const tone = rowTone(mapping);
  const state = rowStateLabel(mapping);
  const shown = displayEndpoint(mapping);
  const copyValue = copyEndpoint(mapping);

  return (
    <li className={`quick-row${mapping.enabled ? '' : ' quick-row--off'}`}>
      <span
        className={`quick-row__dot quick-row__dot--${tone}`}
        role="img"
        aria-label={state}
        title={state}
      />
      <span className="quick-row__name" title={mapping.name}>
        {mapping.name}
      </span>
      <code className="quick-row__addr" title={shown}>
        {shown}
      </code>
      <CopyButton
        value={copyValue}
        ariaLabel={`复制「${mapping.name}」的访问地址 ${copyValue}`}
        onError={onCopyError}
      />
    </li>
  );
}

export function QuickListPage() {
  const { snap, navigate, toast } = useApp();
  const mappings = snap?.mappings ?? [];
  const grouped = useMemo(
    () => buildGroupSections(mappings, snap?.mappingGroupOrder),
    [mappings, snap?.mappingGroupOrder],
  );

  if (!snap) {
    return (
      <div className="loading">
        <span className="spinner spinner--lg" />
        <p>正在读取运行状态…</p>
      </div>
    );
  }

  const sections = [
    ...grouped.ordered,
    ...(grouped.ungrouped.length > 0 ? [{ name: '', items: grouped.ungrouped }] : []),
  ];
  const onCopyError = () => toast('复制失败，请手动选中地址复制', 'error');

  return (
    <>
      <PageHeader
        eyebrow="QUICK ACCESS"
        title="映射一览"
        description="按分组快速浏览本机访问地址，点一下就能复制，直接粘贴到浏览器或远程桌面客户端。"
        actions={
          <Button icon={<IconEdit />} onClick={() => navigate('mappings')}>
            管理映射
          </Button>
        }
      />

      <div className="callout">
        <IconCopy size={14} />
        <span>
          地址列显示真实绑定地址；本地回环/通配绑定复制时会统一成 <code>127.0.0.1:端口</code>，
          IPv6 回环 <code>::1</code> 保留原地址。
        </span>
      </div>

      {sections.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconList size={26} />}
            title="还没有端口映射"
            description="创建第一条映射后，这里会按分组列出所有本机访问地址。"
            action={
              <Button variant="primary" icon={<IconPlus />} onClick={() => navigate('mappings')}>
                去创建映射
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="quick-groups">
          {sections.map((group, index) => {
            const listening = group.items.filter(
              (mapping) => mapping.enabled && mapping.runtime.listening,
            ).length;
            const headingId = `quick-group-${index}`;
            return (
              <section
                key={group.name ? `group:${group.name}` : 'ungrouped'}
                className="quick-group"
                aria-labelledby={headingId}
              >
                <header className="quick-group__head">
                  <h2 className="quick-group__title" id={headingId}>
                    {groupLabel(group.name)}
                  </h2>
                  <span className="quick-group__count">{group.items.length}</span>
                  <span className="quick-group__meta">
                    {listening > 0 ? `${listening} 条监听中` : '暂无监听'}
                  </span>
                </header>
                <ul className="quick-list">
                  {group.items.map((mapping) => (
                    <QuickRow key={mapping.id} mapping={mapping} onCopyError={onCopyError} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
