import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatDateTime } from '../api';
import { IconRefresh, IconSearch } from '../icons';
import { Badge, Button, CopyButton, Drawer, EmptyState } from '../ui';
import { useApp } from '../App';
import type { LogEntry } from '../types';

type LevelFilter = 'all' | 'warn' | 'error';

const LEVEL_TONE: Record<LogEntry['level'], 'neutral' | 'warn' | 'danger'> = {
  info: 'neutral',
  warn: 'warn',
  error: 'danger',
};

const LEVEL_TEXT: Record<LogEntry['level'], string> = {
  info: '信息',
  warn: '警告',
  error: '错误',
};

/**
 * Full in-memory log buffer (`GET /api/logs`). The SSE snapshot only carries
 * the last handful of entries so the stream stays small; this drawer is where
 * the whole ring buffer - and the on-disk log location - is reachable.
 */
export function LogPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snap } = useApp();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.logs();
      setEntries(result.logs);
      setFailed(null);
    } catch (error) {
      setFailed((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [open, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = entries.filter((entry) => {
      if (level === 'error' && entry.level !== 'error') return false;
      if (level === 'warn' && entry.level === 'info') return false;
      if (!needle) return true;
      return `${entry.scope} ${entry.message}`.toLowerCase().includes(needle);
    });
    return matched.slice().reverse();
  }, [entries, level, query]);

  const problems = entries.filter((entry) => entry.level !== 'info').length;
  const logsDir = snap ? `${snap.dataDir}\\logs` : '—';

  return (
    <Drawer
      open={open}
      title="运行日志"
      subtitle={`内存中保留 ${entries.length} 条 · 同时按天写入本机文件`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">
            显示 {visible.length} / {entries.length} 条
          </span>
          <Button variant="secondary" icon={<IconRefresh />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </>
      }
    >
      <div className="log-tools">
        <div className="log-tools__row">
          <div className="segmented">
            <button className={level === 'all' ? 'is-active' : ''} onClick={() => setLevel('all')}>
              全部
            </button>
            <button className={level === 'warn' ? 'is-active' : ''} onClick={() => setLevel('warn')}>
              警告 {problems > 0 ? `(${problems})` : ''}
            </button>
            <button className={level === 'error' ? 'is-active' : ''} onClick={() => setLevel('error')}>
              错误
            </button>
          </div>
          <div className="search log-tools__search">
            <IconSearch size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模块或内容"
              aria-label="搜索日志"
            />
          </div>
        </div>
        <div className="log-tools__path">
          <span className="muted small">日志目录</span>
          <code>{logsDir}</code>
          <CopyButton value={logsDir} label="复制路径" />
        </div>
      </div>

      {failed ? <p className="inline-error">读取日志失败：{failed}</p> : null}

      {visible.length === 0 ? (
        <EmptyState
          icon={<IconSearch size={24} />}
          title={entries.length === 0 ? '暂无日志' : '没有匹配的日志'}
          description={
            entries.length === 0
              ? '连接主机、创建映射或启用代理后，这里会记录每一步。'
              : '换一个关键词，或把过滤条件切回「全部」。'
          }
        />
      ) : (
        <div className="log-list">
          {visible.map((entry) => (
            <div key={entry.id} className={`log-row log-row--${entry.level}`}>
              <span className="log-row__time mono">{formatDateTime(entry.at)}</span>
              <Badge tone={LEVEL_TONE[entry.level]}>{LEVEL_TEXT[entry.level]}</Badge>
              <span className="log-row__scope mono">{entry.scope}</span>
              <span className="log-row__msg">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
