-- Prisma table redefinition drops table triggers; restore without rewriting applied migrations.
CREATE TRIGGER IF NOT EXISTS "PurchaseOrder_insert_guard" BEFORE INSERT ON "PurchaseOrder"
WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000 AND NEW.status IN ('DRAFT','PENDING','APPROVED','PARTIAL','RECEIVED'))
BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
CREATE TRIGGER IF NOT EXISTS "PurchaseOrder_update_guard" BEFORE UPDATE ON "PurchaseOrder"
WHEN NOT (NEW.totalAmount >= 0 AND NEW.totalAmount <= 2000000000 AND NEW.status IN ('DRAFT','PENDING','APPROVED','PARTIAL','RECEIVED'))
BEGIN SELECT RAISE(ABORT, 'BUSINESS_CONSTRAINT'); END;
