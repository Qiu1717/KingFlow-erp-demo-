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
| 公开注册 | **已开启**（`REGISTRATION_ENABLED=true`），审核制：新注册账号为 GUEST + `PENDING`，须管理员审核并分配业务角色后才能登录 |
| 可用角色 | `ADMIN`、`PURCHASE`、`SALES`、`WAREHOUSE`、`FINANCE`、`GUEST`（共 6 个，与共享包 `roleDefinitions` 一致） |

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
REGISTRATION_ENABLED=true
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

## 8. 变更记录

### 2026-10-19 20:22 注册与登录排查修复

**现象**：`/api/v1/auth/options` 返回 `registrationEnabled: false`，登录页看不到注册入口。

**根因**：不是代码缺陷。上一轮部署时为收敛公网暴露面，在 `/etc/kingflow/erp.env` 里显式写了
`REGISTRATION_ENABLED=false`，而 `Login.tsx` 的注册入口正是以 `options.data.registrationEnabled`
为渲染条件（第 241 行）。

**处置**：

1. 变更前备份数据库 → `/var/backups/kingflow/pre-registration-change-20261019-2021.db`
   （454656 字节，SHA256 `d234e4d5…a47d6dc`）；配置备份 `/etc/kingflow/erp.env.bak-*`。
2. `REGISTRATION_ENABLED` 改为 `true`，`systemctl restart kingflow-erp`，
   并核对**进程内存中的实际环境变量**（而非只看配置文件）确认为 `true`。
3. 接口返回 `{"registrationEnabled":true,"registrationMode":"approval"}`，构建产物
   `assets/index-*.js` 中含「注册账号」文案，入口恢复。

**管理员状态**：`admin`（`ACTIVE` / `ADMIN`）存在且可正常登录。
因此**未**执行 `pnpm db:bootstrap`，也**未**重置其密码。

**闭环验证**（全部通过）：

| 步骤 | 结果 |
|---|---|
| 提交注册申请 | 201，`{"username":"qa_check01","status":"PENDING"}` |
| PENDING 账号登录 | 403 `ACCOUNT_PENDING` |
| 以 ADMIN 角色审批 | 422 `INVALID_ROLE`（审核不能直接授予管理员） |
| 以 GUEST 角色审批 | 200，`status: ACTIVE` |
| 审批后登录 | 200，返回会话与 CSRF |
| 新用户读接口 | 200（GUEST 有 `master:read`） |
| 新用户写接口 | 403 `FORBIDDEN` |
| 审计日志 | 含 `REGISTER` / `APPROVE_REGISTRATION` / `LOGIN` |
| 验证账号收尾 | `qa_check01` 置为 `INACTIVE`，再登录返回 `INVALID_CREDENTIALS` |

**演示密码**：注册接口对 `KingFlow@2026` 返回 `VALIDATION_ERROR`（「请勿使用系统名称或演示密码」），
密码策略要求 ≥12 位且含大小写字母、数字、符号；伪造 `Origin` 的注册被 `INVALID_ORIGIN` 拒绝。

**遗留**：库里只有 `ADMIN` 与 `GUEST` 两个角色（`provision-demo.ts` 只建了这两个），
缺少采购 / 销售 / 仓库 / 财务角色，管理员审核时除 GUEST 外无业务角色可选。
需要时按 `packages/shared` 的 `roleDefinitions` 补齐。
**（已于同日 20:44 解决，见下一节）**

### 2026-10-19 20:44 角色补齐、密码策略统一与运维加固

**1. 数据库备份与核验**
- 加载 `/etc/kingflow/erp.env` 后 `DATABASE_URL=file:/var/lib/kingflow/erp.db`，
  并用 `PRAGMA database_list` 证实实际连接的就是 `main → /var/lib/kingflow/erp.db`（绝对路径）。
- 备份：`pre-rolesync-20261019-2031.db`（454,656 字节，SHA256 `8a1c7660…49e92`）、
  定时任务实跑产出 `erp-20261019-2043.db`（462,848 字节，SHA256 `cfbb5954…fb3cf2c`）。

**2. 角色补齐（幂等）**
- 按 `roleDefinitions` 只创建缺失项：新增 `PURCHASE`/`SALES`/`WAREHOUSE`/`FINANCE`；
  已存在的 `ADMIN`/`GUEST` **未做任何修改**（含权限 JSON）。
- 库中角色 2 → 6；账号、密码指纹、会话数、审计数与基线**完全一致**。
- 验证：`GET /api/v1/roles` 返回 6 个角色；审核弹窗的下拉会自动排除 ADMIN 与含
  `system:manage` 的角色，因此可选 5 个业务角色。
- 权限逐项生效：四个角色读主数据均 200；`PATCH /products/:id` 仅 PURCHASE 返回 404
  （权限放行、记录不存在），其余三角色 403；四角色访问角色管理均 403；
  登录返回的 `permissions` 数组与 `roleDefinitions` 逐字一致。

**3. 初始化与部署的非破坏性**
- `provision-demo.ts` 重写为「只补缺失」：角色缺失才创建，已存在的不覆盖权限
  （与共享包不一致时仅告警、交人工决策）；账号存在即整体跳过——不改密码、
  不改角色、不改启停、不撤销会话；密码仅在**真正需要建号**时才必填。
- `bootstrap.sh`：初始化改为总是执行（顺带完成角色同步）；密码生成改为 `gen_pwd()`
  保证 12 位且四类字符齐全（否则会被新口令策略拒绝）；
  **`current` 软链延后到构建 / 迁移 / 初始化全部成功后才切换**——此前是解包后立即切换，
  构建一旦失败线上立刻变成半成品白屏。
- 实测：真实重部署一次，`admin`/`demo` 的密码指纹、状态、角色、`updatedAt`、
  Session 与 AuditLog 计数与基线一致；再次单独执行初始化输出「创建 0 项、跳过 8 项」，
  且无需提供密码。

**4. 口令策略统一（四处入口一份规则）**
- 后端 `system-service` 的 `password` 从「≥8 位」改为共享包 `accountPasswordSchema`
  （≥12 位、≤72 字节、需含大小写字母/数字/符号、禁含系统名称），
  注册、管理员建号、管理员重置、个人改密四处共用。
- 前端新增 `passwordRules.ts`，直接 `safeParse` 同一个共享 schema，
  `Management`（建号/重置）与 `Profile`（改密）不再各写一套校验。
- 测试中的短密码字面量同步升级（`Created@123` → `Created@12345` 等）。
- 验证：8 位、缺符号、短密码在四条路径均被 `VALIDATION_ERROR` 拒绝且错误信息一致；
  管理员重置后旧会话立即 401、`Session` 归零；个人改密后同一会话 401、`Session` 归零；
  `admin` 密码指纹与基线一致 —— **未改动任何已有账号的密码**。

**5. 运维命令的环境守卫**
- 新增 `apps/api/scripts/require-ops-env.ts`，`backup.ts` 在建立数据库连接**之前**引入：
  缺少 `DATABASE_URL` 直接退出（退出码 1），杜绝回退到 `dev.db` 后对着空库产出假备份。
- `BackupResult` 增加 `source` 字段；备份输出打印实际源库路径（由 `PRAGMA database_list`
  解析，而非配置值），并注明备份前已通过 7 项账实不变量核对。
- `bootstrap.sh` 不再内联备份脚本，改为直接安装仓库里的 `deploy/kingflow-backup.sh`，
  消除两份副本漂移；该脚本同样先校验 `DATABASE_URL`。
- 实测：不给 `DATABASE_URL` 时退出码 1、报错明确、**不产生任何备份文件**；
  定时服务实跑输出 `源数据库：/var/lib/kingflow/erp.db`。

**6. HTTPS 接入条件（本次未切换）**
- 现状：80 明文、无证书、443 未监听也未在云防火墙放行；Nginx 自带 `http_ssl_module`。
- 切换 `NODE_ENV=production` 需要同时具备：
  1. 一个域名，且完成 **ICP 备案**（腾讯云备案要求服务器包年包月 ≥3 个月，当前实例仅 1 个月，需先续费）；
  2. TLS 证书（云厂商免费证书或 acme.sh 签发）；
  3. 云防火墙放行 443；
  4. `APP_ORIGIN` 改为 `https://<域名>`，`TRUST_PROXY=loopback` 不变。
- 未切换原因：缺少域名与证书，此刻切 production 会让所有请求返回 426，站点立即不可用。

## 9. 撤销

```bash
systemctl disable --now kingflow-erp kingflow-backup.timer
rm -f /etc/nginx/conf.d/kingflow-erp.conf && systemctl reload nginx
rm -rf /opt/kingflow /var/lib/kingflow /etc/kingflow /var/backups/kingflow
rm -f /etc/systemd/system/kingflow-erp.service /etc/systemd/system/kingflow-backup.*
systemctl daemon-reload
```

删除前先把 `/var/lib/kingflow/erp.db` 或备份拷走。
