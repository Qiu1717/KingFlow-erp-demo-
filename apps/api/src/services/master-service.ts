import {
  can,
  schemas,
  listSchema,
  type Resource,
  type SessionUser,
} from '@kingflow/shared';
import { prisma } from '../repositories/db.js';
import * as repository from '../repositories/master-repository.js';
import { AppError } from '../utils/errors.js';
import { csv } from '../utils/csv.js';
import { z } from 'zod';
export function authorize(user: SessionUser, permission: string) {
  if (!can(user.role.permissions, permission))
    throw new AppError(403, 'FORBIDDEN', '当前角色没有执行此操作的权限');
}
export async function list(
  resource: Resource,
  input: unknown,
  user: SessionUser,
) {
  authorize(user, 'master:read');
  return repository.list(resource, listSchema.parse(input));
}
export async function detail(
  resource: Resource,
  id: string,
  user: SessionUser,
) {
  authorize(user, 'master:read');
  const row = await repository
    .model(resource)
    .findUnique({ where: { id }, include: repository.includeFor(resource) });
  if (!row) throw new AppError(404, 'NOT_FOUND', '资料不存在或已删除');
  return row;
}
export async function save(
  resource: Resource,
  input: unknown,
  user: SessionUser,
  id?: string,
  ifMatch?: string,
) {
  authorize(user, `${resource}:write`);
  const data = (
    id
      ? schemas[resource]
          .partial()
          .refine(
            (value) => Object.keys(value).length > 0,
            '至少填写一个修改字段',
          )
      : schemas[resource]
  ).parse(input);
  return prisma.$transaction(async (tx) => {
    const table = repository.model(resource, tx);
    if (id) {
      if (!ifMatch) {
        if (!(await table.findUnique({ where: { id } })))
          throw new AppError(404, 'NOT_FOUND', '资料不存在或已删除');
        throw new AppError(
          428,
          'VERSION_REQUIRED',
          '编辑必须携带资料版本，请刷新后重试',
        );
      }
      const expected = new Date(
        z.string().datetime().parse(ifMatch.replace(/^"|"$/g, '')),
      );
      const changed = await table.updateMany({
        where: { id, updatedAt: expected },
        data: {
          updatedAt: new Date(Math.max(Date.now(), expected.getTime() + 1)),
        },
      });
      if (!changed.count) {
        if (!(await table.findUnique({ where: { id } })))
          throw new AppError(404, 'NOT_FOUND', '资料不存在或已删除');
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          '资料已被其他用户修改，请刷新核对后重新编辑',
        );
      }
    }
    const existing = id ? await table.findUnique({ where: { id } }) : null;
    if (id && !existing)
      throw new AppError(404, 'NOT_FOUND', '资料不存在或已删除');
    if (
      resource === 'products' &&
      'categoryId' in data &&
      typeof data.categoryId === 'string'
    ) {
      const category = await tx.productCategory.findUnique({
        where: { id: data.categoryId },
      });
      if (
        !category ||
        (category.status !== 'ACTIVE' && existing?.categoryId !== category.id)
      )
        throw new AppError(
          422,
          'INVALID_CATEGORY',
          '请选择有效且启用的商品分类',
        );
    }
    const row = id
      ? await table.update({
          where: { id },
          data: { ...data, updatedAt: existing!.updatedAt },
        })
      : await table.create({ data: { ...data, createdById: user.id } });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: id ? 'UPDATE' : 'CREATE',
        resource,
        resourceId: row.id,
      },
    });
    return row;
  });
}
export async function remove(
  resource: Resource,
  id: string,
  user: SessionUser,
) {
  authorize(user, `${resource}:write`);
  return prisma.$transaction(async (tx) => {
    if (!(await repository.model(resource, tx).findUnique({ where: { id } })))
      throw new AppError(404, 'NOT_FOUND', '资料不存在或已删除');
    if (
      resource === 'categories' &&
      (await tx.product.count({ where: { categoryId: id } }))
    )
      throw new AppError(409, 'REFERENCED', '分类已被商品引用，请停用而非删除');
    // Phase 3+ migrations must add Restrict business foreign keys before order creation is enabled.
    await repository.model(resource, tx).delete({ where: { id } });
    await tx.auditLog.create({
      data: { actorId: user.id, action: 'DELETE', resource, resourceId: id },
    });
    return { id };
  });
}
export async function exportProducts(input: unknown, user: SessionUser) {
  authorize(user, 'master:read');
  const result = await repository.list(
    'products',
    listSchema.parse(input),
    true,
  );
  if (result.total > 10000)
    throw new AppError(422, 'EXPORT_LIMIT', '导出最多10000条，请缩小筛选范围');
  return csv([
    [
      '商品编码',
      '商品名称',
      '分类',
      '规格',
      '单位',
      '采购价（元）',
      '销售价（元）',
      '预警数量',
      '状态',
    ],
    ...result.items.map((row) => [
      row.code,
      row.name,
      row.category?.name,
      row.specification,
      row.unit,
      ((row.purchasePrice ?? 0) / 100).toFixed(2),
      ((row.salesPrice ?? 0) / 100).toFixed(2),
      row.minStock,
      row.status === 'ACTIVE' ? '启用' : '停用',
    ]),
  ]);
}
export async function summary(user: SessionUser) {
  authorize(user, 'master:read');
  const [
    products,
    categories,
    customers,
    suppliers,
    warehouses,
    activeProducts,
    recentLogs,
  ] = await prisma.$transaction([
    prisma.product.count(),
    prisma.productCategory.count(),
    prisma.customer.count(),
    prisma.supplier.count(),
    prisma.warehouse.count(),
    prisma.product.count({ where: { status: 'ACTIVE' } }),
    prisma.auditLog.findMany({
      where: can(user.role.permissions, '*') ? {} : { actorId: user.id },
      take: 6,
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { displayName: true } } },
    }),
  ]);
  return {
    products,
    categories,
    customers,
    suppliers,
    warehouses,
    activeProducts,
    recentLogs,
  };
}
