import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
export function salesLines(where: Prisma.SalesShipmentItemWhereInput) {
  return prisma.salesShipmentItem.findMany({
    where,
    include: {
      shipment: {
        include: { warehouse: true, order: { include: { customer: true } } },
      },
    },
    orderBy: [{ shipment: { createdAt: 'desc' } }, { id: 'asc' }],
  });
}
export function purchaseLines(where: Prisma.GoodsReceiptItemWhereInput) {
  return prisma.goodsReceiptItem.findMany({
    where,
    include: {
      receipt: {
        include: { warehouse: true, order: { include: { supplier: true } } },
      },
    },
    orderBy: [{ receipt: { createdAt: 'desc' } }, { id: 'asc' }],
  });
}
export function inventoryBalances(where: Prisma.StockBalanceWhereInput) {
  return prisma.stockBalance.findMany({
    where,
    include: { product: true, warehouse: true },
    orderBy: { id: 'asc' },
  });
}
export function inventoryMovements(where: Prisma.StockMovementWhereInput) {
  return prisma.stockMovement.findMany({ where });
}
export function recentMovements(where: Prisma.StockMovementWhereInput) {
  return prisma.stockMovement.findMany({
    where,
    include: {
      product: { select: { code: true, name: true } },
      warehouse: { select: { name: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 20,
  });
}
export function financeSources(createdAt: Prisma.DateTimeFilter) {
  return prisma.$transaction([
    prisma.receivable.findMany({
      where: { createdAt },
      include: { customer: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payable.findMany({
      where: { createdAt },
      include: { supplier: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
}
export function alertData(q: {
  productId?: string;
  warehouseId?: string;
  q: string;
}) {
  return prisma.$transaction([
    prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        ...(q.productId ? { id: q.productId } : {}),
        ...(q.q
          ? { OR: [{ name: { contains: q.q } }, { code: { contains: q.q } }] }
          : {}),
      },
      select: { id: true, code: true, name: true, minStock: true, unit: true },
    }),
    prisma.warehouse.findMany({
      where: {
        status: 'ACTIVE',
        ...(q.warehouseId ? { id: q.warehouseId } : {}),
      },
      select: { id: true, name: true },
    }),
    prisma.stockBalance.findMany(),
  ]);
}
