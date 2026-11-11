# TunnelDesk

TunnelDesk 是一个面向个人工作流的 SSH 访问控制台，用来把「电脑 B」（Azure 虚拟机 / 跳板机）上的能力安全地借给「电脑 A」（本机）：

- **端口映射**：把 B 上的服务端口映射到 A 的 `127.0.0.1:<本地端口>`，本机应用像访问本地服务一样使用它。
- **内网代理**：在本机开一个 HTTP 代理，请求经 B 的 DNS 与网络出口发出，从而访问只有 B 能访问的内网 HTTP 服务（含 HTTPS CONNECT）。
- **代理分流**：提供 PAC 脚本，可按固定 IPv4 白名单只让指定内网地址走 B，其余网站保持 A 直连。
- **Azure Bastion 接入（v0.2）**：程序内托管 50022 隧道，并可一键打开已预填凭据的远程桌面，不需要在外部手动运行 `.bat`。

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

A 上 SSH 直连只需 Node.js；使用 Azure Bastion 方式时另需安装 Azure CLI（≥ 2.32）并执行 `az login`。不需要 Python、.NET、Go、Rust。

---

## 2. 快速开始

```bat
:: 首次安装依赖
npm install

:: 日常启动（弹出模式选择，直接回车默认 1）
start.cmd

:: 也可以带参数启动，跳过选择
start.cmd clean
start.cmd run
```

启动窗口会让你选择模式（直接回车默认 `1`）：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `[1] clean` | 清理 `server/dist` 与 `web/dist` → 全量编译 → 启动 | 代码有改动时 |
| `[2] run` | 跳过编译，直接用现有构建启动 | 代码未改动时 |

模式 `2` 会检查 `server/dist/index.js` 与 `web/dist/index.html` 是否存在，并打印构建产物的修改时间；缺失时明确报错并提示改用模式 `1`。**注意**：改过源码却用了旧构建时，模式 `2` 能正常启动但页面是旧的，所以只要动过代码就用模式 `1`。

> 启动脚本内的提示文字使用英文：`cmd.exe` 在 UTF-8 代码页下解析中文全角标点时，会把一行后半段误当成命令执行，纯 ASCII 最稳妥。中文说明以本文为准。

启动窗口会显示对应模式的日志；控制台运行期间窗口保持打开，关闭窗口即停止服务。如果 19000 已被占用，脚本会显示占用进程并询问；输入 `Y` 才会结束并继续，其他输入会取消并保留窗口。控制台固定监听 `http://127.0.0.1:19000`，不会对局域网开放。也可以手动启动：

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
- **停用映射或关闭同步都不会删除 B 侧规则**：只要映射记录还在，规则就保留。停用只停止 A 侧监听，关闭同步只是不再自动补建 / 修复。只有删除映射、或把目标改为非 B 时，才清理对应规则。
- 修改目标端口后，对账会比较规则的本地端口 / 方向 / 协议 / 启用状态；不一致时先删同名规则再重建。即使改端口时 SSH 离线，重连后的对账也会修正。
- **只有目标地址为 `localhost` / `127.0.0.1` / `::1` 时才在 B 上创建规则**；填其它 IP 或域名表示「B 可达的第三方」，B 上不开放端口，也不会修改那台主机的防火墙（见 `docs/manual/protocol-support-guide.md`）。
- 启动、重连、手动「立即对账」时会列出所有 `TunnelDesk-*` 规则，删除不属于任何映射记录的孤儿规则，因此不会越积越多；另有 1 小时低频兜底对账，用于清理崩溃 / 断电后遗留的规则。
- 程序只操作带该前缀/分组的规则，不会误删系统或其他软件的规则。

---

## 4. Azure Bastion 场景

需求明确 **不能修改 Azure VM 的相关配置**（NSG、Bastion、入站规则），因此 TunnelDesk 不依赖任何新增入站端口。v0.2 起程序内置两种连接方式：

**方式一（推荐，v0.2 新增）：程序托管的 Azure Bastion**

1. 在「连接管理 → Azure Bastion」保存三个值：Bastion 名称、资源组、VM 资源 ID，以及可选的 RDP 账号/密码。
2. 新建主机时选择「Azure Bastion」。地址与端口由程序固定为 `127.0.0.1:50022`，不允许编辑。
3. 程序会自动执行并托管：

   ```powershell
   az network bastion tunnel `
     --name <bastion-name> `
     --resource-group <resource-group> `
     --target-resource-id <vm-resource-id> `
     --resource-port 22 `
     --port 50022
   ```

4. 隧道就绪后自动完成首次密码换密钥；此后 SSH、端口映射、内网代理都复用这条隧道。
5. 「远程桌面」按钮会临时建立 3389 隧道并打开 `mstsc`；RDP 账号与密码自动预填，不需要重新输入。

前提：A 上安装 Azure CLI（≥ 2.32）并执行过 `az login`，`az` 在 PATH 中；Bastion 为标准 SKU 且已启用 native client。

> 三个 Bastion 参数只保存在 `%APPDATA%\TunnelDesk\config.json`，不会进入仓库、日志或诊断输出；配置卡片默认打码显示。RDP 密码只以 Windows DPAPI 密文保存。
>
> 该路径已在真实 Azure 环境中实测通过：`--resource-port 22 --port 50022` 建立后，TunnelDesk 以 `127.0.0.1:50022` 正常连接，端口映射与内网代理同时可用。

**方式二：SSH 直连（原有行为）**

A 能直连 B:22 时，直接选择「SSH 直连」，填写 B 的地址与 `22`。若仍想用外部 `.bat` 手动起 Bastion 隧道，也可以选择 SSH 直连并填写 `127.0.0.1:50022`，行为与 v0.1 完全一致。

---

## 5. 界面与功能

| 页面 | 内容 |
| --- | --- |
| 概览 | 链路健康、在线时长、实时吞吐曲线、两个业务的独立指标、最近事件 |
| 端口映射 | 映射卡片、新建/编辑抽屉、端口占用校验、自动挑选空闲端口、启停开关、单映射流量 |
| 内网代理 | 总开关、代理地址复制、PAC 白名单分流、B 侧连通性探测、使用示例、实时请求日志（可按失败过滤） |
| 连接管理 | 主机信息、密钥与指纹、连接/断开/测试、防火墙规则对账与权限修复提示；Azure Bastion 配置、50022 隧道状态/诊断、远程桌面 |
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
- Azure Bastion 的三个参数（Bastion 名称、资源组、VM 资源 ID）只保存在本机配置目录，日志、错误与诊断输出统一替换为 `***`；配置卡片默认打码。
- RDP 密码只以 Windows DPAPI（CurrentUser）密文保存，`.rdp` 文件只写入密文对应的十六进制 blob，不落明文；程序退出时删除临时 `.rdp`。
- 日志自动脱敏 `password=...` 与 PEM 私钥块。

---

## 7. 数据与备份

| 内容 | 路径 |
| --- | --- |
| 配置 | `%APPDATA%\TunnelDesk\config.json`（含 Azure Bastion 配置与 DPAPI 密码密文） |
| 私钥 | `%APPDATA%\TunnelDesk\keys\` |
| 临时远程桌面文件 | `%APPDATA%\TunnelDesk\rdp\`（会话结束/程序退出时删除） |
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
│  │  ├─ bastion/          az 隧道、RDP、DPAPI、打码、配置校验
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
├─ tools/                  mock SSH 服务端、演示服务、E2E / 阶段二验证脚本
├─ docs/specs/             设计规格
├─ docs/plans/             实施计划
├─ docs/manual/            使用说明与验收清单
└─ start.cmd               双模式启动脚本（clean / run）
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

### 阶段二本地验证（2026-11-10，非真实环境）

`node tools/phase2-verify.mjs` 会在隔离端口自动启动 mock B、演示服务与控制台，跑完自动清理。验证记录分三级：

| 标记 | 含义 | 本阶段覆盖 |
| --- | --- | --- |
| `[local-real]` | 本机真实客户端 + 真实协议栈 | HTTP、HTTPS/TLS（自签证书）、真实 git 生成的二进制流、TCP 大包与字节完整性 |
| `[mock]` | 链路级 / 夹具验证 | SVN、SQL Server、MySQL 的字节透传与长连接；F1 判定与对账；新增单测 |
| `[real-env]` | 真实内网 B + 真实服务端 | **本阶段未执行**，请按 `docs/manual/phase2-acceptance-checklist.md`（V-1~V-11）验收 |

```bat
npm test                        :: 10 个文件 / 85 项，全部通过
npm run typecheck               :: 前后端通过
npm run build                   :: 前端 Vite + 后端 tsc 通过
node tools/phase2-verify.mjs    :: 本地端到端 + 原有 12 项 E2E 回归
```

结果：阶段二本地检查 27 项全部通过，其中原有 E2E 冒烟 12 项亦全部通过。**2 项跳过**：HTTPS/TLS 需要本机 `openssl`，Git 的完整 clone/push 需要 git-daemon 或 Smart HTTP，本机 PortableGit 不提供，均留到真实环境验收。

> **阶段二的真实环境未验证**。下表只记录此前 v0.2 已实测项目；阶段二未实测项不写入该表。协议用法见 `docs/manual/protocol-support-guide.md`，真实环境验收清单见 `docs/manual/phase2-acceptance-checklist.md`。

### 真实环境验证（2026-11-10）

在真实 Windows 环境下完成了一次端到端验收，以下项目均已实测通过：

| 项目 | 结果 |
| --- | --- |
| Azure Bastion 接入 | `az network bastion tunnel --resource-port 22 --port 50022` 建立后，控制台以 `127.0.0.1:50022` 正常连接，无需改动 VM / NSG / Bastion |
| 端口映射 | A 本地监听端口 → B 侧目标端口端到端可用 |
| 内网代理（HTTP / HTTPS CONNECT） | 在 A 的系统代理中填入 `127.0.0.1:8888` 后，网页访问直接成功，请求确实经 B 的 DNS 与网络出口发出 |
| PAC 白名单分流 | 命中白名单的地址走 B，未命中地址保持 A 直连，在真实系统代理设置下生效 |
| 防火墙规则生命周期 | 此前已在局域网真实主机上验证：创建映射生成入站/出站规则，删除映射后规则全部清理 |

尚未覆盖的部分（SOCKS5 / UDP、反向映射、多主机并行、指纹变更阻断等）见第 10 节。

---

## 10. 已知限制（v0.2）

- 代理仅支持 HTTP 与 HTTPS CONNECT，**不支持 SOCKS5 / UDP**。
- PAC 白名单只支持固定 IPv4 精确匹配，单次最多 200 个，不支持域名、网段或端口；PAC 只对遵循系统代理设置的程序生效，并可能被浏览器缓存。
- 仅支持「A → B」方向，不做反向映射。
- 无系统托盘、无开机自启、无安装包与自动更新。
- 单用户、单活动主机；多主机配置会保留，但同时只连接一台。
- Azure Bastion 只支持**一套全局配置、一台 VM**；不提供多 VM 切换，也不做 `az vm start` 开机。
- 远程桌面与 DPAPI 加密仅支持 Windows；RDP 会话依赖 3389 隧道，关闭 TunnelDesk 后桌面会断开。
- 主机指纹仅首次记录并展示，不做变更告警。
- 自动化回归仍以 mock SSH 服务端为主；真实环境已完成的验证范围见第 9 节「真实环境验证」。
- 若 B 的 OpenSSH 禁用了密码登录，当前版本需手动导入密钥后编辑配置（界面暂无「使用已有密钥」入口）。
- **内网代理的 HTTP/1.1 语义不合规**（强制 `Connection: close`、一连接只解析一次请求头），依赖连接复用或 WebDAV 扩展方法的客户端经代理可能失败，典型现象是 SVN `commit` 失败而 `checkout` / `update` 正常。阶段二按需求约定**不修复**，此类场景请使用端口映射。
- 端口映射基于 `socket.pipe()`，客户端发完数据立即 TCP 半关闭并期待回包的边缘用法会丢失回包；真实协议均在收到响应后才关闭，不受影响。
- SQL Server 命名实例 `HOST\INSTANCE` 依赖 UDP 1434 SQL Browser，不支持；请使用显式 TCP 端口与 `host,port` 连接串。
- 阶段二的能力矩阵、使用侧适配与验收清单见 `docs/manual/protocol-support-guide.md`、`docs/manual/phase2-acceptance-checklist.md`。

---

## 11. 故障排查

| 现象 | 处理 |
| --- | --- |
| 提示「Access is denied / 拒绝访问」 | B 的远程会话没有管理员令牌，按 3.1 执行一次注册表修复，或关闭该映射的防火墙同步 |
| 映射显示「本地端口已被占用」 | 在编辑抽屉中换一个端口；「新建映射」会自动挑选 13389 起的空闲端口 |
| 连接一直「重连中」 | 检查 A→B 的 SSH 端口；Bastion 方式下确认 50022 隧道处于「就绪」，未就绪时先点「启动 50022」 |
| 提示「未找到 Azure CLI（az）」 | 在 A 上安装 Azure CLI（≥ 2.32），确认 `az` 在 PATH 中，必要时重开启动窗口 |
| 提示「Azure CLI 未登录」 | 在命令行执行 `az login`；多订阅时用 `az account set` 选择正确订阅后重试 |
| 提示「端口 50022 被 xxx(PID) 占用」 | 点击配置卡片里的「一键停止并重连」；若确认是其他程序，先关闭它再启动 |
| 50022 隧道反复重连后停止 | 点「az 诊断输出」查看最近 200 行输出（已打码），确认 az 登录、订阅与 VM 资源 ID |
| 点「远程桌面」没有弹窗 | 确认 `mstsc.exe` 可用、3389 隧道能就绪；错误会以 toast 和诊断输出给出 |
| 远程桌面对话框仍要求输密码 | 在 Bastion 配置里保存 RDP 账号与密码；密码密文换 Windows 账号/机器后无法解密，需要重新填写 |
| 代理能开但访问 502 | 目标地址需从 **B** 侧可达；用「连通性测试」验证，注意内网 DNS 只在 B 上生效 |
| 密钥登录失败（All configured authentication methods failed） | B 的 `authorized_keys` 可能带 UTF-8 BOM，或管理员账号没有写入 `administrators_authorized_keys`；在 B 上用管理员 PowerShell 以无 BOM 方式重写公钥，并写入 `administrators_authorized_keys` 后修正权限 |
| 浏览器提示需要认证/无法使用代理 | 确认客户端走的是 HTTP 代理而非 SOCKS；HTTPS 站点需允许 CONNECT |
| 配了 PAC 但白名单 IP 仍直连 | 确认代理总开关已启用、IP 填写的是 URL 中的主机地址、Windows 已选「使用设置脚本」，并重启浏览器清除 PAC 缓存 |
| 想彻底清理 | 删除所有映射（自动清理 B 规则）→ 删除主机 → 退出程序 → 删除 `%APPDATA%\TunnelDesk` |

---

## 12. 许可

MIT（个人自用项目）。
