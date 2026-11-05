import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { IconCheck, IconClose, IconCopy } from './icons';
import type { LinkState } from './types';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  block = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn--${variant} btn--${size}${block ? ' btn--block' : ''} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({
  label,
  children,
  tone = 'default',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'default' | 'danger' }) {
  return (
    <button className={`icon-btn icon-btn--${tone}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Card({
  className = '',
  children,
  as: Tag = 'section',
}: {
  className?: string;
  children: ReactNode;
  as?: 'section' | 'div' | 'article';
}) {
  return <Tag className={`card ${className}`.trim()}>{children}</Tag>;
}

export function Badge({
  tone = 'neutral',
  children,
  dot = false,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot ? <span className="badge__dot" /> : null}
      {children}
    </span>
  );
}

const STATE_LABEL: Record<LinkState, string> = {
  idle: '未连接',
  connecting: '连接中',
  authenticating: '认证中',
  online: '隧道在线',
  reconnecting: '重连中',
  offline: '已断开',
  error: '连接异常',
};

export function StatusPill({ state, detail }: { state: LinkState; detail?: string | null }) {
  const tone =
    state === 'online' ? 'ok' : state === 'reconnecting' || state === 'connecting' ? 'warn' : state === 'error' ? 'danger' : 'neutral';
  return (
    <span className={`status status--${tone}`} title={detail ?? undefined}>
      <span className={`status__dot${state === 'online' ? ' status__dot--live' : ''}`} />
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? ' switch--on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'accent' | 'ok' | 'warn';
}) {
  return (
    <div className={`stat stat--${tone}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
}

export function Sparkline({
  series,
  secondary,
  height = 44,
  showAxis = false,
  tone = 'accent',
  emptyLabel,
}: {
  series: number[];
  secondary?: number[];
  height?: number;
  showAxis?: boolean;
  tone?: 'accent' | 'ok';
  emptyLabel?: string;
}) {
  const id = useId().replace(/:/g, '');
  const data = series.length > 1 ? series : [0, 0];
  const other = secondary && secondary.length > 1 ? secondary : null;
  const all = other ? [...data, ...other] : data;
  const isEmpty = all.every((value) => value <= 0);
  const max = Math.max(1, ...all);
  const point = (value: number, index: number) => {
    const x = (index / Math.max(1, data.length - 1)) * 100;
    const y = 96 - (value / max) * 88;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
  const line = data.map(point).join(' ');
  const area = `0,100 ${line} 100,100`;
  const line2 = other
    ? other
        .map((value, index) => {
          const x = (index / Math.max(1, other.length - 1)) * 100;
          const y = 96 - (value / max) * 88;
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(' ')
    : null;

  return (
    <div className={`spark spark--${tone}`} style={{ height }}>
      {showAxis ? <div className="spark__grid" /> : null}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#fill-${id})`} />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {line2 ? (
          <polyline points={line2} fill="none" stroke="var(--accent-2)" strokeWidth="1.2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity="0.85" />
        ) : null}
      </svg>
      {isEmpty && emptyLabel ? <span className="spark__empty">{emptyLabel}</span> : null}
    </div>
  );
}

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={`copy${copied ? ' copy--done' : ''}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      {copied ? '已复制' : label}
    </button>
  );
}

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer__head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <IconClose />
          </IconButton>
        </header>
        <div className="drawer__body">{children}</div>
        {footer ? <footer className="drawer__foot">{footer}</footer> : null}
      </aside>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确认删除',
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmText?: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="overlay overlay--center">
      <div className="confirm" role="alertdialog" aria-modal="true">
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="confirm__actions">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Bars({ value, max }: { value: number; max: number }) {
  const ratio = Math.max(0.04, Math.min(1, max <= 0 ? 0 : value / max));
  return (
    <span className="bars" aria-hidden="true">
      <span style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}
