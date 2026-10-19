import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  settlementSchema,
  financeQuerySchema,
  settlementStatus,
  type SessionUser,
} from '@kingflow/shared';
import { prisma } from '../repositories/db.js';
import {
  settlementInclude,
  payableInclude,
  receivableInclude,
} from '../repositories/finance-repository.js';
import { authorize } from './master-service.js';
import { AppError } from '../utils/errors.js';
const transactionOptions = { maxWait: 10000, timeout: 15000 };
const keySchema = z.string().regex(/^[A-Za-z0-9_:-]{8,128}$/);
export async function settle(
  type: 'RECEIPT' | 'PAYMENT',
  input: unknown,
  keyInput: unknown,
  user: SessionUser,
) {
  authorize(user, 'settlements:write');
  const data = settlementSchema.parse(input);
  const key = keySchema.parse(keyInput);
  const scope = 'settlement';
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ ...data, type, userId: user.id }))
    .digest('hex');
  const replay = async (tx: Prisma.TransactionClient) => {
    const record = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (!record) return null;
    if (
      record.scope !== scope ||
      record.userId !== user.id ||
      record.requestHash !== requestHash ||
      !record.settlementId
    )
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        '幂等键已用于其他请求，请勿改变原请求',
      );
    return tx.settlementRecord.findUniqueOrThrow({
      where: { id: record.settlementId },
      include: settlementInclude,
    });
  };
  const previous = await replay(prisma);
  if (previous) return { record: previous, replayed: true };
  try {
    return await prisma.$transaction(async (tx) => {
      // A conditional write acquires SQLite's writer lock before reading the balance.
      const locked =
        type === 'RECEIPT'
          ? await tx.receivable.updateMany({
              where: { id: data.sourceId },
              data: { receivedAmount: { increment: 0 } },
            })
          : await tx.payable.updateMany({
              where: { id: data.sourceId },
              data: { paidAmount: { increment: 0 } },
            });
      if (!locked.count) throw new AppError(404, 'NOT_FOUND', '往来单据不存在');
      const duplicate = await replay(tx);
      if (duplicate) return { record: duplicate, replayed: true };
      const source =
        type === 'RECEIPT'
          ? await tx.receivable.findUniqueOrThrow({
              where: { id: data.sourceId },
            })
          : await tx.payable.findUniqueOrThrow({
              where: { id: data.sourceId },
            });
      const settled =
        'receivedAmount' in source ? source.receivedAmount : source.paidAmount;
      if (data.amount > source.originalAmount - settled)
        throw new AppError(
          409,
          'EXCESS_SETTLEMENT',
          '收付款金额不能超过未结余额',
        );
      const status = settlementStatus(
        source.originalAmount,
        settled + data.amount,
      );
      const changed =
        type === 'RECEIPT'
          ? await tx.receivable.updateMany({
              where: { id: source.id, receivedAmount: settled },
              data: { receivedAmount: { increment: data.amount }, status },
            })
          : await tx.payable.updateMany({
              where: { id: source.id, paidAmount: settled },
              data: { paidAmount: { increment: data.amount }, status },
            });
      if (changed.count !== 1)
        throw new AppError(
          409,
          'WRITE_CONFLICT',
          '单据余额已变化，请刷新后重试',
        );
      const record = await tx.settlementRecord.create({
        data: {
          number: `${type === 'RECEIPT' ? 'RC' : 'PY'}-${randomUUID()}`,
          type,
          receivableId: type === 'RECEIPT' ? source.id : null,
          payableId: type === 'PAYMENT' ? source.id : null,
          amount: data.amount,
          date: data.date,
          method: data.method,
          remark: data.remark,
          createdById: user.id,
        },
        include: settlementInclude,
      });
      await tx.idempotencyRecord.create({
        data: {
          key,
          scope,
          userId: user.id,
          requestHash,
          settlementId: record.id,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'SETTLE',
          resource: 'settlements',
          resourceId: record.id,
        },
      });
      return { record, replayed: false };
    }, transactionOptions);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const record = await replay(prisma);
      if (record) return { record, replayed: true };
    }
    throw error;
  }
}
export async function sourceDetail(
  type: 'receivables' | 'payables',
  id: string,
  user: SessionUser,
) {
  authorize(user, type === 'payables' ? 'payables:read' : 'receivables:read');
  const settlements = {
    orderBy: { createdAt: 'desc' as const },
    include: settlementInclude,
  };
  const data =
    type === 'payables'
      ? await prisma.payable.findUnique({
          where: { id },
          include: { ...payableInclude, settlements },
        })
      : await prisma.receivable.findUnique({
          where: { id },
          include: { ...receivableInclude, settlements },
        });
  if (!data) throw new AppError(404, 'NOT_FOUND', '往来单据不存在');
  return data;
}
export async function sourceList(
  type: 'receivables' | 'payables',
  input: unknown,
  user: SessionUser,
) {
  authorize(user, type === 'payables' ? 'payables:read' : 'receivables:read');
  const q = financeQuerySchema.parse(input);
  const common = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.sourceId ? { id: q.sourceId } : {}),
    ...(q.dateFrom || q.dateTo
      ? {
          createdAt: {
            gte: q.dateFrom
              ? new Date(q.dateFrom + 'T00:00:00+08:00')
              : undefined,
            lt: q.dateTo
              ? new Date(
                  new Date(q.dateTo + 'T00:00:00+08:00').getTime() + 86400000,
                )
              : undefined,
          },
        }
      : {}),
  };
  const paging = {
    skip: (q.page - 1) * q.pageSize,
    take: q.pageSize,
    // 次级排序保证相同生成时间下翻页不重不漏。
    orderBy: [{ createdAt: q.sortOrder }, { id: q.sortOrder }],
  };
  if (type === 'payables') {
    const where: Prisma.PayableWhereInput = {
      ...common,
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
    };
    const [items, total] = await prisma.$transaction([
      prisma.payable.findMany({ where, ...paging, include: payableInclude }),
      prisma.payable.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
  const where: Prisma.ReceivableWhereInput = {
    ...common,
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.shipmentId ? { shipmentId: q.shipmentId } : {}),
    ...(q.q
      ? {
          OR: [
            { number: { contains: q.q } },
            { customer: { name: { contains: q.q } } },
            { shipment: { number: { contains: q.q } } },
          ],
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.receivable.findMany({
      where,
      ...paging,
      include: receivableInclude,
    }),
    prisma.receivable.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function records(input: unknown, user: SessionUser) {
  authorize(user, 'finance:read');
  const q = financeQuerySchema.parse(input);
  // 各来源侧筛选必须同时成立，用 AND 组合，避免 OR 条件互相覆盖。
  const and: Prisma.SettlementRecordWhereInput[] = [];
  if (q.sourceId)
    and.push({ OR: [{ receivableId: q.sourceId }, { payableId: q.sourceId }] });
  if (q.status)
    and.push({
      OR: [
        { receivable: { status: q.status } },
        { payable: { status: q.status } },
      ],
    });
  if (q.q)
    and.push({
      OR: [
        { number: { contains: q.q } },
        { receivable: { customer: { name: { contains: q.q } } } },
        { payable: { supplier: { name: { contains: q.q } } } },
      ],
    });
  const where: Prisma.SettlementRecordWhereInput = {
    ...(q.type ? { type: q.type } : {}),
    ...(q.customerId ? { receivable: { customerId: q.customerId } } : {}),
    ...(q.supplierId ? { payable: { supplierId: q.supplierId } } : {}),
    ...(q.receiptId ? { payable: { receiptId: q.receiptId } } : {}),
    ...(q.shipmentId ? { receivable: { shipmentId: q.shipmentId } } : {}),
    // 收付款记录按业务日期（结算单 date）筛选，与生成时间 createdAt 分离。
    ...(q.dateFrom || q.dateTo
      ? { date: { gte: q.dateFrom, lte: q.dateTo } }
      : {}),
    ...(and.length ? { AND: and } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.settlementRecord.findMany({
      where,
      include: settlementInclude,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      // 次级排序保证相同生成时间下分页不重不漏。
      orderBy: [{ createdAt: q.sortOrder }, { id: q.sortOrder }],
    }),
    prisma.settlementRecord.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function summary(input: unknown, user: SessionUser) {
  authorize(user, 'finance:read');
  const q = financeQuerySchema.parse(input);
  // 概览只支持按业务日期筛选收付款；其余筛选（状态/类型/来源/关键词/分页）
  // 在这里没有定义，静默忽略会让调用方误以为筛选已生效，因此明确拒绝。
  const unsupported = (
    ['status', 'type', 'sourceId', 'receiptId', 'shipmentId', 'customerId', 'supplierId', 'q'] as const
  ).filter((key) => q[key] !== undefined && q[key] !== '');
  if (unsupported.length)
    throw new AppError(
      422,
      'UNSUPPORTED_FILTER',
      `财务概览不支持筛选：${unsupported.join('、')}`,
    );
  // 口径（docs/DECISIONS.md）：往来余额为当前累计的全部有效往来；收付款为所选业务日期的期间发生额。
  const date = { gte: q.dateFrom, lte: q.dateTo };
  const [ar, ap, receipts, payments] = await prisma.$transaction([
    prisma.receivable.aggregate({
      _sum: { originalAmount: true, receivedAmount: true },
    }),
    prisma.payable.aggregate({
      _sum: { originalAmount: true, paidAmount: true },
    }),
    prisma.settlementRecord.aggregate({
      where: { type: 'RECEIPT', date },
      _sum: { amount: true },
    }),
    prisma.settlementRecord.aggregate({
      where: { type: 'PAYMENT', date },
      _sum: { amount: true },
    }),
  ]);
  return {
    receivableTotal: ar._sum.originalAmount ?? 0,
    receivableRemaining:
      (ar._sum.originalAmount ?? 0) - (ar._sum.receivedAmount ?? 0),
    payableTotal: ap._sum.originalAmount ?? 0,
    payableRemaining: (ap._sum.originalAmount ?? 0) - (ap._sum.paidAmount ?? 0),
    receipts: receipts._sum.amount ?? 0,
    payments: payments._sum.amount ?? 0,
    // 显式声明统计口径，避免前端把余额误读为「所选期间的截止余额」。
    balanceScope: 'ALL_OPEN_DOCUMENTS' as const,
    cashScope: 'SELECTED_BUSINESS_DATE_RANGE' as const,
    dateFrom: q.dateFrom ?? null,
    dateTo: q.dateTo ?? null,
  };
}
