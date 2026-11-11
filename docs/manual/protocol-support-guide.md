# 端口映射协议使用说明（阶段二）

- 日期：2026-11-10
- 适用版本：v0.2.0 + 阶段二
- 适用通道：**端口映射**。内网代理只用于 HTTP / HTTPS 网页访问，Git / SVN / 数据库一律走端口映射
- 关联：`../specs/2026-11-10-phase2-protocol-support.md`、`phase2-acceptance-checklist.md`

---

## 0. 先理解一件事

端口映射是**纯 TCP 字节转发**（`socket.pipe(channel)`），程序不解析任何应用层协议。所以 HTTP、HTTPS、Git、SVN、SQL Server、MySQL 在它眼里完全一样，**能力上天然支持**。

需要你做的只有应用层的「地址对齐」：映射到 `127.0.0.1:<本地端口>` 后，域名、证书、URL、连接串里的主机名变了，按本文配置一次即可。这不叫程序缺陷，是本地端口转发的固有使用方式。

---

## 1. 通用前提（所有协议都适用）

1. 在「端口映射」新建映射，填 B 侧目标地址 + 目标端口，本地端口**尽量与远端一致**。
2. 需要保留原内网域名（服务端按 Host 路由、返回绝对 URL、证书校验）时，在 A 的 `hosts` 加一行，并让本地端口与远端一致：

   ```text
   127.0.0.1    svn.corp.local
   ```

   改 hosts 需要管理员权限，程序不自动修改。
3. **目标地址决定是否在 B 上开防火墙**（阶段二新增规则）：

   | 填写值 | 含义 | B 上防火墙 |
   | --- | --- | --- |
   | `localhost` / `127.0.0.1` / `::1` | 访问 B 本机 | 自动创建/清理 `TunnelDesk-*` TCP 规则 |
   | 任何其它 IP（含 B 自身内网 IP）、域名、机器名 | B 可达的第三方地址 | **不创建规则**，也不修改那台主机的防火墙 |

   若你原本填的是 B 自身内网 IP 且确实需要在 B 上放行，请改填 `127.0.0.1`。填 `::1` 需要 B 侧启用 IPv6 回环。

   - **停用映射不会删除 B 侧规则**：映射记录还在时规则保留，缺失会补建；只有删除映射、关闭同步、目标改为非 B 时才清理。
   - 修改目标端口后，对账会比较规则的本地端口 / 方向 / 协议 / 启用状态，不一致时重建；改端口时 SSH 离线，重连后也会修正。
4. 第三方目标主机自己的防火墙不归 TunnelDesk 管：能访问就访问，不能访问就自行在那台主机上放行。

---

## 2. HTTP

```text
# 映射：127.0.0.1:8080 → B 侧 127.0.0.1:8080
curl http://127.0.0.1:8080/api/health
```

若服务端按虚拟主机 / `server_name` 路由，用 hosts + 同端口：

```text
curl http://intranet.corp.local:8080/api/health
```

注意服务端可能在响应里返回原始内网的绝对 URL 导致重定向，hosts 是最省事的规避方式。

---

## 3. HTTPS

TLS 全程透传，不解密、不做 MITM。证书 SAN/SNI 与 `127.0.0.1` 不匹配时有两条路：

```text
# 方式 A：hosts + 同端口（推荐，证书校验保持开启）
#   hosts: 127.0.0.1  intranet.corp.local
curl https://intranet.corp.local:443/api/health

# 方式 B：临时跳过证书校验
curl -k https://127.0.0.1:8443/api/health
```

数据库启用 TLS 时同理：SQL Server 强制加密、MySQL TLS 都会校验证书主机名。

---

## 4. Git

`http(s)://`、`ssh://` / `git@`、`git://` 都是 TCP，无需区分。

```bash
# Smart HTTP（推荐）
git -c http.proxy= clone http://127.0.0.1:8080/git/repo.git
cd repo
git add . && git commit -m "via TunnelDesk"
git push origin main
git pull --rebase

# 若服务端返回原始内网域名的重定向，改 hosts + 同端口后使用原地址
git clone https://git.corp.local/repo.git
```

`clone / fetch / pull / push / commit / branch / tag / merge / rebase / submodule / LFS` 均无协议层限制。pack 大包、LFS 批量上传走同一条字节通道。

> 走内网代理时 Git 需要单独 `git config http.proxy`；走端口映射不需要任何代理配置。

---

## 5. SVN

`http(s)://` WebDAV、`svn://`（3690）、`svn+ssh://` 都支持，**写事务（commit / copy / move / merge）不建议走内网代理**，请走端口映射。

```bash
# 首次检出
svn checkout http://127.0.0.1:8080/svn/repo ./work

# 日常
svn update
svn add new.txt
svn commit -m "via TunnelDesk"
svn copy ^/trunk ^/branches/x -m "branch"
svn merge ^/branches/x
```

**工作副本记录绝对 URL**，换地址时要 relocate 一次：

```bash
svn relocate http://svn.corp.local:8080/svn/repo ./work
svn switch ^/branches/x ./work
```

用 hosts + 同端口可以直接沿用原 URL，省掉 relocate。

---

## 6. SQL Server

```text
# 映射：127.0.0.1:1433 → B 侧 127.0.0.1:1433
# 连接串（逗号分隔端口，不要写实例名）
Server=127.0.0.1,1433;Database=MyDb;User Id=sa;Password=***;Encrypt=no;

# sqlcmd
sqlcmd -S "127.0.0.1,1433" -U sa -P "***" -d MyDb -Q "SELECT 1"
```

**命名实例 `HOST\INSTANCE` 不受支持**：它依赖 UDP 1434 SQL Browser，而 TunnelDesk 只转发 TCP。必须查到实例的固定 TCP 端口并用 `host,port` 连接。

DDL / DML / 事务 / 存储过程 / BLOB / 连接池 / 大结果集均无限制；长时间空闲会话由 SSH keepalive（15s × 3）维持。

---

## 7. MySQL

```text
# 映射：127.0.0.1:3306 → B 侧 127.0.0.1:3306
mysql -h 127.0.0.1 -P 3306 -u root -p

# 连接串
jdbc:mysql://127.0.0.1:3306/mydb?useSSL=false
```

TLS 连接可用，但证书主机名不匹配时需按第 3 节处理。批量导入、预处理语句、大 BLOB、长连接均无限制。

---

## 8. 内网代理（仅 HTTP / HTTPS）

```text
代理地址：http://127.0.0.1:8888
PAC 脚本：http://127.0.0.1:19000/proxy.pac
```

- 只支持 HTTP 明文请求与 HTTPS 的 CONNECT 隧道。
- 不支持 SOCKS5 / UDP；Git / SVN / 数据库请改用端口映射。
- **已知限制**：代理的 HTTP/1.1 语义不合规（强制 `Connection: close`、一连接只解析一次请求头），依赖连接复用或 WebDAV 扩展方法的客户端经代理可能失败，典型现象是 SVN `commit` 失败而 `checkout`/`update` 正常。阶段二按需求约定**不修复**，此类场景一律走端口映射。
- PAC 白名单只支持固定 IPv4 精确匹配、单次最多 200 个。

---

## 9. 验证状态（诚实标注）

| 级别 | 含义 | 本阶段覆盖 |
| --- | --- | --- |
| `[local-real]` | 本机真实客户端 + 真实协议栈 | Git 客户端、HTTP、HTTPS/TLS、TCP 字节完整性 |
| `[mock]` | 链路级 / 夹具验证 | SVN / SQL Server / MySQL 的字节透传、长连接、并发、大包、F1 判定与对账 |
| `[real-env]` | 真实内网 B + 真实服务端 | **未执行**，由你按 `phase2-acceptance-checklist.md` 验收 |

README 的「真实环境验证」表未填入任何本阶段未实测项。
