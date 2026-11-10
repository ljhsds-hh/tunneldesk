# TunnelDesk 实施计划

- 日期：2026-11-04（2026-11-10 补充真实环境验证）
- 关联规格：`docs/specs/2026-11-04-tunneldesk-design.md`
- 状态：v0.1 已交付；本地 mock 全链路验证通过，真实 Azure Bastion / 局域网环境验证通过

## 1. 交付目标

| 编号 | 目标 | 验收标准 |
| --- | --- | --- |
| G1 | 端口映射 | A 上 `127.0.0.1:<本地端口>` 可访问 B 的 TCP 服务，支持增删改启停 |
| G2 | 内网 HTTP 代理 | 客户端配置代理后可访问仅 B 可达的 HTTP/HTTPS 服务 |
| G3 | 业务分离 | 两个业务在导航、页面、指标、日志上完全独立 |
| G4 | B 端零安装 | 不安装 Agent、不注册服务、不新增监听端口，仅复用 OpenSSH |
| G5 | 防火墙生命周期 | 创建映射自动放行 B 端口；删除/停用/改端口同步清理；启动/重连/手动对账清理孤儿规则 |
| G6 | 密钥登录 | 首次密码换 RSA-3072 密钥，之后纯密钥登录，密码不落盘 |
| G7 | 企业级界面 | 自定义设计系统、深浅主题、完整空/错/加载态、响应式 |
| G8 | 可运行与可验证 | 单测、类型检查、构建、E2E 全部可复跑 |

## 2. 阶段划分

### 阶段 0：需求与选型（完成）

- 阅读 `需求.txt`，确认个人自用、B 有管理员权限、内网先只做 HTTP、界面形态自定。
- 对比候选方案：
  - frp / rathole：需在 B 放二进制并常驻，违背「B 端操作最少」。
  - WinRM + PowerShell：不适合长连接与任意 TCP。
  - **SSH `direct-tcpip`（选定）**：复用已有 SSH 与 Bastion 通道，零安装、天然多路复用与加密。
- 结论写入设计规格 D1–D5。

### 阶段 1：工程骨架（完成）

- npm workspaces：`server`（Node + TS + ssh2）、`web`（React 18 + Vite）。
- tsconfig（NodeNext / Bundler）、Vitest、构建脚本、目录约束。
- 规格文档与决策记录。

### 阶段 2：后端核心（完成）

1. `config/store`：版本化配置、字段兜底、原子写、写串行化、损坏备份。
2. `ssh/keys` + `ssh/provision`：RSA-3072（PKCS#1）、OpenSSH 公钥编码、`authorized_keys` 幂等写入。
3. `ssh/link`：状态机、keepalive、指数退避重连、`forwardOut`、`exec` 超时。
4. `forward/manager`：本地监听、离线快速拒绝、按映射统计字节、变更串行化。
5. `proxy/httpProxy`：绝对 URL 请求、CONNECT、请求头过滤、状态码/耗时/流量日志、B 侧探测。
6. `firewall/manager`：规则命名、入/出站下发、删除、对账与孤儿清理、权限错误识别。
7. `api/server`：REST、SSE、静态资源、Host/Origin 校验、请求体上限。
8. `app`：服务编排、快照聚合、速率计算、在线恢复。

### 阶段 3：前端（完成）

- 设计系统：颜色/间距/圆角/阴影 token、深色默认 + 浅色、自绘图标与 SVG 图表。
- 布局：固定侧边栏（窄屏图标模式、移动端底部导航）、页面骨架、Toast、Drawer、确认框。
- 页面：概览、端口映射、内网代理、连接管理、设置。
- 实时：`EventSource` 每秒快照；60 秒滚动序列；切页不重建连接。

### 阶段 4：测试与修复（完成）

- 单元测试：初始 15 项，当前 29 项（新增 PAC、公钥写入、CLIXML 清洗等）；覆盖端口解析、规则名、配置净化、端口探测、密钥编码、PowerShell 编码、配置持久化。
- 类型检查与生产构建通过。
- 本地 E2E 12 项：见下表。
- 修复：PowerShell 回写导致的中文编码损坏、`ClientChannel` 无 `setNoDelay`、TLS socket 类型、列表内联 `code` 断行、主题预览对比度、空图表观感。

### 阶段 5：文档与交付（完成）

- README：安装、B 端准备、Bastion、安全、故障排查。
- 本计划、启动脚本、`.gitignore`。
- 清理演示数据，复跑全部验证命令。

## 3. 测试矩阵

| 层级 | 用例 | 方式 | 结果 |
| --- | --- | --- | --- |
| 单元 | `splitHostPort`（host:port、默认端口、IPv6、多级域名） | Vitest | 通过 |
| 单元 | 防火墙规则名往返、忽略外部规则 | Vitest | 通过 |
| 单元 | 端口钳制、代理绑定范围净化 | Vitest | 通过 |
| 单元 | 端口空闲检测、递增查找 | Vitest | 通过 |
| 单元 | OpenSSH 公钥行、指纹 | Vitest | 通过 |
| 单元 | PowerShell `-EncodedCommand` 往返 | Vitest | 通过 |
| 单元 | 配置默认值、原子落盘、重新加载 | Vitest | 通过 |
| 集成 | 密码 → 公钥写入 → 密钥登录 | mock SSH + API | 通过 |
| 集成 | 映射监听与 TCP 转发 | mock SSH + demo 服务 | 通过 |
| 集成 | HTTP 代理转发 | mock SSH + demo 服务 | 通过 |
| 集成 | B 侧可达性探测 | mock SSH | 通过 |
| 集成 | 防火墙规则创建 | mock PowerShell | 通过 |
| 集成 | 删除映射 → 规则清理 | mock PowerShell | 通过 |
| UI | 五个页面、深/浅主题、抽屉、确认框 | 浏览器人工走查 | 通过 |
| UI | 空状态、加载态、错误提示 | 浏览器人工走查 | 通过 |
| 现场 | 真实 Azure VM：Bastion 本地转发端口接入、端口映射、HTTP/HTTPS 内网代理 | 用户在真实 A/B 上执行 | 通过（2026-11-10） |
| 现场 | 真实 Windows 主机：密钥登录、防火墙规则创建与清理 | 用户在真实 A/B 上执行 | 通过（2026-11-05） |
| 现场 | PAC 白名单分流（Windows 系统代理） | 用户在真实 A 上执行 | 通过（2026-11-10） |

## 4. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| B 的远程会话无管理员令牌 | 防火墙规则下发失败 | 识别 `Access is denied`，UI 展示一次性注册表修复命令；可关闭单映射同步 |
| Bastion 不提供 22 端口直连 | 无法建立 SSH | 文档给出 `az network bastion tunnel` 本地端口转发，程序按普通 host/port 连接 |
| 本地端口被占用 | 映射不可用 | 保存前探测，冲突时返回具体端口；新建时自动挑选空闲端口 |
| 隧道抖动 | 业务中断 | keepalive + 指数退避；监听保持占用，离线快速拒绝；重连后自动恢复与对账 |
| 规则堆积 | B 防火墙膨胀 | 生命周期绑定 + 启动/重连/手动对账清理孤儿规则 |
| 首次指纹信任（TOFU） | 中间人风险 | 展示指纹；文档提示迁移时人工核对；后续版本可加变更阻断 |
| 前端体积 | 首屏延迟 | 自研轻量组件、无 UI 库，生产包约 200 KB（gzip 63 KB） |

## 5. 后续版本建议

1. SOCKS5 + UDP ASSOCIATE，覆盖非 HTTP 内网协议。
2. 多主机并行连接与按映射选择主机。
3. 主机指纹变更告警与已知主机管理。
4. 系统托盘、开机自启、Windows 服务化与安装包。
5. 映射与代理的访问审计导出（CSV/JSON）。
6. 真实 Azure 环境的自动化回归（Bastion 隧道 + 防火墙权限矩阵）。

## 6. 验证记录

```text
npm --workspace server run test       29 passed
npm run typecheck                     通过（server + web）
npm run build                         通过（web 202 KB / gzip 63 KB；server tsc）
node tools/e2e-smoke.mjs              12/12 PASS
```

### 真实环境验证（2026-11-10）

| 项目 | 环境 | 结果 |
| --- | --- | --- |
| Bastion 隧道接入 | `az network bastion tunnel --resource-port 22 --port 50022`，程序连接 `127.0.0.1:50022` | 通过，未改动 VM / NSG / Bastion |
| 端口映射 | 真实 A → B，A 本地端口访问 B 侧目标服务 | 通过 |
| 内网代理 | A 系统代理设为 `127.0.0.1:8888`，访问内网 HTTP 与 HTTPS 站点 | 通过 |
| PAC 白名单分流 | 固定 IPv4 白名单，命中走 B、未命中直连 | 通过 |
| 防火墙规则生命周期 | 局域网真实主机（2026-11-05）：创建映射生成入/出站规则，删除后清理 | 通过 |

以上确认了设计规格 D1 的关键假设：无需新增 B 侧监听端口，复用 SSH 与 Bastion 隧道即可完成两个业务。

E2E 输出摘要：

```text
PASS  console API reachable
PASS  host provisioned (password -> key)
PASS  SSH link online (key auth)
PASS  host record saved
PASS  mapping created
PASS  local mapping listener bound
PASS  traffic through port mapping
PASS  traffic through HTTP proxy
PASS  B-side probe reports reachable
PASS  firewall rule created for mapping
PASS  mapping removed
PASS  firewall rule cleaned up
ALL CHECKS PASSED
```
