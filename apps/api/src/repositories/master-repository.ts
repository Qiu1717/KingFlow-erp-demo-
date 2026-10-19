import type { Prisma } from '@prisma/client';
import type { Resource, ListQuery } from '@kingflow/shared';
import { prisma } from './db.js';
export interface Entity {
  id: string;
  code: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  categoryId?: string;
  category?: { name: string };
  specification?: string;
  unit?: string;
  purchasePrice?: number;
  salesPrice?: number;
  minStock?: number;
}
interface Delegate {
  findMany(args: object): Promise<Entity[]>;
  count(args?: object): Promise<number>;
  findUnique(args: object): Promise<Entity | null>;
  create(args: object): Promise<Entity>;
  update(args: object): Promise<Entity>;
  updateMany(args: object): Promise<{ count: number }>;
  delete(args: object): Promise<Entity>;
}
// Prisma's generated generic delegates have incompatible call signatures across models.
// This narrow adapter is internal; schemas strictly validate all write keys before access.
export function model(
  resource: Resource,
  db: Prisma.TransactionClient = prisma,
): Delegate {
  const models = {
    products: db.product,
    categories: db.productCategory,
    customers: db.customer,
    suppliers: db.supplier,
    warehouses: db.warehouse,
  };
  return models[resource] as unknown as Delegate;
}
export function whereFor(resource: Resource, query: ListQuery) {
  return {
    ...(query.q
      ? {
          OR: [
            { code: { contains: query.q } },
            { name: { contains: query.q } },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(resource === 'products' && query.categoryId
      ? { categoryId: query.categoryId }
      : {}),
  };
}
export const includeFor = (resource: Resource) =>
  resource === 'products'
    ? { category: { select: { id: true, name: true } } }
    : undefined;
export async function list(
  resource: Resource,
  query: ListQuery,
  exportAll = false,
) {
  const where = whereFor(resource, query);
  const [items, total] = await prisma.$transaction(async (tx) =>
    Promise.all([
      model(resource, tx).findMany({
        where,
        include: includeFor(resource),
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: exportAll ? 0 : (query.page - 1) * query.pageSize,
        take: exportAll ? 10000 : query.pageSize,
      }),
      model(resource, tx).count({ where }),
    ]),
  );
  return { items, total, page: query.page, pageSize: query.pageSize };
}
