import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  salesSchema,
  shipmentSchema,
  salesQuerySchema,
  calculateAmount,
  shippedStatus,
  type SessionUser,
  type ShipmentInput,
} from '@kingflow/shared';
import { prisma } from '../repositories/db.js';
import {
  orderInclude,
  shipmentInclude,
  orders,
  createdRange,
} from '../repositories/sales-repository.js';
import { authorize } from './master-service.js';
import { InventoryService } from './inventory-service.js';
import { AppError } from '../utils/errors.js';
const number = (prefix: string) =>
  `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_:-]{8,128}$/, '需要8–128位有效幂等键');
const actionSchema = z.object({}).strict();
const rejectSchema = z
  .object({ reason: z.string().trim().min(1, '请填写驳回原因').max(500) })
  .strict();
const transactionOptions = { maxWait: 10000, timeout: 15000 };
export async function orderList(input: unknown, user: SessionUser) {
  authorize(user, 'sales:read');
  return orders(salesQuerySchema.parse(input));
}
export async function orderDetail(id: string, user: SessionUser) {
  authorize(user, 'sales:read');
  const row = await prisma.salesOrder.findUnique({
    where: { id },
    include: {
      ...orderInclude,
      shipments: { include: shipmentInclude, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', '销售订单不存在');
  return row;
}
async function activeReferences(
  tx: Prisma.TransactionClient,
  customerId: string,
  warehouseId: string,
  productIds: string[],
) {
  const [customer, warehouse, products] = await Promise.all([
    tx.customer.findUnique({ where: { id: customerId } }),
    tx.warehouse.findUnique({ where: { id: warehouseId } }),
    tx.product.findMany({
      where: { id: { in: productIds } },
      include: { category: true },
    }),
  ]);
  if (!customer || customer.status !== 'ACTIVE')
    throw new AppError(422, 'INVALID_CUSTOMER', '客户不存在或已停用');
  if (!warehouse || warehouse.status !== 'ACTIVE')
    throw new AppError(422, 'INVALID_WAREHOUSE', '仓库不存在或已停用');
  if (
    products.length !== productIds.length ||
    products.some(
      (p) => p.status !== 'ACTIVE' || p.category.status !== 'ACTIVE',
    )
  )
    throw new AppError(422, 'INVALID_PRODUCT', '商品或分类不存在或已停用');
  return products;
}
export async function saveOrder(
  input: unknown,
  user: SessionUser,
  id?: string,
  seedNumber?: string,
) {
  authorize(user, 'sales:write');
  const data = salesSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    if (id) {
      if (data.version === undefined)
        throw new AppError(
          428,
          'VERSION_REQUIRED',
          '编辑必须携带读取时的版本号，请刷新后重试',
        );
      const lock = await tx.salesOrder.updateMany({
        where: { id, status: 'DRAFT', version: data.version },
        data: { version: { increment: 1 } },
      });
      if (!lock.count) {
        if (!(await tx.salesOrder.findUnique({ where: { id } })))
          throw new AppError(404, 'NOT_FOUND', '销售订单不存在');
        const current = await tx.salesOrder.findUniqueOrThrow({
          where: { id },
        });
        if (current.status === 'DRAFT')
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            '订单已被其他用户修改，请关闭编辑并刷新，核对后重新填写',
          );
        throw new AppError(409, 'INVALID_STATE', '只有草稿允许编辑');
      }
    }
    const products = await activeReferences(
      tx,
      data.customerId,
      data.warehouseId,
      data.items.map((item) => item.productId),
    );
    const items = data.items.map((item) => {
      const product = products.find((p) => p.id === item.productId)!;
      return {
        ...item,
        amount: item.quantity * item.unitPrice,
        productCode: product.code,
        productName: product.name,
        specification: product.specification,
        unit: product.unit,
      };
    });
    const header = {
      customerId: data.customerId,
      warehouseId: data.warehouseId,
      orderDate: data.orderDate,
      expectedDate: data.expectedDate ?? null,
      remark: data.remark,
      totalAmount: calculateAmount(data.items),
    };
    if (id) await tx.salesOrderItem.deleteMany({ where: { orderId: id } });
    const order = id
      ? await tx.salesOrder.update({
          where: { id },
          data: { ...header, items: { create: items } },
          include: orderInclude,
        })
      : await tx.salesOrder.create({
          data: {
            ...header,
            number: seedNumber ?? number('SO'),
            createdById: user.id,
            items: { create: items },
          },
          include: orderInclude,
        });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: id ? 'UPDATE' : 'CREATE',
        resource: 'sales-orders',
        resourceId: order.id,
      },
    });
    return order;
  }, transactionOptions);
}
export async function transition(
  id: string,
  action: 'submit' | 'approve' | 'reject',
  input: unknown,
  user: SessionUser,
) {
  authorize(user, action === 'submit' ? 'sales:write' : 'sales:approve');
  const body =
    action === 'reject' ? rejectSchema.parse(input) : actionSchema.parse(input);
  const from = action === 'submit' ? 'DRAFT' : 'PENDING';
  const to =
    action === 'submit'
      ? 'PENDING'
      : action === 'approve'
        ? 'APPROVED'
        : 'DRAFT';
  return prisma.$transaction(async (tx) => {
    const result = await tx.salesOrder.updateMany({
      where: { id, status: from },
      data: { status: to, version: { increment: 1 } },
    });
    if (!result.count) {
      if (!(await tx.salesOrder.findUnique({ where: { id } })))
        throw new AppError(404, 'NOT_FOUND', '销售订单不存在');
      throw new AppError(409, 'INVALID_STATE', '订单当前状态不允许此操作');
    }
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id },
      include: orderInclude,
    });
    if (action !== 'reject')
      await activeReferences(
        tx,
        order.customerId,
        order.warehouseId,
        order.items.map((item) => item.productId),
      );
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: action.toUpperCase(),
        resource: 'sales-orders',
        resourceId: id,
      },
    });
    if ('reason' in body && typeof body.reason === 'string')
      await tx.salesOrder.update({
        where: { id },
        data: { rejectionReason: body.reason },
      });
    return tx.salesOrder.findUniqueOrThrow({
      where: { id },
      include: orderInclude,
    });
  }, transactionOptions);
}
function requestHash(input: ShipmentInput, user: SessionUser) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        userId: user.id,
        ...input,
        items: [...input.items].sort((a, b) =>
          a.orderItemId.localeCompare(b.orderItemId),
        ),
      }),
    )
    .digest('hex');
}
export async function postShipment(
  input: unknown,
  keyInput: unknown,
  user: SessionUser,
) {
  authorize(user, 'shipments:post');
  const data = shipmentSchema.parse(input);
  const key = idempotencyKey.parse(keyInput);
  const hash = requestHash(data, user);
  const replay = async (tx: Prisma.TransactionClient) => {
    const record = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (!record) return null;
    if (
      record.userId !== user.id ||
      record.scope !== 'sales-shipment' ||
      record.requestHash !== hash
    )
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        '幂等键已用于其他请求，请勿改变原请求',
      );
    return tx.salesShipment.findUniqueOrThrow({
      where: { id: record.shipmentId! },
      include: shipmentInclude,
    });
  };
  const previous = await replay(prisma);
  if (previous) return { shipment: previous, replayed: true };
  try {
    return await prisma.$transaction(async (tx) => {
      // First transaction statement acquires SQLite's write lock without changing the order.
      const locked = await tx.salesOrder.updateMany({
        where: { id: data.orderId },
        data: { version: { increment: 0 } },
      });
      if (!locked.count) throw new AppError(404, 'NOT_FOUND', '销售订单不存在');
      const duplicate = await replay(tx);
      if (duplicate) return { shipment: duplicate, replayed: true };
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: data.orderId },
        include: orderInclude,
      });
      if (!['APPROVED', 'PARTIAL'].includes(order.status))
        throw new AppError(
          409,
          'INVALID_STATE',
          '只有已审核或部分出库订单可出库',
        );
      await activeReferences(
        tx,
        order.customerId,
        order.warehouseId,
        order.items.map((item) => item.productId),
      );
      const items = data.items.map((item) => {
        const source = order.items.find((row) => row.id === item.orderItemId);
        if (!source)
          throw new AppError(
            422,
            'FOREIGN_ITEM',
            '出库商品必须属于当前销售订单',
          );
        if (item.quantity > source.quantity - source.shippedQuantity)
          throw new AppError(
            409,
            'EXCESS_SHIPMENT',
            '本次出库数量超过剩余可出库数量',
          );
        return {
          orderItemId: source.id,
          productId: source.productId,
          productCode: source.productCode,
          productName: source.productName,
          specification: source.specification,
          unit: source.unit,
          unitPrice: source.unitPrice,
          quantity: item.quantity,
          amount: item.quantity * source.unitPrice,
        };
      });
      const totalAmount = calculateAmount(items);
      const shipment = await tx.salesShipment.create({
        data: {
          number: number('SS'),
          orderId: order.id,
          warehouseId: order.warehouseId,
          totalAmount,
          remark: data.remark,
          createdById: user.id,
          items: { create: items },
        },
      });
      for (const item of items) {
        const source = order.items.find((row) => row.id === item.orderItemId)!;
        const updated = await tx.salesOrderItem.updateMany({
          where: {
            id: source.id,
            shippedQuantity: { lte: source.quantity - item.quantity },
          },
          data: { shippedQuantity: { increment: item.quantity } },
        });
        if (updated.count !== 1)
          throw new AppError(
            409,
            'EXCESS_SHIPMENT',
            '订单余量已变化，请刷新后重试',
          );
        await InventoryService.ship(tx, {
          productId: item.productId,
          warehouseId: order.warehouseId,
          quantity: item.quantity,
          shipmentId: shipment.id,
          actorId: user.id,
        });
      }
      const currentItems = await tx.salesOrderItem.findMany({
        where: { orderId: order.id },
      });
      await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          status: shippedStatus(currentItems),
          version: { increment: 1 },
        },
      });
      await tx.receivable.create({
        data: {
          number: number('AR'),
          customerId: order.customerId,
          shipmentId: shipment.id,
          originalAmount: totalAmount,
          status: totalAmount === 0 ? 'SETTLED' : 'UNSETTLED',
          createdById: user.id,
        },
      });
      await tx.idempotencyRecord.create({
        data: {
          key,
          scope: 'sales-shipment',
          userId: user.id,
          requestHash: hash,
          shipmentId: shipment.id,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'POST',
          resource: 'sales-shipments',
          resourceId: shipment.id,
        },
      });
      return {
        shipment: await tx.salesShipment.findUniqueOrThrow({
          where: { id: shipment.id },
          include: shipmentInclude,
        }),
        replayed: false,
      };
    }, transactionOptions);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const result = await replay(prisma);
      if (result) return { shipment: result, replayed: true };
    }
    throw error;
  }
}
export async function shipmentDetail(id: string, user: SessionUser) {
  authorize(user, 'shipments:read');
  const row = await prisma.salesShipment.findUnique({
    where: { id },
    include: shipmentInclude,
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', '出库单不存在');
  return row;
}
export async function shipmentList(input: unknown, user: SessionUser) {
  authorize(user, 'shipments:read');
  const q = salesQuerySchema.parse(input);
  const where = {
    ...(q.q
      ? {
          OR: [
            { number: { contains: q.q } },
            { order: { number: { contains: q.q } } },
          ],
        }
      : {}),
    ...(q.orderId ? { orderId: q.orderId } : {}),
    ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
    ...createdRange(q),
  };
  const [items, total] = await prisma.$transaction([
    prisma.salesShipment.findMany({
      where,
      include: shipmentInclude,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      orderBy: { createdAt: q.sortOrder },
    }),
    prisma.salesShipment.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
