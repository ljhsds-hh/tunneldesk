# TunnelDesk

TunnelDesk 是一个面向个人工作流的 SSH 访问控制台，用来把「电脑 B」（Azure 虚拟机 / 跳板机）上的能力安全地借给「电脑 A」（本机）：

- **端口映射**：把 B 上的服务端口映射到 A 的 `127.0.0.1:<本地端口>`，本机应用像访问本地服务一样使用它。
- **内网代理**：在本机开一个 HTTP 代理，请求经 B 的 DNS 与网络出口发出，从而访问只有 B 能访问的内网 HTTP 服务（含 HTTPS CONNECT）。
- **代理分流**：提供 PAC 脚本，可按固定 IPv4 白名单只让指定内网地址走 B，其余网站保持 A 直连。

两个业务在界面上完全分开，共用同一条 SSH 连接。**B 端不需要安装任何程序、不注册服务、不新增监听端口。**

```
┌────────────── 电脑 A ──────────────┐        ┌────────── 电脑 B ──────────┐
│  浏览器 / 桌面客户端                │        │                            │
│    │ 127.0.0.1:13389               │        │  127.0.0.1:3389 (RDP)      │
│    ▼                               │        │  intranet.local:8080       │
│  TunnelDesk (Node) ── SSH ─────────┼───────▶│  OpenSSH Server (系统自带) │
│    · 端口映射监听                   │ 22 或  │    · direct-tcpip 转发     │
│    · HTTP/CONNECT 代理              │ Bastion│    · PowerShell exec       │
│    · 控制台 127.0.0.1:19000        │ 隧道端口│                            │
└────────────────────────────────────┘        └────────────────────────────┘
```

---

## 1. 环境要求

| 位置 | 要求 |
| --- | --- |
| 电脑 A | Windows 11，Node.js **22+**（开发使用 24），无需管理员权限 |
| 电脑 B | Windows 11，**OpenSSH Server** 已启用并可登录，账号具备管理员权限 |
| 网络 | A 能通过 TCP 访问 B 的 SSH 端口（Bastion 场景见第 4 节） |

A 上只有 Node.js 一个运行时依赖；不需要 Python、.NET、Go、Rust。

---

## 2. 快速开始

```bat
:: 首次安装依赖
npm install

:: 日常启动（清理旧构建 → 重新构建 → 启动并打开浏览器）
start.cmd
```

启动窗口会显示清理、构建与运行日志；控制台运行期间窗口保持打开，关闭窗口即停止服务。如果 19000 已被占用，脚本会显示占用进程并询问；输入 `Y` 才会结束并继续，其他输入会取消并保留窗口。控制台固定监听 `http://127.0.0.1:19000`，不会对局域网开放。也可以手动启动：

```bat
npm start -- --port 19000 --open
```

首次使用：

1. 打开「连接管理」，填写 B 的地址、SSH 端口、用户名和**一次性密码**。
2. 程序会自动生成 RSA-3072 密钥，以无 BOM 方式写入 B 的用户公钥文件；管理员账号还会写入 `administrators_authorized_keys`。写入后立即用密钥复测，成功才保存主机。密码不落盘。
3. 在「端口映射」中新建映射（例如本地 `13389` → B `3389`），保存后立即监听。
4. 需要访问内网网站时，在「内网代理」中启用代理，把浏览器/命令行指向 `http://127.0.0.1:8888`。
5. 只想让部分固定 IP 走代理时，在「代理分流」选择「仅白名单」，填入 IP 并保存，然后把 Windows 的「使用设置脚本」指向 `http://127.0.0.1:19000/proxy.pac`。

---

## 3. B 端准备（尽量少）

正常情况下 B 只需要满足一件事：**OpenSSH Server 正在运行，且可用密码登录一次**。

如果尚未启用（在 B 的管理员 PowerShell 中执行一次即可）：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd
```

> 若 B 已能通过 Bastion / RDP 正常使用 SSH，则跳过本节。程序不会修改 VM、NSG、Bastion 或 B 的任何系统服务。

### 3.1 防火墙规则的管理员权限

每条映射会在 B 上创建一组同名入站/出站 TCP 规则（`TunnelDesk-<映射ID>`），删除映射时同步删除。远程 SSH 会话默认会被 Windows UAC 过滤掉管理员令牌，导致 `New-NetFirewallRule` 报 `Access is denied`。二选一：

- **推荐**：在 B 上用管理员 PowerShell 执行一次（之后远程会话即带管理员令牌）：

  ```powershell
  New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' `
    -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force
  ```

- 或者：关闭该映射的「在 B 上同步防火墙规则」，自行在 B 上放行端口。

界面在检测到权限错误时会直接显示这段修复命令，可一键复制。

### 3.2 规则命名与清理

- 规则名固定为 `TunnelDesk-<映射ID>`，分组 `TunnelDesk`，出入站各一条。
- 删除映射、关闭同步、修改目标端口时，先删旧规则再按需重建。
- 启动、重连、手动「立即对账」时会列出所有 `TunnelDesk-*` 规则，删除不属于任何启用映射的孤儿规则，因此不会越积越多。
- 程序只操作带该前缀/分组的规则，不会误删系统或其他软件的规则。

---

## 4. Azure Bastion 场景

需求明确 **不能修改 Azure VM 的相关配置**（NSG、Bastion、入站规则），因此 TunnelDesk 不依赖任何新增入站端口，全部复用 SSH：

**方式一（推荐）：Bastion 本地端口转发**

```powershell
az network bastion tunnel `
  --name <bastion-name> `
  --resource-group <resource-group> `
  --target-resource-id <vm-resource-id> `
  --resource-port 22 `
  --port 50022
```

然后在 TunnelDesk 中填写：

- B 的地址：`127.0.0.1`
- SSH 端口：`50022`
- 用户名 / 密码：B 的 Windows 账号

**方式二：A 能直连 B:22**（例如已通过其他方式打通），直接填写 B 的 IP 与 `22`。

程序里的 `host/port` 是普通连接参数，切换方式不需要改代码。

---

## 5. 界面与功能

| 页面 | 内容 |
| --- | --- |
| 概览 | 链路健康、在线时长、实时吞吐曲线、两个业务的独立指标、最近事件 |
| 端口映射 | 映射卡片、新建/编辑抽屉、端口占用校验、自动挑选空闲端口、启停开关、单映射流量 |
| 内网代理 | 总开关、代理地址复制、PAC 白名单分流、B 侧连通性探测、使用示例、实时请求日志（可按失败过滤） |
| 连接管理 | 主机信息、密钥与指纹、连接/断开/测试、防火墙规则对账与权限修复提示 |
| 设置 | 深/浅主题、自动重连、日志保留条数、数据目录与备份说明 |

实时指标通过 SSE 每秒推送一次，不做轮询；页面切换与抽屉使用 150–250ms 的过渡，支持 `prefers-reduced-motion`。

---

## 6. 安全模型

- 控制台与 REST API **只监听 `127.0.0.1`**，并校验 `Host` / `Origin`，避免 DNS rebinding 与跨站写操作。
- 首次配置使用密码登录，仅用于安装公钥；密码只存在于当次请求内存，不写配置、不写日志。
- 私钥保存在 `%APPDATA%\TunnelDesk\keys\`，Windows 下继承用户 ACL；程序启动时校验文件存在。
- 主机指纹在首次连接时记录（TOFU），展示在「连接管理」中；当前版本不做指纹变更阻断，迁移主机时请人工核对。
- 端口映射默认只绑定 `127.0.0.1`；代理默认只允许本机，开启「局域网访问」才会绑定 `0.0.0.0`。
- 远程命令通过 SSH `exec` + PowerShell `-EncodedCommand` 下发，避免引号注入；所有命令有超时与退出码检查。
- 日志自动脱敏 `password=...` 与 PEM 私钥块。

---

## 7. 数据与备份

| 内容 | 路径 |
| --- | --- |
| 配置 | `%APPDATA%\TunnelDesk\config.json` |
| 私钥 | `%APPDATA%\TunnelDesk\keys\` |
| 覆盖数据目录 | 环境变量 `TUNNELDESK_DATA_DIR`（测试/便携模式） |

配置采用「临时文件 + rename」原子写入；读取失败会备份为 `config.json.corrupt-<时间戳>` 并回退默认值。

迁移到另一台 A：复制整个 `TunnelDesk` 目录，重新确认 B 的主机指纹即可。删除该目录会同时清除密钥、映射与代理设置；B 上的 `TunnelDesk-*` 防火墙规则可在删除映射时自动清理，或手动通过「立即对账」清理。

---

## 8. 工程结构

```
tunneldesk/
├─ server/                 Node + TypeScript 后端
│  ├─ src/
│  │  ├─ app.ts            应用服务：主机、映射、代理、快照聚合
│  │  ├─ api/server.ts     REST + SSE + 静态资源
│  │  ├─ ssh/              link（状态机/重连）、provision、keys、client
│  │  ├─ forward/          本地监听与 direct-tcpip 转发
│  │  ├─ proxy/            HTTP / CONNECT 代理、探测、日志
│  │  ├─ firewall/         规则下发、对账、孤儿清理
│  │  ├─ config/           配置存储（原子写、校验、迁移）
│  │  └─ util/             日志、端口、路径
│  └─ test/                Vitest 单元测试
├─ web/                    React 18 + Vite 前端（无 UI 库）
│  ├─ src/pages/           概览 / 端口映射 / 内网代理 / 连接管理 / 设置
│  ├─ src/ui.tsx           自研组件（按钮、抽屉、图表、开关等）
│  ├─ src/styles.css       设计系统与响应式样式
│  └─ src/icons.tsx        自绘 SVG 图标
├─ tools/                  mock SSH 服务端、演示服务、E2E 脚本
├─ docs/specs/             设计规格
├─ docs/plans/             实施计划
└─ start.cmd               一键启动
```

---

## 9. 开发与验证

```bat
npm test                    :: 后端单元测试（Vitest）
npm run typecheck           :: 前后端 TypeScript 检查
npm run build               :: 构建前端静态资源 + 后端 dist
npm run dev:server          :: 后端开发模式（tsx watch）
npm run dev:web             :: 前端 Vite 开发服务器（代理 /api 到 19000）
```

### 本地端到端验证（无需真实 B）

```bat
:: 三个终端分别启动
node tools\demo-target.mjs --port 18080
node tools\mock-ssh-server.mjs --port 2222
set TUNNELDESK_DATA_DIR=%TEMP%\td-e2e && node server\dist\index.js --port 19000

:: 第四个终端
node tools\e2e-smoke.mjs
```

覆盖内容：密码换密钥、密钥登录、端口映射转发、HTTP 代理转发、B 侧探测、防火墙规则创建、删除映射后的规则清理。

模拟服务只用于开发验证，不会进入生产路径。真实环境请按第 3、4 节在 B 上验证一次 RDP/HTTP 与内网域名。

---

## 10. 已知限制（v0.1）

- 代理仅支持 HTTP 与 HTTPS CONNECT，**不支持 SOCKS5 / UDP**。
- PAC 白名单只支持固定 IPv4 精确匹配，单次最多 200 个，不支持域名、网段或端口；PAC 只对遵循系统代理设置的程序生效，并可能被浏览器缓存。
- 仅支持「A → B」方向，不做反向映射。
- 无系统托盘、无开机自启、无安装包与自动更新。
- 单用户、单活动主机；多主机配置会保留，但同时只连接一台。
- 主机指纹仅首次记录并展示，不做变更告警。
- 真实 Azure Bastion 环境因权限原因未在本机完成自动化验证；逻辑链路已由 mock SSH 服务端覆盖。
- 若 B 的 OpenSSH 禁用了密码登录，当前版本需手动导入密钥后编辑配置（界面暂无「使用已有密钥」入口）。

---

## 11. 故障排查

| 现象 | 处理 |
| --- | --- |
| 提示「Access is denied / 拒绝访问」 | B 的远程会话没有管理员令牌，按 3.1 执行一次注册表修复，或关闭该映射的防火墙同步 |
| 映射显示「本地端口已被占用」 | 在编辑抽屉中换一个端口；「新建映射」会自动挑选 13389 起的空闲端口 |
| 连接一直「重连中」 | 检查 A→B 的 SSH 端口；Bastion 方式下确认 `az network bastion tunnel` 仍在运行 |
| 代理能开但访问 502 | 目标地址需从 **B** 侧可达；用「连通性测试」验证，注意内网 DNS 只在 B 上生效 |
| 密钥登录失败（All configured authentication methods failed） | B 的 `authorized_keys` 可能带 UTF-8 BOM，或管理员账号没有写入 `administrators_authorized_keys`；在 B 上用管理员 PowerShell 以无 BOM 方式重写公钥，并写入 `administrators_authorized_keys` 后修正权限 |
| 浏览器提示需要认证/无法使用代理 | 确认客户端走的是 HTTP 代理而非 SOCKS；HTTPS 站点需允许 CONNECT |
| 配了 PAC 但白名单 IP 仍直连 | 确认代理总开关已启用、IP 填写的是 URL 中的主机地址、Windows 已选「使用设置脚本」，并重启浏览器清除 PAC 缓存 |
| 想彻底清理 | 删除所有映射（自动清理 B 规则）→ 删除主机 → 退出程序 → 删除 `%APPDATA%\TunnelDesk` |

---

## 12. 许可

MIT（个人自用项目）。
