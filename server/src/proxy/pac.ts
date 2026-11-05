import type { ProxySettings } from '../types.js';

/**
 * 生成 PAC（Proxy Auto-Config）脚本。
 *
 * 代理端口始终使用本机回环地址：PAC 由 A 上的浏览器执行，命中白名单后
 * 请求交给 A 本机的 TunnelDesk 代理，再由 SSH 通道送到 B。
 */
export function buildPacScript(settings: ProxySettings): string {
  const proxy = `PROXY 127.0.0.1:${settings.port}`;
  const header = [
    '// TunnelDesk PAC - generated automatically, do not edit.',
    `// mode: ${settings.routingMode}`,
    `var TD_PROXY = ${JSON.stringify(proxy)};`,
  ];

  if (settings.routingMode === 'all') {
    return [
      ...header,
      '',
      'function FindProxyForURL(url, host) {',
      '  return TD_PROXY;',
      '}',
      '',
    ].join('\n');
  }

  const entries = settings.whitelist.map((ip) => `  ${JSON.stringify(ip)}: true,`);
  return [
    ...header,
    '// Only these fixed IPv4 addresses are proxied; everything else goes direct.',
    'var TD_WHITELIST = {',
    ...entries,
    '};',
    '',
    'function FindProxyForURL(url, host) {',
    '  if (!host) return "DIRECT";',
    '  var key = String(host).toLowerCase();',
    '  if (Object.prototype.hasOwnProperty.call(TD_WHITELIST, key)) return TD_PROXY;',
    '  return "DIRECT";',
    '}',
    '',
  ].join('\n');
}
