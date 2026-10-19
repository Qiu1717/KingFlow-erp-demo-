export { createdRange } from './purchase-repository.js';
import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import type { SalesQuery } from '@kingflow/shared';
export const orderInclude = {
  customer: { select: { id: true, name: true, status: true } },
  warehouse: { select: { id: true, name: true, status: true } },
  createdBy: { select: { displayName: true } },
  items: { orderBy: { id: 'asc' as const } },
} satisfies Prisma.SalesOrderInclude;
export const shipmentInclude = {
  items: true,
  warehouse: { select: { name: true } },
  createdBy: { select: { displayName: true } },
  order: { select: { number: true, customer: { select: { name: true } } } },
} satisfies Prisma.SalesShipmentInclude;
export function orderWhere(query: SalesQuery): Prisma.SalesOrderWhereInput {
  return {
    ...(query.q
      ? {
          OR: [
            { number: { contains: query.q } },
            { customer: { name: { contains: query.q } } },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    ...(query.dateFrom || query.dateTo
      ? { orderDate: { gte: query.dateFrom, lte: query.dateTo } }
      : {}),
  };
}
export async function orders(query: SalesQuery) {
  const where = orderWhere(query);
  const [items, total] = await prisma.$transaction([
    prisma.salesOrder.findMany({
      where,
      include: orderInclude,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
    }),
    prisma.salesOrder.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}
