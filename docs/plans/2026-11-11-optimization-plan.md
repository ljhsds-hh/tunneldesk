# 实施计划：体验与工程化优化（v0.2.1）

- 日期：2026-11-11
- 状态：**已完成（2026-11-11）**
- 代码基线：v0.2.0（1216dc5）
- 触发来源：全量代码复查（server 25 文件 / web 10 文件 / 3354 行 CSS）后达成的优化清单
- 实施原则：不重写架构、不改配置模型语义、不动 `httpProxy.ts` 的 HTTP/1.1 语义（阶段二约定）、不动转发核心、不为「看起来安全」引入半套信任存储

---

## 1. 问题与目标

| 编号 | 问题 | 证据 | 目标 |
| --- | --- | --- | --- |
| P-1 | 任何映射变更都同步等待一次 B 侧防火墙对账，UI 点击后 1~2 秒无反馈 | `app.ts` `updateMapping` 末尾 `await syncFirewall()`；`firewall.sync()` 至少 2 次 PowerShell exec | 变更接口立即返回，对账转入串行链后台执行 |
| P-2 | 防火墙脚本开销随规则数线性放大 | `list()` 全量枚举规则后在 PowerShell 侧过滤；`sync()` 每条待建规则单独 exec + 单独 refresh | `-Group` 下推过滤 + 待建规则单次批量下发 |
| P-3 | 删除「非活动主机」时，它名下的 B 侧规则永久残留 | `removeHost` 仅在 `isActive && online` 时清理 | 删除主机时用临时 SSH 连接清理，失败明确告警 |
| P-4 | 日志能力做了但不可达：接口闲置、无落盘、无审计 | `GET /api/logs` 前端零引用；Logger 仅内存 400 条；启停映射/分组/设置不写日志 | 日志落盘 + 补审计事件 + 新增日志面板 |
| P-5 | SSE 每秒推全量快照，多标签页重复序列化 | `openEventStream` 每个连接每秒调 `app.snapshot()`，含 80 条系统日志 + 60 条代理日志 | 帧内容短 TTL 缓存复用；快照内日志条数收敛 |
| P-6 | 显示与文案与实现不符 | 版本 0.1.0、UA `TunnelDesk/0.1`、无条件「自动重连已启用」、`formatRelative().replace('前','')`、映射卡片写死 `127.0.0.1`、运行时长只给分钟、SOCKS5「已预留」说法 | 逐条按实现改正 |

## 2. 改动点清单

| 编号 | 文件 | 改动 | 对应 |
| --- | --- | --- | --- |
| CH-1 | `server/src/version.ts`（新增） | 运行时读取根 `package.json` 的 version，读失败回退 `0.0.0`；导出 `APP_VERSION` | P-6 |
| CH-2 | `web/vite.config.ts`、`web/src/env.d.ts`（新增）、`web/src/App.tsx`、`web/src/pages/Settings.tsx` | 构建期注入 `__APP_VERSION__`；侧栏与「关于」改用注入值 | P-6 |
| CH-3 | `server/src/util/logger.ts` | 新增 `fileDir` 选项：按天滚动写 `tunneldesk-YYYY-MM-DD.log`，保留 7 天；时间戳改本地；TTY 下级别着色；`VITEST` 环境强制不落盘 | P-4 |
| CH-4 | `server/src/firewall/manager.ts` | `list()` 改 `Get-NetFirewallRule -Group 'TunnelDesk'`；新增 `buildRuleScript()` / `buildRuleRemovalScript()`；`sync()` 待建规则合并为一次批量下发并按 `OK|name` / `ERR|name|msg` 解析；`applyMapping()` 复用批量路径 | P-2 |
| CH-5 | `server/src/app.ts` | 新增 `scheduleFirewallSync()`；`create/update/deleteMapping` 改为不阻塞；`deleteMapping` 去掉多余的全量 sync；`removeHost()` 清理所有被删主机的规则（临时连接，10s 上限）；补审计日志；`snapshot()` 带 `version`；新增 `snapshotFrame()` 短 TTL 缓存；日志条数收敛 | P-1、P-3、P-4、P-5 |
| CH-6 | `server/src/api/server.ts` | SSE 改用 `app.snapshotFrame()` | P-5 |
| CH-7 | `server/src/forward/manager.ts` | 监听失败只记一条日志，保留可读文案（不再被原始 errno 覆盖） | P-6 |
| CH-8 | `web/src/api.ts` | 新增 `logs()`；新增 `formatSince()`（「已保持」用，不带「前」） | P-4、P-6 |
| CH-9 | `web/src/pages/LogPanel.tsx`（新增）、`web/src/pages/Overview.tsx` | 运行日志抽屉：级别过滤、关键字搜索、复制、刷新、落盘路径 | P-4 |
| CH-10 | `web/src/pages/Connection.tsx`、`Mappings.tsx`、`Proxy.tsx`、`Settings.tsx`、`index.html` | 文案与显示修正；映射卡片改用 `bindAddress` 并补「上行」；主题首帧预热脚本 | P-6 |
| CH-11 | `server/test/*` | 新增批量下发、`-Group` 过滤、删除脚本、Logger 落盘、版本一致性用例；沿用既有 fake SSH 语义 | 第 5 章 |
| CH-12 | `README.md`、本文件 | 回填验证结果与测试数字 | 第 5 章 |

**明确不改**：`server/src/proxy/httpProxy.ts` 的 HTTP/1.1 语义（阶段二 C6）、`forward/manager.ts` 的 `pipe` 转发核心、`MappingConfig` / `config.json` 结构、`isTrustedOrigin` 与 `hostVerifier` 的既有取舍、3354 行全局 CSS 的组织方式。

## 3. 关键实现决策

1. **对账异步化不改语义**：`syncFirewall()` 仍走同一条 `firewallChain`，只是不再被变更接口 `await`；所有 `enqueueFirewall` 调用共享串行链，保证同一时刻只有一条 B 侧命令在跑。失败只记 `warn` 日志，不再向 API 调用者抛出——防火墙失败不该让「改个名字」这种操作整体报错。
2. **批量下发的解析协议**：脚本对每条规则 `try { ... ; Write-Output 'OK|<name>' } catch { Write-Output ('ERR|<name>|' + $_.Exception.Message) }`。若 stdout 里没有逐条标记但含 `RULE_OK`，视为全部成功——该分支保留给既有的 fake SSH 实现，真实执行时必定带逐条标记。
3. **删除主机的清理边界**：活动且在线走现有 `link.exec`；其余情况用 `host.keyPath` 建一次临时连接，10 秒硬超时，无论成败都 `end()`。只删 `TunnelDesk-<mappingId>` 精确名称，不碰第三方规则。清理失败时保留主机删除结果，但写 `warn` 并在返回体里带上失败条数，UI 据此提示。
4. **日志落盘不阻塞主流程**：`fs.createWriteStream` 追加写；跨天检测在 `push()` 里按日期字符串比较，切换时重建流并异步清理 7 天前的文件。任何 IO 异常都被吞掉（日志失败不能让业务失败）。
5. **测试环境隔离**：`Logger` 在 `process.env.VITEST` 存在时不落盘，避免单测往真实 `%APPDATA%\TunnelDesk\logs` 写文件。
6. **版本单一来源**：根 `package.json` → 服务端运行时读取（`new URL('../../package.json', import.meta.url)`，`src` 与 `dist` 两种布局都能解析）→ snapshot 的 `version`；前端构建期 `define` 注入。新增一致性测试防漂移。

## 4. 非目标

- 不引入 ESLint / Prettier / CI / Docker（阶段二已明确非目标）。
- 不做 React 组件级 memo / 虚拟列表：本机单用户场景，收益低于改动风险。
- 不做前端 bundle 拆分、静态资源 gzip：服务对象是本机 127.0.0.1。
- 不改 HTTP 代理的 `Connection: close` 与单请求解析逻辑（SVN commit 场景按阶段二约定走端口映射）。

## 5. 验证计划

| 层级 | 手段 | 通过标准 |
| --- | --- | --- |
| 单元 | `npm test`（server，单 worker） | 全绿，新增用例覆盖 CH-4 / CH-5 / CH-3 / CH-1 |
| 类型 | `npm run typecheck` | server + web 均无错误 |
| 构建 | `npm run build` | web 产物 + server dist 均生成 |
| 端到端 | `tools/phase2-verify.mjs` | 既有 27 PASS + 1 SKIP 不回归 |
| 人工 | 启动控制台，检查日志面板、开关响应、主题首帧 | 见第 6 章记录 |

## 6. 实施结果

| 编号 | 结果 |
| --- | --- |
| CH-1 / CH-2 | 根 `package.json` 成为唯一来源：服务端 `version.ts` 运行时解析（`src` 与 `dist` 两种布局均可），前端由 `vite define` 注入 `__APP_VERSION__`；`snapshot()` 增加 `version`。新增一致性单测，版本漂移会直接失败 |
| CH-3 | Logger 支持按天滚动落盘、保留 7 天、本地时间戳、TTY 级别着色；落盘开关收敛到 `App` 构造处（`VITEST` 下不写盘），Logger 本身保持纯粹、可单测 |
| CH-4 | `list()` 改 `Get-NetFirewallRule -Group 'TunnelDesk'`；`buildRuleScript()` 把 N 条规则合成一次 exec，逐条 `OK|name` / `ERR|name|msg`；`buildRuleRemovalScript()` 供删除主机复用。sync 的 B 侧 exec 次数由 `1 + 2N` 降为 `3` |
| CH-5 | `create/update/deleteMapping` 不再 `await` 对账；删除映射去掉多余的全量 sync（少 2 次 PowerShell）；`removeHost()` 对非活动主机用临时连接清理规则并回报 `rulesCleaned` / `cleanupNote`；补齐审计日志（映射字段级 diff、分组、代理、设置、主机关闭）；`snapshotFrame()` 做 250ms 序列化复用 |
| CH-6 | SSE 改用 `snapshotFrame()`，多客户端共享同一帧；帧内日志由 80 / 60 收敛为 30 / 50，全量走 `/api/logs` |
| CH-7 | 监听失败只有一个错误入口：保留「本地端口 x 已被占用」文案，并补 `EACCES` / `EADDRNOTAVAIL` 人话提示，不再重复记两条日志 |
| CH-8 / CH-9 | 新增 `api.logs()`、`formatSince()`、`formatDateTime()`；概览「最近活动」可打开运行日志抽屉（级别过滤、关键字搜索、复制路径、3 秒自动刷新，展示内存条数与落盘目录） |
| CH-10 | 文案与显示：自动重连提示按实际设置显示；「自动重连」卡片改名「隧道开关」；「已保持」改用 `formatSince`；映射卡片显示真实 `bindAddress` 并补「上行」；运行时长用 `formatDuration`；去掉「SOCKS5 已预留」的未证实说法；`index.html` 增加首帧主题预热；SSE 断开时侧栏提示数据可能过期 |
| CH-11 | 新增 `server/test/runtime-ops.test.ts` 17 项：批量脚本结构、逐条失败计数、`-Group` 下推、日志落盘与保留策略、版本一致性、审计 diff、删除主机清理（成功 / 失败两条路径）、快照帧复用。同步更新 `tools/phase2-verify.mjs` 的两处即时断言为轮询（对账异步化后必须等待最终一致） |
| CH-12 | README 更新测试数字（111 项 / 1 项跳过）、日志路径、异步对账说明与「优化验证（2026-11-11）」记录；阶段二规格中的测试数字补注 |

### 6.1 计划外发现并修复

- **流量方向统计错误**：`bytesIn` 实际统计的是 A 发出的字节（上行），UI 却把它标成「下行」，上下行在概览、映射卡片、代理页全部反了。改为从 A 的视角记账（`bytesIn` = 到达 A）后，一处修正即让所有标签变正确，`types.ts` 补了约定注释。
- **权限判定优先级**：批量下发时若部分规则因权限失败，`privilege` 仍会被置为 `elevated`，UI 会误以为会话有管理员令牌。改为权限类错误优先标记 `denied`。
- **删除未知主机**：`removeHost` 原先对不存在的 id 静默返回成功，现返回 404「主机不存在」。

### 6.2 验证记录

| 层级 | 结果 |
| --- | --- |
| `npm test` | **11 文件 / 111 项全部通过** |
| `npm run typecheck` | server + web 通过 |
| `npm run build` | web 产物（46.4 KB CSS / 235.9 KB JS）+ server dist 生成 |
| `node tools/phase2-verify.mjs` | **27 PASS + 1 SKIP**，含原有 12 项 E2E 回归 |
| 接口自检 | 临时数据目录启动，`/api/state` 含 `version:0.2.0`，`/api/logs` 返回全量，`/api/events` 正常推帧，`/proxy.pac` 正常，未知主机 DELETE 返回 404 |
| 日志落盘 | 生成 `logs/tunneldesk-2026-11-11.log`，本地时间戳、定宽对齐、`password=` 已脱敏 |
| `-Group` 语义 | 本机 PowerShell 对比 `-Group` 与属性过滤，返回数量一致（52 = 52） |

**仍未验证**：批量脚本在真实 Windows B 上的执行、`removeHost` 临时连接清理、`Get-NetFirewallRule -Group` 对本工具创建规则的匹配，均需真实主机。README 中已列为「未在本轮验证」并给出三步自查方法，未写入真实环境验证表。

### 6.3 终审补强（2026-11-11 第二轮）

对着 diff 逐文件复查后又收了六处，均已补测试或补断言：

| 项 | 问题 | 处理 |
| --- | --- | --- |
| R-1 | 规则名直接插进 PowerShell 单引号，映射 ID 若含 `'`（手改 config.json 可造）会让**整批**脚本语法错误 | 新增 `psQuote()`，按 PowerShell 规则把 `'` 转义成 `''`，规则名本身不变；新增断言 |
| R-2 | 批量脚本「退出码 0 但没有任何标记」会被当成 0 条待办，静默漏建 | 改为记为失败并写 `lastError = 'B 端未返回规则执行结果'`；新增断言 |
| R-3 | 批量成功后没有任何成功日志（旧实现每条规则一行），审计断链 | 补聚合日志「已放行 N 条 B 端口规则」；新增断言并验证只记一行 |
| R-4 | 离线删除映射时日志仍写「并清理 B 侧规则」，与事实不符 | 按 `link.isOnline()` 分两种文案，离线时写明「将在下次连接时清理」 |
| R-5 | `openEntry` 的 `catch` 在同步 `listen()` 抛错时可能带出上一次残留的 `lastError` | 进入 `openEntry` 先清空 `lastError`，`catch` 回退到本次抛出的 message |
| R-6 | 映射卡片改 4 列后，`999.9 KB/s` 这类数值可能压到相邻列 | 字号 12.5→11.5px、`min-width: 0` + `ellipsis` |

终审后复跑：`npm test` 111 项全过、`typecheck` 0 错误、`build` 通过、`phase2-verify` 27 项通过 + 1 跳过 + 0 失败。产物检查确认新样式与文案（`log-tools`、`log-row--error`、`live-note`、`运行日志`、`实时连接中断`、`隧道开关`、`A 任意网卡`）都进了构建包，版本常量被 vite 内联为 `0.2.0`。受本机沙箱限制，无头浏览器无法启动，UI 只做到类型检查、构建与静态产物核对，未做真实浏览器渲染验证。
