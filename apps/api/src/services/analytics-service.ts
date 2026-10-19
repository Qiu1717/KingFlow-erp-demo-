import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { can, dateOnly, type SessionUser } from '@kingflow/shared';
import { prisma as db } from '../repositories/db.js';
import * as repository from '../repositories/analytics-repository.js';
import { authorize } from './master-service.js';
import { InventoryService } from './inventory-service.js';
import { AppError } from '../utils/errors.js';
import { csv } from '../utils/csv.js';
const querySchema = z
  .object({
    dateFrom: dateOnly.optional(),
    dateTo: dateOnly.optional(),
    warehouseId: z.string().optional(),
    productId: z.string().optional(),
    q: z.string().trim().max(100).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    format: z.enum(['csv']).optional(),
    rankBy: z.enum(['amount', 'quantity']).default('amount'),
  })
  .strict()
  .refine(
    (q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo,
    '开始日期不得晚于结束日期',
  );
export type ReportKind = 'sales' | 'purchases' | 'inventory' | 'finance';
const permissions = {
  sales: 'sales:read',
  purchases: 'purchase:read',
  inventory: 'inventory:read',
  finance: 'finance:read',
};
function range(q: { dateFrom?: string; dateTo?: string }) {
  return {
    ...(q.dateFrom ? { gte: new Date(q.dateFrom + 'T00:00:00+08:00') } : {}),
    ...(q.dateTo
      ? {
          lt: new Date(
            new Date(q.dateTo + 'T00:00:00+08:00').getTime() + 86400000,
          ),
        }
      : {}),
  };
}
const day = (date: Date) =>
  new Date(date.getTime() + 28800000).toISOString().slice(0, 10);
const textDate = (date: Date) =>
  date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
export async function stockAlerts(input: unknown, user: SessionUser) {
  authorize(user, 'inventory:read');
  const q = querySchema.parse(input);
  const [products, warehouses, balances] = await repository.alertData(q);
  const balanceMap = new Map(
    balances.map((b) => [b.productId + ':' + b.warehouseId, b.quantity]),
  );
  const rows = products
    .flatMap((product) =>
      warehouses.map((warehouse) => {
        const quantity = balanceMap.get(product.id + ':' + warehouse.id) ?? 0;
        return {
          id: product.id + ':' + warehouse.id,
          productId: product.id,
          warehouseId: warehouse.id,
          product,
          warehouse,
          quantity,
          shortage: Math.max(0, product.minStock - quantity),
        };
      }),
    )
    .filter((r) => r.quantity < r.product.minStock)
    .sort((a, b) => b.shortage - a.shortage || a.id.localeCompare(b.id));
  return {
    items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
    total: rows.length,
    productCount: new Set(rows.map((row) => row.productId)).size,
    page: q.page,
    pageSize: q.pageSize,
  };
}
export async function report(
  kind: ReportKind,
  input: unknown,
  user: SessionUser,
) {
  authorize(user, permissions[kind]);
  const q = querySchema.parse(input);
  // 往来报表按往来单据本身聚合，没有仓库/商品维度；明确拒绝而不是静默忽略筛选条件，
  // 否则用户以为筛过、实际拿到全量，报表口径会被误读。
  if (kind === 'finance' && (q.warehouseId || q.productId))
    throw new AppError(
      422,
      'UNSUPPORTED_FILTER',
      '往来报表不支持按仓库或商品筛选',
    );
  const createdAt = range(q);
  const warehouse = q.warehouseId ? { warehouseId: q.warehouseId } : {};
  const product = q.productId ? { productId: q.productId } : {};
  let rows: {
    id: string;
    number: string;
    date: string;
    dateKey?: string;
    partner: string;
    product: string;
    warehouse: string;
    quantity: number;
    openingQuantity?: number;
    inboundQuantity?: number;
    outboundQuantity?: number;
    amount: number;
    settled: number;
    balance: number;
    sourcePath: string;
  }[];
  if (kind === 'sales') {
    const items = await repository.salesLines({
      ...product,
      shipment: { createdAt, ...warehouse },
    });
    rows = items.map((i) => ({
      id: i.id,
      number: i.shipment.number,
      date: textDate(i.shipment.createdAt),
      dateKey: day(i.shipment.createdAt),
      partner: i.shipment.order.customer.name,
      product: `${i.productCode} · ${i.productName}`,
      warehouse: i.shipment.warehouse.name,
      quantity: i.quantity,
      amount: i.amount,
      settled: 0,
      balance: 0,
      sourcePath: `/sales-orders?view=${i.shipment.orderId}`,
    }));
  } else if (kind === 'purchases') {
    const items = await repository.purchaseLines({
      ...product,
      receipt: { createdAt, ...warehouse },
    });
    rows = items.map((i) => ({
      id: i.id,
      number: i.receipt.number,
      date: textDate(i.receipt.createdAt),
      dateKey: day(i.receipt.createdAt),
      partner: i.receipt.order.supplier.name,
      product: `${i.productCode} · ${i.productName}`,
      warehouse: i.receipt.warehouse.name,
      quantity: i.quantity,
      amount: i.amount,
      settled: 0,
      balance: 0,
      sourcePath: `/purchase-orders?view=${i.receipt.orderId}`,
    }));
  } else if (kind === 'inventory') {
    // Historical stock is reconstructed from formal movements, current stock from balances.
    const items = await repository.inventoryBalances({
      ...warehouse,
      ...product,
    });
    const changes =
      q.dateFrom || q.dateTo
        ? await repository.inventoryMovements({
            ...warehouse,
            ...product,
            createdAt: { lt: createdAt.lt },
          })
        : null;
    rows = items.map((i) => {
      const movements = changes?.filter(
        (m) => m.productId === i.productId && m.warehouseId === i.warehouseId,
      );
      const openingQuantity =
        movements
          ?.filter((m) => createdAt.gte && m.createdAt < createdAt.gte)
          .reduce((sum, m) => sum + m.quantity, 0) ?? i.quantity;
      const period = movements?.filter(
        (m) => !createdAt.gte || m.createdAt >= createdAt.gte,
      );
      return {
        id: i.id,
        number: i.product.code,
        date: q.dateTo ?? '实时',
        partner: '',
        product: i.product.name,
        warehouse: i.warehouse.name,
        quantity: movements?.reduce((s, m) => s + m.quantity, 0) ?? i.quantity,
        openingQuantity,
        inboundQuantity:
          period
            ?.filter((m) => m.quantity > 0)
            .reduce((s, m) => s + m.quantity, 0) ?? 0,
        outboundQuantity:
          period
            ?.filter((m) => m.quantity < 0)
            .reduce((s, m) => s - m.quantity, 0) ?? 0,
        amount: 0,
        settled: 0,
        balance: 0,
        sourcePath: `/stock-movements?productId=${i.productId}&warehouseId=${i.warehouseId}`,
      };
    });
  } else {
    // 往来报表按「来源单据生成日期」筛选，已结/未结为当前累计（口径见 docs/DECISIONS.md）。
    const [ar, ap] = await repository.financeSources(createdAt);
    rows = [
      ...ar.map((i) => ({
        id: i.id,
        number: i.number,
        date: textDate(i.createdAt),
        partner: i.customer.name,
        product: '应收账款',
        warehouse: '',
        quantity: 0,
        amount: i.originalAmount,
        settled: i.receivedAmount,
        balance: i.originalAmount - i.receivedAmount,
        sourcePath: `/receivables?view=${i.id}`,
      })),
      ...ap.map((i) => ({
        id: i.id,
        number: i.number,
        date: textDate(i.createdAt),
        partner: i.supplier.name,
        product: '应付账款',
        warehouse: '',
        quantity: 0,
        amount: i.originalAmount,
        settled: i.paidAmount,
        balance: i.originalAmount - i.paidAmount,
        sourcePath: `/payables?view=${i.id}`,
      })),
    ];
  }
  // SQLite 的 LIKE 对 ASCII 大小写不敏感、对中文按字面匹配；这里统一做不区分大小写
  // 的关键词过滤，避免同一关键词在基础资料列表能搜到、在报表里搜不到。
  if (q.q) {
    const keyword = q.q.toLowerCase();
    rows = rows.filter((r) =>
      [r.number, r.partner, r.product, r.warehouse].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }
  const totals = rows.reduce(
    (s, r) => ({
      quantity: s.quantity + r.quantity,
      amount: s.amount + r.amount,
      settled: s.settled + r.settled,
      balance: s.balance + r.balance,
    }),
    { quantity: 0, amount: 0, settled: 0, balance: 0 },
  );
  const grouped = (key: 'product' | 'partner' | 'warehouse' | 'dateKey') => {
    const groups = new Map<
      string,
      { name: string; quantity: number; amount: number }
    >();
    for (const row of rows) {
      const name = row[key];
      if (!name) continue;
      const current = groups.get(name) ?? { name, quantity: 0, amount: 0 };
      current.quantity += row.quantity;
      current.amount += row.amount;
      groups.set(name, current);
    }
    return [...groups.values()];
  };
  const financeSummary =
    kind === 'finance'
      ? ['应收账款', '应付账款'].map((name) =>
          rows
            .filter((r) => r.product === name)
            .reduce(
              (s, r) => ({
                ...s,
                amount: s.amount + r.amount,
                settled: s.settled + r.settled,
                balance: s.balance + r.balance,
              }),
              { name, amount: 0, settled: 0, balance: 0 },
            ),
        )
      : [];
  const analysis = {
    trend:
      kind === 'sales' || kind === 'purchases'
        ? grouped('dateKey').sort((a, b) => a.name.localeCompare(b.name))
        : [],
    productRanking:
      kind === 'sales' || kind === 'purchases'
        ? grouped('product')
            .sort(
              (a, b) =>
                b[q.rankBy] - a[q.rankBy] || a.name.localeCompare(b.name),
            )
            .slice(0, 10)
        : [],
    partnerRanking:
      kind === 'sales' || kind === 'purchases'
        ? grouped('partner')
            .sort(
              (a, b) =>
                b[q.rankBy] - a[q.rankBy] || a.name.localeCompare(b.name),
            )
            .slice(0, 10)
        : [],
    warehouseSummary: kind === 'inventory' ? grouped('warehouse') : [],
    financeSummary,
    stockAlerts:
      kind === 'inventory'
        ? await stockAlerts(
            { q: q.q, warehouseId: q.warehouseId, productId: q.productId },
            user,
          )
        : undefined,
    movements:
      kind === 'inventory'
        ? await repository.recentMovements({
            ...warehouse,
            ...product,
            createdAt,
          })
        : undefined,
  };
  if (q.format === 'csv') {
    // 期初/期间增减只有选定日期区间才有意义；未选日期时输出它们会让人误读为
    // 「期初=当前库存、期间无变动」，因此与明细表一致，仅在区间存在时导出这三列。
    const historical = kind === 'inventory' && !!(q.dateFrom || q.dateTo);
    return csv([
      [
        '单号/编码',
        '日期（上海）',
        '往来单位',
        '商品/类型',
        '仓库',
        '数量',
        '金额（元）',
        '已结（元）',
        '未结（元）',
        '来源',
        ...(historical ? ['期初数量', '期间增加', '期间减少'] : []),
      ],
      ...rows.map((r) => [
        r.number,
        r.date,
        r.partner,
        r.product,
        r.warehouse,
        r.quantity,
        (r.amount / 100).toFixed(2),
        (r.settled / 100).toFixed(2),
        (r.balance / 100).toFixed(2),
        r.sourcePath,
        ...(historical
          ? [r.openingQuantity, r.inboundQuantity, r.outboundQuantity]
          : []),
      ]),
    ]);
  }
  return {
    items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
    total: rows.length,
    page: q.page,
    pageSize: q.pageSize,
    totals,
    analysis,
  };
}
export async function business(user: SessionUser) {
  const allowed = (p: string) => can(user.role.permissions, p);
  const today = day(new Date()),
    month = today.slice(0, 7) + '-01';
  const dates = Array.from({ length: 30 }, (_, i) =>
    day(
      new Date(
        new Date(today + 'T00:00:00+08:00').getTime() - (29 - i) * 86400000,
      ),
    ),
  );
  const start = new Date(dates[0] + 'T00:00:00+08:00'),
    end = new Date(new Date(today + 'T00:00:00+08:00').getTime() + 86400000);
  const metrics: Record<string, number> = {};
  const trend = dates.map((date) => ({
    date,
    ...(allowed('sales:read') ? { sales: 0 } : {}),
    ...(allowed('purchase:read') ? { purchases: 0 } : {}),
  }));
  let topProducts:
    { name: string; quantity: number; amount: number }[] | undefined;
  let orderStatuses: { name: string; value: number }[] | undefined;
  if (allowed('sales:read')) {
    const [sum, records, products, statuses] = await db.$transaction([
      db.salesShipment.aggregate({
        where: {
          createdAt: { gte: new Date(month + 'T00:00:00+08:00'), lt: end },
        },
        _sum: { totalAmount: true },
      }),
      db.salesShipment.findMany({
        where: { createdAt: { gte: start, lt: end } },
        select: { createdAt: true, totalAmount: true },
      }),
      db.salesShipmentItem.groupBy({
        by: ['productId', 'productName'],
        where: { shipment: { createdAt: { gte: start, lt: end } } },
        _sum: { quantity: true, amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 5,
      }),
      db.salesOrder.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
    ]);
    metrics.monthSales = sum._sum.totalAmount ?? 0;
    for (const r of records) {
      const row = trend.find((d) => d.date === day(r.createdAt));
      if (row) row.sales = (row.sales ?? 0) + r.totalAmount;
    }
    topProducts = products.map((r) => ({
      name: r.productName,
      quantity: r._sum?.quantity ?? 0,
      amount: r._sum?.amount ?? 0,
    }));
    orderStatuses = statuses.map((r) => ({
      name: r.status,
      value: typeof r._count === 'object' ? (r._count._all ?? 0) : 0,
    }));
  }
  if (allowed('purchase:read')) {
    const [sum, records] = await db.$transaction([
      db.goodsReceipt.aggregate({
        where: {
          createdAt: { gte: new Date(month + 'T00:00:00+08:00'), lt: end },
        },
        _sum: { totalAmount: true },
      }),
      db.goodsReceipt.findMany({
        where: { createdAt: { gte: start, lt: end } },
        select: { createdAt: true, totalAmount: true },
      }),
    ]);
    metrics.monthPurchases = sum._sum.totalAmount ?? 0;
    for (const r of records) {
      const row = trend.find((d) => d.date === day(r.createdAt));
      if (row) row.purchases = (row.purchases ?? 0) + r.totalAmount;
    }
  }
  if (allowed('inventory:read')) {
    metrics.stockQuantity =
      (await db.stockBalance.aggregate({ _sum: { quantity: true } }))._sum
        .quantity ?? 0;
    metrics.stockAlerts = (await stockAlerts({}, user)).productCount;
  }
  if (allowed('finance:read')) {
    const [ar, ap] = await db.$transaction([
      db.receivable.aggregate({
        _sum: { originalAmount: true, receivedAmount: true },
      }),
      db.payable.aggregate({
        _sum: { originalAmount: true, paidAmount: true },
      }),
    ]);
    metrics.receivable =
      (ar._sum.originalAmount ?? 0) - (ar._sum.receivedAmount ?? 0);
    metrics.payable = (ap._sum.originalAmount ?? 0) - (ap._sum.paidAmount ?? 0);
  }
  let pending = 0;
  if (allowed('purchase:approve'))
    pending += await db.purchaseOrder.count({ where: { status: 'PENDING' } });
  if (allowed('sales:approve'))
    pending += await db.salesOrder.count({ where: { status: 'PENDING' } });
  if (allowed('purchase:approve') || allowed('sales:approve'))
    metrics.pendingApprovals = pending;
  return {
    metrics,
    trend,
    topProducts,
    orderStatuses,
    dateFrom: dates[0],
    dateTo: today,
    timezone: 'Asia/Shanghai',
  };
}
export async function todos(user: SessionUser) {
  const items: { id: string; title: string; path: string; type: string }[] = [];
  for (const kind of ['purchase', 'sales'] as const) {
    const p = can(user.role.permissions, kind + ':approve');
    const fulfill = can(
      user.role.permissions,
      kind === 'purchase' ? 'receipts:post' : 'shipments:post',
    );
    if (!p && !fulfill) continue;
    const statuses = [
      ...(p ? ['PENDING'] : []),
      ...(fulfill ? ['APPROVED', 'PARTIAL'] : []),
    ];
    const rows =
      kind === 'purchase'
        ? await db.purchaseOrder.findMany({
            where: { status: { in: statuses } },
            take: 8,
            orderBy: { createdAt: 'asc' },
            select: { id: true, number: true, status: true },
          })
        : await db.salesOrder.findMany({
            where: { status: { in: statuses } },
            take: 8,
            orderBy: { createdAt: 'asc' },
            select: { id: true, number: true, status: true },
          });
    items.push(
      ...rows.map((r) => ({
        id: r.id,
        title: `${r.number} · ${r.status === 'PENDING' ? '待审核' : kind === 'purchase' ? '待入库' : '待出库'}`,
        path: `/${kind}-orders?view=${r.id}`,
        type: kind,
      })),
    );
  }
  if (can(user.role.permissions, 'inventory:read')) {
    const alerts = await stockAlerts({}, user);
    if (alerts.total)
      items.push({
        id: 'stock-alerts',
        title: `${alerts.total} 项库存低于预警线`,
        path: '/stock-alerts',
        type: 'inventory',
      });
  }
  return items;
}
const adjustmentSchema = z
  .object({
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    quantity: z
      .number()
      .int()
      .min(-2_000_000_000)
      .max(2_000_000_000)
      .refine((n) => n !== 0, '调整数量不能为0'),
    reason: z.string().trim().min(1, '请填写调整原因').max(500),
  })
  .strict();
export async function adjustments(input: unknown, user: SessionUser) {
  authorize(user, 'inventory:read');
  const q = querySchema.parse(input);
  const where = {
    createdAt: range(q),
    ...(q.productId ? { productId: q.productId } : {}),
    ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
    ...(q.q
      ? {
          OR: [
            { number: { contains: q.q } },
            { reason: { contains: q.q } },
            { product: { name: { contains: q.q } } },
          ],
        }
      : {}),
  };
  const [items, total] = await db.$transaction([
    db.stockAdjustment.findMany({
      where,
      include: {
        product: { select: { code: true, name: true } },
        warehouse: { select: { name: true } },
        createdBy: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    db.stockAdjustment.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function postAdjustment(
  input: unknown,
  keyInput: unknown,
  user: SessionUser,
) {
  authorize(user, 'inventory:adjust');
  const data = adjustmentSchema.parse(input),
    key = z
      .string()
      .regex(/^[A-Za-z0-9_:-]{8,128}$/)
      .parse(keyInput);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ userId: user.id, ...data }))
    .digest('hex');
  const replay = async (tx: Prisma.TransactionClient) => {
    const record = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (!record) return null;
    if (
      record.userId !== user.id ||
      record.scope !== 'stock-adjustment' ||
      record.requestHash !== requestHash
    )
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        '幂等键已用于其他请求，请使用原请求重试',
      );
    return tx.stockAdjustment.findUniqueOrThrow({
      where: { id: record.adjustmentId! },
    });
  };
  const previous = await replay(db);
  if (previous) return { adjustment: previous, replayed: true };
  try {
    return await db.$transaction(
      async (tx) => {
        const lock = await tx.product.updateMany({
          where: { id: data.productId },
          data: { minStock: { increment: 0 } },
        });
        if (!lock.count)
          throw new AppError(422, 'INVALID_PRODUCT', '商品不存在');
        const previous = await replay(tx);
        if (previous) return { adjustment: previous, replayed: true };
        const [product, warehouse] = await Promise.all([
          tx.product.findUniqueOrThrow({
            where: { id: data.productId },
            include: { category: true },
          }),
          tx.warehouse.findUnique({ where: { id: data.warehouseId } }),
        ]);
        if (product.status !== 'ACTIVE' || product.category.status !== 'ACTIVE')
          throw new AppError(422, 'INVALID_PRODUCT', '商品或分类已停用');
        if (!warehouse || warehouse.status !== 'ACTIVE')
          throw new AppError(422, 'INVALID_WAREHOUSE', '仓库不存在或已停用');
        const adjustment = await tx.stockAdjustment.create({
          data: { ...data, number: `SA-${randomUUID()}`, createdById: user.id },
        });
        await InventoryService.adjust(tx, {
          ...data,
          adjustmentId: adjustment.id,
          actorId: user.id,
        });
        await tx.idempotencyRecord.create({
          data: {
            key,
            scope: 'stock-adjustment',
            userId: user.id,
            requestHash,
            adjustmentId: adjustment.id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'POST',
            resource: 'stock-adjustments',
            resourceId: adjustment.id,
          },
        });
        return { adjustment, replayed: false };
      },
      { maxWait: 10000, timeout: 15000 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const previous = await replay(db);
      if (previous) return { adjustment: previous, replayed: true };
    }
    throw error;
  }
}
