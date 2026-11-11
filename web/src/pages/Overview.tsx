import { useState } from 'react';
import { api, formatBytes, formatDuration, formatRate, formatRelative } from '../api';
import {
  IconArrow,
  IconBolt,
  IconChevron,
  IconClock,
  IconGlobe,
  IconPorts,
  IconPower,
  IconServer,
} from '../icons';
import { Badge, Button, Card, PageHeader, Sparkline, StatTile, StatusPill } from '../ui';
import { useApp } from '../App';
import { LogPanel } from './LogPanel';

export function OverviewPage() {
  const { snap, history, navigate, toast } = useApp();
  const [logOpen, setLogOpen] = useState(false);

  if (!snap) {
    return (
      <div className="loading">
        <span className="spinner spinner--lg" />
        <p>正在读取运行状态…</p>
      </div>
    );
  }

  const online = snap.link.state === 'online';
  const activeMappings = snap.mappings.filter((mapping) => mapping.enabled);
  const listening = activeMappings.filter((mapping) => mapping.runtime.listening).length;
  const connections =
    snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.activeConnections, 0) +
    snap.proxy.runtime.activeConnections;
  const downRate =
    snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.rateIn, 0) + snap.proxy.runtime.rateIn;
  const upRate =
    snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.rateOut, 0) + snap.proxy.runtime.rateOut;
  const totalBytes =
    snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.bytesIn + mapping.runtime.bytesOut, 0) +
    snap.proxy.runtime.bytesIn +
    snap.proxy.runtime.bytesOut;
  const uptime = snap.link.since ? formatDuration(Date.now() - new Date(snap.link.since).getTime()) : '—';

  const connect = async () => {
    if (!snap.host) {
      navigate('connection');
      return;
    }
    try {
      if (online) {
        await api.disconnect(snap.host.id);
        toast('已断开隧道', 'info');
      } else {
        await api.connect(snap.host.id);
        toast('正在建立 SSH 隧道…', 'info');
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  if (!snap.host) {
    return (
      <>
        <PageHeader
          eyebrow="OVERVIEW"
          title="欢迎使用 TunnelDesk"
          description="一个入口，两条通路：把 B 的端口带到本机，把 B 的内网带到浏览器。"
          actions={
            <Button variant="primary" icon={<IconServer />} onClick={() => navigate('connection')}>
              配置第一台主机
            </Button>
          }
        />
        <Card className="onboarding">
          <div className="onboarding__art" aria-hidden="true">
            <span className="onboarding__node onboarding__node--a">A</span>
            <span className="onboarding__link" />
            <span className="onboarding__node onboarding__node--b">B</span>
            <span className="onboarding__pulse" />
          </div>
          <div className="onboarding__content">
            <h2>三步建立受控访问</h2>
            <ol className="steps">
              <li>
                <span>1</span>
                <div>
                  <strong>配置 B 的连接</strong>
                  <p>填写 IP、SSH 端口、账号与一次性密码，程序会自动换成密钥登录。</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>创建端口映射</strong>
                  <p>把 B 上的服务端口映射到本机回环地址，访问体验与本地服务一致。</p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>开启内网代理</strong>
                  <p>浏览器指向本机代理端口，即可打开只有 B 能访问的内网系统。</p>
                </div>
              </li>
            </ol>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="OVERVIEW"
        title="运行概览"
        description={
          <>
            {snap.host.name} · <span className="mono">{snap.link.endpoint}</span> · SSH 密钥登录
          </>
        }
        actions={
          <>
            <Button variant="ghost" icon={<IconServer />} onClick={() => navigate('connection')}>
              连接设置
            </Button>
            <Button
              variant={online ? 'secondary' : 'primary'}
              icon={<IconPower />}
              onClick={() => void connect()}
            >
              {online ? '断开隧道' : '建立连接'}
            </Button>
          </>
        }
      />

      <div className="grid grid--hero">
        <Card className="hero">
          <div className="hero__head">
            <div>
              <span className="eyebrow">TUNNEL HEALTH</span>
              <h2 className="hero__title">
                {online ? '链路稳定运行中' : snap.link.state === 'reconnecting' ? '正在重新建立链路' : '隧道当前不可用'}
              </h2>
              <p className="hero__sub">
                {online
                  ? `已保持 ${uptime} · ${
                      snap.settings.reconnect ? '自动重连已启用' : '自动重连已关闭'
                    }`
                  : snap.link.lastError ?? '点击“建立连接”开始使用，程序会自动重试并恢复服务'}
              </p>
            </div>
            <StatusPill state={snap.link.state} detail={snap.link.lastError} />
          </div>

          <div className="hero__chart">
            <Sparkline series={history.total.down} secondary={history.total.up} height={148} showAxis emptyLabel="等待流量" />
            <div className="hero__legend">
              <span className="legend legend--down">下行 {formatRate(downRate)}</span>
              <span className="legend legend--up">上行 {formatRate(upRate)}</span>
              <span className="legend legend--muted">最近 60 秒</span>
            </div>
          </div>

          <div className="hero__metrics">
            <div>
              <span>在线时长</span>
              <strong>{online ? uptime : '—'}</strong>
            </div>
            <div>
              <span>活动映射</span>
              <strong>{listening} / {activeMappings.length}</strong>
            </div>
            <div>
              <span>会话流量</span>
              <strong>{formatBytes(totalBytes)}</strong>
            </div>
            <div>
              <span>当前连接</span>
              <strong>{connections}</strong>
            </div>
          </div>
        </Card>

        <div className="stat-stack">
          <StatTile
            label="SSH 通道"
            value={online ? '在线' : '离线'}
            hint={snap.link.fingerprint ? `主机指纹 ${snap.link.fingerprint.slice(0, 22)}…` : '尚未完成握手'}
            tone={online ? 'ok' : 'warn'}
          />
          <StatTile
            label="重连状态"
            value={snap.link.state === 'reconnecting' ? `第 ${snap.link.reconnectAttempt + 1} 次` : '待命'}
            hint="指数退避，最长 30 秒一次"
          />
          <StatTile
            label="B 侧防火墙规则"
            value={snap.firewall.rules.length}
            hint={
              snap.firewall.lastError
                ? '最近一次下发失败，请检查权限'
                : `上次对账 ${formatRelative(snap.firewall.lastReconciledAt)}`
            }
            tone={snap.firewall.lastError ? 'warn' : 'default'}
          />
        </div>
      </div>

      <div className="grid grid--two">
        <Card className="biz">
          <div className="biz__head">
            <span className="biz__icon biz__icon--ports">
              <IconPorts size={20} />
            </span>
            <div>
              <h3>端口映射</h3>
              <p>把 B 的端口带到 A 的本地回环地址</p>
            </div>
            <Badge tone={activeMappings.length ? 'accent' : 'neutral'}>{activeMappings.length} 条规则</Badge>
          </div>
          <div className="biz__body">
            <div className="biz__metric">
              <strong>{listening}</strong>
              <span>正在监听</span>
            </div>
            <div className="biz__metric">
              <strong>{formatRate(downRate)}</strong>
              <span>实时下行</span>
            </div>
            <div className="biz__metric">
              <strong>{connections}</strong>
              <span>活动连接</span>
            </div>
          </div>
          <div className="biz__list">
            {snap.mappings.slice(0, 3).map((mapping) => (
              <div key={mapping.id} className="biz__row">
                <span className={`dot ${mapping.runtime.listening ? 'dot--ok' : 'dot--idle'}`} />
                <span className="biz__row-name">{mapping.name}</span>
                <span className="biz__row-port">
                  {mapping.localPort} → {mapping.targetPort}
                </span>
              </div>
            ))}
            {snap.mappings.length === 0 ? (
              <p className="muted small">还没有创建映射，先添加一条试试。</p>
            ) : null}
          </div>
          <button className="link-btn" onClick={() => navigate('mappings')}>
            管理端口映射 <IconChevron size={14} />
          </button>
        </Card>

        <Card className="biz">
          <div className="biz__head">
            <span className="biz__icon biz__icon--proxy">
              <IconGlobe size={20} />
            </span>
            <div>
              <h3>内网代理</h3>
              <p>通过 B 的视角访问内部 HTTP 服务</p>
            </div>
            <Badge tone={snap.proxy.runtime.running ? 'ok' : 'neutral'} dot>
              {snap.proxy.runtime.running ? '运行中' : '未启用'}
            </Badge>
          </div>
          <div className="biz__body">
            <div className="biz__metric">
              <strong>{snap.proxy.runtime.totalRequests}</strong>
              <span>累计请求</span>
            </div>
            <div className="biz__metric">
              <strong>{formatRate(snap.proxy.runtime.rateIn)}</strong>
              <span>实时下行</span>
            </div>
            <div className="biz__metric">
              <strong>{snap.proxy.runtime.activeConnections}</strong>
              <span>活动连接</span>
            </div>
          </div>
          <div className="biz__address">
            <span>代理地址</span>
            <code>
              http://{snap.proxy.bindAddress}:{snap.proxy.port}
            </code>
          </div>
          {snap.proxy.runtime.error ? <p className="inline-error">{snap.proxy.runtime.error}</p> : null}
          <button className="link-btn" onClick={() => navigate('proxy')}>
            打开代理设置 <IconChevron size={14} />
          </button>
        </Card>
      </div>

      <div className="grid grid--two grid--wide-left">
        <Card className="activity">
          <div className="card-head">
            <div>
              <h3>最近活动</h3>
              <p>连接、映射与防火墙的实时事件</p>
            </div>
            <Button size="sm" variant="quiet" icon={<IconBolt size={14} />} onClick={() => setLogOpen(true)}>
              查看全部
            </Button>
          </div>
          <div className="activity__list">
            {snap.logs.slice(-7).reverse().map((entry) => (
              <div key={entry.id} className={`activity__row activity__row--${entry.level}`}>
                <span className="activity__time">{new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className="activity__scope">{entry.scope}</span>
                <span className="activity__msg">{entry.message}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="tips">
          <div className="card-head">
            <div>
              <h3>运行提示</h3>
              <p>保持链路健康的小建议</p>
            </div>
            <IconClock size={16} className="muted" />
          </div>
          <ul className="tips__list">
            <li>
              <span className="tips__icon"><IconArrow size={14} /></span>
              <span>映射只在 A 的 <code>127.0.0.1</code> 上监听，外部机器无法直接访问。</span>
            </li>
            <li>
              <span className="tips__icon"><IconBolt size={14} /></span>
              <span>隧道断开时端口仍然占用，客户端会立刻收到拒绝，而不是长时间等待。</span>
            </li>
            <li>
              <span className="tips__icon"><IconServer size={14} /></span>
              <span>每次重连都会自动恢复监听并核对 B 侧防火墙规则。</span>
            </li>
          </ul>
        </Card>
      </div>

      <LogPanel open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}
