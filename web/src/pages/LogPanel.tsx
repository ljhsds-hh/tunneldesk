import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatDateTime } from '../api';
import { IconRefresh, IconSearch } from '../icons';
import { Badge, Button, CopyButton, Drawer, EmptyState } from '../ui';
import { useApp } from '../App';
import type { LogEntry } from '../types';

type LevelFilter = 'all' | 'problem' | 'error';

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

/** Cheap equality check: same length and same tail entry means no new logs. */
function isSameSnapshot(prev: LogEntry[], next: LogEntry[]): boolean {
  if (prev.length !== next.length) return false;
  if (prev.length === 0) return true;
  const prevLast = prev[prev.length - 1];
  const nextLast = next[next.length - 1];
  return (
    prevLast?.id === nextLast?.id &&
    prevLast?.at === nextLast?.at &&
    prevLast?.message === nextLast?.message
  );
}

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
  const inFlight = useRef(false);

  const load = useCallback(async (showSpinner = false) => {
    // Localhost is fast, but a slow request must not stack up behind the 3s
    // interval or make the refresh button flicker on every poll.
    if (inFlight.current) return;
    inFlight.current = true;
    if (showSpinner) setLoading(true);
    try {
      const result = await api.logs();
      // Skip the state update when nothing changed so a full re-render of the
      // list is not triggered for no reason.
      setEntries((prev) => (isSameSnapshot(prev, result.logs) ? prev : result.logs));
      setFailed(null);
    } catch (error) {
      setFailed((error as Error).message);
    } finally {
      inFlight.current = false;
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load(true);
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [open, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = entries.filter((entry) => {
      if (level === 'error' && entry.level !== 'error') return false;
      if (level === 'problem' && entry.level === 'info') return false;
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
      subtitle={`内存中保留 ${entries.length} 条 · 超长输出已自动截断 · 同时按天写入本机文件`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">
            显示 {visible.length} / {entries.length} 条
          </span>
          <Button
            variant="secondary"
            icon={<IconRefresh />}
            loading={loading}
            onClick={() => void load(true)}
          >
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
            <button
              className={level === 'problem' ? 'is-active' : ''}
              title="显示警告与错误"
              onClick={() => setLevel('problem')}
            >
              问题 {problems > 0 ? `(${problems})` : ''}
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
              <span className="log-row__msg" title={entry.message}>
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
