# 实施计划：阶段二 · 协议支持范围与防火墙规则归属

- 日期：2026-11-10
- 状态：**已完成（2026-11-10）**
- 需求规格：`../specs/2026-11-10-phase2-protocol-support.md`
- 代码基线：v0.2.0
- 实施原则：不全面重写、不改配置模型、不动 `httpProxy.ts`、不动 `forward/manager.ts` 转发核心

---

## 1. 改动点清单

| 编号 | 文件 | 改动 | 对应需求 |
| --- | --- | --- | --- |
| CH-1 | `server/src/util/net.ts` | 新增 `isBLocalTarget()`：`trim()` + `toLowerCase()` 后仅 `localhost` / `127.0.0.1` / `::1` 返回 true；`isValidHostname()` 增加 `::1` 白名单 | 4.2、4.3 |
| CH-2 | `server/src/firewall/manager.ts` | 导出 `firewallEligible()`；`FirewallDesiredPort` 增加 `targetHost`；`applyMapping()` 硬校验拒绝非 B 目标；`sync()` 补建时构造完整映射对象 | 4.4、4.6、C2/C3 |
| CH-3 | `server/src/app.ts` | desired 计算改用 `firewallEligible()`；`syncFirewall()` 串行化（防定时任务与配置变更并发下发 PowerShell）；新增 1 小时定时兜底并在 `shutdown()` 清理 | 4.4、4.5 |
| CH-4 | `web/src/pages/Mappings.tsx` | 目标地址提示改写；非 B 目标时「同步防火墙」开关置灰并说明原因，不提供绕过入口 | 4.6 |
| CH-5 | `web/src/pages/Connection.tsx` | 映射徽标对非 B 目标显示「不同步」而非「自动同步」，避免误导 | 4.6（一致性） |
| CH-6 | `server/test/firewall-target.test.ts` | 新增：判定表全类目、`::1` 校验、desired 资格、硬校验、命名空间 | 第 7 章 |
| CH-7 | `server/test/forward-transparency.test.ts` | 新增：字节完整性、大包、并发连接、半关闭、长连接空闲（用 fake `SshLink` + 本地 echo server，无需真实 SSH） | FR-1~FR-5、第 7 章 |
| CH-8 | `tools/phase2-verify.mjs` | 新增：本地协议验证脚本（HTTP/HTTPS 回归、Git 真实客户端端到端、TCP 透传） | FR-1~FR-3、FR-6 |
| CH-9 | `docs/manual/protocol-support-guide.md` | 新增：五项协议的 A 侧 URL / 连接串写法、已知适配项与可复制命令 | 第 6 章、第 9 章 |
| CH-10 | `docs/manual/phase2-acceptance-checklist.md` | 新增：V-1~V-11 完整版验收清单 | 第 8 章 |
| CH-11 | `README.md` | 补阶段二分级验证记录、更新已知限制；未实测项不进「真实环境验证」表 | C5、第 7 章 |
| CH-12 | `docs/specs/2026-11-10-phase2-protocol-support.md` | 状态改为「已实现（mock / 本地验证）」 | 第 9 章 |

**明确不改**：`server/src/proxy/httpProxy.ts`（C6）、`server/src/forward/manager.ts` 转发核心（C1）、`MappingConfig` / `config.json` 结构（C8）、`web/src/types.ts` 类型定义。

---

## 2. 关键实现决策

1. **判定函数单一来源**：`isBLocalTarget()` 放 `util/net.ts`，`firewallEligible()` 放 `firewall/manager.ts`。后端 desired 计算与 `applyMapping` 硬校验都调用同一函数，避免两处逻辑漂移。前端因无法 import server 模块，在 `Mappings.tsx` 内置一份等价的字面量集合（单测锁定后端行为）。
2. **desired 资格统一**：`firewallEligible = enabled && syncFirewall && isBLocalTarget(targetHost)`。`sync()` 补建路径构造的 `MappingConfig` 必须带 `targetHost` 与 `enabled: true`，否则硬校验会把补建全部拦掉——这是实施时最容易踩的坑。
3. **串行化**：`App` 增加 `firewallChain`，`syncFirewall()` 把实际对账排进链尾；链自身吞掉 rejection 保证后续调用不被打断，返回给调用者的 Promise 保留错误以供上层 `.catch()`。
4. **定时兜底**：`init()` 里在现有 `ticker` 之后注册 1 小时 `setInterval`（`unref()`），回调先判 `link.isOnline()`，离线跳过；`shutdown()` 里 `clearInterval`。不新增第二个定时器管理范式。
5. **转发核心零改动**：五项协议能力由现有 `socket.pipe(channel)` 天然提供，本阶段通过 CH-7 / CH-8 证明链路无损，并靠 CH-9 把使用侧适配写清。

---

## 3. 测试矩阵

| 用例 | 类型 | 覆盖 | 期望 |
| --- | --- | --- | --- |
| T-1 | Vitest | `isBLocalTarget` 判定表：`localhost` / `127.0.0.1` / `::1` / `LOCALHOST` / 前后空格 / `127.0.0.2` / B 内网 IP / 域名 / 机器名 / 其它 IPv6 / 空串 | 仅前三组（含规范化后）为 true |
| T-2 | Vitest | `isValidHostname('::1')` | true；其它 IPv6 仍 false |
| T-3 | Vitest | `firewallEligible` 组合：`enabled` / `syncFirewall` / `targetHost` 三因子 | 三者全真才 true |
| T-4 | Vitest | `applyMapping` 对非 B 目标 | 直接返回 true，不下发任何 PowerShell（fake exec 计数为 0） |
| T-5 | Vitest | `sync()` 的 missing / orphans 分类 | 非 B 目标的现存规则被判 orphan；他人前缀规则不受影响 |
| T-6 | Vitest | 串行化 | 并发 3 次 `syncFirewall()` 不产生并发 exec |
| T-7 | Vitest | 转发透明性 | 字节完整性、1 MB 大包、10 并发连接、半关闭、空闲 2s 后仍可收发 |
| T-8 | 本地脚本 | HTTP / HTTPS 经映射回归 | 状态码与正文一致；TLS 握手成功 |
| T-9 | 本地脚本 | 真实 `git` 客户端 | clone / commit / push / pull 成功 |
| T-10 | 本地脚本 | 内网代理 HTTP/HTTPS 现状回归 | 经 `:8888` 可访问；不改代码 |
| T-11 | CLI | `npm run typecheck` / `npm test` / `npm run build` | 全部通过 |
| T-12 | 人工 | `tools/e2e-smoke.mjs` 现有 12 项 | 不回归 |

---

## 4. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `sync()` 补建对象缺字段导致硬校验误拦 | CH-2 同步补 `targetHost` / `enabled`，T-5 覆盖 |
| 定时兜底与配置变更并发下发 PowerShell | CH-3 串行化，T-6 覆盖 |
| 前端判定与后端漂移 | 前端仅字面量集合；T-1 锁定后端行为；规格 4.2 为唯一口径 |
| 存量「填 B 自身 IP」映射失去规则 | 规格 4.7 已确认接受；UI 提示改填 `127.0.0.1` |
| 无真实 SVN / 数据库服务端，无法证明「全操作」 | 验证记录严格分级标注，README 真实环境表不填未实测项（C5） |
| `::1` 在 B 侧未启用 IPv6 | 列为使用前提写入 CH-9 |

---

## 5. 执行与验证顺序

1. CH-1 ~ CH-3（后端）→ CH-4 ~ CH-5（前端）
2. CH-6 ~ CH-7（单测）→ `npm test` / `npm run typecheck`
3. `npm run build` → CH-8 本地脚本 → 现有 `e2e-smoke.mjs` 回归
4. CH-9 ~ CH-12（文档）
5. 全量复核：`git diff` 审阅、逐条对照规格追溯表、确认 `httpProxy.ts` 与转发核心零改动
6. 向用户汇报，附未覆盖项与真实环境验收清单

---

## 6. 交付判定

- 全部 CH-1 ~ CH-12 完成；
- T-1 ~ T-12 通过或明确标注「环境不具备、由用户次日执行」；
- 规格 C1 ~ C8、NT-1 ~ NT-8 未被违反；
- 交付说明中明确写出「真实环境未验证」及 V-1~V-11 清单位置。

---

## 7. 实施结果（2026-11-10）

- CH-1 ~ CH-12 全部完成；另加 CH-13（`server/package.json` 测试脚本固定单 worker，消除沙箱并发缓存冲突）。
- T-1 ~ T-12：`npm test` 10 文件 / 77 用例全通过；`npm run typecheck`、`npm run build` 通过；`tools/phase2-verify.mjs` 25 项 PASS + 原有 12 项 E2E 回归全通过，退出码 0。1 项 SKIP 为本机无 git-daemon / Smart HTTP（Git 完整 clone/push 转 V-3 真实验收）。
- 转发核心最终**零改动**：半关闭验证发现的限制属 Node pipe 固有行为，临时改动已回退，详见规格第 11 章。
- 真实环境验收清单：`docs/manual/phase2-acceptance-checklist.md`；协议用法：`docs/manual/protocol-support-guide.md`。
- 收尾代码审核：所有 B 侧防火墙命令统一走 `enqueueFirewall()` 串行链（修复 `removeMapping()` 绕过链的并发缺口）；删除验证脚本的假阳性检查与死常量；测试数 76 → 77，本地验证 25 项 PASS（含 4 类运行时边界）。
