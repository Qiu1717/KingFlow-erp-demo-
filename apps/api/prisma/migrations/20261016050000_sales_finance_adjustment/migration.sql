-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "orderDate" TEXT NOT NULL,
    "expectedDate" TEXT,
    "rejectionReason" TEXT NOT NULL DEFAULT '',
    "remark" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalAmount" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesOrderItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "specification" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "shippedQuantity" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SalesOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesShipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesShipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesShipment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesShipmentItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shipmentId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "specification" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    CONSTRAINT "SalesShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "SalesShipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesShipmentItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "SalesOrderItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesShipmentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Receivable" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "originalAmount" INTEGER NOT NULL,
    "receivedAmount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'UNSETTLED',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receivable_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Receivable_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "SalesShipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Receivable_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SettlementRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivableId" TEXT,
    "payableId" TEXT,
    "amount" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettlementRecord_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "Receivable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SettlementRecord_payableId_fkey" FOREIGN KEY ("payableId") REFERENCES "Payable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SettlementRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockAdjustment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_IdempotencyRecord" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "receiptId" TEXT,
    "shipmentId" TEXT,
    "settlementId" TEXT,
    "adjustmentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IdempotencyRecord_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IdempotencyRecord_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "SalesShipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IdempotencyRecord_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "SettlementRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IdempotencyRecord_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "StockAdjustment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_IdempotencyRecord" ("createdAt", "key", "receiptId", "requestHash", "scope", "userId") SELECT "createdAt", "key", "receiptId", "requestHash", "scope", "userId" FROM "IdempotencyRecord";
DROP TABLE "IdempotencyRecord";
ALTER TABLE "new_IdempotencyRecord" RENAME TO "IdempotencyRecord";
CREATE UNIQUE INDEX "IdempotencyRecord_receiptId_key" ON "IdempotencyRecord"("receiptId");
CREATE UNIQUE INDEX "IdempotencyRecord_shipmentId_key" ON "IdempotencyRecord"("shipmentId");
CREATE UNIQUE INDEX "IdempotencyRecord_settlementId_key" ON "IdempotencyRecord"("settlementId");
CREATE UNIQUE INDEX "IdempotencyRecord_adjustmentId_key" ON "IdempotencyRecord"("adjustmentId");
CREATE TABLE "new_StockMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "beforeQuantity" INTEGER NOT NULL,
    "afterQuantity" INTEGER NOT NULL,
    "receiptId" TEXT,
    "shipmentId" TEXT,
    "adjustmentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "SalesShipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "StockAdjustment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_StockMovement" ("afterQuantity", "beforeQuantity", "createdAt", "createdById", "id", "number", "productId", "quantity", "receiptId", "type", "warehouseId") SELECT "afterQuantity", "beforeQuantity", "createdAt", "createdById", "id", "number", "productId", "quantity", "receiptId", "type", "warehouseId" FROM "StockMovement";
DROP TABLE "StockMovement";
ALTER TABLE "new_StockMovement" RENAME TO "StockMovement";
CREATE UNIQUE INDEX "StockMovement_number_key" ON "StockMovement"("number");
CREATE INDEX "StockMovement_productId_warehouseId_createdAt_idx" ON "StockMovement"("productId", "warehouseId", "createdAt");
CREATE UNIQUE INDEX "StockMovement_receiptId_productId_key" ON "StockMovement"("receiptId", "productId");
CREATE UNIQUE INDEX "StockMovement_shipmentId_productId_key" ON "StockMovement"("shipmentId", "productId");
CREATE UNIQUE INDEX "StockMovement_adjustmentId_productId_key" ON "StockMovement"("adjustmentId", "productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_number_key" ON "SalesOrder"("number");

-- CreateIndex
CREATE INDEX "SalesOrder_status_orderDate_idx" ON "SalesOrder"("status", "orderDate");

-- CreateIndex
CREATE INDEX "SalesOrder_customerId_idx" ON "SalesOrder"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderItem_orderId_productId_key" ON "SalesOrderItem"("orderId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesShipment_number_key" ON "SalesShipment"("number");

-- CreateIndex
CREATE INDEX "SalesShipment_orderId_idx" ON "SalesShipment"("orderId");

-- CreateIndex
CREATE INDEX "SalesShipment_createdAt_idx" ON "SalesShipment"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesShipmentItem_shipmentId_orderItemId_key" ON "SalesShipmentItem"("shipmentId", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Receivable_number_key" ON "Receivable"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Receivable_shipmentId_key" ON "Receivable"("shipmentId");

-- CreateIndex
CREATE INDEX "Receivable_customerId_status_idx" ON "Receivable"("customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRecord_number_key" ON "SettlementRecord"("number");

-- CreateIndex
CREATE INDEX "SettlementRecord_createdAt_idx" ON "SettlementRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockAdjustment_number_key" ON "StockAdjustment"("number");

-- Database invariants complement Service validation; historical records remain protected by foreign keys.
CREATE TRIGGER IF NOT EXISTS "PurchaseOrder_insert_guard" BEFORE INSERT ON "PurchaseOrder" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000 AND NEW.status IN ('DRAFT','PENDING','APPROVED','PARTIAL','RECEIVED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "PurchaseOrder_update_guard" BEFORE UPDATE ON "PurchaseOrder" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000 AND NEW.status IN ('DRAFT','PENDING','APPROVED','PARTIAL','RECEIVED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "PurchaseOrderItem_insert_guard" BEFORE INSERT ON "PurchaseOrderItem" WHEN NOT (NEW.quantity > 0 AND NEW.quantity <= 1000000 AND NEW.receivedQuantity >= 0 AND NEW.receivedQuantity <= NEW.quantity AND NEW.unitPrice >= 0 AND NEW.unitPrice <= 1000000000 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "PurchaseOrderItem_update_guard" BEFORE UPDATE ON "PurchaseOrderItem" WHEN NOT (NEW.quantity > 0 AND NEW.quantity <= 1000000 AND NEW.receivedQuantity >= 0 AND NEW.receivedQuantity <= NEW.quantity AND NEW.unitPrice >= 0 AND NEW.unitPrice <= 1000000000 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "GoodsReceipt_insert_guard" BEFORE INSERT ON "GoodsReceipt" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "GoodsReceipt_update_guard" BEFORE UPDATE ON "GoodsReceipt" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "GoodsReceiptItem_insert_guard" BEFORE INSERT ON "GoodsReceiptItem" WHEN NOT (NEW.quantity > 0 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "GoodsReceiptItem_update_guard" BEFORE UPDATE ON "GoodsReceiptItem" WHEN NOT (NEW.quantity > 0 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "StockBalance_insert_guard" BEFORE INSERT ON "StockBalance" WHEN NOT (NEW.quantity >= 0 AND NEW.quantity <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "StockBalance_update_guard" BEFORE UPDATE ON "StockBalance" WHEN NOT (NEW.quantity >= 0 AND NEW.quantity <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "StockMovement_insert_guard" BEFORE INSERT ON "StockMovement" WHEN NOT (NEW.afterQuantity = NEW.beforeQuantity + NEW.quantity AND NEW.beforeQuantity >= 0 AND NEW.afterQuantity >= 0) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "StockMovement_update_guard" BEFORE UPDATE ON "StockMovement" WHEN NOT (NEW.afterQuantity = NEW.beforeQuantity + NEW.quantity AND NEW.beforeQuantity >= 0 AND NEW.afterQuantity >= 0) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "Payable_insert_guard" BEFORE INSERT ON "Payable" WHEN NOT (NEW.originalAmount >= 0 AND NEW.originalAmount <= 2000000000 AND NEW.paidAmount >= 0 AND NEW.paidAmount <= NEW.originalAmount AND NEW.status IN ('UNSETTLED','PARTIAL','SETTLED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "Payable_update_guard" BEFORE UPDATE ON "Payable" WHEN NOT (NEW.originalAmount >= 0 AND NEW.originalAmount <= 2000000000 AND NEW.paidAmount >= 0 AND NEW.paidAmount <= NEW.originalAmount AND NEW.status IN ('UNSETTLED','PARTIAL','SETTLED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

-- Database invariants complement Service validation; historical records remain protected by foreign keys.
CREATE TRIGGER IF NOT EXISTS "SalesOrder_insert_guard" BEFORE INSERT ON "SalesOrder" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000 AND NEW.status IN ('DRAFT','PENDING','APPROVED','PARTIAL','SHIPPED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "SalesOrder_update_guard" BEFORE UPDATE ON "SalesOrder" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000 AND NEW.status IN ('DRAFT','PENDING','APPROVED','PARTIAL','SHIPPED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "SalesOrderItem_insert_guard" BEFORE INSERT ON "SalesOrderItem" WHEN NOT (NEW.quantity > 0 AND NEW.quantity <= 1000000 AND NEW.shippedQuantity >= 0 AND NEW.shippedQuantity <= NEW.quantity AND NEW.unitPrice >= 0 AND NEW.unitPrice <= 1000000000 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "SalesOrderItem_update_guard" BEFORE UPDATE ON "SalesOrderItem" WHEN NOT (NEW.quantity > 0 AND NEW.quantity <= 1000000 AND NEW.shippedQuantity >= 0 AND NEW.shippedQuantity <= NEW.quantity AND NEW.unitPrice >= 0 AND NEW.unitPrice <= 1000000000 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "SalesShipment_insert_guard" BEFORE INSERT ON "SalesShipment" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "SalesShipment_update_guard" BEFORE UPDATE ON "SalesShipment" WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "SalesShipmentItem_insert_guard" BEFORE INSERT ON "SalesShipmentItem" WHEN NOT (NEW.quantity > 0 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "SalesShipmentItem_update_guard" BEFORE UPDATE ON "SalesShipmentItem" WHEN NOT (NEW.quantity > 0 AND NEW.amount = NEW.quantity * NEW.unitPrice AND NEW.amount <= 2000000000) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER IF NOT EXISTS "Receivable_insert_guard" BEFORE INSERT ON "Receivable" WHEN NOT (NEW.originalAmount >= 0 AND NEW.originalAmount <= 2000000000 AND NEW.receivedAmount >= 0 AND NEW.receivedAmount <= NEW.originalAmount AND NEW.status IN ('UNSETTLED','PARTIAL','SETTLED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "Receivable_update_guard" BEFORE UPDATE ON "Receivable" WHEN NOT (NEW.originalAmount >= 0 AND NEW.originalAmount <= 2000000000 AND NEW.receivedAmount >= 0 AND NEW.receivedAmount <= NEW.originalAmount AND NEW.status IN ('UNSETTLED','PARTIAL','SETTLED')) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "IdempotencyRecord_insert_source_guard" BEFORE INSERT ON "IdempotencyRecord" WHEN NOT (((NEW.receiptId IS NOT NULL) + (NEW.shipmentId IS NOT NULL) + (NEW.settlementId IS NOT NULL) + (NEW.adjustmentId IS NOT NULL)) = 1 AND ((NEW.scope = 'goods-receipt' AND NEW.receiptId IS NOT NULL) OR (NEW.scope = 'sales-shipment' AND NEW.shipmentId IS NOT NULL) OR (NEW.scope IN ('settlement','settlements','settlement-record') AND NEW.settlementId IS NOT NULL) OR (NEW.scope IN ('stock-adjustment','adjustment') AND NEW.adjustmentId IS NOT NULL))) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "IdempotencyRecord_update_source_guard" BEFORE UPDATE ON "IdempotencyRecord" WHEN NOT (((NEW.receiptId IS NOT NULL) + (NEW.shipmentId IS NOT NULL) + (NEW.settlementId IS NOT NULL) + (NEW.adjustmentId IS NOT NULL)) = 1 AND ((NEW.scope = 'goods-receipt' AND NEW.receiptId IS NOT NULL) OR (NEW.scope = 'sales-shipment' AND NEW.shipmentId IS NOT NULL) OR (NEW.scope IN ('settlement','settlements','settlement-record') AND NEW.settlementId IS NOT NULL) OR (NEW.scope IN ('stock-adjustment','adjustment') AND NEW.adjustmentId IS NOT NULL))) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "StockMovement_insert_source_guard" BEFORE INSERT ON "StockMovement" WHEN NOT (((NEW.receiptId IS NOT NULL) + (NEW.shipmentId IS NOT NULL) + (NEW.adjustmentId IS NOT NULL)) = 1 AND ((NEW.type = 'PURCHASE_RECEIPT' AND NEW.receiptId IS NOT NULL AND NEW.quantity > 0) OR (NEW.type = 'SALES_SHIPMENT' AND NEW.shipmentId IS NOT NULL AND NEW.quantity < 0) OR (NEW.type = 'STOCK_ADJUSTMENT' AND NEW.adjustmentId IS NOT NULL AND NEW.quantity != 0))) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "StockMovement_update_source_guard" BEFORE UPDATE ON "StockMovement" WHEN NOT (((NEW.receiptId IS NOT NULL) + (NEW.shipmentId IS NOT NULL) + (NEW.adjustmentId IS NOT NULL)) = 1 AND ((NEW.type = 'PURCHASE_RECEIPT' AND NEW.receiptId IS NOT NULL AND NEW.quantity > 0) OR (NEW.type = 'SALES_SHIPMENT' AND NEW.shipmentId IS NOT NULL AND NEW.quantity < 0) OR (NEW.type = 'STOCK_ADJUSTMENT' AND NEW.adjustmentId IS NOT NULL AND NEW.quantity != 0))) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "SettlementRecord_insert_source_guard" BEFORE INSERT ON "SettlementRecord" WHEN NOT (NEW.amount > 0 AND NEW.amount <= 2000000000 AND ((NEW.type = 'RECEIPT' AND NEW.receivableId IS NOT NULL AND NEW.payableId IS NULL) OR (NEW.type = 'PAYMENT' AND NEW.payableId IS NOT NULL AND NEW.receivableId IS NULL))) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "SettlementRecord_update_source_guard" BEFORE UPDATE ON "SettlementRecord" WHEN NOT (NEW.amount > 0 AND NEW.amount <= 2000000000 AND ((NEW.type = 'RECEIPT' AND NEW.receivableId IS NOT NULL AND NEW.payableId IS NULL) OR (NEW.type = 'PAYMENT' AND NEW.payableId IS NOT NULL AND NEW.receivableId IS NULL))) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "StockAdjustment_insert_source_guard" BEFORE INSERT ON "StockAdjustment" WHEN NOT (NEW.quantity != 0 AND NEW.quantity BETWEEN -2000000000 AND 2000000000 AND length(trim(NEW.reason)) > 0) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;

CREATE TRIGGER "StockAdjustment_update_source_guard" BEFORE UPDATE ON "StockAdjustment" WHEN NOT (NEW.quantity != 0 AND NEW.quantity BETWEEN -2000000000 AND 2000000000 AND length(trim(NEW.reason)) > 0) BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'sales:read') WHERE code = 'SALES' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'sales:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'sales:write') WHERE code = 'SALES' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'sales:write');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'sales:approve') WHERE code = 'SALES' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'sales:approve');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'shipments:read') WHERE code = 'SALES' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'shipments:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'sales:read') WHERE code = 'WAREHOUSE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'sales:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'shipments:read') WHERE code = 'WAREHOUSE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'shipments:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'shipments:post') WHERE code = 'WAREHOUSE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'shipments:post');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'shipments:read') WHERE code = 'FINANCE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'shipments:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'receivables:read') WHERE code = 'FINANCE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'receivables:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'sales:read') WHERE code = 'GUEST' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'sales:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'shipments:read') WHERE code = 'GUEST' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'shipments:read');
