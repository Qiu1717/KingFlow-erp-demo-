# KingFlow ERP 部署记录（49.233.200.176）

本文件记录**实际完成**的部署结果，不是执行前的计划。计划文档见 `DEPLOY-PLAN-IP.md`，
codex 编写的生产版手册见 `DEPLOYMENT.md`（其 HTTPS / production 前提与本机部署不同，见第 6 节）。

## 1. 交付信息

| 项目 | 值 |
|---|---|
| 访问地址 | <http://49.233.200.176> |
| 账号 | `admin`（系统管理员，`*` 全权限）、`demo`（只读访客） |
| 密码 | 服务器 `/root/kingflow-credentials.txt`（0600），不入库、不写进本文件 |
| 实例 | `lhins-epeyuale`，ap-beijing，Ubuntu 26.04 LTS，2 核 / 1962 MB / 49G |
| 运行时 | Node v24.22.0（`/opt/nodejs`）+ pnpm 11.25.0 |
| 数据库 | SQLite，`/var/lib/kingflow/erp.db` |
| 公开注册 | 已关闭（`REGISTRATION_ENABLED=false`），只有上述两个账号 |

## 2. 采用的方案

**方案 C：开发模式 + 明文 HTTP，Nginx 托管前端。**

原因是 `apps/api/src/app.ts` 在 `NODE_ENV=production` 下强制 HTTPS（明文直连业务接口返回 426）、
Cookie 加 `Secure`，且 `runtime.ts` 要求 `APP_ORIGIN` 必须是 `https://`。用公网 IP 直访时没有证书，
这条链路走不通。代价与边界见第 6 节。

请求链路：

```
浏览器 → Nginx :80
           ├─ /          → /opt/kingflow/current/apps/web/dist（SPA，try_files 回退 index.html）
           └─ /api/      → proxy_pass 127.0.0.1:3001（Node 单实例）
```

开发模式下 Express **不会**挂 `express.static`，所以前端必须由 Nginx 托管——这也是 Nginx 在本方案里不可省的原因。

## 3. 服务器上的落点

| 路径 | 说明 |
|---|---|
| `/opt/kingflow/releases/<时间戳>/` | 每次部署一个独立版本目录 |
| `/opt/kingflow/current` | 指向当前版本的软链接（回滚只改这个链接） |
| `/opt/kingflow/.npmrc` | 指向 npmmirror 镜像 |
| `/var/lib/kingflow/erp.db` | 数据库（唯一可写数据目录） |
| `/etc/kingflow/erp.env` | 环境变量，`root:kingflow 0640` |
| `/var/backups/kingflow/` | 每日备份，保留 14 天 |
| `/opt/nodejs/` | Node 24 二进制 |
| `/usr/local/bin/kingflow-backup` | 备份脚本 |
| `/etc/systemd/system/kingflow-erp.service` | 应用服务 |
| `/etc/nginx/conf.d/kingflow-erp.conf` | Nginx 站点 |

`erp.env` 实际内容：

```ini
NODE_ENV=development
APP_ORIGIN=http://49.233.200.176
DATABASE_URL=file:/var/lib/kingflow/erp.db
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=loopback
REGISTRATION_ENABLED=false
```

服务以 `kingflow` 系统用户运行，并启用 `ProtectSystem=strict` + `ReadWritePaths=/var/lib/kingflow`，
除数据目录外整个文件系统只读。**没有**启用 `MemoryDenyWriteExecute`——那会让 V8 的 JIT 直接崩溃。

## 4. 常用运维命令

```bash
systemctl status kingflow-erp            # 状态
journalctl -u kingflow-erp -f            # 实时日志
systemctl restart kingflow-erp           # 重启
tail -f /var/log/nginx/kingflow.error.log

systemctl start kingflow-backup.service  # 立即备份一次
systemctl list-timers kingflow-backup.timer
ls -lh /var/backups/kingflow/
```

升级（新版本进来后）：

```bash
cd /opt/kingflow/current
pnpm install --frozen-lockfile && pnpm build
pnpm db:migrate          # 只前向
systemctl restart kingflow-erp
```

回滚代码：把 `current` 指回上一个 release 目录再重启。注意**数据库迁移只前向**，
回滚数据要用发布前的备份 `pnpm db:restore` 到新库再人工切换。

重新完整部署：`bash bootstrap.sh <源码包>`（脚本幂等，可重复执行）。

## 5. 验收记录

| 检查项 | 结果 |
|---|---|
| `GET /` 首页 | 200，`text/html` |
| `GET /purchases` 深链接（SPA 回退） | 200，`text/html` |
| `GET /api/v1/health` | 200 `{"status":"ok"}` |
| `GET /api/v1/ready` | 200 `{"status":"ready"}` |
| 静态资源 `/assets/*.js` | 200，222 KB |
| admin 登录 + `/auth/me` | 200，会话 Cookie `HttpOnly`，path `/api/v1` |
| 写入缺 `X-CSRF-Token` | 403 `INVALID_CSRF` |
| demo（GUEST）带合法 CSRF 写入 | 403 `FORBIDDEN` |
| 伪造 `Origin` 登录 | 403 `INVALID_ORIGIN` |
| 完整写入链路（类别→仓库→商品→回读） | 全部成功，测试数据已删除 |
| 每日备份实跑 | 成功，444 KB，SHA256 校验值已输出 |
| 同日重复备份 | 自动改用 `erp-YYYYMMDD-HHMM.db`，不再冲突 |
| 重启验证 | 应用/ Nginx / 定时器全部自动拉起，数据与账号完好 |

## 6. 本次修复的两个仓库缺陷

这两个都是「本地能跑、全新部署必挂」的问题，已修进源码：

1. **`apps/api` 的 `build` 未先生成 Prisma Client**
   全新克隆后 `tsc` 报 `Property 'PrismaClientKnownRequestError' does not exist on type 'typeof Prisma'`
   以及大量 `implicitly has an 'any' type`。本地能过是因为 `node_modules` 里存着之前生成的 client。
   已在 `apps/api/package.json` 的 `build` 前置 `prisma generate`。

2. **空迁移目录 `20261019090000_registration_invitation`**
   目录存在但没有 `migration.sql`，`prisma migrate deploy` 直接报 `P3015` 并中断部署。
   核对确认 `schema.prisma` 里没有任何注册/邀请相关模型（注册功能复用 `User.status`），
   该目录是纯占位，已删除。删除后 `migrate diff` 结果为空，即迁移与 schema 零漂移。

## 7. 已知限制与风险

- **明文 HTTP**：账号密码、会话 Cookie 在公网上以明文传输。仅适合 demo，不要放真实业务数据。
  证书与 443 已具备放行条件，后续切 HTTPS 只需改 `NODE_ENV=production` + 域名 + 证书。
- **Cookie 无 `Secure` 属性**：开发模式的必然结果，同第 1 条。
- **单实例**：SQLite 单写者，连接池固定为 `connection_limit=1`。**禁止**起多进程或多副本。
- **无域名/无备案**：纯 IP 访问不需要备案；一旦解析域名到这台境内服务器就必须备案，
  且腾讯云备案要求包年包月 ≥3 个月（当前实例仅 1 个月）。
- **备份保留 14 天**：由 `/usr/local/bin/kingflow-backup` 中 `-mtime +14` 控制，需要更长改这里。
- **`admin` 密码为随机生成**：建议登录后在个人资料里改掉，并另存一份。
- 部署机与源站之间留了一把临时 SSH 公钥（`/root/.ssh/authorized_keys` 中标记
  `workbuddy-deploy-temp`）。不再需要远程部署时可删除该行。

## 8. 撤销

```bash
systemctl disable --now kingflow-erp kingflow-backup.timer
rm -f /etc/nginx/conf.d/kingflow-erp.conf && systemctl reload nginx
rm -rf /opt/kingflow /var/lib/kingflow /etc/kingflow /var/backups/kingflow
rm -f /etc/systemd/system/kingflow-erp.service /etc/systemd/system/kingflow-backup.*
systemctl daemon-reload
```

删除前先把 `/var/lib/kingflow/erp.db` 或备份拷走。
