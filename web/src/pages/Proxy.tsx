import { useMemo, useState } from 'react';
import { api, formatBytes, formatClock, formatRate } from '../api';
import {
  IconBolt,
  IconCopy,
  IconExternal,
  IconGlobe,
  IconLock,
  IconShield,
  IconTerminal,
} from '../icons';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  Field,
  PageHeader,
  StatTile,
  Toggle,
} from '../ui';
import { useApp } from '../App';
import type { ProxyRoutingMode } from '../types';

const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function parseWhitelist(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const item of text.split(/[\s,;，；]+/)) {
    const value = item.trim();
    if (!value) continue;
    if (!IPV4_PATTERN.test(value)) {
      if (!invalid.includes(value)) invalid.push(value);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    valid.push(value);
  }
  return { valid, invalid };
}

export function ProxyPage() {
  const { snap, refresh, toast } = useApp();
  const [testUrl, setTestUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; note: string; status: number | null; ms: number } | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'error'>('all');
  const [routingDraft, setRoutingDraft] = useState<ProxyRoutingMode | null>(null);
  const [whitelistDraft, setWhitelistDraft] = useState<string | null>(null);
  const [savingRouting, setSavingRouting] = useState(false);

  const proxy = snap?.proxy;
  const address = proxy ? `http://${proxy.bindAddress}:${proxy.port}` : '—';

  const logs = useMemo(() => {
    const list = snap?.proxyLogs ?? [];
    return filter === 'error' ? list.filter((entry) => entry.outcome === 'error') : list;
  }, [snap?.proxyLogs, filter]);

  if (!proxy) {
    return (
      <div className="loading">
        <span className="spinner spinner--lg" />
        <p>正在读取代理状态…</p>
      </div>
    );
  }

  const routingMode = routingDraft ?? proxy.routingMode;
  const whitelistValue = whitelistDraft ?? proxy.whitelist.join('\n');
  const whitelist = parseWhitelist(whitelistValue);
  const routingDirty =
    routingMode !== proxy.routingMode ||
    whitelist.valid.join('\n') !== proxy.whitelist.join('\n') ||
    whitelist.invalid.length > 0;
  const pacUrl = new URL('/proxy.pac', window.location.origin).toString();

  const saveRouting = async () => {
    if (routingMode === 'whitelist') {
      if (whitelist.invalid.length > 0) {
        toast(`以下内容不是固定 IPv4：${whitelist.invalid.slice(0, 4).join('、')}`, 'error');
        return;
      }
      if (whitelist.valid.length === 0) {
        toast('「仅白名单」模式至少需要填写一个固定 IP', 'error');
        return;
      }
      if (whitelist.valid.length > 200) {
        toast('白名单最多支持 200 个固定 IP', 'error');
        return;
      }
    }
    setSavingRouting(true);
    try {
      await api.updateProxy({
        routingMode,
        whitelist: routingMode === 'whitelist' ? whitelist.valid : proxy.whitelist,
      });
      setRoutingDraft(null);
      setWhitelistDraft(null);
      toast(
        routingMode === 'whitelist'
          ? `分流已保存：仅 ${whitelist.valid.length} 个白名单 IP 走代理`
          : '分流已保存：所有请求都走代理',
        'ok',
      );
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setSavingRouting(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    try {
      await api.updateProxy({ enabled });
      toast(enabled ? 'HTTP 代理已启用' : 'HTTP 代理已停止', enabled ? 'ok' : 'info');
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const toggleLan = async (allowLan: boolean) => {
    try {
      await api.updateProxy({ allowLan });
      toast(allowLan ? '代理已允许局域网访问，请确认网络可信' : '代理已限制为本机访问', allowLan ? 'info' : 'ok');
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const applyPort = async () => {
    if (portDraft === null) return;
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast('端口需为 1–65535 的整数', 'error');
      return;
    }
    try {
      await api.updateProxy({ port });
      toast(`代理端口已切换为 ${port}`, 'ok');
      setPortDraft(null);
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const runTest = async () => {
    if (!testUrl.trim()) {
      toast('请填写完整的测试地址', 'error');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProxy(testUrl.trim());
      setTestResult(result);
      toast(result.ok ? 'B 侧可达' : '未能连通，请查看结果', result.ok ? 'ok' : 'error');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="MODULE 02"
        title="内网代理"
        description="浏览器或命令行指向本机 HTTP 代理，请求会经 B 的 DNS 与出口发起，能访问只有 B 见得到的内网系统。"
        actions={
          <Button
            variant={proxy.enabled ? 'secondary' : 'primary'}
            icon={<IconGlobe />}
            onClick={() => void toggle(!proxy.enabled)}
          >
            {proxy.enabled ? '停止代理' : '启用代理'}
          </Button>
        }
      />

      <div className="grid grid--hero">
        <Card className={`proxy-hero${proxy.runtime.running ? ' proxy-hero--on' : ''}`}>
          <div className="proxy-hero__top">
            <div>
              <span className="eyebrow">HTTP PROXY</span>
              <h2>{proxy.runtime.running ? '代理已就绪' : proxy.enabled ? '等待隧道' : '代理未启用'}</h2>
              <p>
                {proxy.runtime.error
                  ? proxy.runtime.error
                  : proxy.runtime.running
                    ? '监听中，请求按目标地址经 SSH 通道转发到 B'
                    : '启用后会在本机监听代理端口，隧道恢复时无需重新开启'}
              </p>
            </div>
            <Toggle checked={proxy.enabled} onChange={(next) => void toggle(next)} label="启用 HTTP 代理" />
          </div>

          <div className="proxy-address">
            <span className="proxy-address__label">代理地址</span>
            <code>{address}</code>
            <CopyButton value={address} label="复制地址" />
            <Badge tone={proxy.allowLan ? 'warn' : 'ok'} dot>
              {proxy.allowLan ? '局域网可访问' : '仅本机'}
            </Badge>
          </div>

          <div className="proxy-hero__stats">
            <div>
              <span>累计请求</span>
              <strong>{proxy.runtime.totalRequests}</strong>
            </div>
            <div>
              <span>活动连接</span>
              <strong>{proxy.runtime.activeConnections}</strong>
            </div>
            <div>
              <span>下行</span>
              <strong>{formatRate(proxy.runtime.rateIn)}</strong>
            </div>
            <div>
              <span>累计流量</span>
              <strong>{formatBytes(proxy.runtime.bytesIn + proxy.runtime.bytesOut)}</strong>
            </div>
          </div>
        </Card>

        <div className="stat-stack">
          <StatTile
            label="监听端口"
            value={proxy.port}
            hint={proxy.runtime.running ? '端口已占用，可被客户端连接' : '未监听'}
            tone={proxy.runtime.running ? 'ok' : 'default'}
          />
          <StatTile
            label="绑定范围"
            value={proxy.allowLan ? '局域网' : '本机'}
            hint={proxy.allowLan ? '0.0.0.0：请确认网络可信' : '127.0.0.1：仅本机可用'}
          />
          <StatTile
            label="DNS 解析位置"
            value="电脑 B"
            hint="内网域名无需在 A 上配置 hosts"
          />
        </div>
      </div>

      <Card className="panel">
        <div className="card-head">
          <div>
            <h3>代理分流（PAC 白名单）</h3>
            <p>只有指定的固定 IP 走 B，其余网站保持 A 直连，不必每次手动切换代理</p>
          </div>
          <Badge tone={routingMode === 'whitelist' ? 'accent' : 'neutral'}>
            {routingMode === 'whitelist' ? `白名单 ${whitelist.valid.length} 个` : '全部走代理'}
          </Badge>
        </div>

        <div className="routing">
          <div className="routing__modes">
            <div>
              <strong>分流模式</strong>
              <p>修改后点击右侧保存，PAC 脚本会立即更新。</p>
            </div>
            <div className="segmented">
              <button
                className={routingMode === 'all' ? 'is-active' : ''}
                onClick={() => setRoutingDraft('all')}
              >
                全部走代理
              </button>
              <button
                className={routingMode === 'whitelist' ? 'is-active' : ''}
                onClick={() => setRoutingDraft('whitelist')}
              >
                仅白名单
              </button>
            </div>
          </div>

          {routingMode === 'whitelist' ? (
            <Field
              label="固定 IP 白名单"
              hint="每行一个 IPv4，例如 10.1.2.3。仅做精确匹配，不支持域名、网段或端口，最多 200 个。"
            >
              <textarea
                className="input input--mono textarea"
                rows={5}
                value={whitelistValue}
                onChange={(event) => setWhitelistDraft(event.target.value)}
                placeholder={'10.1.2.3\n10.1.2.4\n192.168.1.50'}
                spellCheck={false}
              />
            </Field>
          ) : (
            <p className="muted small">
              当前所有 HTTP/HTTPS 请求都会交给 B。若只想让部分内网地址走 B，请切换到「仅白名单」。
            </p>
          )}

          {whitelist.invalid.length > 0 ? (
            <p className="field__error">
              以下内容不是合法的固定 IPv4：{whitelist.invalid.slice(0, 6).join('、')}
              {whitelist.invalid.length > 6 ? ' …' : ''}
            </p>
          ) : null}

          <div className="proxy-address">
            <span className="proxy-address__label">PAC 地址</span>
            <code>{pacUrl}</code>
            <CopyButton value={pacUrl} label="复制地址" />
            <a className="link-btn" href="/proxy.pac" target="_blank" rel="noreferrer">
              查看脚本 <IconExternal size={13} />
            </a>
            {proxy.enabled ? null : (
              <Badge tone="warn" dot>
                代理未启用
              </Badge>
            )}
          </div>

          <div className="routing__foot">
            <span className="muted small">
              Windows：设置 → 网络和 Internet → 代理 → 使用设置脚本，填入上面的地址。
            </span>
            <Button
              variant="primary"
              loading={savingRouting}
              disabled={!routingDirty}
              onClick={() => void saveRouting()}
            >
              保存分流设置
            </Button>
          </div>
        </div>

        <div className="callout routing__callout">
          <IconShield size={15} />
          <p>
            <strong>PAC 只负责“选择走不走代理”</strong>
            浏览器会先执行本机脚本：命中白名单的地址返回{' '}
            <code>PROXY 127.0.0.1:{proxy.port}</code>，其余返回 <code>DIRECT</code>。代理总开关仍需保持启用；
            修改白名单后请刷新或重启浏览器，避免 PAC 缓存。
          </p>
        </div>
      </Card>

      <div className="grid grid--two">
        <Card className="panel">
          <div className="card-head">
            <div>
              <h3>连通性测试</h3>
              <p>从 B 的视角探测目标地址，验证内网是否真的可达</p>
            </div>
            <IconBolt size={16} className="muted" />
          </div>
          <div className="test-row">
            <input
              className="input input--mono"
              value={testUrl}
              onChange={(event) => setTestUrl(event.target.value)}
              placeholder="http://intranet.local:8080/health"
              spellCheck={false}
            />
            <Button variant="primary" loading={testing} onClick={() => void runTest()}>
              测试
            </Button>
          </div>
          {testResult ? (
            <div className={`test-result test-result--${testResult.ok ? 'ok' : 'error'}`}>
              <strong>{testResult.ok ? '可达' : '不可达'}</strong>
              <span>
                {testResult.status ? `HTTP ${testResult.status} · ` : ''}
                {testResult.ms} ms · {testResult.note}
              </span>
            </div>
          ) : (
            <p className="muted small">测试不会经过 A 的网络，全部由 B 发起，因此结果等同于在 B 上访问。</p>
          )}
        </Card>

        <Card className="panel">
          <div className="card-head">
            <div>
              <h3>使用方法</h3>
              <p>任意支持 HTTP 代理的客户端都可以接入</p>
            </div>
            <IconTerminal size={16} className="muted" />
          </div>
          <div className="snippet">
            <div className="snippet__head">
              <span className="snippet__dot" />
              <span className="snippet__dot" />
              <span className="snippet__dot" />
              <span className="snippet__title">命令行</span>
              <CopyButton value={`curl -x http://127.0.0.1:${proxy.port} http://intranet.local`} label="复制" />
            </div>
            <pre>{`curl -x http://127.0.0.1:${proxy.port} \\\n  http://intranet.local`}</pre>
          </div>
          <ul className="hint-list">
            <li>
              <IconGlobe size={14} /> <span>浏览器：系统代理或扩展中填写 <code>127.0.0.1:{proxy.port}</code></span>
            </li>
            <li>
              <IconLock size={14} /> <span>HTTPS 站点通过 CONNECT 隧道转发，证书校验仍由客户端完成</span>
            </li>
            <li>
              <IconCopy size={14} /> <span>首版仅支持 HTTP/CONNECT，SOCKS5 与 UDP 已在架构中预留</span>
            </li>
          </ul>
        </Card>
      </div>

      <Card className="panel">
        <div className="card-head">
          <div>
            <h3>高级设置</h3>
            <p>端口与访问范围调整后会立即重建监听</p>
          </div>
          <Badge tone="neutral">谨慎修改</Badge>
        </div>
        <div className="settings-row">
          <Field label="代理端口" hint="修改后需要客户端同步更新">
            <div className="inline-field">
              <input
                className="input input--mono"
                value={portDraft ?? String(proxy.port)}
                inputMode="numeric"
                onChange={(event) => setPortDraft(event.target.value)}
              />
              <Button variant="secondary" onClick={() => void applyPort()} disabled={portDraft === null}>
                应用
              </Button>
            </div>
          </Field>
          <div className="settings-toggle">
            <div>
              <strong>允许局域网设备使用此代理</strong>
              <p>开启后绑定 0.0.0.0。仅在网络可信时使用，否则请保持关闭。</p>
            </div>
            <Toggle checked={proxy.allowLan} onChange={(next) => void toggleLan(next)} label="允许局域网访问" />
          </div>
        </div>
      </Card>

      <Card className="panel">
        <div className="card-head">
          <div>
            <h3>实时请求日志</h3>
            <p>仅记录目标、状态与耗时；不记录请求内容</p>
          </div>
          <div className="segmented">
            <button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>
              全部
            </button>
            <button className={filter === 'error' ? 'is-active' : ''} onClick={() => setFilter('error')}>
              仅失败
            </button>
          </div>
        </div>

        {logs.length === 0 ? (
          <EmptyState
            icon={<IconGlobe size={24} />}
            title="暂无请求"
            description="启用代理并把浏览器或命令行指向代理地址后，这里会实时出现访问记录。"
          />
        ) : (
          <div className="table">
            <div className="table__head">
              <span>时间</span>
              <span>方法</span>
              <span>目标</span>
              <span>状态</span>
              <span>大小</span>
              <span>耗时</span>
            </div>
            {logs.map((entry) => (
              <div key={entry.id} className={`table__row${entry.outcome === 'error' ? ' table__row--error' : ''}`}>
                <span className="mono muted">{formatClock(entry.at)}</span>
                <span className="mono">{entry.method}</span>
                <span className="table__target" title={entry.error ?? entry.target}>
                  {entry.target}
                  {entry.error ? <em>{entry.error}</em> : null}
                </span>
                <span>
                  {entry.status ? (
                    <span className={`code code--${entry.status < 400 ? 'ok' : 'error'}`}>{entry.status}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </span>
                <span className="mono">{formatBytes(entry.bytes)}</span>
                <span className="mono muted">{entry.durationMs} ms</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
