# KingFlow ERP 部署与运维手册

面向单实例部署（Windows Server 或 Linux 主机 + Nginx/SLB 反向代理 + SQLite 本地文件）。本轮验证在 Windows 本机完成，未验证公网真实部署。

## 1. 环境要求

- Node.js 22.12+（验证版本 24）
- pnpm 11.25（`packageManager` 已锁定）
- 反向代理负责 TLS 终止（Nginx、SLB、Caddy 均可）
- 仅支持单实例：SQLite 单写者模型，多实例会破坏一致性（见第 6 节）

## 2. 首次部署

```bash
pnpm install --frozen-lockfile
pnpm build
export NODE_ENV=production
export APP_ORIGIN=https://erp.example.com
export DATABASE_URL=file:/var/lib/kingflow/erp.db
export HOST=127.0.0.1
export PORT=3001
export TRUST_PROXY=loopback
pnpm --filter @kingflow/api db:migrate
# 首次部署：交互输入密码，避免在命令历史中留下明文；不要运行 db:seed。
export ADMIN_USERNAME=erp_owner
export ADMIN_DISPLAY_NAME=企业管理员
read -rsp '设置管理员密码: ' ADMIN_PASSWORD; echo
export ADMIN_PASSWORD
pnpm db:bootstrap
unset ADMIN_PASSWORD ADMIN_USERNAME ADMIN_DISPLAY_NAME
pnpm --filter @kingflow/api start:prod
```

`start:prod` 直接用 `node` 运行编译产物（`apps/api/dist`），不依赖 tsx，也不需要在生产机安装开发依赖以外的工具。

初始化阶段的 `db:migrate`、`db:bootstrap` 需要安装开发依赖（Prisma CLI、tsx）；运行阶段的 `start:prod` 不需要。首次生产部署应使用独立空库，禁止复制 `dev.db` 或运行Demo Seed。管理员密码至少12位、包含大小写字母/数字/符号，不超过72个UTF-8字节，不能包含系统名称。不要将密码保存在提交的配置文件或命令参数中。初始化不会创建其他演示账号，也不会覆盖已有管理员。

Windows PowerShell 初始化管理员（先按下表配置生产环境变量与数据库路径）：

```powershell
$env:ADMIN_USERNAME = 'erp_owner'
$env:ADMIN_DISPLAY_NAME = '企业管理员'
$adminCredential = Get-Credential -UserName $env:ADMIN_USERNAME -Message '设置首任管理员密码'
try {
  $env:ADMIN_PASSWORD = $adminCredential.GetNetworkCredential().Password
  pnpm db:bootstrap
} finally {
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $adminCredential = $null
}
```

公开注册默认开启，所有申请先待审核，管理员在用户管理中分配业务角色后才能登录；可以设置 `REGISTRATION_ENABLED=false` 关闭注册。详细操作见 [账号注册与审核](REGISTRATION.md)。该功能尚未在目标公网服务器验收。

## 3. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `NODE_ENV` | 是 | 生产必须为 `production`，否则 Cookie 不加 Secure、不强制 HTTPS |
| `APP_ORIGIN` | 是 | 完整来源，必须 `https://` 且不带路径/查询；浏览器变更请求严格校验 |
| `DATABASE_URL` | 是 | 生产必须是**绝对路径** `file:/abs/path/erp.db` |
| `HOST` / `PORT` | 否 | 默认 `127.0.0.1:3001`；对外暴露请交给反向代理 |
| `TRUST_PROXY` | 否 | 仅允许 `false`（默认）或 `loopback`。**禁止 `true`/`1`/`*`** |
| `WEB_DIST` | 否 | 前端构建目录，默认自动定位到 `apps/web/dist` |
| `DEMO_PASSWORD` | 否 | 仅开发/测试 Seed 使用，生产不要设置 |
| `REGISTRATION_ENABLED` | 否 | `true`（默认）公开注册但须管理员审核；`false` 服务端关闭注册 |
| `ADMIN_USERNAME` / `ADMIN_DISPLAY_NAME` / `ADMIN_PASSWORD` | 初始化时 | `db:bootstrap`读取，只用于首次创建管理员；不用于服务运行，不设置默认密码 |

启动即校验：缺失或非法的生产配置会在启动阶段直接抛错退出，不会带病运行。

## 4. 反向代理

```nginx
server {
  listen 443 ssl;
  server_name erp.example.com;
  ssl_certificate     /etc/ssl/erp.crt;
  ssl_certificate_key /etc/ssl/erp.key;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Real-IP         $remote_addr;
  }
}
```

`TRUST_PROXY=loopback` 只信任来自本机回环的转发头。这样既能正确识别 HTTPS，又不会让外部伪造 `X-Forwarded-Proto` 绕过 HTTPS 强制或伪造 IP 绕过登录限流。若代理不在本机，需改为可信网段并在代码中扩展白名单，**不要**直接放开成 `true`。

## 5. 健康检查与就绪检查

- `GET /api/v1/health`：进程存活，不做数据库访问，允许明文（适配容器探针）
- `GET /api/v1/ready`：真实查询数据库表，数据库不可用时返回 503

负载均衡请用 `/ready` 作为摘流量依据，用 `/health` 判断进程存活。

## 6. 容量边界（重要）

SQLite 是单写者数据库。本项目把 Prisma 连接池固定为 `connection_limit=1`，写入在应用内串行化，因此：

- 单实例下并发请求会排队执行，**不会**产生 `P1008 socket timeout`，也不会超发/超结
- 实测 20 路并发写入 20/20 成功且账实一致
- **不要**为了提升并发把 `connection_limit` 调大：多连接抢 SQLite 写锁正是原先并发 503 的根因
- 需要多实例或更高写入吞吐时，必须迁移 PostgreSQL 并重新验证事务与锁策略，不能直接套用当前结论

## 7. 备份

```bash
# 备份到新文件（拒绝覆盖已存在文件）
pnpm db:backup /backup/erp-2026-10-19.db

# 只做账实核对
pnpm db:verify

# 恢复到全新库（拒绝覆盖，恢复后自动清除历史会话并核对）
pnpm db:restore /backup/erp-2026-10-19.db /var/lib/kingflow/erp-restored.db

# 恢复演练：备份 + 恢复到独立目录 + 双库核对，不动生产库
pnpm db:drill /tmp/kingflow-drill
```

备份使用 SQLite `VACUUM INTO`，由数据库自身在一致性视图下写出快照，不会捕获到写了一半的页。备份前会先做账实核对，**源库核对不通过时拒绝备份**。

`checkIntegrity()` 覆盖七项不变量：

1. 库存余额 = 流水累计
2. 流水 before/after 首尾相接
3. 单据金额 = 明细金额合计
4. 订单累计入/出库量 = 明细单据合计
5. 应收应付余额 = 结算流水合计
6. 正式单据 ↔ 往来单一一对应且金额一致
7. 流水来源唯一且与类型匹配

建议：每日一次 `db:backup`，每周一次 `db:drill`，发布前必做一次 `db:verify`。

## 8. 发布与回滚

发布：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate          # 只做前向迁移
# 重启进程（建议先 db:backup）
```

回滚：代码回滚到上一版本即可；数据库迁移**只前向**，如需回退数据，用 `pnpm db:verify` 确认当前库状态后，从发布前的备份 `db:restore` 到恢复库、再人工切换。

## 9. 安全基线

- 密码 bcrypt 哈希，Session 只存 SHA256 摘要，Cookie `HttpOnly + Secure + SameSite=Lax`
- CSRF 双提交令牌 + Origin 严格校验
- 登录限流：15 分钟 60 次/IP
- 六角色权限在服务层校验，前端菜单同步隐藏无权限入口
- 审计日志不记录密码/哈希/令牌
- 响应头：`nosniff`、`SAMEORIGIN`、`no-referrer`、CSP
- 生产 `Secure` Cookie 要求 HTTPS，明文直连业务接口返回 426

## 10. 常见问题

**启动报「缺少前端生产构建」**：先 `pnpm build`，或设置 `WEB_DIST` 指向正确的 `dist` 目录。

**构建报 `esbuild ... Access is denied`（Windows）**：系统临时目录受策略/杀毒限制，esbuild 删不掉中间产物。项目已通过 `scripts/with-local-temp.mjs` 把临时目录重定向到工作区 `.tmp-build`，`pnpm build` 会自动使用。

**登录后立刻被踢回登录页**：检查 `APP_ORIGIN` 是否与浏览器地址栏完全一致（协议、端口、主机名都要一致，`localhost` 与 `127.0.0.1` 视为不同来源）。

**迁移/生成 Prisma Client 失败（Windows）**：先停止占用 Prisma DLL 的 API 进程再执行迁移。

**所有用户登录都提示限流**：说明 `TRUST_PROXY` 没配对，代理把所有请求的源 IP 都压成了同一个；按第 4 节配置可信代理。

## 11. 未覆盖范围

未验证：公网真实域名/证书、多实例集群、PostgreSQL 迁移、容器化与编排、监控告警接入、银行/支付对接、税务与总账。本地与受控环境验证不等于公网生产验收。
