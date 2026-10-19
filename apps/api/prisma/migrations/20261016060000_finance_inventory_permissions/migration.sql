UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'finance:read') WHERE code = 'FINANCE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'finance:read');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'settlements:write') WHERE code = 'FINANCE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'settlements:write');
UPDATE "Role" SET permissions = json_insert(permissions, '$[#]', 'inventory:adjust') WHERE code = 'WAREHOUSE' AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'inventory:adjust');
CREATE INDEX "SettlementRecord_date_type_idx" ON "SettlementRecord"("date", "type");
CREATE INDEX "SettlementRecord_receivableId_idx" ON "SettlementRecord"("receivableId");
CREATE INDEX "SettlementRecord_payableId_idx" ON "SettlementRecord"("payableId");
CREATE INDEX "StockAdjustment_createdAt_idx" ON "StockAdjustment"("createdAt");
