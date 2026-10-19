import { it, expect, afterAll } from 'vitest';
import { prisma } from '../src/repositories/db.js';
afterAll(() => prisma.$disconnect());
import {
  calculateAmount,
  receivedStatus,
  remainingQuantity,
  purchaseSchema,
  dateOnly,
} from '@kingflow/shared';
it('整数分金额与总额溢出保护', () => {
  expect(
    calculateAmount([
      { quantity: 10, unitPrice: 8000 },
      { quantity: 3, unitPrice: 101 },
    ]),
  ).toBe(80303);
  expect(() =>
    calculateAmount([{ quantity: 1000000, unitPrice: 1000000000 }]),
  ).toThrow();
});
it('入库状态及剩余数量按各行实际累计推导', () => {
  expect(receivedStatus([{ quantity: 10, receivedQuantity: 0 }])).toBe(
    'APPROVED',
  );
  expect(receivedStatus([{ quantity: 10, receivedQuantity: 6 }])).toBe(
    'PARTIAL',
  );
  expect(receivedStatus([{ quantity: 10, receivedQuantity: 10 }])).toBe(
    'RECEIVED',
  );
  expect(remainingQuantity({ quantity: 10, receivedQuantity: 6 })).toBe(4);
});
it('真实日期及价格分值校验', () => {
  expect(dateOnly.safeParse('2026-02-30').success).toBe(false);
  expect(dateOnly.safeParse('2024-02-29').success).toBe(true);
  expect(
    purchaseSchema.safeParse({
      supplierId: 's',
      warehouseId: 'w',
      orderDate: '2026-10-16',
      items: [{ productId: 'p', quantity: 1, unitPrice: 0.1 }],
    }).success,
  ).toBe(false);
});
it('所有迁移后数据库仍保留14个金额数量状态保护触发器', async () => {
  const triggers = await prisma.$queryRaw<
    { name: string }[]
  >`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_guard'`;
  expect(triggers.length).toBeGreaterThanOrEqual(14);
  for (const model of [
    'PurchaseOrder',
    'PurchaseOrderItem',
    'GoodsReceipt',
    'GoodsReceiptItem',
    'StockBalance',
    'StockMovement',
    'Payable',
  ])
    for (const action of ['insert', 'update'])
      expect(triggers.map((row) => row.name)).toContain(
        `${model}_${action}_guard`,
      );
  expect(triggers.map((row) => row.name)).toContain(
    'PurchaseOrder_insert_guard',
  );
  expect(triggers.map((row) => row.name)).toContain(
    'PurchaseOrder_update_guard',
  );
});
