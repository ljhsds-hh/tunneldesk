import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { AppSnapshot } from './types';
import {
  IconClose,
  IconGlobe,
  IconMoon,
  IconOverview,
  IconPorts,
  IconServer,
  IconSettings,
  IconSun,
} from './icons';
import { StatusPill } from './ui';
import { OverviewPage } from './pages/Overview';
import { MappingsPage } from './pages/Mappings';
import { ProxyPage } from './pages/Proxy';
import { ConnectionPage } from './pages/Connection';
import { SettingsPage } from './pages/Settings';

export type Route = 'overview' | 'mappings' | 'proxy' | 'connection' | 'settings';

export interface Series {
  down: number[];
  up: number[];
}

export interface ToastItem {
  id: number;
  tone: 'ok' | 'error' | 'info';
  message: string;
}

interface AppContextValue {
  snap: AppSnapshot | null;
  refresh: () => Promise<void>;
  toast: (message: string, tone?: ToastItem['tone']) => void;
  history: { total: Series; mappings: Record<string, Series> };
  route: Route;
  navigate: (route: Route) => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppContext missing');
  return value;
}

const NAV: Array<{ key: Route; label: string; icon: JSX.Element; hint: string }> = [
  { key: 'overview', label: '概览', icon: <IconOverview />, hint: '整体运行状态' },
  { key: 'mappings', label: '端口映射', icon: <IconPorts />, hint: 'A 本地端口 → B' },
  { key: 'proxy', label: '内网代理', icon: <IconGlobe />, hint: '经 B 访问内网 HTTP' },
  { key: 'connection', label: '连接管理', icon: <IconServer />, hint: '主机、密钥与防火墙' },
  { key: 'settings', label: '设置', icon: <IconSettings />, hint: '偏好与数据' },
];

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (NAV.find((item) => item.key === hash)?.key ?? 'overview') as Route;
}

export default function App() {
  const [snap, setSnap] = useState<AppSnapshot | null>(null);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('tunneldesk-theme') === 'light' ? 'light' : 'dark'),
  );
  const [history, setHistory] = useState<{ total: Series; mappings: Record<string, Series> }>({
    total: { down: [], up: [] },
    mappings: {},
  });

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setSnap(next);
    } catch {
      /* the SSE stream will recover */
    }
  }, []);

  const toast = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, tone, message }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 4200);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('tunneldesk-theme', next);
      void api.updateSettings({ theme: next }).catch(() => undefined);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!snap) return;
    if (localStorage.getItem('tunneldesk-theme')) return;
    setTheme(snap.settings.theme);
  }, [snap?.serverTime]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.hash = '#/overview';
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    void refresh();
    const source = new EventSource('/api/events');
    source.onmessage = (event) => {
      try {
        setSnap(JSON.parse(event.data) as AppSnapshot);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, [refresh]);

  useEffect(() => {
    if (!snap) return;
    const totalDown = snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.rateIn, 0) + snap.proxy.runtime.rateIn;
    const totalUp = snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.rateOut, 0) + snap.proxy.runtime.rateOut;
    setHistory((prev) => {
      const nextMappings: Record<string, Series> = {};
      for (const mapping of snap.mappings) {
        const previous = prev.mappings[mapping.id] ?? { down: [], up: [] };
        nextMappings[mapping.id] = {
          down: [...previous.down, mapping.runtime.rateIn].slice(-60),
          up: [...previous.up, mapping.runtime.rateOut].slice(-60),
        };
      }
      return {
        total: {
          down: [...prev.total.down, totalDown].slice(-60),
          up: [...prev.total.up, totalUp].slice(-60),
        },
        mappings: nextMappings,
      };
    });
  }, [snap?.serverTime]);

  const value = useMemo<AppContextValue>(
    () => ({ snap, refresh, toast, history, route, navigate, theme, toggleTheme }),
    [snap, refresh, toast, history, route, navigate, theme, toggleTheme],
  );

  const Page =
    route === 'mappings'
      ? MappingsPage
      : route === 'proxy'
        ? ProxyPage
        : route === 'connection'
          ? ConnectionPage
          : route === 'settings'
            ? SettingsPage
            : OverviewPage;

  const activeCount = snap?.mappings.filter((mapping) => mapping.enabled).length ?? 0;

  return (
    <AppContext.Provider value={value}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand__mark">
              <IconPorts size={20} />
            </span>
            <span className="brand__text">
              <strong>TunnelDesk</strong>
              <small>Secure Access Console</small>
            </span>
          </div>

          <nav className="nav" aria-label="主导航">
            <span className="nav__label">工作区</span>
            {NAV.map((item) => (
              <button
                key={item.key}
                className={`nav__item${route === item.key ? ' nav__item--active' : ''}`}
                onClick={() => navigate(item.key)}
                title={item.hint}
              >
                <span className="nav__icon">{item.icon}</span>
                <span className="nav__text">{item.label}</span>
                {item.key === 'mappings' && activeCount > 0 ? <span className="nav__count">{activeCount}</span> : null}
                {item.key === 'proxy' && snap?.proxy.enabled ? <span className="nav__live" /> : null}
              </button>
            ))}
          </nav>

          <div className="sidebar__foot">
            <div className="linkcard">
              <div className="linkcard__top">
                <span className="linkcard__name">{snap?.host?.name ?? '未配置主机'}</span>
                <button className="theme-btn" onClick={toggleTheme} aria-label="切换主题" title="切换主题">
                  {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
                </button>
              </div>
              <span className="linkcard__endpoint">
                {snap?.link.endpoint ?? '尚未连接 SSH'}
              </span>
              <StatusPill state={snap?.link.state ?? 'idle'} detail={snap?.link.lastError} />
            </div>
            <span className="sidebar__version">v0.1.0 · 本地控制台</span>
          </div>
        </aside>

        <main className="main">
          <div className="main__glow" aria-hidden="true" />
          <div className="page" key={route}>
            <Page />
          </div>
        </main>
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone}`}>
            <span className="toast__dot" />
            <span>{item.message}</span>
            <button aria-label="关闭" onClick={() => setToasts((prev) => prev.filter((entry) => entry.id !== item.id))}>
              <IconClose size={14} />
            </button>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
