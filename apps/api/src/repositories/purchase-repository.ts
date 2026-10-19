import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import type { DocumentQuery } from '@kingflow/shared';
export const orderInclude = {
  supplier: { select: { id: true, name: true, status: true } },
  warehouse: { select: { id: true, name: true, status: true } },
  createdBy: { select: { displayName: true } },
  items: { orderBy: { id: 'asc' as const } },
} satisfies Prisma.PurchaseOrderInclude;
export const receiptInclude = {
  items: true,
  warehouse: { select: { name: true } },
  createdBy: { select: { displayName: true } },
  order: { select: { number: true, supplier: { select: { name: true } } } },
} satisfies Prisma.GoodsReceiptInclude;
export function orderWhere(
  query: DocumentQuery,
): Prisma.PurchaseOrderWhereInput {
  return {
    ...(query.q
      ? {
          OR: [
            { number: { contains: query.q } },
            { supplier: { name: { contains: query.q } } },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    ...(query.dateFrom || query.dateTo
      ? { orderDate: { gte: query.dateFrom, lte: query.dateTo } }
      : {}),
  };
}
export function createdRange(query: { dateFrom?: string; dateTo?: string }) {
  return query.dateFrom || query.dateTo
    ? {
        createdAt: {
          ...(query.dateFrom
            ? { gte: new Date(query.dateFrom + 'T00:00:00+08:00') }
            : {}),
          ...(query.dateTo
            ? {
                lt: new Date(
                  new Date(query.dateTo + 'T00:00:00+08:00').getTime() +
                    86400000,
                ),
              }
            : {}),
        },
      }
    : {};
}
export async function orders(query: DocumentQuery) {
  const where = orderWhere(query);
  const [items, total] = await prisma.$transaction([
    prisma.purchaseOrder.findMany({
      where,
      include: orderInclude,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}
