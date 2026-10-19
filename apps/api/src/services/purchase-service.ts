import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  purchaseSchema,
  receiptSchema,
  documentQuerySchema,
  calculateAmount,
  receivedStatus,
  type SessionUser,
  type ReceiptInput,
} from '@kingflow/shared';
import { prisma } from '../repositories/db.js';
import {
  orderInclude,
  receiptInclude,
  orders,
  createdRange,
} from '../repositories/purchase-repository.js';
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
  authorize(user, 'purchase:read');
  return orders(documentQuerySchema.parse(input));
}
export async function orderDetail(id: string, user: SessionUser) {
  authorize(user, 'purchase:read');
  const row = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      ...orderInclude,
      receipts: { include: receiptInclude, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', '采购订单不存在');
  return row;
}
async function activeReferences(
  tx: Prisma.TransactionClient,
  supplierId: string,
  warehouseId: string,
  productIds: string[],
) {
  const [supplier, warehouse, products] = await Promise.all([
    tx.supplier.findUnique({ where: { id: supplierId } }),
    tx.warehouse.findUnique({ where: { id: warehouseId } }),
    tx.product.findMany({
      where: { id: { in: productIds } },
      include: { category: true },
    }),
  ]);
  if (!supplier || supplier.status !== 'ACTIVE')
    throw new AppError(422, 'INVALID_SUPPLIER', '供应商不存在或已停用');
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
  authorize(user, 'purchase:write');
  const data = purchaseSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    if (id) {
      if (data.version === undefined)
        throw new AppError(
          428,
          'VERSION_REQUIRED',
          '编辑必须携带读取时的版本号，请刷新后重试',
        );
      const lock = await tx.purchaseOrder.updateMany({
        where: { id, status: 'DRAFT', version: data.version },
        data: { version: { increment: 1 } },
      });
      if (!lock.count) {
        if (!(await tx.purchaseOrder.findUnique({ where: { id } })))
          throw new AppError(404, 'NOT_FOUND', '采购订单不存在');
        const current = await tx.purchaseOrder.findUniqueOrThrow({
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
      data.supplierId,
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
      supplierId: data.supplierId,
      warehouseId: data.warehouseId,
      orderDate: data.orderDate,
      expectedDate: data.expectedDate ?? null,
      remark: data.remark,
      totalAmount: calculateAmount(data.items),
    };
    if (id) await tx.purchaseOrderItem.deleteMany({ where: { orderId: id } });
    const order = id
      ? await tx.purchaseOrder.update({
          where: { id },
          data: { ...header, items: { create: items } },
          include: orderInclude,
        })
      : await tx.purchaseOrder.create({
          data: {
            ...header,
            number: seedNumber ?? number('PO'),
            createdById: user.id,
            items: { create: items },
          },
          include: orderInclude,
        });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: id ? 'UPDATE' : 'CREATE',
        resource: 'purchase-orders',
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
  authorize(user, action === 'submit' ? 'purchase:write' : 'purchase:approve');
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
    const result = await tx.purchaseOrder.updateMany({
      where: { id, status: from },
      data: { status: to, version: { increment: 1 } },
    });
    if (!result.count) {
      if (!(await tx.purchaseOrder.findUnique({ where: { id } })))
        throw new AppError(404, 'NOT_FOUND', '采购订单不存在');
      throw new AppError(409, 'INVALID_STATE', '订单当前状态不允许此操作');
    }
    const order = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: orderInclude,
    });
    if (action !== 'reject')
      await activeReferences(
        tx,
        order.supplierId,
        order.warehouseId,
        order.items.map((item) => item.productId),
      );
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: action.toUpperCase(),
        resource: 'purchase-orders',
        resourceId: id,
      },
    });
    if ('reason' in body && typeof body.reason === 'string')
      await tx.purchaseOrder.update({
        where: { id },
        data: { rejectionReason: body.reason },
      });
    return tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: orderInclude,
    });
  }, transactionOptions);
}
function requestHash(input: ReceiptInput, user: SessionUser) {
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
export async function postReceipt(
  input: unknown,
  keyInput: unknown,
  user: SessionUser,
) {
  authorize(user, 'receipts:post');
  const data = receiptSchema.parse(input);
  const key = idempotencyKey.parse(keyInput);
  const hash = requestHash(data, user);
  const replay = async (tx: Prisma.TransactionClient) => {
    const record = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (!record) return null;
    if (
      record.userId !== user.id ||
      record.scope !== 'goods-receipt' ||
      record.requestHash !== hash
    )
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        '幂等键已用于其他请求，请勿改变原请求',
      );
    return tx.goodsReceipt.findUniqueOrThrow({
      where: { id: record.receiptId! },
      include: receiptInclude,
    });
  };
  const previous = await replay(prisma);
  if (previous) return { receipt: previous, replayed: true };
  try {
    return await prisma.$transaction(async (tx) => {
      // First transaction statement acquires SQLite's write lock without changing the order.
      const locked = await tx.purchaseOrder.updateMany({
        where: { id: data.orderId },
        data: { version: { increment: 0 } },
      });
      if (!locked.count) throw new AppError(404, 'NOT_FOUND', '采购订单不存在');
      const duplicate = await replay(tx);
      if (duplicate) return { receipt: duplicate, replayed: true };
      const order = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: data.orderId },
        include: orderInclude,
      });
      if (!['APPROVED', 'PARTIAL'].includes(order.status))
        throw new AppError(
          409,
          'INVALID_STATE',
          '只有已审核或部分入库订单可入库',
        );
      await activeReferences(
        tx,
        order.supplierId,
        order.warehouseId,
        order.items.map((item) => item.productId),
      );
      const items = data.items.map((item) => {
        const source = order.items.find((row) => row.id === item.orderItemId);
        if (!source)
          throw new AppError(
            422,
            'FOREIGN_ITEM',
            '入库商品必须属于当前采购订单',
          );
        if (item.quantity > source.quantity - source.receivedQuantity)
          throw new AppError(
            409,
            'EXCESS_RECEIPT',
            '本次入库数量超过剩余可入库数量',
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
      const receipt = await tx.goodsReceipt.create({
        data: {
          number: number('GR'),
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
        const updated = await tx.purchaseOrderItem.updateMany({
          where: {
            id: source.id,
            receivedQuantity: { lte: source.quantity - item.quantity },
          },
          data: { receivedQuantity: { increment: item.quantity } },
        });
        if (updated.count !== 1)
          throw new AppError(
            409,
            'EXCESS_RECEIPT',
            '订单余量已变化，请刷新后重试',
          );
        await InventoryService.receive(tx, {
          productId: item.productId,
          warehouseId: order.warehouseId,
          quantity: item.quantity,
          receiptId: receipt.id,
          actorId: user.id,
        });
      }
      const currentItems = await tx.purchaseOrderItem.findMany({
        where: { orderId: order.id },
      });
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: {
          status: receivedStatus(currentItems),
          version: { increment: 1 },
        },
      });
      await tx.payable.create({
        data: {
          number: number('AP'),
          supplierId: order.supplierId,
          receiptId: receipt.id,
          originalAmount: totalAmount,
          status: totalAmount === 0 ? 'SETTLED' : 'UNSETTLED',
          createdById: user.id,
        },
      });
      await tx.idempotencyRecord.create({
        data: {
          key,
          scope: 'goods-receipt',
          userId: user.id,
          requestHash: hash,
          receiptId: receipt.id,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'POST',
          resource: 'goods-receipts',
          resourceId: receipt.id,
        },
      });
      return {
        receipt: await tx.goodsReceipt.findUniqueOrThrow({
          where: { id: receipt.id },
          include: receiptInclude,
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
      if (result) return { receipt: result, replayed: true };
    }
    throw error;
  }
}
export async function receiptDetail(id: string, user: SessionUser) {
  authorize(user, 'receipts:read');
  const row = await prisma.goodsReceipt.findUnique({
    where: { id },
    include: receiptInclude,
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', '入库单不存在');
  return row;
}
export async function receiptList(input: unknown, user: SessionUser) {
  authorize(user, 'receipts:read');
  const q = documentQuerySchema.parse(input);
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
    prisma.goodsReceipt.findMany({
      where,
      include: receiptInclude,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      orderBy: { createdAt: q.sortOrder },
    }),
    prisma.goodsReceipt.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function stocks(input: unknown, user: SessionUser) {
  authorize(user, 'inventory:read');
  const q = documentQuerySchema.parse(input);
  const where = {
    ...(q.productId ? { productId: q.productId } : {}),
    ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
    ...(q.q
      ? {
          product: {
            OR: [{ code: { contains: q.q } }, { name: { contains: q.q } }],
          },
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.stockBalance.findMany({
      where,
      include: {
        product: {
          select: { code: true, name: true, unit: true, minStock: true },
        },
        warehouse: { select: { name: true } },
      },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      orderBy: { updatedAt: q.sortOrder },
    }),
    prisma.stockBalance.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function movements(input: unknown, user: SessionUser) {
  authorize(user, 'inventory:read');
  const q = documentQuerySchema.parse(input);
  const where = {
    ...(q.productId ? { productId: q.productId } : {}),
    ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
    ...(q.receiptId ? { receiptId: q.receiptId } : {}),
    ...(q.shipmentId ? { shipmentId: q.shipmentId } : {}),
    ...(q.adjustmentId ? { adjustmentId: q.adjustmentId } : {}),
    ...(q.q
      ? {
          OR: [
            { number: { contains: q.q } },
            { product: { name: { contains: q.q } } },
            { receipt: { number: { contains: q.q } } },
            { shipment: { number: { contains: q.q } } },
            { adjustment: { number: { contains: q.q } } },
          ],
        }
      : {}),
    ...createdRange(q),
  };
  const [items, total] = await prisma.$transaction([
    prisma.stockMovement.findMany({
      where,
      include: {
        product: { select: { code: true, name: true } },
        warehouse: { select: { name: true } },
        receipt: { select: { id: true, number: true } },
        shipment: { select: { id: true, number: true } },
        adjustment: { select: { id: true, number: true } },
        createdBy: { select: { displayName: true } },
      },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      orderBy: { createdAt: q.sortOrder },
    }),
    prisma.stockMovement.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function payables(input: unknown, user: SessionUser) {
  authorize(user, 'payables:read');
  const q = documentQuerySchema.parse(input);
  const where = {
    ...(q.supplierId ? { supplierId: q.supplierId } : {}),
    ...(q.receiptId ? { receiptId: q.receiptId } : {}),
    ...(q.q
      ? {
          OR: [
            { number: { contains: q.q } },
            { supplier: { name: { contains: q.q } } },
            { receipt: { number: { contains: q.q } } },
          ],
        }
      : {}),
    ...createdRange(q),
  };
  const [items, total] = await prisma.$transaction([
    prisma.payable.findMany({
      where,
      include: {
        supplier: { select: { name: true } },
        receipt: { select: { id: true, number: true, orderId: true } },
      },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      orderBy: { createdAt: q.sortOrder },
    }),
    prisma.payable.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
