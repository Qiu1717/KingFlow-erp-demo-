import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/repositories/db.js';
import {
  checkIntegrity,
  backupDatabase,
  restoreDatabase,
  restoreDrill,
  databaseFile,
} from '../src/services/recovery-service.js';
import * as master from '../src/services/master-service.js';
import * as purchase from '../src/services/purchase-service.js';
import * as sales from '../src/services/sales-service.js';
import * as finance from '../src/services/finance-service.js';
import { cleanDatabase } from './helpers.js';
import { hash } from 'bcryptjs';

let directory = '';
const clients: PrismaClient[] = [];
const openClient = (path: string) => {
  const client = new PrismaClient({
    datasourceUrl: `file:${path.replaceAll('\\', '/')}`,
  });
  clients.push(client);
  return client;
};

const role = (permissions: string[]) => ({
  id: 'user-1',
  username: 'recovery',
  displayName: '备份演练',
  role: { code: 'ADMIN', name: '管理员', permissions },
});
const user = role(['*']);

/**
 * 用真实 Service 层构造一笔完整业务闭环：采购入库 → 库存 → 应付 → 付款，
 * 销售出库 → 应收 → 收款，确保备份/核对覆盖真实台账而不是空库。
 */
async function buildRealBusinessData() {
  await cleanDatabase();
  const dbRole = await prisma.role.create({
    data: { code: 'ADMIN', name: '管理员', permissions: '["*"]' },
  });
  const created = await prisma.user.create({
    data: {
      username: 'recovery',
      passwordHash: await hash('Recovery@12345', 4),
      displayName: '备份演练',
      roleId: dbRole.id,
    },
  });
  const actor = { ...user, id: created.id };
  const category = await master.save(
    'categories',
    { code: 'RC', name: '演练分类' },
    actor,
  );
  const product = await master.save(
    'products',
    {
      code: 'RP1',
      name: '演练商品',
      categoryId: category.id,
      unit: '件',
      purchasePrice: 10000,
      salesPrice: 20000,
      minStock: 5,
    },
    actor,
  );
  const warehouse = await master.save(
    'warehouses',
    { code: 'RW1', name: '演练仓' },
    actor,
  );
  const supplier = await master.save(
    'suppliers',
    { code: 'RS1', name: '演练供应商' },
    actor,
  );
  const customer = await master.save(
    'customers',
    { code: 'RU1', name: '演练客户' },
    actor,
  );
  const order = await purchase.saveOrder(
    {
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      orderDate: '2026-10-19',
      items: [{ productId: product.id, quantity: 10, unitPrice: 10000 }],
    },
    actor,
  );
  await purchase.transition(order.id, 'submit', {}, actor);
  await purchase.transition(order.id, 'approve', {}, actor);
  const detail = await purchase.orderDetail(order.id, actor);
  const receipt = await purchase.postReceipt(
    {
      orderId: order.id,
      items: [{ orderItemId: detail.items[0].id, quantity: 10 }],
    },
    'recovery-receipt',
    actor,
  );
  const payable = await prisma.payable.findFirstOrThrow({
    where: { receiptId: receipt.receipt.id },
  });
  await finance.settle(
    'PAYMENT',
    {
      sourceId: payable.id,
      amount: 40000,
      date: '2026-10-19',
      method: '银行转账',
    },
    'recovery-payment',
    actor,
  );
  const sale = await sales.saveOrder(
    {
      customerId: customer.id,
      warehouseId: warehouse.id,
      orderDate: '2026-10-19',
      items: [{ productId: product.id, quantity: 4, unitPrice: 20000 }],
    },
    actor,
  );
  await sales.transition(sale.id, 'submit', {}, actor);
  await sales.transition(sale.id, 'approve', {}, actor);
  const saleDetail = await sales.orderDetail(sale.id, actor);
  const shipment = await sales.postShipment(
    {
      orderId: sale.id,
      items: [{ orderItemId: saleDetail.items[0].id, quantity: 4 }],
    },
    'recovery-shipment',
    actor,
  );
  const receivable = await prisma.receivable.findFirstOrThrow({
    where: { shipmentId: shipment.shipment.id },
  });
  await finance.settle(
    'RECEIPT',
    {
      sourceId: receivable.id,
      amount: 30000,
      date: '2026-10-19',
      method: '现金',
    },
    'recovery-receipt-money',
    actor,
  );
  return { product, warehouse, receipt, shipment };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kingflow-recovery-'));
  await buildRealBusinessData();
});
afterAll(async () => {
  for (const client of clients) await client.$disconnect();
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

describe.sequential('备份、恢复与账实一致性核对', () => {
  it('真实业务台账通过全部七项不变量核对', async () => {
    const report = await checkIntegrity();
    expect(report.checks.map((check) => check.name)).toEqual([
      'stock-ledger',
      'movement-chain',
      'document-amounts',
      'fulfilled-quantities',
      'settlement-balances',
      'source-documents',
      'movement-sources',
    ]);
    for (const check of report.checks)
      expect(check.violations, `${check.label} 应无不一致`).toBe(0);
    expect(report.ok).toBe(true);
    // 确认核对对象不是空库。
    expect(await prisma.stockBalance.count()).toBeGreaterThan(0);
    expect(await prisma.stockMovement.count()).toBeGreaterThan(0);
    expect(await prisma.settlementRecord.count()).toBeGreaterThan(0);
  });

  it('备份生成一致性快照，恢复后业务数据逐表一致且清除历史会话', async () => {
    const source = await databaseFile();
    const backup = join(directory, 'backup.db');
    const result = await backupDatabase(backup);
    expect(result.path).toBe(backup);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.path).not.toBe(source);

    const restored = join(directory, 'restored.db');
    const restoration = await restoreDatabase(backup, restored);
    expect(restoration.ok).toBe(true);
    expect(restoration.integrity.ok).toBe(true);

    const db = openClient(restored);
    expect(await db.session.count()).toBe(0);
    const models = [
      'product',
      'productCategory',
      'customer',
      'supplier',
      'warehouse',
      'purchaseOrder',
      'purchaseOrderItem',
      'goodsReceipt',
      'goodsReceiptItem',
      'stockBalance',
      'stockMovement',
      'payable',
      'salesOrder',
      'salesOrderItem',
      'salesShipment',
      'salesShipmentItem',
      'receivable',
      'settlementRecord',
      'auditLog',
    ] as const;
    for (const model of models) {
      const sourceCount = await (
        prisma as unknown as Record<string, { count: () => Promise<number> }>
      )[model].count();
      const restoredCount = await (
        db as unknown as Record<string, { count: () => Promise<number> }>
      )[model].count();
      expect(restoredCount, `恢复后${model}条数应与源库一致`).toBe(sourceCount);
      expect(sourceCount, `${model}不应为空，否则核对无意义`).toBeGreaterThan(
        0,
      );
    }
    expect((await checkIntegrity(db)).ok).toBe(true);
  }, 60000);

  it('拒绝覆盖已存在的备份或恢复目标，拒绝与源库同路径', async () => {
    const backup = join(directory, 'backup.db');
    const restored = join(directory, 'restored.db');
    await expect(backupDatabase(backup)).rejects.toThrow(/已存在/);
    await expect(restoreDatabase(backup, restored)).rejects.toThrow(/已存在/);
    await expect(restoreDatabase(backup, backup)).rejects.toThrow(/相同/);
    await expect(
      restoreDatabase(join(directory, 'missing.db'), join(directory, 'x.db')),
    ).rejects.toThrow(/不存在/);
    await expect(backupDatabase(await databaseFile())).rejects.toThrow(/相同/);
  }, 60000);

  it('核对能精确定位被篡改的库存余额，篡改库不能作为恢复源', async () => {
    const restored = join(directory, 'restored.db');
    const db = openClient(restored);
    const balance = await db.stockBalance.findFirstOrThrow();
    await db.stockBalance.update({
      where: { id: balance.id },
      data: { quantity: { increment: 1 } },
    });
    const corrupted = await checkIntegrity(db);
    expect(corrupted.ok).toBe(false);
    const ledger = corrupted.checks.find(
      (check) => check.name === 'stock-ledger',
    );
    expect(ledger?.violations).toBeGreaterThan(0);
    expect(ledger?.sample).toBeTruthy();
    // 其它不变量不受影响，证明定位精准而非全表报错。
    expect(
      corrupted.checks.find((check) => check.name === 'movement-chain')
        ?.violations,
    ).toBe(0);
    const corruptedBackup = join(directory, 'corrupted.db');
    await db.$executeRawUnsafe(
      `VACUUM INTO '${corruptedBackup.replaceAll("'", "''")}'`,
    );
    await expect(
      restoreDatabase(corruptedBackup, join(directory, 'from-corrupted.db')),
    ).rejects.toThrow(/账实核对未通过/);
  }, 60000);

  it('恢复演练生成独立备份与恢复库，双库核对一致且不改动生产库', async () => {
    const drillDirectory = join(directory, 'drill');
    const before = await prisma.product.count();
    const drill = await restoreDrill(drillDirectory, 'test-drill');
    expect(drill.before.ok).toBe(true);
    expect(drill.after.ok).toBe(true);
    expect(drill.backup.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await prisma.product.count()).toBe(before);
    const files = await readdir(drillDirectory);
    expect(files).toHaveLength(2);
    expect(files.some((name) => name.startsWith('kingflow-'))).toBe(true);
    expect(files.some((name) => name.startsWith('kingflow-restored-'))).toBe(
      true,
    );
  }, 60000);

  it('备份快照中的用户密码仍为哈希，不含可复用明文', async () => {
    const db = openClient(join(directory, 'restored.db'));
    const users = await db.user.findMany({
      select: { username: true, passwordHash: true },
    });
    expect(users.length).toBeGreaterThan(0);
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
      expect(user.passwordHash).not.toContain('Recovery@12345');
    }
  }, 30000);
});
