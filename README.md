# KingFlow ERP

面向中小型商贸企业的中文 ERP Web 系统。以「基础资料 → 采购/销售订单 → 审核 → 分批出入库 → 应收应付 → 收付款」为主线，覆盖库存调整、流水追溯、经营分析与数据可视化，内置基于角色的权限控制、审核制注册与全链路审计。

后端为 Express + Prisma + SQLite，前端为 React + Ant Design，pnpm monorepo 单仓库管理。项目为个人作品，使用 Codex 辅助完成实现、调试与回归；仅面向本地或受控演示环境，不宣称商业上线。

## 功能特性

**业务闭环**

- **采购**：采购订单审核 → 分批入库 → 自动生成应付 → 分批/全额付款；未审核订单不能入库，入库数量不能超过订单余量
- **销售**：销售订单审核 → 分批出库 → 自动生成应收 → 分批/全额收款；出库扣减实时库存，超额被拒绝
- **库存**：多仓库库存余额、调整（需填原因，盘亏不能超过余额）、出入库流水、低库存预警、按来源单据逐级追溯
- **财务**：应付/应收台账，已结/未结金额，收付款记录与来源单据关联
- **报表与可视化**：经营分析看板；销售/采购金额趋势与排行、仓库库存对比、应收应付已结未结堆叠图，支持 7/30/90 天与自定义日期筛选、CSV 导出

**平台能力**

- **审核制注册**：`REGISTRATION_ENABLED=true` 时开放公开注册，新账号固定 GUEST + `PENDING`，须管理员审核并分配业务角色后方可登录；审核禁止直接授予 ADMIN
- **角色权限**：ADMIN / PURCHASE / SALES / WAREHOUSE / FINANCE / GUEST 六个角色，权限定义集中在 `packages/shared`，前后端共用同一份 schema；前端隐藏按钮不等于后端授权，所有接口独立鉴权
- **安全**：bcrypt 口令哈希、Session 摘要存储、HttpOnly Cookie、CSRF 双提交校验、严格 Origin 来源校验、登录限流；统一口令策略（≥12 位，含大小写字母/数字/符号，禁用系统名称与演示密码），注册、管理员建号、管理员重置、个人改密四条路径共用同一规则
- **可靠性与审计**：审核、过账、调整、结算均写审计日志；正式单据不允许直接修改或删除；接口幂等，网络异常重试不会重复过账
- **备份运维**：`VACUUM INTO` 一致性备份 + 7 项账实不变量核对，支持备份校验、恢复与演练；运维命令强制校验 `DATABASE_URL`，杜绝误连空库
- **移动端**：手机/平板自适应（侧滑菜单、底部导航、卡片式明细、全宽抽屉），992px 以上保留桌面布局

## 技术栈

| 层 | 技术 |
|---|---|
| 包管理 | pnpm 11.25 workspace monorepo |
| 运行时 | Node.js ≥ 22.12（开发/生产实测 24） |
| 后端 | Express 5、Prisma 6、SQLite、Zod 3、bcryptjs、express-rate-limit、helmet |
| 前端 | React 19、Ant Design 5、Vite 7、TanStack Query 5、Zustand 5、React Router 7、Recharts 3、Axios |
| 共享包 | `@kingflow/shared`：角色权限定义、单据状态机、Zod 校验 schema（前后端零漂移） |
| 工程 | TypeScript 5.9、Vitest 3、Playwright 1.56、ESLint 10、Prettier 3.6 |

## 安装与运行

环境要求：Node.js ≥ 22.12、pnpm 11.25（`corepack enable` 可自动切换）。

```bash
# 1. 克隆仓库
git clone https://github.com/Qiu1717/KingFlow-erp-demo-.git
cd KingFlow-erp-demo-

# 2. 安装依赖
pnpm install --frozen-lockfile

# 3. 初始化数据库（在 apps/api/prisma 下生成 dev.db 并应用迁移）
pnpm db:migrate

# 4. （仅开发）灌入演示数据，创建 6 个角色账号
pnpm db:seed

# 5. 启动 API（3001）与 Web（5173）
pnpm dev
```

访问 <http://localhost:5173>，API 基地址 <http://localhost:3001/api/v1>。不要直接双击 `apps/web/index.html`，前端需通过 Vite 开发服务器运行。

**生产模式初始化**（不用 seed，只建管理员）：

```bash
pnpm db:bootstrap   # 交互式设置强密码管理员；留空则随机生成并打印一次
```

默认配置无需创建 `.env`；需要自定义时参考 `.env.example`：

| 变量 | 默认/用途 |
|---|---|
| `DATABASE_URL` | `file:./dev.db`，相对于 `apps/api/prisma` |
| `PORT` | 3001 |
| `APP_ORIGIN` | `http://localhost:5173`，浏览器变更请求严格校验来源 |
| `NODE_ENV` | development；production 强制 HTTPS 且 Cookie 加 `Secure` |
| `REGISTRATION_ENABLED` | true，是否开放公开注册（审核制） |

> 并发说明：SQLite 为单写者数据库，Prisma 连接池固定 `connection_limit=1` 并在应用内串行化写入，**不要调大该值**；需要多实例时迁移 PostgreSQL 并重新验证事务策略。

部署到服务器（Nginx + systemd）见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 目录结构

```text
kingflow-erp/
├── apps/
│   ├── api/                        # Express API（端口 3001）
│   │   ├── prisma/                 # schema.prisma + 版本化迁移
│   │   ├── scripts/                # migrate / bootstrap / backup / seed / 冒烟测试
│   │   ├── src/
│   │   │   ├── controllers/        # 路由控制器（master/purchase/sales/analytics/system）
│   │   │   ├── routes/             # /api/v1 路由注册
│   │   │   ├── services/           # 业务逻辑（auth/purchase/sales/inventory/finance…）
│   │   │   ├── repositories/       # Prisma 数据访问
│   │   │   ├── middleware/         # 安全中间件（CSRF、限流、鉴权）
│   │   │   ├── config/             # 运行时配置与启动上下文
│   │   │   ├── app.ts              # Express 应用装配
│   │   │   └── server.ts           # 入口
│   │   └── tests/                  # Vitest 接口测试（真实库、并发、回滚）
│   └── web/                        # React SPA（Vite，端口 5173）
│       └── src/
│           ├── modules/            # 按业务域组织（purchase/sales/inventory/finance/
│           │                       #   master-data/reports/system/dashboard）
│           ├── components/         # 通用组件（单据明细表、日期筛选等）
│           ├── layouts/            # 应用框架布局
│           ├── services/           # Axios 客户端
│           ├── stores/             # Zustand 认证状态
│           └── styles/             # 全局样式与移动端适配
├── packages/
│   └── shared/src/                 # 角色权限、单据状态、Zod schema（前后端共用）
├── deploy/
│   ├── bootstrap.sh                # 服务器一键部署脚本（幂等）
│   ├── kingflow-backup.sh          # 备份脚本（含环境守卫）
│   └── kingflow-erp.service        # systemd 单元
├── tests/e2e/                      # Playwright 端到端测试（真实浏览器）
├── docs/                           # PRD、架构、API、数据库、部署、验收等文档
├── scripts/                        # 仓库级辅助脚本
├── 作品集展示.html                  # 离线项目介绍与截图（无需安装依赖）
└── pnpm-workspace.yaml
```

## 使用示例

**演示账号**（`pnpm db:seed` 创建，仅限本地开发）：

| 账号 | 角色 | 主要权限 |
|---|---|---|
| `admin` | 系统管理员 | 全部业务及系统配置 |
| `purchase` | 采购人员 | 商品/分类/供应商维护，采购创建与审核 |
| `sales` | 销售人员 | 客户维护，销售创建与审核 |
| `warehouse` | 仓库人员 | 执行出入库、库存调整 |
| `finance` | 财务人员 | 应收应付、收付款、财务分析 |
| `guest` | 只读访客 | 已授权范围内的查询 |

以上账号初始密码均为 `KingFlow@2026`。**生产环境登录与注册接口会显式拒绝该密码**及任何含 "kingflow" 的密码，上线请使用 `pnpm db:bootstrap` 创建的管理员。

**采购闭环示例**（约 2 分钟）：

1. `purchase` 登录 → 基础资料确认分类/供应商/仓库 → 新建采购订单（商品 10 件、单价 80 元）→ 保存草稿 → 提交审核 → 审核通过
2. `warehouse` 登录 → 入库单选该采购订单 → 先入 6 件、再入 4 件；库存 0 → 6 → 10，生成 480 元 + 320 元两笔应付
3. `finance` 登录 → 应付台账对该供应商付款 → 先付 500 元（部分结清）→ 再付 300 元（全额结清，余额归零后禁止继续付款）
4. 任意时刻打开库存流水，可逐笔追溯到「入库单 → 采购订单」来源

**接口调用示例**（带会话 Cookie 与 CSRF）：

```bash
# 登录，保存 Cookie
curl -c cookies.txt -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"KingFlow@2026"}'

# 读取当前会话与 CSRF Token
curl -b cookies.txt http://localhost:3001/api/v1/auth/me

# 写操作必须带 X-CSRF-Token（从 /auth/me 或登录响应获取）
curl -b cookies.txt -X POST http://localhost:3001/api/v1/categories \
  -H 'Content-Type: application/json' -H 'X-CSRF-Token: <token>' \
  -d '{"code":"DEMO-01","name":"演示分类"}'
```

**注册与审核**（`REGISTRATION_ENABLED=true` 时）：登录页点击「提交注册申请」→ 填写账号与符合策略的密码 → 提交后账号为 `PENDING` 不能登录 → 管理员在用户管理审核并分配业务角色 → 审核通过后即可登录。

## 测试与验证

```bash
pnpm lint          # ESLint
pnpm typecheck     # 全包 TypeScript 检查
pnpm test          # Vitest 接口测试
pnpm exec playwright install chromium   # 首次需安装浏览器
pnpm test:e2e      # Playwright 端到端
pnpm build         # 全量构建（含 prisma generate）
```

接口测试自动迁移独立 `test.db`，浏览器测试初始化独立 `e2e.db` 并启动真实前后端，均不修改 `dev.db`。

**备份、恢复与生产运行**：

```bash
pnpm db:backup <目标文件>          # 一致性快照备份（拒绝覆盖已存在文件）
pnpm db:verify                     # 七项账实不变量核对
pnpm db:restore <备份> <新库文件>  # 恢复到全新库，自动清会话并核对
pnpm db:drill <目录>               # 恢复演练：备份+恢复+双库核对，不动生产库
pnpm smoke:prod                    # 生产 HTTPS 冒烟（真实反向代理 + 编译产物）
```

生产启动用纯 Node 运行编译产物（不依赖 tsx）：

```bash
NODE_ENV=production APP_ORIGIN='https://erp.example.com' \
DATABASE_URL='file:/var/lib/kingflow/erp.db' \
pnpm --filter @kingflow/api start:prod
```

## 当前范围与限制

V1 为单企业 ERP，不提供生产制造、BOM/MRP、退货、跨仓调拨、总账凭证、税务发票、多币种、多租户或真实支付。已过账单据不支持直接修改、删除或红字冲销。SQLite 适合本地演示，多人高并发需迁移 PostgreSQL 并重新验证。报表面向 Demo 数据规模做内存聚合，大数据量需改用数据库聚合/分页。

## 文档

[PRD](docs/PRD.md) · [架构](docs/ARCHITECTURE.md) · [API](docs/API.md) · [数据库](docs/DATABASE.md) · [部署运维](docs/DEPLOYMENT.md) · [注册与审核](docs/REGISTRATION.md) · [移动端](docs/MOBILE.md) · [演示指南](docs/DEMO.md) · [交付验收](docs/VERIFICATION.md)

离线了解项目概览与真实界面截图：双击根目录 **作品集展示.html**，或查看 [作品集PDF](docs/portfolio/KingFlow-ERP-作品集.pdf) 与 [项目介绍](docs/PORTFOLIO.md)。

## 安全说明

- 仓库不含任何真实服务器地址、生产口令与私钥；`deploy/bootstrap.sh` 的公网 IP 通过 `PUBLIC_IP` 环境变量传入
- 演示数据与 `db:seed` 仅用于本地开发，请勿用于生产
- 明文 HTTP 部署（方案 C）仅适合演示场景，公网长期暴露请配置域名、证书并切换到 `NODE_ENV=production`，详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
