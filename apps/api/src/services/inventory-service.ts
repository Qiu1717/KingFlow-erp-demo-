import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
export class InventoryService {
  static async adjust(
    tx: Prisma.TransactionClient,
    input: {
      productId: string;
      warehouseId: string;
      quantity: number;
      adjustmentId: string;
      actorId: string;
    },
  ) {
    const { productId, warehouseId, quantity, adjustmentId, actorId } = input;
    if (
      !Number.isInteger(quantity) ||
      quantity === 0 ||
      Math.abs(quantity) > 2_000_000_000
    )
      throw new AppError(422, 'INVALID_QUANTITY', '调整数量必须为非零整数');
    const balance = await tx.stockBalance.upsert({
      where: { productId_warehouseId: { productId, warehouseId } },
      create: { productId, warehouseId, quantity: 0 },
      update: {},
    });
    const changed = await tx.stockBalance.updateMany({
      where: {
        id: balance.id,
        quantity: {
          gte: Math.max(0, -quantity),
          lte: Math.min(2_000_000_000, 2_000_000_000 - quantity),
        },
      },
      data: { quantity: { increment: quantity } },
    });
    if (changed.count !== 1)
      throw new AppError(
        409,
        quantity < 0 ? 'INSUFFICIENT_STOCK' : 'STOCK_OVERFLOW',
        quantity < 0 ? '库存不足，不能调整为负库存' : '库存超出允许范围',
      );
    await tx.stockMovement.create({
      data: {
        number: `SM-${randomUUID()}`,
        productId,
        warehouseId,
        type: 'STOCK_ADJUSTMENT',
        quantity,
        beforeQuantity: balance.quantity,
        afterQuantity: balance.quantity + quantity,
        adjustmentId,
        createdById: actorId,
      },
    });
  }
  static async receive(
    tx: Prisma.TransactionClient,
    input: {
      productId: string;
      warehouseId: string;
      quantity: number;
      receiptId: string;
      actorId: string;
      createdAt?: Date;
    },
  ) {
    const { productId, warehouseId, quantity, receiptId, actorId, createdAt } =
      input;
    if (!Number.isInteger(quantity) || quantity <= 0)
      throw new AppError(422, 'INVALID_QUANTITY', '入库数量必须为正整数');
    const balance = await tx.stockBalance.upsert({
      where: { productId_warehouseId: { productId, warehouseId } },
      create: { productId, warehouseId, quantity: 0 },
      update: {},
    });
    const changed = await tx.stockBalance.updateMany({
      where: { id: balance.id, quantity: { lte: 2_000_000_000 - quantity } },
      data: { quantity: { increment: quantity } },
    });
    if (changed.count !== 1)
      throw new AppError(409, 'STOCK_OVERFLOW', '库存数量超出允许范围');
    await tx.stockMovement.create({
      data: {
        number: `SM-${randomUUID()}`,
        productId,
        warehouseId,
        type: 'PURCHASE_RECEIPT',
        quantity,
        beforeQuantity: balance.quantity,
        afterQuantity: balance.quantity + quantity,
        receiptId,
        createdById: actorId,
        createdAt,
      },
    });
  }
  static async ship(
    tx: Prisma.TransactionClient,
    input: {
      productId: string;
      warehouseId: string;
      quantity: number;
      shipmentId: string;
      actorId: string;
      createdAt?: Date;
    },
  ) {
    const { productId, warehouseId, quantity, shipmentId, actorId, createdAt } =
      input;
    if (!Number.isInteger(quantity) || quantity <= 0)
      throw new AppError(422, 'INVALID_QUANTITY', '出库数量必须为正整数');
    const balance = await tx.stockBalance.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
    if (!balance)
      throw new AppError(409, 'INSUFFICIENT_STOCK', '仓库可用库存不足');
    const changed = await tx.stockBalance.updateMany({
      where: { id: balance.id, quantity: { gte: quantity } },
      data: { quantity: { decrement: quantity } },
    });
    if (changed.count !== 1)
      throw new AppError(409, 'INSUFFICIENT_STOCK', '仓库可用库存不足');
    await tx.stockMovement.create({
      data: {
        number: `SM-${randomUUID()}`,
        productId,
        warehouseId,
        type: 'SALES_SHIPMENT',
        quantity: -quantity,
        beforeQuantity: balance.quantity,
        afterQuantity: balance.quantity - quantity,
        shipmentId,
        createdById: actorId,
        createdAt,
      },
    });
  }
}
