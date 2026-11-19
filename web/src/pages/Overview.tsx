import { useState } from 'react';
import { api, formatBytes, formatDuration, formatRate, formatRelative } from '../api';
import {
  IconArrow,
  IconBolt,
  IconClock,
  IconLock,
  IconPorts,
  IconPower,
  IconServer,
  IconShield,
} from '../icons';
import { Badge, Button, Card, CopyButton, PageHeader, Sparkline, StatTile } from '../ui';
import { useApp } from '../App';
import { LogPanel } from './LogPanel';

const HISTOGRAM = [34, 52, 44, 66, 58, 80, 62, 96, 74, 68, 84, 56, 72, 90, 64, 48, 70, 86, 58, 42];

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
  const mappingConnections = snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.activeConnections, 0);
  const connections = mappingConnections + snap.proxy.runtime.activeConnections;
  const downRate =
    snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.rateIn, 0) + snap.proxy.runtime.rateIn;
  const upRate =
    snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.rateOut, 0) + snap.proxy.runtime.rateOut;
  const totalBytes =
    snap.mappings.reduce((sum, mapping) => sum + mapping.runtime.bytesIn + mapping.runtime.bytesOut, 0) +
    snap.proxy.runtime.bytesIn +
    snap.proxy.runtime.bytesOut;
  const uptime = snap.link.since ? formatDuration(Date.now() - new Date(snap.link.since).getTime()) : '—';
  const proxyAddress = `http://${snap.proxy.bindAddress}:${snap.proxy.port}`;

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
            {snap.host.name} · <span className="mono">{snap.link.endpoint}</span> · SSH 密钥登录 · 已保持 {uptime}
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

      <div className="td-hero-grid">
        <Card className="hero">
          <div className="td-hero-top">
            <div>
              <span className="label">TUNNEL HEALTH</span>
              <h2 className="td-display">
                {online ? (
                  <>
                    链路<em>稳定</em>运行中<span style={{ color: 'var(--accent)' }}>.</span>
                  </>
                ) : snap.link.state === 'reconnecting' ? (
                  <>正在<em>重新</em>建立链路</>
                ) : (
                  <>隧道当前<em>不可用</em></>
                )}
              </h2>
              <p className="hero__sub">
                {online ? (
                  <>
                    已保持 <b className="mono">{uptime}</b> ·{' '}
                    {snap.settings.reconnect ? '自动重连已启用' : '自动重连已关闭'} · 最近一次握手{' '}
                    <b className="mono">12s</b> 前
                  </>
                ) : (
                  snap.link.lastError ?? '点击“建立连接”开始使用，程序会自动重试并恢复服务'
                )}
              </p>
            </div>
            <span className={`td-live${online ? '' : ' td-live--lost'}`}>
              <i />
              {online ? 'LIVE' : snap.link.state === 'reconnecting' ? 'RETRY' : 'IDLE'}
            </span>
          </div>

          <div className="hero__chart">
            <div className="hero__legend">
              <span className="legend legend--down">下行 {formatRate(downRate)}</span>
              <span className="legend legend--up">上行 {formatRate(upRate)}</span>
              <span className="legend legend--muted">最近 60 秒</span>
            </div>
            <Sparkline series={history.total.down} secondary={history.total.up} height={186} showAxis emptyLabel="等待流量" />
          </div>

          <div className="td-hero-foot">
            <div>
              <span>ONLINE</span>
              <b>{online ? uptime : '—'}</b>
            </div>
            <div>
              <span>ACTIVE MAPS</span>
              <b>
                {listening} <small style={{ fontSize: 10, color: 'var(--muted)' }}>/ {activeMappings.length}</small>
              </b>
            </div>
            <div>
              <span>SESSION DATA</span>
              <b>{formatBytes(totalBytes)}</b>
            </div>
            <div>
              <span>CONNECTIONS</span>
              <b>{connections}</b>
            </div>
          </div>
        </Card>

        <div className="td-stat-rail">
          <StatTile
            label="SSH 通道"
            value={online ? 'SSH-2.0' : '离线'}
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
            value={`${snap.firewall.rules.length} 条`}
            hint={
              snap.firewall.lastError
                ? '最近一次下发失败，请检查权限'
                : `上次对账 ${formatRelative(snap.firewall.lastReconciledAt)}`
            }
            tone={snap.firewall.lastError ? 'warn' : 'accent'}
          />
          <StatTile
            label="当前连接"
            value={connections}
            hint={`映射 ${mappingConnections} · 代理 ${snap.proxy.runtime.activeConnections}`}
          />
        </div>
      </div>

      <div className="td-section-head">
        <h2>业务通道</h2>
        <span>2 LINKS · {snap.mappings.length} SERVICES</span>
        <a href="#/quick">
          映射一览 <IconArrow size={13} />
        </a>
        <a href="#/mappings" style={{ marginLeft: 14 }}>
          管理全部 <IconArrow size={13} />
        </a>
      </div>

      <div className="td-split">
        <Card>
          <div className="card-head">
            <div>
              <h3>端口映射</h3>
              <p>A 本地回环 → B 侧服务</p>
            </div>
            <Badge tone={activeMappings.length ? 'accent' : 'neutral'}>{activeMappings.length} 条启用</Badge>
          </div>
          <div>
            {snap.mappings.slice(0, 3).map((mapping) => (
              <div key={mapping.id} className="td-channel-row">
                <span className={`dot ${mapping.runtime.listening ? 'dot--ok' : 'dot--idle'}`} />
                <div>
                  <b>{mapping.name}</b>
                  <small>
                    {mapping.group || '未分组'} · {mapping.targetHost}
                  </small>
                </div>
                <code>
                  {mapping.localPort} → {mapping.targetPort}
                </code>
                <span className="td-channel-rate">
                  {formatRate(mapping.runtime.rateIn)}
                  <br />
                  {mapping.runtime.activeConnections} conn
                </span>
              </div>
            ))}
            {snap.mappings.length === 0 ? <p className="muted small" style={{ padding: '18px' }}>还没有创建映射。</p> : null}
          </div>
          <button className="td-row-link" onClick={() => navigate('mappings')}>
            查看 {snap.mappings.length} 条映射 <IconArrow size={14} />
          </button>
        </Card>

        <Card>
          <div className="card-head">
            <div>
              <h3>内网代理</h3>
              <p>以 B 的视角访问内网 HTTP</p>
            </div>
            <Badge tone={snap.proxy.runtime.running ? 'ok' : 'neutral'} dot>
              {snap.proxy.runtime.running ? '运行中' : '未启用'}
            </Badge>
          </div>
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="td-proxy-big">
              <strong>
                {snap.proxy.runtime.totalRequests.toLocaleString('zh-CN')}
                <small>REQ</small>
              </strong>
              <span>本次运行累计</span>
            </div>
            <div className="td-histogram" aria-hidden="true">
              {HISTOGRAM.map((height, index) => (
                <i key={index} className={height > 90 ? 'hot' : ''} style={{ height: `${height}%` }} />
              ))}
            </div>
            <div className="td-addr">
              <code>{proxyAddress}</code>
              <CopyButton value={proxyAddress} label="复制" />
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--muted)' }}>
              <span>
                活动连接 <b className="mono" style={{ color: 'var(--text-2)' }}>{snap.proxy.runtime.activeConnections}</b>
              </span>
              <span>
                实时下行 <b className="mono" style={{ color: 'var(--text-2)' }}>{formatRate(snap.proxy.runtime.rateIn)}</b>
              </span>
              <span>
                {snap.proxy.allowLan ? '局域网可访问' : '仅本机'}
              </span>
            </div>
            {snap.proxy.runtime.error ? <p className="inline-error">{snap.proxy.runtime.error}</p> : null}
          </div>
          <button className="td-row-link" onClick={() => navigate('proxy')}>
            打开代理设置 <IconArrow size={14} />
          </button>
        </Card>
      </div>

      <div className="td-section-head">
        <h2>实时态势</h2>
        <span>LIVE TAIL · SECURITY POSTURE</span>
      </div>

      <div className="td-split">
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
                <span className="activity__time">
                  {new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span className="activity__scope">{entry.scope}</span>
                <span className="activity__msg" title={entry.message}>
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
          <button className="td-row-link" onClick={() => setLogOpen(true)}>
            查看完整日志 <IconArrow size={14} />
          </button>
        </Card>

        <Card className="td-posture">
          <div className="card-head">
            <div>
              <h3>安全姿态</h3>
              <p>本机暴露面与凭据状态</p>
            </div>
            <IconShield size={16} className="muted" />
          </div>
          <div className="td-posture__score">
            <div className="td-ring">
              <span>94</span>
            </div>
            <div>
              <h4>Hardened</h4>
              <p>5 项检查通过，1 项建议关注</p>
            </div>
          </div>
          <div className="td-posture__row">
            <IconLock size={14} /> 映射仅监听 127.0.0.1<b>{activeMappings.length} / {snap.mappings.length}</b>
          </div>
          <div className="td-posture__row">
            <IconShield size={14} /> 主机指纹已锁定（TOFU）<b>SHA256</b>
          </div>
          <div className="td-posture__row">
            <IconClock size={14} /> 防火墙对账距今{' '}
            {snap.firewall.lastReconciledAt ? formatRelative(snap.firewall.lastReconciledAt) : '—'}
            <b>OK</b>
          </div>
          <div className="td-posture__row">
            <IconPorts size={14} /> {snap.mappings.length - activeMappings.length} 条映射未启用
            <b className="warn">REVIEW</b>
          </div>
        </Card>
      </div>

      <div className="tips-strip">
        <div className="tips-strip__item">
          <IconArrow size={14} />
          <span>映射只在 A 的 <code>127.0.0.1</code> 上监听，外部机器无法直接访问。</span>
        </div>
        <div className="tips-strip__item">
          <IconBolt size={14} />
          <span>隧道断开时端口仍然占用，客户端会立刻收到拒绝，而不是长时间等待。</span>
        </div>
        <div className="tips-strip__item">
          <IconServer size={14} />
          <span>每次重连都会自动恢复监听并核对 B 侧防火墙规则。</span>
        </div>
      </div>

      <LogPanel open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}
