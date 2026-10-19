import { it, expect, afterAll, beforeAll } from 'vitest';
import { cleanDatabase } from './helpers.js';
beforeAll(cleanDatabase);
import { seed } from '../prisma/seed.js';
import { prisma } from '../src/repositories/db.js';
afterAll(() => prisma.$disconnect());
it('Seed幂等并保留用户编辑，生产环境拒绝Seed', async () => {
  await seed();
  const counts = await Promise.all([
    prisma.product.count(),
    prisma.productCategory.count(),
    prisma.customer.count(),
    prisma.supplier.count(),
    prisma.warehouse.count(),
    prisma.user.count(),
    prisma.purchaseOrder.count(),
    prisma.goodsReceipt.count(),
    prisma.stockMovement.count(),
    prisma.payable.count(),
    prisma.salesOrder.count(),
    prisma.salesShipment.count(),
    prisma.receivable.count(),
    prisma.settlementRecord.count(),
  ]);
  expect(counts[0]).toBeGreaterThanOrEqual(30);
  expect(counts[1]).toBeGreaterThanOrEqual(5);
  expect(counts[2]).toBeGreaterThanOrEqual(10);
  expect(counts[3]).toBeGreaterThanOrEqual(8);
  expect(counts[4]).toBeGreaterThanOrEqual(2);
  expect(counts[5]).toBeGreaterThanOrEqual(6);
  expect(counts[6]).toBe(15);
  expect(counts[7]).toBe(15);
  expect(counts[8]).toBe(44);
  expect(counts[9]).toBe(15);
  expect(counts[10]).toBe(20);
  expect(counts[11]).toBe(14);
  expect(counts[12]).toBe(14);
  expect(counts[13]).toBe(24);
  await prisma.product.update({
    where: { code: 'KF-0001' },
    data: { name: '保留用户更改' },
  });
  await seed();
  expect(
    await Promise.all([
      prisma.product.count(),
      prisma.productCategory.count(),
      prisma.customer.count(),
      prisma.supplier.count(),
      prisma.warehouse.count(),
      prisma.user.count(),
      prisma.purchaseOrder.count(),
      prisma.goodsReceipt.count(),
      prisma.stockMovement.count(),
      prisma.payable.count(),
    prisma.salesOrder.count(),
    prisma.salesShipment.count(),
    prisma.receivable.count(),
    prisma.settlementRecord.count(),
    ]),
  ).toEqual(counts);
  expect(
    (await prisma.product.findUniqueOrThrow({ where: { code: 'KF-0001' } }))
      .name,
  ).toBe('保留用户更改');
  process.env.NODE_ENV = 'production';
  await expect(seed()).rejects.toThrow('Seed仅允许');
  process.env.NODE_ENV = 'test';
});
