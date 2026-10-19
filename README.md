# KingFlow ERP V1.0

面向中小型商贸企业的中文 ERP Web Demo。原创浅色企业界面，支持单企业、多仓库、整数数量及人民币业务。核心数据由 Express API、Prisma 与本地 SQLite 持久化。

已实现基础资料 → 采购审核 → 分批入库 → 应付 → 付款，以及销售审核 → 分批出库 → 应收 → 收款；提供库存调整、流水、预警、经营分析、用户角色和审计。

新增公开注册与管理员审核：登录页不展示或预填账号密码；新账号在用户管理审核并分配角色后才能登录。部署操作见 [部署与运维](docs/DEPLOYMENT.md)，注册规则见 [注册与审核](docs/REGISTRATION.md)。生产首次使用空库迁移后执行 `pnpm db:bootstrap` 创建管理员，**不要使用下方开发Seed及演示账号上线**。本轮未执行测试套件或公网验收，不能视为生产验收完成。

## 作品集阅读顺序

1. 双击根目录 **作品集展示.html**：离线查看项目概览与真实界面截图，无需安装依赖。
2. 查看 [作品集PDF](docs/portfolio/KingFlow-ERP-作品集.pdf)、[项目介绍](docs/PORTFOLIO.md) 与 [演示指南](docs/DEMO.md)：了解业务闭环、工程要点与演示步骤。
3. 按下方命令运行真实系统；接口和数据库说明见 docs/API.md、docs/DATABASE.md。
4. 本次交付的实际检查见 [交付验证记录](docs/VERIFICATION.md)。

开发方式：个人项目，使用 Codex 辅助完成实现、调试及回归。此作品不宣称商业上线、生产并发量或业务营收指标。

## 数据可视化（2026-10-19 增强）

手机/平板现支持侧滑功能菜单、底部快捷导航、卡片式单据明细、窄屏筛选和全宽抽屉，992px及以上保留桌面布局。手机访问和本轮确认范围见 [手机端说明](docs/MOBILE.md)。

登录后在「经营报表 → 数据可视化」进入，或访问 `/visualizations`。

- 销售、采购：面积趋势图、客户/供应商和商品横向排行，切换金额/数量，后端从全部筛选记录中取前10名。
- 库存：仓库库存柱状对比、库存数量环形占比；日期筛选展示截止日库存，预警仍使用当前余额。
- 往来：应收应付已结/未结金额堆叠图，并保留原始金额与明细追溯。
- 共用近7/30/90天、自定义日期、关键词、仓库筛选（往来除外）、刷新及CSV导出；按角色显示主题。

图表金额显示人民币元，数据库仍存整数分；数量按商品计量单位汇总，不表示库存价值或统一物理量。财务按来源单生成日期筛选，已结金额为当前累计。新功能与原报表共用接口及缓存失效机制，业务过账后重新查询。原项目介绍PDF为10月17日版本，新增可视化以本节、离线展示页和新截图为准。

## 环境与安装

验证环境：Windows、Node.js 24.16、pnpm 11.25。建议 Node.js 22.12+ 或 24 LTS。前端 React 19/TypeScript/Vite 7/Ant Design 5/React Router/TanStack Query/Zustand/Axios/Recharts，后端 Express 5/Prisma 6.19/SQLite/Zod/bcrypt。具体版本以 pnpm-lock.yaml 为准。

```powershell
# 在解压后的 KingFlow-ERP-V1.0 目录打开终端
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 http://localhost:5173；API http://localhost:3001/api/v1。默认配置可直接运行。API读取 apps/api/.env；需要调整时参考根目录 .env.example：

| 变量 | 默认/用途 |
|---|---|
| DATABASE_URL | file:./dev.db，相对于 apps/api/prisma |
| PORT | 3001 |
| APP_ORIGIN | http://localhost:5173；浏览器变更请求严格校验来源 |
| NODE_ENV | development；生产Cookie启用Secure，需要HTTPS |
| DEMO_PASSWORD | KingFlow@2026，仅开发Seed初始化缺失账号 |

请使用 localhost 访问界面，避免 127.0.0.1 与配置来源不一致。数据库自动建立在 apps/api/prisma/dev.db。迁移、Seed和测试前停止开发API，避免Windows占用Prisma DLL；完成后重新运行 pnpm dev。

## 演示账号

以下账号初始密码均为 `KingFlow@2026`。Seed不覆盖已修改密码或角色设置。

| 账号 | 角色 | 主要权限 |
|---|---|---|
| admin | 系统管理员 | 全部业务及系统配置 |
| purchase | 采购人员 | 商品/分类/供应商维护，采购创建审核，库存查询 |
| sales | 销售人员 | 客户维护，销售创建审核，库存查询 |
| warehouse | 仓库人员 | 执行出入库、库存调整、订单及库存查询 |
| finance | 财务人员 | 应收应付、收付款、财务分析及来源出入库查询 |
| guest | 只读访客 | 已授权基础资料、订单、出入库、库存查询 |

## 演示步骤

1. admin登录，查看经营概览、30天趋势、商品排行、状态分布、待办。所有指标来自数据库，财务指标按权限返回。
2. 基础资料创建商品A，采购价80元、销售价120元，选择分类和单位；新增客户、供应商、仓库。查询、编辑、停用/启用、刷新，数据持久保留。已引用资料禁止破坏性删除。
3. 采购订单创建A共10件×80元，保存草稿→提交审核→审核通过。先入6件：部分入库、库存+6、应付480元；再入4件：已入库、累计+10、应付合计800元。新建商品可排除既有演示库存干扰。
4. 销售订单创建A共3件×120元，提交审核→审核通过→出库：库存10→7，应收360元。未审核、超量、库存不足均不能出库。
5. 应收账款打开该单，先收100元：已收100、未收260、部分结清；再收260元：已结清，禁止继续收款。应付账款可按同样方法分批付款。
6. 库存调整填写正负整数和原因；盘亏不能使库存为负。流水可追溯采购入库、销售出库和调整，预警也包含尚无库存余额的商品仓库组合。
7. 经营报表按上海日期筛选正式出入库，查询客户/供应商/商品排行、日趋势，查看仓库汇总、历史期间增减和应收应付分析；导出中文CSV。
8. 用户管理新增、编辑、启停、分配角色和重置密码；角色权限页调整非管理员角色权限并使其已有登录失效。系统保护最后管理员与自身账号；访客只允许查询权限。
9. 操作日志查询关键业务；个人设置修改名称和密码。改密码后退出并撤销全部会话，使用新密码重新登录。

过账及结算遇到网络中断时，页面保留原请求及幂等键，刷新后重新打开原单据并使用“重试原请求”确认结果。请勿清除标签页存储或复制新请求来猜测是否成功。

## 数据口径与一致性

- 金额整数分、数量整数。订单保存商品名称/规格/单位/成交价快照。
- 已实现销售额按正式销售出库金额；采购额按正式采购入库金额；订单草稿/审核不计入实现额。
- 库存按商品+仓库独立核算。出入库和调整通过统一InventoryService，事务内同时更新余额、流水、订单、往来、审计及幂等结果。
- 应收应付按原始金额减累计已结；收付款只记录业务，不调用银行或支付服务。
- 时间UTC存储，界面及发生日期筛选按Asia/Shanghai：[首日零点，末日次日零点)。财务报表日期筛选来源生成日期，已结/未结显示当前累计；财务概览的收付日期筛选结算业务日期。
- 条件更新、SQLite写锁、唯一键和数据库触发器保障不会超额或重复过账。409/503写冲突保留原幂等键重试。
- 密码bcrypt哈希、HttpOnly Session、CSRF/Origin、登录限流、服务端权限、输入校验、审计脱敏、CSV公式注入防护。

## 初始化与重置

全新Seed包括6角色账号、30商品、5分类、10客户、8供应商、2仓库、15采购单、20销售单、15入库、14出库、44库存流水、15应付、14应收和24收付款，覆盖近60天；所有业务经Service产生。重复执行不无限新增，不覆盖用户编辑。可用演示主数据不足时保留用户修改并跳过相应缺失单据。

仅开发环境且明确确认时允许重置本项目 dev.db，不能对测试库或任意路径执行开发重置：

```powershell
$env:NODE_ENV='development'
$env:DATABASE_URL='file:./dev.db'
pnpm db:reset --confirm-local-dev
```

## 验证

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

已安装Chrome时可用：

```powershell
$env:PLAYWRIGHT_CHANNEL='chrome'
pnpm test:e2e
```

API测试自动迁移独立 test.db；浏览器测试初始化独立 e2e.db，启动真实前后端。均不修改dev.db。测试期间不要同时启动开发服务；失败截图及Trace在test-results。本次交付实际结果见 docs/VERIFICATION.md 与 docs/DELIVERY-READINESS.md；原阶段开发记录在本地 docs/PROGRESS.md。

## 备份、恢复与生产运行

```powershell
pnpm db:backup <目标文件>          # 一致性快照备份（拒绝覆盖已存在文件）
pnpm db:verify                     # 七项账实不变量核对
pnpm db:restore <备份> <新库文件>  # 恢复到全新库，自动清会话并核对
pnpm db:drill <目录>               # 恢复演练：备份+恢复+双库核对，不动生产库
pnpm smoke:prod                    # 生产 HTTPS 冒烟（真实反向代理 + 编译产物）
```

生产启动用纯 Node 运行编译产物（不依赖 tsx）：

```powershell
$env:NODE_ENV='production'
$env:APP_ORIGIN='https://erp.example.com'
$env:DATABASE_URL='file:/var/lib/kingflow/erp.db'
pnpm --filter @kingflow/api start:prod
```

部署、反向代理、环境变量、容量边界与故障排查见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)；交付就绪结论与已修复缺陷见 [docs/DELIVERY-READINESS.md](docs/DELIVERY-READINESS.md)。

> 并发说明：SQLite 为单写者数据库，本项目把 Prisma 连接池固定为 `connection_limit=1` 并在应用内串行化写入，避免多连接抢锁导致的 503。**不要调大该值**；需要多实例时迁移 PostgreSQL 并重新验证。

## 工程目录

```text
apps/web/src/       app、layouts、routes、components、modules、services、stores、styles
apps/api/src/       routes、controllers、services、repositories、middleware、utils
apps/api/prisma/    schema、版本化迁移、主数据/采购/销售/财务Seed
apps/api/tests/     单元、API、权限、并发、事务回滚及Seed测试
packages/shared/   状态、校验规则、权限及共享数据结构
tests/e2e/         真实浏览器端到端测试
docs/              项目介绍、演示指南、截图、架构、数据库、API及交付验收
scripts/           构建辅助与生产冒烟脚本（工作区级）
```

## 当前范围与限制

V1为本地或受控演示环境的单企业ERP，不提供生产制造、BOM/MRP、退货、跨仓调拨、总账凭证、税务发票、多币种、多租户或真实支付。已过账单据不支持直接修改、删除或红字冲销。SQLite适合本地演示；多人高并发使用需迁移PostgreSQL并重新验证事务策略。报表当前面向Demo数据规模进行内存聚合，未来大数据量需数据库聚合/分页。Session无外部服务依赖，Cookie生产需要HTTPS。Windows重新生成Prisma Client前需关闭占用它的API进程。


## 交付包与本地文件

作品集包含完整源码、版本锁文件、迁移、Seed、自动化测试、界面截图、离线展示与项目介绍PDF。不包含node_modules、dist、任何数据库、.env或测试临时结果；解压安装后通过迁移和Seed重建干净演示数据。安装依赖需网络，已具备完整pnpm缓存时可离线安装。

本地开发依赖和dev.db保留，旧生成文件已移出项目至工作区delivery-backup目录，可恢复；不会随作品集提交。开发历史文档本地归档，评审以交付验证记录为准。SHA256SUMS.txt可用于核验包内文件完整性。
