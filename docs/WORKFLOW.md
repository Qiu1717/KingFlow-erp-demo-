# KingFlow ERP V1.0 完整开发 Workflow（项目执行版）

本文件持久保存用户工作流的全部阶段、范围与验收规则。详细字段/关系/API拆分在PRD、DATABASE、API中。Phase0–7已完成V1验收；当前仅整理作品集与交付验证，不扩展V2业务。

2026-10-19追加上线账号授权：用户要求移除登录页凭据、加入注册，并明确选择公开注册+管理员审核。新增待审/驳回账号状态、后台审核与角色分配、注册安全约束及生产首任管理员初始化；保留此前停止测试的要求，本轮仅执行代码/类型/构建检查，不声称公网验收通过。详见REGISTRATION.md、DEPLOYMENT.md和PROGRESS.md。

2026-10-19追加授权：用户要求完善可视化。作为V1分析能力增补，新增四主题数据可视化入口与可交互图表，复用真实报表与权限；实际结果见PROGRESS.md、VERIFICATION.md。继续遵守逐项实现、测试、修复、记录，不扩展V2业务范围。

2026-10-19交付加固授权：用户要求「做成真正的企业级、企业会遇到的情况都测一遍、随时可交付」。在既有V1业务范围内补齐并发/事务回滚/幂等/权限矩阵/备份恢复/生产运行的真实测试与修复，不新增V2业务模块。结论见 `DELIVERY-READINESS.md`，部署运维见 `DEPLOYMENT.md`。

## 产品目标及技术约束

原创企业级ERP Demo，参考商贸ERP模块组织，不复制金蝶Logo/商标/页面/专有素材。单企业、多仓库、中文、人民币、PC优先。必须真实API和数据库、持久化、完整CRUD、采购销售库存财务联动；不允许前端假成功、空按钮或假审核。组件化、模块化、可扩展，先核心业务闭环。

前端React/TypeScript/Vite/Ant Design/React Router/TanStack Query/Zustand/Axios/Recharts/Day.js/Lucide React；后端Node/TypeScript/Express/Prisma/SQLite/Zod/bcrypt或argon2/Session。pnpm workspace、ESLint、Prettier、Vitest、Supertest、Playwright。依赖兼容稳定、提交锁文件。后端Controller→Service→Repository，重要业务规则必须在Service层，shared存共享结构/枚举。

UI：浅色极简SaaS，#1677FF、#F5F7FA、白卡片、#1F2937/#64748B、#E5E7EB，状态绿橙红蓝灰。侧栏Logo、分级菜单、折叠、高亮；顶栏面包屑、全局搜索、消息入口、头像退出；内容标题/操作/筛选/表格分页/弹窗抽屉。适配1440/1366，反馈hover/loading/disabled、表单校验、保存提示、空/加载/错误状态。未具备真实功能的入口不可伪装。

共用组件目标：AppLayout、PageHeader、FilterBar、DataTable、StatusTag、FormDrawer、ConfirmDialog、MoneyText、DateRangeFilter、EmptyState、ErrorState、LoadingState、DocumentItemsTable、PermissionGuard；按实际阶段引入，订单/日期组件留后续。

## 全局执行

每阶段Inspect→Plan→Implement→Test→Fix→Review→Document。读取实际代码和进度；计划文件/接口/任务；编写实际代码；运行测试修复；核对验收；更新PROGRESS。未实现或未经验证不能勾完成。新聊天读取AGENTS、WORKFLOW、PROGRESS，不重复实现。

## Phase 0 项目规划与架构

检查目录避免覆盖；建立Monorepo；完整PRD、模块边界、数据库关系、API和UI规范、长期规则。
交付docs/PRD、ARCHITECTURE、DATABASE、API、WORKFLOW、PROGRESS、DECISIONS及AGENTS.md。
验收：目录清晰、核心规则明确、关系清晰、无范围冲突、可直接继续开发。

## Phase 1 工程初始化与系统框架

React/Vite/TS/Ant Design/路由、Express/Prisma/SQLite、运行脚本、Session认证、主布局、完整菜单、错误页、通用组件。页面登录、基础工作台、个人中心、404。
验收：前后端启动、登录退出、保护页面、切换导航、符合UI、类型与构建通过。

## Phase 2 基础资料

商品、单级分类、客户、供应商、仓库真实CRUD、迁移、筛选、验证、停用、Seed。商品唯一编码、价格和分类、删除引用保护、CSV；其他字段见PRD。
验收：创建商品→保存DB→刷新存在→修改名称价格→关键词查询→停用；新增客户、供应商、仓库。实际持久化。

## Phase 3 采购与入库

采购订单/行、列表/新建/多商品/整数分金额、草稿编辑、提交/审核/驳回、分批入库、库存余额与流水、应付、状态更新。
验收：A商品10件×80元=800元，审核后先入6：库存+6、流水+6、应付480、部分入库、余4；再入4：累计+10、应付800、已入库。同一次入库重试不能重复增加。未审核不可入库，超量/零负数拒绝，已过账不可编辑；所有更新在同一事务。

## Phase 4 销售与出库

销售订单/行、列表/筛选/日期/分页/详情/表单、审核、库存检查与扣减、流水/应收/状态。仅审核后，商品必须属于订单，数量≤未出数量和仓库余额，条件更新防并发负库存。
验收：A库存10，订单3×120=360，审核出库后库存7、已出库、应收360、出库流水-3、销售报表可查。尝试出库100库存不足，库存/应收/出库单均不改变。失败事务回滚。

## Phase 5 财务往来

应收/应付列表详情、收款付款、部分/全部结清、财务概览。金额>0且不超过余额，防重复，结算来源明确。
验收：应收360，收100→已收100未收260部分结清；再收260→已收360未收0已结清；继续收款拒绝。付款对称。

## Phase 6 工作台与经营报表

真实数据库聚合：本月销售/采购、库存数量、待收/付、待审核、预警；近30天销售、采购销售对比、销售排行、状态分布；待办审核/未完成/预警可跳转；快捷商品/采购/销售/库存。报表销售/采购/库存/往来，日期筛选、CSV、来源追溯。
统计：销售按正式出库，采购按正式入库，库存按余额，待收付按未结余额；时区及半开范围明确。
验收：无写死指标；入库采购更新、出库销售更新、收款余额更新、低库存预警、各报表查询导出正常。

## Phase 7 系统完善与质量验收

用户管理、角色权限、审计、加载/查询/表单优化、幂等、统一错误/UI、浏览器E2E、构建、README。
验收：全部菜单可用，无假按钮，无阻断错误，后端权限生效、事务正确、无负库存/重复过账、持久化、审计完整、可完整演示。

## 安全与数据不变量

六角色：管理员、采购、销售、仓库、财务、只读访客。管理员全部；采购创建审核采购/部分基础维护；销售创建审核销售/部分基础维护；仓库出入库；财务往来与结算；所有可查基础，访客仅授权查询。用户角色管理管理员专有。密码哈希、HttpOnly Session、生产Secure、认证/权限/Origin/CSRF、Zod输入、审计脱敏、注入/XSS防护、登录限流、演示账号受控。

实体：User、Role、Session、Product、ProductCategory、Customer、Supplier、Warehouse、PurchaseOrder/Item、GoodsReceipt/Item、SalesOrder/Item、SalesShipment/Item、StockBalance、StockMovement、StockAdjustment、Receivable、Payable、SettlementRecord、AuditLog、IdempotencyRecord。唯一主键/编码/单号/商品仓库；整数分、整数数量、创建人时间、订单行快照、引用删除保护、事务/幂等唯一约束、状态专用方法、正式过账不可改。SQLite并发明确处理。

## 自动化测试

单元：金额、状态、剩余入出库量、库存不足、未收/付、权限。
API：未登录/无权限/非法输入、创建商品/采购/审核、未审核不可过账、入库流水/出库扣减、超入/库存不足/超结拒绝、幂等。
E2E01登录→工作台→退出；02商品新增→查询→编辑→停用；03采购创建→审核→入库→库存→应付→付款；04销售创建→审核→出库→库存→应收→收款；05业务后工作台/报表一致；06销售角色财务API拒绝。必须真实独立测试数据库，不能伪造前端成功。首轮实现适用测试，其余随阶段补。

## Seed、运行、交付

最终Seed：管理员1+其他角色5、商品≥30、分类≥5、客户≥10、供应商≥8、仓库≥2、采购≥15、销售≥20、流水≥30、多笔应收付/收付款、近60天逻辑一致数据。支持幂等Seed；仅开发重置，有环境保护。本轮只初始化基础资料和账号，业务数据后续经Service产生。

命令：pnpm install、db:migrate、db:seed、dev、lint、typecheck、test、test:e2e、build。README含简介/技术/环境/安装/变量/数据库/启动/账号/模块/业务步骤/测试/范围/限制。项目结构apps/web、apps/api、packages/shared、tests/e2e、docs，锁文件和.env.example。

## 进度与阶段报告

PROGRESS必须有当前阶段、已完成、进行中、未开始、验证命令和结果、已知问题、下一阶段。每阶段报告名称、实际完成功能、主要文件、测试结果、未完成、已知问题、下一阶段。首轮报告另含目录、决策、启动命令、账号，结束停止扩展。

## 最终验收清单

功能：登录退出/完整导航、五类主数据、采购创建审核入库/库存+应付、销售创建审核出库/库存+应收、不足拦截、流水、部分收付、工作台/图表/报表/CSV、权限、审计。
技术：本地启动、迁移/Seed、持久化、API、事务/幂等、类型/Lint/单元/集成/E2E/构建通过、README完整。
V1排除：BOM/MRP/生产、总账凭证、税务发票、多币种、集团合并、支付接口、复杂审批、退货、调拨、多租户计费。
