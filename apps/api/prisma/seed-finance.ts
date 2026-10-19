import type { SessionUser } from '@kingflow/shared';
import { prisma } from '../src/repositories/db.js';
import { settle } from '../src/services/finance-service.js';
export async function seedFinance() {
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
  for (const type of ['RECEIPT', 'PAYMENT'] as const) {
    const sources =
      type === 'RECEIPT'
        ? await prisma.receivable.findMany({
            where: {
              shipment: { order: { number: { startsWith: 'SO-DEMO-' } } },
            },
            orderBy: { createdAt: 'asc' },
            take: 8,
          })
        : await prisma.payable.findMany({
            where: {
              receipt: { order: { number: { startsWith: 'PO-DEMO-' } } },
            },
            orderBy: { createdAt: 'asc' },
            take: 8,
          });
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (source.originalAmount === 0) continue;
      const firstAmount = Math.max(1, Math.floor(source.originalAmount / 3));
      const date = new Date(
        Math.min(Date.now(), source.createdAt.getTime() + 86400000),
      );
      for (const [part, amount] of [
        [1, firstAmount],
        ...(i % 2 === 0 ? [[2, source.originalAmount - firstAmount]] : []),
      ]) {
        if (!amount) continue;
        const key = `seed-finance-${type}-${source.id}-${part}`;
        if (await prisma.idempotencyRecord.findUnique({ where: { key } }))
          continue;
        // Existing settlements are user data: do not re-settle a modified fixture.
        const current =
          type === 'RECEIPT'
            ? await prisma.receivable.findUniqueOrThrow({
                where: { id: source.id },
              })
            : await prisma.payable.findUniqueOrThrow({
                where: { id: source.id },
              });
        const done =
          'receivedAmount' in current
            ? current.receivedAmount
            : current.paidAmount;
        if (amount > current.originalAmount - done) continue;
        const result = await settle(
          type,
          {
            sourceId: source.id,
            amount,
            date: new Date(date.getTime() + 8 * 3600000)
              .toISOString()
              .slice(0, 10),
            method: i % 2 === 0 ? '银行转账' : '现金',
            remark: '演示分批结算，经真实Service生成',
          },
          key,
          actor,
        );
        await prisma.settlementRecord.update({
          where: { id: result.record.id },
          data: { createdAt: date },
        });
        await prisma.auditLog.updateMany({
          where: { resource: 'settlements', resourceId: result.record.id },
          data: { createdAt: date },
        });
      }
    }
  }
}
