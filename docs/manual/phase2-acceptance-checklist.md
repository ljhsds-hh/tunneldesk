# 阶段二 · 真实环境验收清单

- 日期：2026-11-10
- 用途：由你在真实「电脑 B + 内网服务」环境逐项执行；本阶段开发机无真实环境，下列项目**均未由程序侧实测**
- 关联：`../specs/2026-11-10-phase2-protocol-support.md` 第 8 章、`protocol-support-guide.md`

---

## 0. 准备

1. `start.cmd` 启动控制台，确认 SSH 链路「在线」。
2. 按下表建好映射；本地端口尽量与 B 侧相同。
3. 需要保留内网域名时，在 A 的 `hosts` 加 `127.0.0.1 <内网域名>`（需管理员权限）。
4. 把 `<B>` / `<PORT>` / `<REPO>` / `<USER>` / `<PWD>` 替换成真实值。

| 编号 | 场景 | 命令 / 操作 | 判定点 | 结果 |
| --- | --- | --- | --- | --- |
| V-1 | HTTP | `curl http://127.0.0.1:8080/api/health` | 返回 200 且正文正确；观察是否被重定向回原始内网域名 | ☐ |
| V-2 | HTTPS | `curl https://intranet.corp.local:443/api/health`（hosts + 同端口） | TLS 握手成功、证书校验通过、正文正确 | ☐ |
| V-3 | Git 全操作 | 见 §1 | clone/commit/push/pull/tag/submodule/LFS 全部成功 | ☐ |
| V-4 | SVN 全操作 | 见 §2 | checkout/update/**commit**/copy/move/merge/relocate 全部成功 | ☐ |
| V-5 | SQL Server | 见 §3 | 连接、DDL、DML、事务、存储过程、BLOB、空闲后复用全部成功 | ☐ |
| V-6 | MySQL | 见 §4 | 连接、DDL、DML、事务、批量导入、大结果集、TLS 全部成功 | ☐ |
| V-7 | 代理 HTTP/HTTPS | 见 §5 | 网页可访问、PAC 白名单分流生效 | ☐ |
| V-8 | F1 · B 本机目标 | 见 §6 步骤 1 | B 上出现 `TunnelDesk-<id>` 入站 + 出站 TCP 规则 | ☐ |
| V-9 | F1 · 第三方目标 | 见 §6 步骤 2 | B 上**不新增**任何 `TunnelDesk-*` 规则，服务仍可访问 | ☐ |
| V-10 | F1 · 孤儿清理 | 见 §6 步骤 5–6 | 目标改为第三方 / 删除映射后规则被清理；其它软件规则保持不变 | ☐ |
| V-11 | F1 · 兜底 | 见 §6 步骤 7 | SSH 在线状态下，手工造的孤儿规则 1 小时内被清理 | ☐ |

---

## 1. V-3 Git 全操作

```bash
git -c http.proxy= clone http://127.0.0.1:8080/git/<REPO>.git repo
cd repo
git config user.name  "Phase2 Test"
git config user.email "phase2@local"
echo "via TunnelDesk" > phase2.txt
git add . && git commit -m "phase2: commit"
git tag phase2-v1
git push origin HEAD
git pull --rebase
git submodule add <内网子模块URL> sub   # 若环境有子模块
git lfs track "*.bin" && git add .gitattributes   # 若环境启用 LFS
```

判定：每一步退出码 0；远端仓库能看到新提交与 tag；LFS 对象上传下载完整。

---

## 2. V-4 SVN 全操作

```bash
svn checkout http://127.0.0.1:8080/svn/<REPO> ./work
cd work
svn update
echo "via TunnelDesk" > phase2.txt
svn add phase2.txt
svn commit -m "phase2: commit"            # 重点：写事务
svn copy  ^/trunk ^/branches/phase2 -m "phase2: copy"
svn move  phase2.txt phase2-renamed.txt
svn commit -m "phase2: move"
svn merge ^/branches/phase2
svn relocate http://svn.corp.local:8080/svn/<REPO> .
svn switch ^/trunk .
```

判定：**commit 必须成功**（这是内网代理下会失败、端口映射下应通过的关键项）；relocate/switch 后 `svn info` 的 URL 正确。

> 对照实验（可选）：把同一仓库配到内网代理 `:8888`，`checkout`/`update` 应正常而 `commit` 失败——这是阶段二约定**不修复**的已知限制，符合预期。

---

## 3. V-5 SQL Server

```bash
# 用显式 TCP 端口，不要写 HOST\INSTANCE
sqlcmd -S "127.0.0.1,1433" -U <USER> -P <PWD> -d <DB> -Q "
CREATE TABLE phase2_test (id INT PRIMARY KEY, payload VARBINARY(MAX));
INSERT INTO phase2_test VALUES (1, 0x0102030405);
SELECT * FROM phase2_test;
BEGIN TRAN; UPDATE phase2_test SET id = 2 WHERE id = 1; ROLLBACK;
DROP TABLE phase2_test;"
```

判定：DDL / DML / 事务 / VARBINARY 全部成功。再等 5–10 分钟不操作，重跑 `SELECT 1` 确认长连接空闲后仍可用。

---

## 4. V-6 MySQL

```bash
mysql -h 127.0.0.1 -P 3306 -u <USER> -p -e "
CREATE DATABASE IF NOT EXISTS phase2;
USE phase2;
CREATE TABLE t (id INT PRIMARY KEY, blob_col LONGBLOB);
INSERT INTO t VALUES (1, REPEAT('x', 1048576));
START TRANSACTION; UPDATE t SET id=2 WHERE id=1; ROLLBACK;
SELECT id, LENGTH(blob_col) FROM t;
DROP TABLE t;"
```

判定：批量/大字段/事务成功；再用 TLS 参数连接一次确认加密链路可用。

---

## 5. V-7 内网代理 HTTP / HTTPS

```bash
curl -x http://127.0.0.1:8888 http://intranet.corp.local/
curl -x http://127.0.0.1:8888 https://intranet.corp.local/ -k
```

判定：页面可访问；在「代理分流」切到「仅白名单」并填入固定 IPv4 后，命中地址走 B、其它地址保持直连。

---

## 6. V-8 ~ V-11 防火墙归属（F1）

在 B 上用管理员 PowerShell 观察：

```powershell
Get-NetFirewallRule -Group TunnelDesk | ForEach-Object {
  $pf = $_ | Get-NetFirewallPortFilter
  [pscustomobject]@{
    DisplayName = $_.DisplayName
    Direction   = $_.Direction
    Enabled     = $_.Enabled
    Protocol    = $pf.Protocol
    LocalPort   = $pf.LocalPort
  }
}
```

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 1 | 新建映射，目标地址 `127.0.0.1`、目标端口 `<PORT>`、开启同步 | 出现 `TunnelDesk-<id>` 入站 + 出站规则（V-8） |
| 2 | 再建一条映射，目标地址填内网其它主机 IP / 域名 | **不新增**任何 `TunnelDesk-*` 规则；该服务仍可访问（V-9） |
| 3 | 把步骤 1 的映射**停用**（不删除） | 规则仍然存在；这是预期行为，停用只停止 A 侧监听 |
| 4 | 在 B 上手工删除步骤 1 的入站或出站规则，保持 SSH 在线，点「立即对账」 | 缺失的方向被补建；端口/协议变化时同名规则会重建 |
| 5 | 把步骤 1 的映射目标地址改成第三方 IP，或删除该映射 | 其规则被对账清理（V-10） |
| 6 | 在 B 上手工建一条**其它软件**的规则（名字不带 `TunnelDesk-`），再点「立即对账」 | 该规则**保持不变**（V-10） |
| 7 | 手工在 B 上建一条 `TunnelDesk-manual-test` 规则，工具里无对应映射；保持 SSH 在线 | 1 小时内被兜底对账清理（V-11） |

```powershell
# 步骤 7 造规则 / 步骤 6 造对照规则
New-NetFirewallRule -DisplayName "TunnelDesk-manual-test" -Group TunnelDesk `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 59999
New-NetFirewallRule -DisplayName "OtherApp-Rule" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 59998
```

> 清理验证用规则：`Remove-NetFirewallRule -DisplayName "TunnelDesk-manual-test"`、`Remove-NetFirewallRule -DisplayName "OtherApp-Rule"`。

---

## 7. 结果记录

| 项 | 通过 | 备注（报错原文 / 服务端类型 / 客户端版本） |
| --- | --- | --- |
| V-1 HTTP | ☐ | |
| V-2 HTTPS | ☐ | |
| V-3 Git | ☐ | |
| V-4 SVN | ☐ | |
| V-5 SQL Server | ☐ | |
| V-6 MySQL | ☐ | |
| V-7 代理 | ☐ | |
| V-8 ~ V-11 F1 | ☐ | |

未通过项请把完整报错贴回，按 `README.md` 第 11 节排查；SVN commit 若走代理失败属已知限制，改用端口映射即可。
