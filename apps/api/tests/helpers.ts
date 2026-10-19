import { prisma } from '../src/repositories/db.js';
export async function cleanDatabase() {
  await prisma.idempotencyRecord.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.settlementRecord.deleteMany();
  await prisma.stockAdjustment.deleteMany();
  await prisma.receivable.deleteMany();
  await prisma.salesShipmentItem.deleteMany();
  await prisma.salesShipment.deleteMany();
  await prisma.salesOrderItem.deleteMany();
  await prisma.salesOrder.deleteMany();
  await prisma.payable.deleteMany();
  await prisma.goodsReceiptItem.deleteMany();
  await prisma.goodsReceipt.deleteMany();
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.stockBalance.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.product.deleteMany();
  await prisma.productCategory.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.warehouse.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
}
