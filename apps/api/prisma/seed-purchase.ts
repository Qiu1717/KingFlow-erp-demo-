import { prisma } from '../src/repositories/db.js';
import {
  saveOrder,
  transition,
  postReceipt,
} from '../src/services/purchase-service.js';
import type { SessionUser } from '@kingflow/shared';
export async function seedPurchases() {
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
  const products = await prisma.product.findMany({
    where: { code: { startsWith: 'KF-' }, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
    take: 30,
  });
  const suppliers = await prisma.supplier.findMany({
    where: { code: { startsWith: 'SUP-' }, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
  });
  const warehouses = await prisma.warehouse.findMany({
    where: { code: { startsWith: 'WH-' }, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
  });
  if (products.length < 30 || !suppliers.length || !warehouses.length) {
    console.log(
      '保留已修改主数据：可用Seed商品/供应商/仓库不足，跳过缺失的演示采购',
    );
    return;
  }
  for (let i = 0; i < 15; i++) {
    const number = `PO-DEMO-${String(i + 1).padStart(3, '0')}`;
    if (await prisma.purchaseOrder.findUnique({ where: { number } })) continue;
    const recordedAt = new Date(Date.now() - (59 - i * 4) * 86400000);
    const orderDate = recordedAt.toISOString().slice(0, 10);
    const order = await saveOrder(
      {
        supplierId: suppliers[i % suppliers.length].id,
        warehouseId: warehouses[i % warehouses.length].id,
        orderDate,
        expectedDate: new Date(recordedAt.getTime() + 3 * 86400000)
          .toISOString()
          .slice(0, 10),
        remark: '开发演示采购；经真实业务Service生成',
        items: products.slice(i * 2, i * 2 + 2).map((p, index) => ({
          productId: p.id,
          quantity: index === 0 ? 10 : 20,
          unitPrice: p.purchasePrice,
        })),
      },
      actor,
      undefined,
      number,
    );
    if (i >= 2) await transition(order.id, 'submit', {}, actor);
    if (i >= 4) await transition(order.id, 'approve', {}, actor);
    if (i >= 6) {
      const first = await postReceipt(
        {
          orderId: order.id,
          remark: '演示第一批到货',
          items: order.items.map((item) => ({
            orderItemId: item.id,
            quantity: item.quantity * 0.6,
          })),
        },
        `seed-purchase-${i + 1}-first`,
        actor,
      );
      await dateReceipt(
        first.receipt.id,
        new Date(recordedAt.getTime() + 3600000),
      );
      if (i >= 9) {
        const second = await postReceipt(
          {
            orderId: order.id,
            remark: '演示第二批到货',
            items: order.items.map((item) => ({
              orderItemId: item.id,
              quantity: item.quantity * 0.4,
            })),
          },
          `seed-purchase-${i + 1}-second`,
          actor,
        );
        await dateReceipt(
          second.receipt.id,
          new Date(recordedAt.getTime() + 7200000),
        );
      }
    }
    await prisma.$transaction([
      prisma.purchaseOrder.update({
        where: { id: order.id },
        data: { createdAt: recordedAt, updatedAt: recordedAt },
      }),
      prisma.auditLog.updateMany({
        where: { resource: 'purchase-orders', resourceId: order.id },
        data: { createdAt: recordedAt },
      }),
    ]);
  }
  console.log(
    '采购Seed完成：15单，覆盖草稿/待审核/已审核/部分入库/已入库；库存、流水、应付均由Service过账',
  );
}
async function dateReceipt(receiptId: string, createdAt: Date) {
  // Development fixtures backdate timestamps only; quantities and money are produced by the business Service.
  await prisma.$transaction([
    prisma.goodsReceipt.update({
      where: { id: receiptId },
      data: { createdAt },
    }),
    prisma.stockMovement.updateMany({
      where: { receiptId },
      data: { createdAt },
    }),
    prisma.payable.updateMany({ where: { receiptId }, data: { createdAt } }),
    prisma.idempotencyRecord.updateMany({
      where: { receiptId },
      data: { createdAt },
    }),
    prisma.auditLog.updateMany({
      where: { resource: 'goods-receipts', resourceId: receiptId },
      data: { createdAt },
    }),
  ]);
}
