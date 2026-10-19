# 架构与 UI 规范

pnpm workspace：apps/web（React19、Vite7、Ant Design5、Router7、Query5、Zustand5、Axios）；apps/api（Express5、Prisma6.19、SQLite、Zod3、bcryptjs）；packages/shared（资源定义、校验及权限）。锁文件固定实际解析版本，Node22.12+或24。

浏览器 → Axios /api/v1 → Express Router → Controller → Service → Repository → Prisma → SQLite。Service 做业务与授权，Repository 只访问数据库。Session 表持久化，Cookie 只存随机令牌，数据库存令牌摘要，8小时过期；csrf令牌随me响应，变更请求检查Origin和X-CSRF-Token。登录限流，bcrypt12轮，生产Cookie Secure。Vite仅代理本地开发，生产需要同源反向代理和HTTPS。

前端：Query 管理远端数据，Zustand仅会话；列表用统一页面，字段配置来自共享定义，各资源保持独立数据库模型。表单人民币显示元，发送整数分。明确加载、错误、空态、权限、操作反馈。主色#1677FF，背景#F5F7FA，文字#1F2937/#64748B，边框#E5E7EB；侧栏240px、白色顶栏、内容24px间距。折叠侧栏适应笔记本，表格横向滚动。

基础模块业务组件在modules/master-data，布局在layouts，共用UI在components。未来模块按pages/components/hooks/api/types组织，有实现才创建，避免空壳。API事务记录审计，不记录密码/Session/CSRF。CSV由后端输出UTF-8 BOM并处理公式风险。

部署限制：SQLite适合本地/受控单实例；多人业务阶段使用短事务、条件更新、busy超时和冲突反馈，规模扩大迁移PostgreSQL。

## V1 模块落地

采购/销售独立业务模块通过事务服务调用InventoryService.receive/ship，库存调整调用adjust，财务通过FinanceService条件结算。库存流水可追溯三种真实来源；所有过账结果与幂等、审计一起提交。报表Repository访问数据库，Service按权限聚合；仪表盘只返回允许的模块指标。

系统模块的用户/角色维护在写锁内重新检查操作者权限及管理员保留条件。Session撤销和变更同事务。登录读取凭据后在建Session事务重新检查快照，防止并发改密遗留旧凭据会话。

前端按业务路由拆包，图表和Ant组件独立chunk；Query负责持久数据缓存，过账统一刷新关联经营/财务/库存查询。未确认提交按用户与来源保留sessionStorage原请求，服务端以请求摘要及唯一业务来源校验重放。
