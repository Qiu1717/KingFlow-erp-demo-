# API 规范

前缀/api/v1。成功{data:...}；列表{data:{items,total,page,pageSize}}；失败{error:{code,message,fields?}}。401未登录，403权限/来源/CSRF，404不存在，409编码/引用冲突，422校验错误，429限流。禁止返回密码摘要。

POST /auth/login {username,password} → 用户和csrfToken；GET /auth/me → 同上；POST /auth/logout撤销Session。变更接口必须带Origin和X-CSRF-Token（登录只校验来源），SameSite=Lax HttpOnly Cookie。

已实现资源：products、categories、customers、suppliers、warehouses。均GET列表、POST新增、GET /:id详情、PATCH /:id编辑、DELETE /:id删除未引用。列表支持q/status/categoryId/page/pageSize/sortBy/sortOrder，排序白名单code/name/createdAt/updatedAt；状态ACTIVE/INACTIVE。GET /products/export.csv同查询条件，最多10000条。GET /dashboard/summary主数据计数；GET /system/reference角色只读信息。

## Phase 3 采购与入库

- GET/POST /purchase-orders，GET/PATCH /purchase-orders/:id；POST /:id/submit、approve、reject。新增/编辑body为supplierId、warehouseId、orderDate、expectedDate?、remark、items[{productId,quantity,unitPrice}]。金额分、数量正整数，服务端计算总额，不接收status或totalAmount。
- reject要求{reason}，独立保存为rejectionReason并保留原备注；其余动作body为{}。草稿DRAFT→待审核PENDING→已审核APPROVED→部分入库PARTIAL→已入库RECEIVED；待审核可驳回草稿。
- GET/POST /goods-receipts，GET /goods-receipts/:id；正式单据PATCH/DELETE返回405。POST body为{orderId,remark?,items:[{orderItemId,quantity}]}，请求头Idempotency-Key为8–128位字母/数字/下划线/短横线/冒号。
- 首次过账201，同键同用户同业务请求200并返回原入库单；同键异请求/异用户409。明细按ID排序摘要，不因数组顺序改变重复过账。已完成订单仍能重放原键。SQLite写入竞争返回409/503时，客户端保留原键重试。
- GET /stocks、/stock-movements、/payables：只读余额、流水、应付；应付结算见下文Phase5接口。入库响应不包含财务结算信息，只有payables:read角色可查应付。

采购列表支持q（订单编号/供应商）、supplierId/status、dateFrom/dateTo（订单业务日期，闭区间）、page/pageSize、sortBy（createdAt/orderDate/number/totalAmount）、sortOrder。入库列表支持q（入库/采购单号）、orderId/warehouseId、日期；流水支持商品/仓库/来源receiptId、q；余额支持商品/仓库和名称编码q；应付支持supplierId/receiptId、q。其他列表按创建/更新时间排序、分页。发生时间的日期筛选使用Asia/Shanghai零点至结束日期次日零点半开区间。

权限：采购可维护/审核采购单、查入库与库存；仓库查采购/库存、执行入库；财务查入库及应付；销售库存及销售查询（Phase4扩展见下文）；访客授权采购/入库/库存只读；管理员全部。后端每个业务入口校验，前端页面也有403保护。

Phase3时规划、现已在Phase4–7完成的API：sales-orders创建/审核/出库，sales-shipments，stock-alerts、stock-adjustments，receivables、settlements及收付款，reports各报表、users/roles/audit-logs配置与查询页面。
## Phase 4–7 已实现接口

原计划接口均已实现。所有路径前缀 /api/v1，受Session/CSRF/权限约束。

### 销售

GET/POST /sales-orders，GET/PATCH /sales-orders/:id；POST /sales-orders/:id/submit、approve、reject。body与采购一致，supplierId改customerId。状态DRAFT→PENDING→APPROVED→PARTIAL→SHIPPED；reject body{reason}。列表q/customerId/status/warehouseId/dateFrom/dateTo/page/pageSize/sortBy/sortOrder。

GET/POST /sales-shipments，GET /sales-shipments/:id。过账body{orderId,remark?,items:[{orderItemId,quantity}]}，Idempotency-Key；仓库取订单来源，实际库存不足409 INSUFFICIENT_STOCK，超出订单余量409 EXCESS_SHIPMENT。首创201，同键同内容重放200；只允许已审核/部分出库，正式单据不可PATCH/DELETE。

### 财务

GET /receivables、/payables：q/status/customerId或supplierId/shipmentId或receiptId/sourceId/dateFrom/dateTo/page/pageSize/sortOrder。GET /receivables/:id、/payables/:id含结算历史及来源。

GET /settlements：type RECEIPT/PAYMENT、sourceId、q、dateFrom/dateTo、分页。POST /settlements/receipts 或 /settlements/payments，body{sourceId,amount,date,method,remark?}；amount为正整数分，date真实YYYY-MM-DD，method为银行转账/现金/其他。必须Idempotency-Key；超过余额409 EXCESS_SETTLEMENT，不允许任意status。同键异类型/内容/用户409 IDEMPOTENCY_CONFLICT。状态UNSETTLED/PARTIAL/SETTLED由后端推导。

GET /finance/summary：dateFrom/dateTo筛选结算业务日期，应收应付总额及未结余额始终为全部有效单据；receivableTotal/receivableRemaining/payableTotal/payableRemaining/receipts/payments。

### 经营分析与库存

GET /dashboard/business：按当前角色返回七类经营指标、30天趋势、商品销售排行和销售状态分布，无权限财务字段不返回。
GET /dashboard/todos：当前角色可处理的待审核/待出入库单据及库存预警链接。
GET /reports/sales、purchases、inventory、finance：dateFrom/dateTo、q、warehouseId/productId、page/pageSize；format=csv导出所有筛选行。销售/采购返回正式过账行、总额数量、趋势、商品及往来排行；库存返回余额及日期期间期初/增加/减少/截止库存、仓库汇总、预警/流水；财务返回应收应付分别原始/已结/未结。CSV为UTF-8 BOM，防公式注入。

可视化增强（2026-10-19）：销售/采购支持 `rankBy=amount|quantity`（默认amount），对全部匹配明细聚合后取前10名，不受page/pageSize影响；相同指标按名称排序。非法指标返回422。图表与明细、CSV共用筛选条件；仓库筛选仅用于销售/采购/库存，往来页面不提供仓库筛选。页面 `/visualizations` 复用以上接口，按销售/采购/库存/财务读取权限展示页签，不另建绕过授权的数据接口。
GET /stock-alerts：q、warehouseId/productId、分页；启用商品×启用仓库，无余额按0。
GET /stock-adjustments：q、warehouseId/productId、dateFrom/dateTo、分页。
POST /stock-adjustments：{productId,warehouseId,quantity,reason}，非零有符号整数、原因必填、Idempotency-Key；同事务余额/流水/来源调整/幂等/审计，禁止负库存。
库存流水新增shipmentId、adjustmentId筛选和来源关系，数量入库为正、出库为负。

### 系统

GET/POST /users，PATCH /users/:id，POST /users/:id/reset-password {password}。新增{username,displayName,password,roleId,status?}，编辑只接收displayName/roleId/status，敏感密码不出响应。
GET /roles，PATCH /roles/:id {permissions:string[]}；GET /permissions权限白名单。
GET /audit-logs：actorId/action/resource/from/to/page/pageSize。上述接口也提供/system前缀路径，界面使用/system/*。
PATCH /auth/profile {displayName}，POST /auth/password {currentPassword,newPassword}。改密、停用、角色变更会撤销对应会话。管理员角色保留*，只读访客不可授予写权限，保护自身及最后启用管理员。

系统管理仅system:manage（默认管理员*）；结算settlements:write、财务分析finance:read；查询应收receivables:read、应付payables:read；库存调整inventory:adjust。后端每个Service独立授权。
# 2026-10-19 公开注册与审核增补

- `GET /api/v1/auth/options`：匿名读取注册开关及审核模式。
- `POST /api/v1/auth/register`：匿名提交账号、姓名及密码；严格Origin，10次/IP/小时，Zod严格字段，用户名唯一，bcrypt哈希；201返回 `{ username, status: "PENDING" }`，不签发Session。
- `POST /api/v1/system/users/:id/review`：仅实时有效管理员，Origin+CSRF；`{ decision: "APPROVE", roleId }` 或 `{ decision: "REJECT" }`。同事务更新账号和审计；重复审核409，普通角色/管理员权限注入422。
- `GET /api/v1/system/users?status=PENDING` 与 `REJECTED`：新增申请筛选；普通PATCH不能启用待审或已驳回账号。
- 登录正确凭据但待审核返回403 `ACCOUNT_PENDING`，驳回返回403 `ACCOUNT_REJECTED`；错误凭据仍通用401。
- `REGISTRATION_ENABLED=false` 时，注册返回403 `REGISTRATION_DISABLED`；密码规则及初始管理员见REGISTRATION.md。

