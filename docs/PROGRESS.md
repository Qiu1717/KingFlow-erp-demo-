# KingFlow ERP 开发进度

## 当前阶段

2026-10-19最新请求：为上线调整账号体系。已实施：彻底移除登录页演示凭据；公开注册（PENDING）；管理员在用户管理审核并分配普通业务角色，支持驳回（REJECTED）；未审核/驳回无法签发登录Session；普通更新接口不能绕过审核；注册限流、来源检查、严格字段、密码哈希、事务及审计；可由REGISTRATION_ENABLED服务端关闭注册。增加db:bootstrap受控创建首任管理员，拒绝覆盖已有管理员；生产登录拒绝原演示口令。保留手机适配和原业务数据。

本轮检查：`pnpm typecheck`、`pnpm lint`通过；`pnpm build`通过（包含前后端；构建辅助脚本存在Node DEP0190弃用提示，命令退出0）；前端源码和dist中无原演示口令/提示。新增6项注册安全回归源码（registration.test.ts），按此前停止测试要求未执行测试套件、未启动服务或完成浏览器/目标服务器验收，因此不标记为生产验收通过。无新增数据库表或迁移，User.status沿用字符串字段；未执行Seed、重置或修改dev.db。最后新增生产口令拦截后，重新执行全项目typecheck、lint及API build，均退出0。

上线操作与边界见REGISTRATION.md和DEPLOYMENT.md；首部署必须独立空库迁移+db:bootstrap，禁止带演示账号或开发库上线。后续尚需目标服务器HTTPS、实际注册审核链路及运维验收，本轮没有代为发布。

2026-10-19最新指令：停止继续测试，转为手机端响应式适配。已实施手机导航、卡片录单、出入库填写、弹窗、筛选及报表布局；本轮仅做前端构建/代码检查，不进行业务测试或公网交付验收。具体范围与预览限制见MOBILE.md。

手机适配本轮结果：前端ESLint通过，前端TypeScript及Vite生产构建通过；未运行测试套件。预览启动被自动审批拒绝（仅返回策略拦截），尚未完成运行截图与真机验收，不能标记为真机验收通过。

V1.0：Phase 0–7 全部通过本地验收（2026-10-16）。按用户授权连续完成全部V1阶段；停止扩展新功能，不自动推进V2。

2026-10-19：按用户新请求完成V1数据可视化增强；业务实现、自动化验收、截图及新版作品集内容核验完成。

2026-10-19（交付加固）：用户要求「做成真正的企业级、企业会遇到的情况都测一遍、随时可交付」。在 Codex 中断的半成品基础上继续：修复基线断裂，补齐企业级并发/事务/幂等/备份恢复/生产运行测试，修复 9 个真实产品缺陷。详见下方「交付加固」章节与 `DELIVERY-READINESS.md`、`DEPLOYMENT.md`。

## 交付加固（2026-10-19）

### 接手时的实际状态（未隐藏）

Codex 会话中断时项目**不是绿的**：

- `apps/api/src/services/recovery-service.ts` 文件缺失，类型检查与测试直接失败
- `apps/api/tests/api.test.ts` 8 项失败：`Cannot read properties of null (reading 'address')`
- `apps/api/tests/enterprise.test.ts` 4 项失败：20 路并发约一半返回 503
- `tests/e2e/session-isolation.spec.ts` 1 项失败：旧会话迟到 401 会踢掉新账号

### 修复的真实缺陷（先复现后修复）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | 并发过账偶发 503（P1008） | Prisma 默认多连接抢 SQLite 写锁 | `db.ts` 固定 `connection_limit=1&socket_timeout=30` + 交互式事务指数退避重试 |
| 2 | `pnpm build` 产物无法运行 | 编译产物保留 `@kingflow/shared` 包名说明符，该包 exports 指向 `.ts` | 新增 `scripts/postbuild.ts` 改写为相对路径；新增 `start:prod` 用纯 Node 启动 |
| 3 | 生产模式静态目录解析错误 | `webDist` 用固定相对路径，在 `dist` 层级指向不存在目录 | 逐级向上定位工作区根再取 `apps/web/dist` |
| 4 | 旧会话迟到 401 踢掉新账号 | 全局拦截器把所有 401 当作当前会话失效 | 请求发出时记录会话标识，`isCurrentSessionFailure()` 只对当前会话 401 清登录态 |
| 5 | `createApp(config)` 注入被忽略 | 中间件与 Cookie 直接读 `process.env` | 配置挂 `app.locals.runtime`，经 `config/context.ts` 读取 |
| 6 | 菜单 key 重复 | 同一路径出现在多个分组，antd Menu 要求 key 全局唯一 | 用「分组:路径」作 key 并映射回路由；无权限入口按权限隐藏 |
| 7 | 入库数量可输入超量且无提示 | `InputNumber` 手动键入绕过 `max` | 服务端错误之外，前端提交前校验 + 输入框标红 + 明确提示 |
| 8 | 抽屉底部操作区被挤出视口 | 表单过长时 footer 不可达 | 抽屉 body 独立滚动、footer 固定 |
| 9 | antd v5 + React 19 兼容警告 | 缺少官方兼容补丁 | 引入 `@ant-design/v5-patch-for-react-19` |

测试基础设施缺陷（不改业务代码）：supertest 7 共享 server 生命周期竞态 → `tests/server.ts` 的 `startTestServer()`；Windows 临时目录导致 esbuild 构建失败 → `scripts/with-local-temp.mjs`。

### 新增能力

- **备份/恢复/账实核对**：`recovery-service.ts` + `pnpm db:backup|verify|restore|drill`，`VACUUM INTO` 一致性快照、拒绝覆盖、恢复后清会话、七项不变量核对
- **生产 HTTPS 冒烟**：`pnpm smoke:prod`，真实反向代理 + 编译产物 + 27 项断言
- **企业级测试**：六角色权限矩阵、20 路并发抢库存/抢余额/同键幂等、多行回滚、跨仓隔离、停用资料拦截、日期口径、CSV 注入防护、备份恢复演练

## 已完成

- [x] Phase 0：Monorepo、PRD、架构、数据库关系、API、UI规范、Workflow、AGENTS与技术决策。
- [x] Phase 1：React/Vite/TypeScript/Ant Design、Express/Prisma/SQLite、真实Session登录退出、保护路由、ERP布局、菜单、404及通用状态组件。
- [x] Phase 2：商品/分类/客户/供应商/仓库真实CRUD，查询筛选分页排序、启停、编码唯一、引用保护、商品CSV、持久化演示数据。
- [x] Phase 3：采购草稿/编辑/提交/审核/驳回、快照、6+4分批入库、库存余额/流水、应付、幂等及同事务审计。
- [x] Phase 4：销售草稿/编辑/提交/审核/驳回、分批出库、条件扣库存、负数流水、应收同事务、剩余数量/实际库存校验、20单真实销售Seed。
- [x] Phase 5：应收应付详情、部分/全部收付款、记录、财务概览、超额拦截、并发余额保护、幂等恢复、24笔真实收付款Seed。
- [x] Phase 6：七类经营指标、四类经营图表、待办与快捷入口；销售/采购/库存/往来分析、排行、趋势、上海日期范围、来源追溯和CSV。
- [x] Phase 6：库存预警含无余额0组合，库存调整需原因、非零整数和非负余额；三类流水追溯；报表历史期初/期间增减/截止库存。
- [x] Phase 7：用户/角色权限/审计/个人设置，最后管理员与自身保护，改密/禁用/角色变更撤销会话，登录并发凭据快照检查。
- [x] Phase 7：网络失败刷新原键恢复、资金来源切换回调安全、跨账号缓存隔离、业务联动缓存刷新、路由/图表/UI拆包、1440/1366布局检查。
- [x] 最终Lint/类型/79项单元及接口/24项E2E/构建通过，生产构建预览五页面无JS错误，迁移与Seed成功，README及技术文档更新。

## 进行中

无。

## 未开始

V1范围无；V2生产制造、退货、调拨、总账、税务、支付、多租户等不在本轮范围。

## 验证记录

### 交付加固轮（2026-10-19，最终结果）

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过，0 错误 |
| `pnpm typecheck` | 根配置 / shared / API / Web 全部通过 |
| `pnpm test` | **18 个文件、210 项全部通过** |
| `pnpm test:e2e` | **45 项全部通过**（约 4.9 分钟） |
| `pnpm build` | shared / API（含 postbuild）/ Web 全部通过 |
| `pnpm smoke:prod` | **27 项全部通过**（真实 HTTPS 反向代理 + 编译产物） |
| `pnpm db:verify` | 七项账实不变量全部通过 |
| `pnpm db:drill` | 备份→恢复→双库核对通过，生产库未被改动 |

API 测试覆盖分布：`api` 20、`trade-enterprise` 34、`security-enterprise` 22、`system-enterprise` 18、`finance-enterprise` 15、`analytics-enterprise` 14、`purchase` 15、`sales` 11、`analytics` 11、`enterprise` 10、`production` 10、`system` 9、`recovery` 6、`finance` 6、`purchase-rules` 4、`sales-finance-rules` 2、`shared` 2、`seed` 1。

E2E 覆盖分布：`enterprise-flows` 14、`master-data` 10、`session-isolation` 4、`finance` 3、`visualizations` 3、`analytics` 2、`purchase` 2、`sales` 2、`system` 2。

> 说明：本轮的 210/45 与上一版的 79/24 不是同一口径——新增的 5 个企业级测试文件专门覆盖并发、事务回滚、幂等、权限矩阵、备份恢复与生产运行边界，不是原有用例的重复计数。

### 历史验证记录（Phase 0–7 及可视化轮）

| 命令/检查 | 结果 |
|---|---|
| pnpm db:migrate | 7个版本化迁移成功，dev.db保留已有数据 |
| pnpm db:seed | 成功；重复执行不重复业务、不覆盖用户修改，独立Seed测试通过 |
| pnpm lint | 通过，0错误 |
| pnpm typecheck | 根配置、shared、API、Web全部通过 |
| pnpm test | 10个文件，79/79通过；独立真实test.db |
| PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e | 24/24通过，约2.1分钟；独立真实e2e.db |
| pnpm build | shared/API/Web全部通过；无大包警告 |
| 生产构建预览 | 登录/经营概览/销售报表/库存报表/往来报表/用户管理可访问；5个受保护页面，JS错误0，健康接口ok |
| 本地开发服务恢复 | pnpm dev已启动，localhost:5173及API3001正常 |

关键真实结果：

- 采购10件×80元，入6+4件：部分→全部入库、库存累计+10、应付480+320元。
- 销售3件×120元：库存10→7、应收360元，未审核/超额/不足拒绝且无副作用。
- 应收360元收100+260：部分→结清、余额260→0；付款同规则验证。
- 并发订单抢库存、并发结算抢余额只能有一笔成功；下游财务/流水/审计失败全部回滚。
- 采购入库、销售出库、库存调整、收款响应断开后刷新，原键重放不重复过账。
- 来源A结算延迟返回时切换到未确认来源B，B原键仍保留，重试仅有一条结算。
- 销售角色财务API/页面403，业务指标不泄露采购/财务字段；改密/权限变更撤销会话。
- CSV下载、中文编码、公式风险、上海首末日边界和草稿不计入经营实现额已验证。

失败与修复历史（保留记录）：

- Phase0–3原42项单元/接口及15项浏览器通过；本轮新增覆盖后逐步扩至79/24。
- 首轮浏览器16/23，7项失败：必填项accessible name、旧工作台文案、销售默认采购价、用户抽屉角色初值、应付来源列。已逐项修复。
- 第二轮22/23，剩库存调整同页表单ID冲突；命名表单并修复定位。
- 第三轮22/23，采购测试在lazy路由完成前操作旧页面；增加新页面就绪断言。
- 最终24/24，包含新增资金来源切换回归。曾出现的Prisma DLL占用通过停止相关API后迁移解决，不隐藏失败或用假状态绕过。

## 已知问题与限制

无已知阻断性业务缺陷。系统为本地/受控Demo：SQLite单实例写入能力有限，报表面向Demo规模内存聚合；不提供真实银行支付、总账税务或已过账冲销。生产使用需HTTPS、环境密钥与数据库迁移/运维评估，不将Demo等同完整财税产品。

## 数据可视化增强验收（2026-10-19）

- [x] 新增「经营报表 → 数据可视化」，按角色展示销售、采购、库存、往来主题，刷新保留URL主题。
- [x] 销售/采购面积趋势、客户/供应商与商品横向排行；金额/数量切换，后端全量聚合后取前10。
- [x] 库存仓库柱状对比、环形占比；财务应收应付已结/未结堆叠图，保留精确金额表与业务来源。
- [x] 日期快捷及自定义上海日期、关键词、仓库筛选、刷新、CSV共用真实数据及既有权限；加载、空态与异常明确反馈。
- [x] Lint、类型、生产构建通过；10文件81项单元/API、27项真实浏览器测试通过，最终E2E约2.2分钟。
- [x] 生产预览三张新增截图目检、SVG真实绘制、悬停提示及1366布局检查通过，JS错误0；独立干净Seed，未使用本地业务数据。
- [x] 离线页9张图片加载、768布局、无外部请求及JS错误检查通过；候选包149内容文件与当前源码逐字节一致，清单/SHA256/ZIP完整性通过。

主要修改：ReportCharts、Visualizations、ReportPage及types，App路由/navigation，analytics-service的rankBy校验排序，API/E2E测试，README/API/DECISIONS/PORTFOLIO/DEMO及离线页、截图。无新依赖或迁移，不改动库存/财务过账流程。

修复记录：未实现rankBy的API红测试422→200；单选测试改点可见标签并断言checked；截图发现Card高度引起说明重叠，位置测试先复现后修复，最终说明底部970.55、下一卡顶部1003.55，无重叠。曾误在预览服务运行时启动E2E，被端口保护拒绝；停止对应进程后完整重跑通过。无未解决阻断；PDF保留10月17日原版，新增内容见说明与07–09截图。

本轮结束，不自动继续V2。

独立财务审阅及整体审阅发现的问题已修复；整体审阅后半因子任务会话中断由主执行者完成自审与自动化验证。最终证据见 `tests/e2e` 与 `docs/screenshots`。（原 `docs/development/` 历史过程文档已在 2026-10-19 清理，结论汇总于本文件与 `DELIVERY-READINESS.md`。）

## 阶段总结与修改文件

- Phase4：sales-service/repository/controller/routes、SalesOrder/Shipment/Receivable迁移、销售订单/出库页面、InventoryService.ship、shared/sales及seed-sales。销售11项API与2项浏览器通过；未完成V1项无。下一阶段Phase5已完成。
- Phase5：finance-service/repository/routes、FinancePage、shared/finance、seed-finance及相应测试。财务6项API、状态单元及3项浏览器通过；未完成V1项无。下一阶段Phase6已完成。
- Phase6：analytics-service/repository/controller/routes、Dashboard/activity、ReportPage、InventoryPages、InventoryService.adjust及来源类型。分析9项API与2项浏览器通过；未完成V1项无。下一阶段Phase7已完成。
- Phase7：system-service/repository/controller/routes、Management/Profile、auth-service、布局路由、构建拆包、测试和README。系统9项API与2项浏览器、全部工程检查通过；未完成V1项无。交付加固轮的实际结果见本文件「交付加固」与 `DELIVERY-READINESS.md`。

## 下一阶段

V1开发结束，等待用户体验反馈；不自动开发V2或发布部署。


## 作品集整理（2026-10-17）

已完成：历史计划与审阅文档归档docs/development；移出构建、测试库和临时截图至工作区delivery-backup，可恢复。保留dev.db和本地依赖，不纳入交付包。删除无引用Planned页面及对应CSS。新增离线介绍、真实截图、项目介绍PDF、演示及交付验证记录。最终结果以VERIFICATION.md为准。

作品集交付复验：Lint/类型/构建通过，79项单元/API和24项E2E全部通过；候选ZIP独立解压、缓存重装、7迁移、Seed、构建、启动及浏览器核对成功。6张独立干净演示截图、离线HTML及3页PDF已检查；生成文件可恢复移出，dev.db摘要未变。最终ZIP包含清单与SHA256校验，完整记录见VERIFICATION.md。
