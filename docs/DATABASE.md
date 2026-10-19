# 数据库设计

## Phase 1–2 已建模型

Role 1→N User 1→N Session；ProductCategory 1→N Product。Customer、Supplier、Warehouse为独立主数据。AuditLog关联操作者（保留审计），保存动作、资源ID和时间，不存敏感请求体。主数据创建人关联User，编辑/删除在事务中写审计。各资源编码唯一，分类外键Restrict，产品分类删除前检查引用。软停用优先；无引用可硬删除。

时间UTC存储，界面Asia/Shanghai。价格Int整数分，上限1000000000分；库存预警整数。日期默认数据库生成，updatedAt由Prisma维护。

## Phase 3 已建关系

PurchaseOrder/Item、GoodsReceipt/Item、StockBalance、StockMovement、Payable、IdempotencyRecord已迁移。订单/入库/流水/应付保留创建人时间；订单行及入库行保存商品编码、名称、规格、单位、单价快照。商品、供应商、仓库外键Restrict阻止业务引用删除。订单行(订单,商品)、余额(商品,仓库)、入库行(入库,订单行)、流水(入库,商品)、应付receiptId均唯一。

guards迁移使用INSERT/UPDATE触发器约束金额、数量、累计收货量、库存非负、流水前后数量和状态；应付paidAmount不超过originalAmount。SQLite无法ALTER ADD CHECK，触发器提供等效约束。过账事务第一条无值变化条件UPDATE取得写锁，然后校验最新余量并条件累加；库存、流水、应付、状态、审计、幂等同事务。全局唯一幂等键绑定用户、scope和请求摘要；冲突不伪报成功。

演示15单、15入库、30流水、15应付由Service产生；仅Seed回填历史时间，重复执行不改已有业务。默认角色迁移按增量添加新权限，保留其余权限和密码。

## 关系总览（销售及结算已在后续迁移建表）

PurchaseOrder → Supplier/Warehouse/User，1→N PurchaseOrderItem，1→N GoodsReceipt → GoodsReceiptItem → PurchaseOrderItem。SalesOrder → Customer/Warehouse/User，1→N SalesOrderItem，1→N SalesShipment → SalesShipmentItem → SalesOrderItem。

StockBalance(productId,warehouseId)唯一；StockMovement保存前/后数量、有符号变动量、来源单号、操作者。StockAdjustment保存原因。GoodsReceipt 1→1 Payable；SalesShipment 1→1 Receivable。SettlementRecord必须且只能关联一个应收或应付。IdempotencyRecord的(userId,scope,key)唯一，保存请求摘要与结果，和过账同事务。

单据编号全局唯一（加业务前缀），来源过账唯一。订单行保留名称/规格/单位/单价快照。库存扣减使用quantity>=requested条件更新，受影响行数必须为1；所有财务与库存更新同一事务。采购/销售完成量按订单行累计，状态由后端推导。SQLite写冲突不伪报成功，返回可重试409/503。Phase3迁移时补外键阻止商品历史引用删除，不得仅靠前端判断。

## Phase 4–7 实际模型与约束

SalesOrder/Item、SalesShipment/Item、Receivable、SettlementRecord、StockAdjustment均已迁移。Customer关联销售及应收；销售行保存shippedQuantity、全部商品/价格快照；SalesShipment一对一Receivable，receivedAmount累计不超过originalAmount。

StockMovement的receiptId/shipmentId/adjustmentId可空，但必须恰有一个来源；type PURCHASE_RECEIPT/SALES_SHIPMENT/STOCK_ADJUSTMENT与来源及数量符号匹配。三个来源分别与productId构成唯一约束，仍保留前后数量恒等和库存非负触发器。

IdempotencyRecord.key是全局唯一主键，绑定userId/scope/requestHash；receiptId/shipmentId/settlementId/adjustmentId四选一且各unique。幂等来源恰一个且匹配scope由触发器约束。scope为goods-receipt/sales-shipment/settlement/stock-adjustment；结算摘要含收付款type。原先关系总览的(userId,scope,key)表述以本节全局key约束为准。

SettlementRecord保存number/type/amount/date/method/remark/createdById/createdAt，必须且只能关联Receivable或Payable，方向与type匹配，amount>0。应收应付状态UNSETTLED/PARTIAL/SETTLED由余额推导，零额来源直接SETTLED。结算先获得SQLite写锁，条件增加累计已结，生成结算、幂等、审计同事务。

StockAdjustment包含有符号quantity及必填reason，InventoryService.adjust通过条件更新保证0≤库存≤2,000,000,000；所有来源记录和业务引用使用Restrict。

全部七个版本化迁移保留原14个采购约束，并增加销售金额/数量/累计出库/应收余额、幂等和流水来源、结算方向、调整原因约束。SQLite重建表后显式恢复trigger。结算增加date+type及来源索引，调整增加时间索引。默认角色权限通过增量迁移追加，不覆盖已有密码或自定义权限。

全新Seed业务计数15采购/20销售、15入库/14出库、44库存流水、15应付/14应收、24收付款；经Service产生并幂等，历史日期仅在Seed回填。库存与流水/应收应付/结算金额的关系在真实数据库测试中验证。
# 2026-10-19 注册状态增补

User.status新增 `PENDING`（注册待审）和 `REJECTED`（审核驳回），保留 `ACTIVE` / `INACTIVE`。现有数据库字段为String，无需重建表或数据迁移。公开注册使用GUEST角色作内部关联占位，待审账号不能创建Session；管理员批准时必须明确指定普通业务角色。

注册与注册审计同事务写入；审核通过/驳回、Session撤销与审计同事务完成。审核前取得SQLite写锁，再检查当前管理员和申请状态，重复审核409。用户名原有唯一约束防止重复创建。无邀请表或邀请凭证。

