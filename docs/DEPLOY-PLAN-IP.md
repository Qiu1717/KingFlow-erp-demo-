# KingFlow ERP 公网 IP 部署计划（方案 C · 已确认，待执行）

> 状态：**方案已定，尚未执行**，等 Codex 适配完成后按本计划落地。
> 目标：把 `E:\codex workspace\kingflow-erp` 部署到已购轻量服务器，他人通过 `http://<服务器公网 IP>` 直接访问。
> 关联文档：[DEPLOYMENT.md](./DEPLOYMENT.md)（应用侧运维手册）、[DELIVERY-READINESS.md](./DELIVERY-READINESS.md)（交付就绪结论）。

## 0. 已确认的决策

| 决策项   | 结论                                | 对方案的影响                                                           |
| -------- | ----------------------------------- | ---------------------------------------------------------------------- |
| 访问方案 | **C：开发模式 + 明文 HTTP**         | 放弃生产模式的强制 HTTPS 与 Secure Cookie；前端静态文件改由 Nginx 托管 |
| 443 端口 | **已授权放行**                      | 方案 C 本身不用 443；授权保留，将来切 A/B 时直接可用                   |
| 账号     | **只建 2 个：ADMIN + 一个普通账号** | 不再跑 `db:seed`（它会建 6 个角色账号），改为一次性初始化脚本          |
| 备份     | **每日自动备份**                    | systemd timer，`db:backup` + 保留策略                                  |
| 版本控制 | **要 Git**                          | 部署前 `git init` + 首次提交 + tag，之后每版一个 tag                   |

### 方案选择依据（三选一的取舍）

ERP 在 `NODE_ENV=production` 下有两条硬约束：`APP_ORIGIN` 必须是 `https://` 开头，且非 HTTPS 请求一律 `426`、Cookie 带 `Secure`。所以"IP 明文访问"与"生产模式"不可兼得：

| 方案                           | 访问地址                 | 生产约束                            | 门槛                                                   | 代价 / 风险                                              |
| ------------------------------ | ------------------------ | ----------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| A. 自签证书 + HTTPS            | `https://<服务器公网 IP>` | 全部满足                            | 仅需开 443                                             | 浏览器"连接不是私密连接"警告；微信内置浏览器可能直接拦截 |
| B. 域名 + 备案 + 真证书        | `https://erp.你的域名`   | 全部满足                            | 域名 + ICP 备案（服务器需续费到 ≥3 个月，审核 1–3 周） | 时间成本最高，但无警告、可长期使用                       |
| **C. 开发模式 + 明文（选定）** | `http://<服务器公网 IP>`  | **放弃**强制 HTTPS 与 Secure Cookie | 需 Nginx 另托管前端静态文件                            | 登录密码与 Cookie 明文传输；仅适合演示，不适合长期对外   |

**选择 C 的代价必须写清楚**：同一网络下可被嗅探登录凭据（明文 HTTP + 无 Secure Cookie）。因为只用于作品演示、数据是演示数据，可以接受；但**不要在这个实例上放真实业务数据**，也不要把这个地址当作长期产品入口。

## 1. 现状盘点（已核实）

| 项目     | 实际情况                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 结构     | pnpm monorepo：`apps/api`（Express 5 + Prisma 6 + SQLite）、`apps/web`（React 19 + AntD 5 + Vite 7）、`packages/shared` |
| Node     | `engines.node >= 22.12`，本机验证 24                                                                                    |
| 包管理器 | `packageManager: pnpm@11.25.0`（必须用 pnpm，不能用 npm/yarn 装）                                                       |
| 构建     | `pnpm build` = 各子包 `tsc` + `vite build`；后端产物 `apps/api/dist/apps/api/src/server.js`                             |
| 启动     | `pnpm --filter @kingflow/api start:prod` → 纯 `node` 跑编译产物，不需要 tsx                                             |
| 端口     | API 默认 `127.0.0.1:3001`；**前端静态文件由 API 进程托管**（仅 production 模式），所以只需一个端口                      |
| 数据库   | SQLite，Prisma 固定 `connection_limit=1`；迁移 `pnpm db:migrate`（`prisma migrate deploy` + `generate`）                |
| 健康检查 | `/api/v1/health`（存活）、`/api/v1/ready`（查库）                                                                       |
| 现成工具 | `db:backup / db:verify / db:restore / db:drill`、`smoke:prod`（自签 HTTPS 端到端冒烟）、`test`、`typecheck`             |
| 当前状态 | `apps/web/dist`、`apps/api/dist` **均未构建**（干净仓库）；`apps/api/.env` 不存在；**不是 git 仓库**                    |
| 遗留杂物 | `apps/api/process.exit(0))`（0 字节的误创建文件）、`apps/api/prisma/dev.db`（本地开发库），都不应带上服务器             |

## 2. 目标架构（方案 C）

```
朋友浏览器 ── http(80) ──► Nginx ─┬─ /            → 静态文件 apps/web/dist（SPA 回退 index.html）
                                  └─ /api/         → http://127.0.0.1:3001 ──► Node（NODE_ENV=development）
                                                                              └ SQLite /var/lib/kingflow/erp.db
```

- 只有 **1 个 Node 进程**、**1 个 SQLite 文件**；Node 只监听回环，公网无法直连 3001。
- **前端静态文件由 Nginx 托管**——这是方案 C 的关键差异：开发模式下 API 进程不托管静态文件（`app.ts` 里 `express.static` 只在 production 挂载），所以不能只靠 Node。
- 只开 80 端口即可访问；443 已获授权但不使用，保留给将来切 A/B。
- **禁止**多实例 / pm2 cluster / 负载均衡：SQLite 单写者模型，多写会破坏一致性（DEPLOYMENT.md 第 6 节）。

## 3. 部署前检查清单

### 3.1 本机（Windows 开发机）

| 项             | 检查命令                                                          | 期望                                                                       |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Node 版本      | `node -v`                                                         | ≥ 22.12（建议 24）                                                         |
| pnpm 版本      | `pnpm -v`                                                         | 11.25.0                                                                    |
| 依赖完整       | `pnpm install --frozen-lockfile`                                  | 成功，lockfile 无变更                                                      |
| 静态检查       | `pnpm lint`、`pnpm typecheck`                                     | 0 错误                                                                     |
| 单元/集成测试  | `pnpm test`                                                       | 全绿（api 测试）                                                           |
| 构建           | `pnpm build`                                                      | 产出 `apps/web/dist/index.html` 与 `apps/api/dist/apps/api/src/server.js`  |
| 构建完整性自检 | `pnpm --filter @kingflow/api smoke:prod`                          | 全绿（这条跑的是 production 模式，用于证明构建本身没问题，不代表线上路径） |
| 数据核对       | `pnpm db:verify`                                                  | 七项不变量通过                                                             |
| 杂物清理       | 删除 `apps/api/process.exit(0))`，确认 `prisma/dev.db` 不进发布包 | —                                                                          |
| 版本控制       | `git init && git add -A && git commit -m "..."`                   | 首次提交成功，`.gitignore` 已覆盖 `node_modules/ dist/ .env *.db`          |

这一步在本机跑通，等于把"代码是否可发布"的问题提前暴露，避免把构建问题带到 2G 内存的服务器上。

### 3.2 服务器（已购轻量实例）

| 项         | 现状                                           | 目标                           |
| ---------- | ---------------------------------------------- | ------------------------------ |
| 实例       | 轻量应用服务器（实例 ID 略），北京，2C2G / 50G SSD，Ubuntu | 保持                           |
| 公网 IP    | `<服务器公网 IP>`                               | —                              |
| 防火墙     | 已开 22 / 80 / ICMP；443 未开                  | **无需变更**（方案 C 只走 80） |
| 系统盘剩余 | 待确认                                         | ≥ 5 GB（依赖 + 构建缓存）      |
| 到期时间   | 2026-11-18                                     | 演示期内有效，到期前需续费     |
| 月流量包   | 待确认（套餐内）                               | 4 Mbps 出方向，够小范围演示    |

## 4. 代码构建与生产打包

**结论：在服务器上构建，不在 Windows 上构建后上传。**
原因：`@prisma/client` 依赖平台相关的查询引擎二进制，`esbuild` 也带原生二进制；Windows 上生成 `node_modules` 搬到 Linux 会缺 `.so` 引擎，直接启动失败。

### 4.1 打包源码（是否上传数据库？否）

```sh
# 开发机，在项目根目录执行
tar -czf kingflow-src.tar.gz \
  --exclude=node_modules --exclude='*/dist' --exclude='*.db' \
  --exclude=.tmp-build --exclude=.git \
  -C . .
```

包内必须包含：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`apps/`、`packages/`、`scripts/`（`with-local-temp.mjs` 被 build 引用）、`tsconfig*.json`。
包内不能包含：`node_modules`、`*.db`、`.env`、`dist`。

### 4.2 服务器侧构建

```sh
cd /opt/kingflow/releases/<时间戳>
pnpm install --frozen-lockfile      # 首次约 3–8 分钟，之后走 pnpm store 缓存快很多
pnpm build                          # web(vite) + api(tsc/postbuild)
```

构建产物校验（缺一不可）：

- `apps/web/dist/index.html`
- `apps/api/dist/apps/api/src/server.js`

> 说明：轻量服务器的 4 Mbps 限制的是**出方向**，入方向（下载依赖）通常不受此限制，所以首次装依赖不会是 4 Mbps 的水平；真正被 4 Mbps 卡住的是朋友打开页面的速度（首屏约 1–2 MB，预计 2–4 秒）。

## 5. 服务器运行环境准备

一次性（幂等，可重复执行）：

```sh
# 1. Node 24（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs nginx openssl rsync
node -v

# 2. pnpm 11.25.0
corepack enable
corepack prepare pnpm@11.25.0 --activate    # 若 corepack 不可用：npm i -g pnpm@11.25.0

# 3. 运行用户与目录
useradd --system --home /opt/kingflow --shell /usr/sbin/nologin kingflow
install -d -o kingflow -g kingflow -m 0750 /var/lib/kingflow          # 数据库目录
install -d -o kingflow -g kingflow -m 0755 /opt/kingflow/releases
install -d -o root     -g kingflow -m 0750 /etc/kingflow              # 配置文件目录

# 4. 交换分区（2G 内存跑 vite 构建容易吃紧，加 2G swap 兜底）
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 环境变量（`/etc/kingflow/erp.env`，权限 0640）

```ini
NODE_ENV=development
APP_ORIGIN=http://<服务器公网 IP>
DATABASE_URL=file:/var/lib/kingflow/erp.db
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=loopback
```

要点（方案 C 与生产模式的差异）：

- `NODE_ENV=development` 是方案 C 的核心：不开强制 HTTPS、Cookie 不带 `Secure`，所以 `http://` 能正常登录。
- `APP_ORIGIN` 必须是 `http://<服务器公网 IP>`——**协议写错就登录不上**（写 `https://` 时浏览器 Origin 与配置不符，来源校验直接拒）。同样不要画蛇添足加 `:80`。
- 开发模式下 API **不托管前端静态文件**，页面由 Nginx 提供；因此 `WEB_DIST` 不需要设置。
- `DATABASE_URL` 用绝对路径，避免相对路径落到 `apps/api/` 下。
- `TRUST_PROXY=loopback` 保留：Nginx 会带 `X-Forwarded-Proto: http`、`X-Real-IP`，限流按真实客户端 IP 计算；不设会让所有请求都算同一个 IP，15 分钟内 60 次很容易被限流。
- 即使走开发模式，**错误处理器也不吐堆栈**（`app.ts` 的 errorHandler 对未知异常只返回通用 500），不会泄露内部信息。

## 6. 数据库初始化与账号（只建 2 个）

```sh
sudo -u kingflow bash -c '
  set -a; . /etc/kingflow/erp.env; set +a
  cd /opt/kingflow/current
  pnpm --filter @kingflow/api db:migrate     # prisma migrate deploy + generate
  pnpm db:verify                             # 空库也应通过（七项不变量）
'
```

**账号方案要改**：`prisma/seed.ts` 会按六个角色（ADMIN/PURCHASE/SALES/WAREHOUSE/FINANCE/GUEST）各建一个账号，且共用同一密码，不满足"只要一个 admin + 一个普通"。两条实现路径，二选一：

| 做法                            | 说明                                                                                                  | 评价                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **A. 一次性初始化脚本（推荐）** | 新增 `apps/api/scripts/provision-demo.ts`：建 2 个角色记录 + 2 个用户，密码从环境变量读，bcrypt 12 轮 | 干净、可重复执行（upsert）、不动 seed |
| B. 先 seed 再删 4 个账号        | 跑完 seed 后删掉多余用户与角色                                                                        | 会留下 6 个角色的残留与共用密码痕迹   |

选 A 时的账号设计：

| 账号    | 角色                  | 权限             | 用途                                |
| ------- | --------------------- | ---------------- | ----------------------------------- |
| `admin` | ADMIN                 | `*`（全部）      | 演示完整功能、系统管理              |
| `demo`  | **GUEST**（只读访客） | 只读权限，无写入 | 给朋友/观者用，**不会改坏演示数据** |

> GUEST 是项目里现成的只读角色。如果你希望普通账号也能开单（演示"业务员视角"），把它换成 `SALES` 或 `PURCHASE` 即可——一句话就能改，权限矩阵是现成的。

密码要求：≥12 位、不含用户名；admin 与 demo 用**不同**密码；写入 `/etc/kingflow/erp.env` 之外的地方不落盘明文（脚本用一次性环境变量传入）。

## 7. 服务启动与常驻进程管理

### 7.1 systemd 单元（`/etc/systemd/system/kingflow-erp.service`）

```ini
[Unit]
Description=KingFlow ERP (API + Web)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kingflow
Group=kingflow
WorkingDirectory=/opt/kingflow/current/apps/api
EnvironmentFile=/etc/kingflow/erp.env
ExecStart=/usr/bin/node dist/apps/api/src/server.js
Restart=always
RestartSec=3
TimeoutStopSec=20

StateDirectory=kingflow
StateDirectoryMode=0750
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/var/lib/kingflow
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
```

不要加 `MemoryDenyWriteExecute=true`（Node 的 V8 JIT 需要可写可执行内存，加了会直接崩）。

### 7.2 发布目录与切换方式

```
/opt/kingflow/releases/20261019-1930/   ← 每个版本一个目录（含 node_modules 与 dist）
/opt/kingflow/current -> releases/20261019-1930
```

```sh
ln -sfn /opt/kingflow/releases/<新版本> /opt/kingflow/current
systemctl daemon-reload
systemctl restart kingflow-erp
```

用软链切换而不是覆盖，回滚就是把软链指回上一个目录。

### 7.3 只允许单实例

```sh
systemctl status kingflow-erp
ss -lntp | grep 3001          # 应只有 1 个 node 进程监听 127.0.0.1:3001
```

### 7.4 每日自动备份（systemd timer）

先用一个包装脚本管住"文件名带日期 + 保留 14 天"（`db:backup` 只接受**具体文件名**，而 systemd 的 `ExecStart` 不做日期展开，所以不能把 `%Y%m%d` 直接写进 unit）：

```sh
mkdir -p /var/backups/kingflow && chown kingflow:kingflow /var/backups/kingflow
cat > /usr/local/bin/kingflow-backup <<'EOF'
#!/bin/sh
set -eu
DEST=/var/backups/kingflow
mkdir -p "$DEST"
cd /opt/kingflow/current
pnpm db:backup "$DEST/erp-$(date +%Y%m%d).db"
find "$DEST" -name 'erp-*.db' -mtime +14 -delete    # 只保留 14 天
EOF
chmod 750 /usr/local/bin/kingflow-backup
chown kingflow:kingflow /usr/local/bin/kingflow-backup
```

`/etc/systemd/system/kingflow-backup.service`：

```ini
[Unit]
Description=KingFlow daily SQLite backup

[Service]
Type=oneshot
User=kingflow
Group=kingflow
EnvironmentFile=/etc/kingflow/erp.env
ExecStart=/usr/local/bin/kingflow-backup
ReadWritePaths=/var/lib/kingflow /var/backups/kingflow
```

`/etc/systemd/system/kingflow-backup.timer`：

```ini
[Unit]
Description=KingFlow daily backup timer

[Timer]
OnCalendar=*-*-* 04:10:00
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
```

启用与验证：

```sh
systemctl daemon-reload
systemctl enable --now kingflow-backup.timer
systemctl list-timers kingflow-backup.timer
systemctl start kingflow-backup.service && ls -lh /var/backups/kingflow/   # 手动跑一次确认出文件
```

`db:backup` 内部用 `VACUUM INTO` 出一致性快照，且**备份前先做七项账实核对，核对不过直接拒绝备份**——所以"备份成功"本身就是一条数据健康证明。备份目录与数据目录分开，避免一起被删；`Persistent=true` 保证错过时间点后补跑。

## 8. 端口与防火墙配置（方案 C）

### 8.1 Nginx（`/etc/nginx/conf.d/kingflow-erp.conf`）

```nginx
# 方案 C：80 明文直连；前端由 Nginx 托管，/api 反代到 Node
server {
    listen 80;
    listen [::]:80;
    server_name _;

    root /opt/kingflow/current/apps/web/dist;
    index index.html;

    client_max_body_size 2m;
    access_log /var/log/nginx/kingflow.access.log;
    error_log  /var/log/nginx/kingflow.error.log warn;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    # API：交给 Node（Node 只监听回环）
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-Proto http;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_read_timeout 30s;
        add_header Cache-Control "no-store" always;
    }

    # 带 hash 的构建产物可长缓存
    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # SPA 回退：刷新 /purchases 这类深链接才不会 404
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-store";
    }
}
```

三个容易出错的点：

1. **必须有 `try_files ... /index.html`**。开发模式下 Node 不托管前端，`/purchases` 这类路由只能靠 Nginx 回退到 `index.html`，否则刷新就 404。
2. `root` 指向 `current/apps/web/dist`，`current` 是软链，发布切换版本时 Nginx 无需改动；但 Nginx 进程（`www-data`）要能穿过 `/opt/kingflow` 目录，发布脚本里会 `chmod -R a+rX`。
3. `Host` 用 `$http_host`（含端口）而不是 `$host`，保证服务端做同源校验时与浏览器地址栏一致。

### 8.2 443：已授权，方案 C 不用

授权保留，将来切 A/B 时再加 TLS server 块（见文末附录）。现在不做 443 变更，少一个暴露面。

### 8.3 防火墙

| 端口 | 当前 | 计划                 | 说明                         |
| ---- | ---- | -------------------- | ---------------------------- |
| 22   | 已开 | 保留                 | 建议后续限制来源 IP          |
| 80   | 已开 | **保持开放**         | 方案 C 的唯一入口            |
| 443  | 未开 | 授权已给，本次不操作 | 切 A/B 时再开                |
| 3001 | 未开 | **保持关闭**         | 只监听 127.0.0.1，公网不可达 |

两层都要配：轻量控制台防火墙（云侧）+ 实例内 `ufw`（若启用）。**本次唯一需要的网络条件是"80 对 0.0.0.0/0 放行"，当前已满足，实际不需要改防火墙。**

## 9. 通过 IP 访问的验证方式

### 9.1 机器验证（服务器上执行）

```sh
# 1) 进程与监听：只允许一个 node，且绑在回环
systemctl is-active kingflow-erp
ss -lntp | grep 3001                       # 期望 127.0.0.1:3001，不能是 0.0.0.0

# 2) Nginx 与静态文件
nginx -t
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1/          # 200 text/html
curl -sI http://127.0.0.1/ | grep -i cache-control                                   # no-store
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/purchases                  # 200（SPA 回退生效）

# 3) 探针
curl -s http://127.0.0.1/api/v1/health     # 期望 {"status":"ok"...}，不查库
curl -s http://127.0.0.1/api/v1/ready      # 期望 200，查库成功

# 4) 未登录访问受保护接口必须 401，而不是 500/404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/v1/purchases

# 5) 构建完整性自检（跑的是独立临时库 + 生产模式，不碰线上库）
cd /opt/kingflow/current && pnpm --filter @kingflow/api smoke:prod

# 6) 数据核对
pnpm db:verify
```

### 9.2 浏览器验证（你自己先走一遍，再给他人）

1. 打开 `http://<服务器公网 IP>`，应直接进登录页，**无证书警告**（这就是选 C 的好处）。
2. `admin` 登录 → 采购/销售/库存各点一页 → 能出数据。
3. 刷新页面仍保持登录；DevTools → Application → Cookies，确认会话 Cookie 是 `HttpOnly` + `SameSite=Lax`，**没有** `Secure`（方案 C 的预期）。
4. 点 `/purchases` 直接刷新（不是从首页点进去），确认不是 404——验证 SPA 回退。
5. 换个浏览器用 `demo` 账号登录 → 写入类按钮应不可见或返回 403（GUEST 只读）。
6. 退出登录，确认回到登录页、接口返回 401。

### 9.3 他人访问验收口径

直接把 `http://<服务器公网 IP>` 和两个账号发出去即可，无需任何"点继续访问"的指导。
提醒一句：**这是演示环境，数据会被别人改**（admin 可写），所以日常演示建议给 GUEST 账号。

## 10. 风险点与应对（方案 C 版）

| #   | 风险                                      | 影响                                                       | 应对                                                                                      |
| --- | ----------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R1  | 明文 HTTP + 无 Secure Cookie              | **方案 C 的固有代价**：同网络可嗅探登录凭据；仅适合演示    | 不放真实业务数据；对外只发 GUEST 只读账号；将来切 A/B 即消除                              |
| R2  | Nginx 未配 SPA 回退                       | 刷新 `/purchases` 等深链接直接 404（看起来像"页面打不开"） | `try_files $uri /index.html`；验收时专门测一条深链接刷新                                  |
| R3  | `APP_ORIGIN` 写成 `https://` 或多写 `:80` | 登录成功但立刻被踢回登录页（来源校验不过）                 | 严格 `http://<服务器公网 IP>`，改完重启再验                                                |
| R4  | `TRUST_PROXY` 未设                        | 所有请求被算成同一个 IP，15 分钟内 60 次登录即触发 429     | 设 `loopback`；Nginx 必须带 `X-Real-IP` / `X-Forwarded-For`                               |
| R5  | 2G 内存跑 vite 构建 OOM                   | 构建中断                                                   | 已加 2G swap；仍失败则仅 web 在本地构建（`apps/web/dist` 与平台无关），api 仍在服务器构建 |
| R6  | 沿用 `db:seed` 会建 6 个账号              | 与"只要 2 个账号"不符，且六账号共用密码                    | 改一次性 `provision-demo.ts`（见第 6 节），不跑 seed                                      |
| R7  | 账号密码弱                                | 演示数据被随意改动                                         | admin/demo 用不同强密码（≥12 位）；日常对外只发 demo                                      |
| R8  | SQLite 单写者                             | 并发稍高时请求排队；多实例会写坏                           | 维持单实例 + `connection_limit=1`；不要 pm2 cluster                                       |
| R9  | 端口 3001 误绑 0.0.0.0                    | 暴露一个绕过 Nginx 的入口                                  | 强制 `HOST=127.0.0.1`，防火墙不放行 3001                                                  |
| R10 | 4 Mbps 出方向带宽                         | 首屏 2–4 秒，多人同时打开更慢                              | Nginx 开 gzip + assets 长缓存；演示人数控制在小范围                                       |
| R11 | 无 git 仓库（当前状态）                   | 回滚没有"上一版本"的依据                                   | 部署前 `git init` + 首次提交 + 每次发布打 tag                                             |
| R12 | 备份缺失（当前状态）                      | 误操作后数据不可恢复                                       | 每日 systemd timer 跑 `db:backup`，保留 14 天，每周 `db:drill`                            |
| R13 | 迁移只前向                                | 回滚代码后可能与新 schema 不兼容                           | 发布前必须备份；回滚以"备份 + 恢复到新库 + 切库"为准，不直接覆盖                          |
| R14 | 服务器 2026-11-18 到期                    | 演示链接突然失效                                           | 记入日历，到期前续费                                                                      |

## 11. 回滚方案

三层，按故障类型选择：

**① 代码回滚（最常见，秒级，不动数据）**

```sh
ln -sfn /opt/kingflow/releases/<上一版本> /opt/kingflow/current
systemctl restart kingflow-erp
curl -s http://127.0.0.1/api/v1/ready
```

前提：保留最近 2–3 个 release 目录不删。有 git 之后就是 `git checkout <上一个 tag>` 重新构建。

**② 数据回滚（迁移/误操作导致数据异常）**

```sh
# 发布前
sudo -u kingflow bash -c 'cd /opt/kingflow/current && pnpm db:backup /backup/erp-$(date +%F-%H%M).db'

# 出事时：恢复到新库 → 核对 → 切库 → 重启（不覆盖生产库）
sudo -u kingflow bash -c 'cd /opt/kingflow/current && pnpm db:restore /backup/erp-xxx.db /var/lib/kingflow/erp-restored.db'
# 核对通过后，改 DATABASE_URL 指向 erp-restored.db，重启服务
```

**③ 整体下线**

- 停服务：`systemctl stop kingflow-erp`
- 收回入口：云侧关闭 80，或删掉 Nginx 配置后 `systemctl reload nginx`

**每次发布的标准动作**：`git tag` → 备份 → 构建 → 迁移 → 切软链 → `ready` + 深链接刷新通过 → 保留旧版本 7 天。

## 12. 执行顺序与耗时预估

| 阶段 | 内容                                                   | 预计耗时  | 是否影响访问   |
| ---- | ------------------------------------------------------ | --------- | -------------- |
| 0    | 本机检查（lint/typecheck/test/build）+ `git init`      | 10–15 min | 否             |
| 1    | 服务器装 Node/pnpm/Nginx、建用户与目录、加 swap        | 10 min    | 否             |
| 2    | 上传源码、`pnpm install`、`pnpm build`                 | 10–20 min | 否             |
| 3    | 写 Nginx / systemd / 环境变量（80 已开，无需改防火墙） | 10 min    | 否（尚未对外） |
| 4    | 迁移 + 建 2 个账号                                     | 5 min     | 否             |
| 5    | 启动 + 探针 + 深链接刷新 + 浏览器验收                  | 10 min    | 短暂           |
| 6    | 配置每日备份 timer + 交付地址与账号                    | 5 min     | 否             |

合计约 **50–65 分钟**；首次部署是从无到有，不存在停机。

## 13. 还差三件小事

已定：方案 C、443 授权、2 个账号（ADMIN + 普通）、每日备份、Git。

还需你两句话（不着急，等 Codex 适配完再说）：

1. **密码**：`admin` / `demo` 各给一个，或我生成随机强密码后告诉你一次。`demo` 默认 GUEST 只读；若要能开单改成 SALES/PURCHASE。
2. **备份保留天数**：默认 14 天。
3. **Git 远端**：只做本地仓库，还是推到 GitHub 私有仓库？（推远端需要你先建仓库，我不碰你的账号凭据。）

你说"开始"，我就按第 12 节执行，每步贴真实命令输出。

## 附录：将来切 A（自签 HTTPS）或 B（正式证书）时的增量

```nginx
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name _;

    ssl_certificate     /etc/kingflow/tls/erp.crt;   # B 方案换成真实证书
    ssl_certificate_key /etc/kingflow/tls/erp.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP         $remote_addr;
    }
}
```

同时改两处：`NODE_ENV=production`、`APP_ORIGIN=https://<服务器公网 IP>`，并在云侧放行 443。

自签证书（含 IP SAN，现代浏览器只认 SAN）：

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 397 \
  -keyout /etc/kingflow/tls/erp.key -out /etc/kingflow/tls/erp.crt \
  -subj "/CN=<服务器公网 IP>" -addext "subjectAltName=IP:<服务器公网 IP>"
```
