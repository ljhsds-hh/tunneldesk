import { useState } from 'react';
import { api, formatDuration } from '../api';
import { IconBolt, IconClock, IconLock, IconMoon, IconServer, IconSun } from '../icons';
import { Badge, Button, Card, CopyButton, Field, PageHeader, Toggle } from '../ui';
import { useApp } from '../App';
import { APP_VERSION } from '../version';

export function SettingsPage() {
  const { snap, refresh, toast, theme, toggleTheme } = useApp();
  const [logLimit, setLogLimit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reconnect = snap?.settings.reconnect ?? true;

  const setReconnect = async (value: boolean) => {
    try {
      await api.updateSettings({ reconnect: value });
      toast(value ? '自动重连已启用' : '自动重连已关闭', 'info');
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const saveLogLimit = async () => {
    if (!snap || logLimit === null) return;
    const value = Number(logLimit);
    if (!Number.isInteger(value) || value < 20 || value > 1000) {
      toast('日志条数需在 20–1000 之间', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.updateProxy({ logLimit: value });
      toast('日志上限已更新', 'ok');
      setLogLimit(null);
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="PREFERENCES"
        title="设置"
        description="外观、连接行为与本地数据。所有配置都保存在本机，不上传任何位置。"
      />

      <div className="grid grid--two">
        <Card className="panel">
          <div className="card-head">
            <div>
              <h3>外观</h3>
              <p>选择控制台的配色方案</p>
            </div>
            {theme === 'dark' ? <IconMoon size={16} className="muted" /> : <IconSun size={16} className="muted" />}
          </div>
          <div className="theme-picker">
            <button
              className={`theme-option${theme === 'dark' ? ' theme-option--active' : ''}`}
              onClick={() => theme !== 'dark' && toggleTheme()}
            >
              <span className="theme-option__preview theme-option__preview--dark">
                <span />
                <span />
                <span />
              </span>
              <span className="theme-option__foot">
                <span className="theme-option__label">
                  深色 <small>默认，适合长时间值守</small>
                </span>
                {theme === 'dark' ? <Badge tone="accent">使用中</Badge> : null}
              </span>
            </button>
            <button
              className={`theme-option${theme === 'light' ? ' theme-option--active' : ''}`}
              onClick={() => theme !== 'light' && toggleTheme()}
            >
              <span className="theme-option__preview theme-option__preview--light">
                <span />
                <span />
                <span />
              </span>
              <span className="theme-option__foot">
                <span className="theme-option__label">
                  浅色 <small>明亮环境下更清晰</small>
                </span>
                {theme === 'light' ? <Badge tone="accent">使用中</Badge> : null}
              </span>
            </button>
          </div>
        </Card>

        <Card className="panel">
          <div className="card-head">
            <div>
              <h3>连接行为</h3>
              <p>隧道断开后的处理方式</p>
            </div>
            <IconBolt size={16} className="muted" />
          </div>
          <div className="settings-toggle">
            <div>
              <strong>断线自动重连</strong>
              <p>指数退避（1s → 30s），重连成功后自动恢复监听与防火墙规则。</p>
            </div>
            <Toggle checked={reconnect} onChange={(next) => void setReconnect(next)} label="自动重连" />
          </div>
          <div className="settings-row">
            <Field label="代理日志保留条数" hint="仅保存在内存，重启后清空">
              <div className="inline-field">
                <input
                  className="input input--mono"
                  value={logLimit ?? String(snap?.proxy.logLimit ?? 200)}
                  inputMode="numeric"
                  onChange={(event) => setLogLimit(event.target.value)}
                />
                <Button variant="secondary" loading={saving} disabled={logLimit === null} onClick={() => void saveLogLimit()}>
                  应用
                </Button>
              </div>
            </Field>
          </div>
        </Card>
      </div>

      <Card className="panel">
        <div className="card-head">
          <div>
            <h3>本机数据</h3>
            <p>配置、密钥与备份位置</p>
          </div>
          <IconLock size={16} className="muted" />
        </div>
        <div className="data-rows">
          <div className="data-row">
            <span>配置目录</span>
            <code>{snap?.dataDir ?? '%APPDATA%\\TunnelDesk'}</code>
            <CopyButton value={snap?.dataDir ?? ''} />
          </div>
          <div className="data-row">
            <span>私钥存储</span>
            <code>{snap ? `${snap.dataDir}\\keys` : '—'}</code>
            <CopyButton value={snap ? `${snap.dataDir}\\keys` : ''} />
          </div>
          <div className="data-row">
            <span>运行日志</span>
            <code>{snap ? `${snap.dataDir}\\logs` : '—'}</code>
            <CopyButton value={snap ? `${snap.dataDir}\\logs` : ''} />
          </div>
          <div className="data-row">
            <span>运行时长</span>
            <code>{snap ? formatDuration(snap.uptimeMs) : '—'}</code>
            <Badge tone="ok" dot>
              运行中
            </Badge>
          </div>
        </div>
        <div className="callout">
          <IconServer size={15} />
          <p>
            删除配置目录会同时清除密钥与所有映射；如需迁移到另一台 A，只需复制该目录并重新确认 B 的主机指纹。
          </p>
        </div>
      </Card>

      <Card className="panel panel--about">
        <div className="about">
          <div>
            <span className="eyebrow">ABOUT</span>
            <h3>TunnelDesk</h3>
            <p>
              面向个人工作流的 SSH 访问控制台：端口映射与内网 HTTP 代理分离为两个业务，B 端零安装。版本{' '}
              {snap?.version ?? APP_VERSION} · MIT。
            </p>
          </div>
          <ul className="about__facts">
            <li>
              <IconClock size={14} /> 指标每秒推送（SSE），不做轮询
            </li>
            <li>
              <IconLock size={14} /> 密码不落盘，登录一律使用密钥
            </li>
            <li>
              <IconBolt size={14} /> 监听默认仅绑定 127.0.0.1
            </li>
          </ul>
        </div>
      </Card>
    </>
  );
}
