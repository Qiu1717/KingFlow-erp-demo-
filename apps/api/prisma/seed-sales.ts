import { prisma } from '../src/repositories/db.js';
import {
  saveOrder,
  transition,
  postShipment,
} from '../src/services/sales-service.js';
import type { SessionUser } from '@kingflow/shared';
export async function seedSales() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { username: 'admin' },
    include: { role: true },
  });
  const actor: SessionUser = {
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    role: {
      code: admin.role.code,
      name: admin.role.name,
      permissions: JSON.parse(admin.role.permissions),
    },
  };
  const customers = await prisma.customer.findMany({
    where: { code: { startsWith: 'CUS-' }, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
  });
  if (!customers.length) return;
  for (let i = 0; i < 20; i++) {
    const number = `SO-DEMO-${String(i + 1).padStart(3, '0')}`;
    if (await prisma.salesOrder.findUnique({ where: { number } })) continue;
    const balance = await prisma.stockBalance.findFirst({
      where: {
        quantity: { gte: 3 },
        product: { status: 'ACTIVE', category: { status: 'ACTIVE' } },
        warehouse: { status: 'ACTIVE' },
      },
      include: { product: true },
      orderBy: [{ quantity: 'desc' }, { id: 'asc' }],
    });
    if (!balance) {
      console.log('可用真实库存不足，保留现有数据，跳过剩余销售Seed');
      break;
    }
    const receipt = await prisma.stockMovement.findFirst({
      where: {
        productId: balance.productId,
        warehouseId: balance.warehouseId,
        type: 'PURCHASE_RECEIPT',
      },
      orderBy: { createdAt: 'asc' },
    });
    const recordedAt = new Date(
      Math.max(
        Date.now() - (19 - i) * 86400000,
        (receipt?.createdAt.getTime() ?? 0) + 3600000,
      ),
    );
    const order = await saveOrder(
      {
        customerId: customers[i % customers.length].id,
        warehouseId: balance.warehouseId,
        orderDate: recordedAt.toISOString().slice(0, 10),
        remark: '开发演示销售；库存、流水和应收由真实Service产生',
        items: [
          {
            productId: balance.productId,
            quantity: 3,
            unitPrice: balance.product.salesPrice,
          },
        ],
      },
      actor,
      undefined,
      number,
    );
    if (i >= 2) await transition(order.id, 'submit', {}, actor);
    if (i >= 4) await transition(order.id, 'approve', {}, actor);
    if (i >= 6) {
      const result = await postShipment(
        {
          orderId: order.id,
          items: [{ orderItemId: order.items[0].id, quantity: i < 9 ? 1 : 3 }],
        },
        `seed-sales-${i + 1}-shipment`,
        actor,
      );
      const createdAt = new Date(recordedAt.getTime() + 3600000);
      await prisma.$transaction([
        prisma.salesShipment.update({
          where: { id: result.shipment.id },
          data: { createdAt },
        }),
        prisma.stockMovement.updateMany({
          where: { shipmentId: result.shipment.id },
          data: { createdAt },
        }),
        prisma.receivable.updateMany({
          where: { shipmentId: result.shipment.id },
          data: { createdAt },
        }),
        prisma.idempotencyRecord.updateMany({
          where: { shipmentId: result.shipment.id },
          data: { createdAt },
        }),
        prisma.auditLog.updateMany({
          where: {
            resource: 'sales-shipments',
            resourceId: result.shipment.id,
          },
          data: { createdAt },
        }),
      ]);
    }
    await prisma.$transaction([
      prisma.salesOrder.update({
        where: { id: order.id },
        data: { createdAt: recordedAt, updatedAt: recordedAt },
      }),
      prisma.auditLog.updateMany({
        where: { resource: 'sales-orders', resourceId: order.id },
        data: { createdAt: recordedAt },
      }),
    ]);
  }
  console.log(
    '销售Seed完成：20单，覆盖草稿/待审核/已审核/部分出库/已出库；仅消耗真实采购库存',
  );
}
