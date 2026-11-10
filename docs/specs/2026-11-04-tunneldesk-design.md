# TunnelDesk 设计规格

- 日期：2026-11-04（2026-11-10 补充真实环境验证记录）
- 状态：已实现基线（v0.1），并在真实 Windows 环境完成端到端验证
- 需求来源：`../../需求.txt`

## 1. 目标与边界

电脑 A（真实机）需要通过界面完成两件彼此独立的事：

1. **端口映射**：把电脑 B 上的服务端口映射到 A 的本地端口，A 直接访问 `127.0.0.1:<本地端口>`。
2. **内网访问**：电脑 B 能访问、A 不能访问的内网资源，通过 A 上的 HTTP 代理访问。

约束：

- 电脑 B 是 Azure 虚拟机，经 Azure Bastion 接入，**不得修改 VM 层配置**（NSG、Bastion、入站规则）。
- 电脑 B 上的操作尽量少：不安装常驻 Agent、不注册服务、不开额外监听端口。
- 两端可用环境：Node.js（当前稳定版）、Python 3.14、.NET 8。无 Go / Rust。
- 首版仅代理 HTTP（含 HTTPS CONNECT），不做 SOCKS5/UDP，但协议层与 UI 预留扩展位。
- 界面须达到企业级观感：自定义设计系统，非组件库默认堆叠。

## 2. 关键决策

### D1：以 SSH 为唯一传输层

A 端使用 `ssh2` 库直连 `B:22`，通过 SSH `direct-tcpip` 通道按需拨号到 B 侧目标。理由：

- SSH 端口已被 Bastion 放通，不需要在 B 上开新监听端口，也不触碰 VM 配置。
- 加密、认证、多路复用、流控由 SSH 提供，无需自研隧道协议。
- 目标主机名由 **B 侧解析**，这是内网域名可访问的前提。
- B 端零安装：规则下发通过 SSH `exec` 完成。

连接参数 `host/port` 可配置，后续接入 Bastion 本地转发端口（如 `127.0.0.1:50022`）无需改代码。

### D2：首次密码换密钥

首次配置输入 B 的 `host / port / user / password`，程序：

1. 用密码建立 SSH；
2. 生成 RSA-3072 密钥对（`%APPDATA%\TunnelDesk\keys\`，PKCS#1 PEM）；
3. 以无 BOM 方式写入 B 的用户 `~/.ssh/authorized_keys`；管理员账号同时写入 `administrators_authorized_keys`，已存在则保留、不重复；
4. 立即用密钥复测，成功后才保存主机；丢弃密码，此后一律密钥登录。

密码只存在于当次请求内存中，不落盘、不写日志。

### D3：防火墙规则与映射同生命周期

每条映射可开启“同步放行 B 端口”（默认开启）。规则名固定为 `TunnelDesk-<mappingId>`，同时创建入站与出站 TCP 规则（通过 PowerShell `New-NetFirewallRule` 下发）：

```powershell
New-NetFirewallRule -DisplayName "TunnelDesk-<id>" -Group TunnelDesk `
  -Direction Inbound  -Action Allow -Protocol TCP -LocalPort <port> -Profile Any
New-NetFirewallRule -DisplayName "TunnelDesk-<id>" -Group TunnelDesk `
  -Direction Outbound -Action Allow -Protocol TCP -LocalPort <port> -Profile Any
```

删除映射 / 关闭该选项 / 修改端口时，先删旧规则再按需重建。程序启动、重连成功、手动触发时执行**对账**：

- 列出 B 上所有 `TunnelDesk-*` 规则；
- 删除不属于任何“启用且开启放行”映射的孤儿规则。

规则名带统一前缀，避免误删非本程序创建的规则。

### D4：进程与模块边界

A 端单进程（Node），模块各自单一职责：

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `config` | 读写配置、校验、原子落盘 | 无 |
| `ssh/link` | 连接状态机、重连、keepalive、开通道、执行命令 | ssh2 |
| `forward` | 本地监听、按映射转发、字节统计 | link |
| `proxy` | HTTP 代理、CONNECT、访问日志 | link |
| `firewall` | 规则增删与对账 | link (exec) |
| `stats` | 指标聚合与 SSE 推送 | forward/proxy |
| `api` | REST + SSE + 静态资源 | 以上 |

### D5：界面信息架构

- **概览**：链路健康、在线时长、实时吞吐、业务卡片、最近事件。
- **端口映射**：映射卡片列表 + 新建/编辑抽屉，端口占用校验、自动选空闲端口、开关、流量。
- **内网代理**：总开关、代理地址、使用示例、连通性测试、实时请求日志。
- **连接管理**：主机配置、密钥状态、重连/断开、防火墙规则对账与列表。
- **设置**：主题、开机自启提示、日志上限、规则清理策略。

视觉：深色为默认、浅色可切换；自定义 token（色板、8px 栅格、12px 圆角、柔和阴影）；无第三方 UI 库；自绘 SVG 图表与图标；150–200ms 过渡；SSE 实时更新，不轮询。

## 3. 数据模型

```ts
Host {
  id, name, host, port, username,
  keyPath,            // 私钥文件
  fingerprint,        // 首次记录的主机指纹（展示用）
  createdAt, updatedAt
}

Mapping {
  id, name, hostId,
  bindAddress,        // 默认 127.0.0.1
  localPort,
  targetHost,         // 默认 127.0.0.1
  targetPort,
  enabled,
  autoStart,          // 启动时自动启用
  syncFirewall,       // 同步 B 防火墙入/出站规则
  createdAt, updatedAt
}

ProxySettings {
  enabled, bindAddress, port,
  allowLan,           // 默认 false，仅本机
  logLimit
}
```

配置文件：`%APPDATA%\TunnelDesk\config.json`（Windows）/ `~/.config/TunnelDesk/config.json`。
写入采用“临时文件 + rename”，避免半写损坏。

## 4. 连接与错误处理

- 状态机：`idle → connecting → authenticating → online → reconnecting → offline/error`。
- 重连退避：1s、2s、4s、8s、15s、30s 封顶，无限重试；手动断开不重连。
- keepalive：15s 间隔，3 次无响应判定断开。
- 离线时本地监听**保持端口占用**，新连接立即被拒绝，避免端口忽隐忽现。
- 映射端口冲突：保存前探测，冲突则拒绝并给出具体端口。
- 代理端口被占用：启动失败时降级为“禁用”并在 UI 明确提示，不阻塞其他业务。
- 所有 SSH 命令执行有超时（默认 10s）并捕获退出码与 stderr。
- 日志分级，敏感字段（密码、私钥）永不输出。

## 5. 测试策略

- 单元测试：配置存储（原子写、迁移）、HTTP 代理请求行解析、端口选择器、规则名生成、对账差集。
- 集成测试：用进程内假 SSH 通道验证转发的字节计数与快速失败。
- 手工验收：本机双角色（同机 22 端口未开时用模拟通道），真实 B 上验证映射与内网域名。
- 真实环境验收：B 经 Azure Bastion 本地转发端口（`127.0.0.1:50022`）接入，验证映射、HTTP/HTTPS 代理、PAC 分流；已通过，记录见第 7 节。

## 6. 非目标（v0.1）

- SOCKS5 / UDP 代理
- 多用户、权限、审计导出
- 反向映射（B → A）
- 自动更新与安装包签名

## 7. 验证记录

| 日期 | 环境 | 验证内容 | 结果 |
| --- | --- | --- | --- |
| 2026-11-04 | 本机 mock SSH（127.0.0.1:2222）+ 演示服务 | 单元测试 29 项、E2E 12 项（密码换密钥、密钥登录、映射转发、代理转发、B 侧探测、规则创建与清理） | 通过 |
| 2026-11-05 | 局域网真实 Windows 主机（直连 22） | 密钥登录（无 BOM 写入 + 管理员公钥）、防火墙规则创建/清理、隧道在线 | 通过 |
| 2026-11-10 | 真实 Azure VM（Azure Bastion，本地转发端口 50022） | `az network bastion tunnel --resource-port 22 --port 50022` 接入；端口映射端到端；内网代理 HTTP 与 HTTPS CONNECT；A 系统代理指向 `127.0.0.1:8888`；PAC 固定 IP 白名单分流 | 通过 |

D1 中「`host/port` 可配置，接 Bastion 本地转发端口无需改代码」这一假设已由 2026-11-10 的实测确认。

仍未覆盖：SOCKS5 / UDP、反向映射、多主机并行、指纹变更阻断、托盘与开机自启。
