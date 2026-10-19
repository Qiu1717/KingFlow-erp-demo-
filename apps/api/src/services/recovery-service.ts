import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../repositories/db.js';

/**
 * 备份、恢复与账实一致性核对。
 *
 * 交付约束：
 * - 备份使用 SQLite `VACUUM INTO`，由数据库自身生成一致性快照，不直接复制活动库文件，
 *   避免复制到写入中途的页而得到「能打开但账实不符」的库。
 * - 恢复只写入**不存在**的目标文件，绝不覆盖任何现有数据库。
 * - 恢复后清除全部 Session，避免旧会话凭据随备份复活。
 * - 完整性核对覆盖库存台账、单据金额、累计入出库量、结算余额与流水前后链，
 *   任一项不成立即视为不可交付数据。
 */

export interface IntegrityCheck {
  name: string;
  label: string;
  violations: number;
  sample?: string;
}

export interface IntegrityReport {
  ok: boolean;
  checks: IntegrityCheck[];
  checkedAt: string;
}

export interface BackupResult {
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface RestoreResult {
  ok: boolean;
  target: string;
  source: string;
  sessionsCleared: number;
  integrity: IntegrityReport;
}

type Client = PrismaClient;

const quoted = (path: string) => `'${resolve(path).replaceAll("'", "''")}'`;

/** 取当前连接真实使用的 SQLite 主库文件，避免依赖 DATABASE_URL 相对路径解析规则。 */
export async function databaseFile(client: Client = prisma): Promise<string> {
  const rows = await client.$queryRawUnsafe<
    { name: string; file: string }[]
  >('PRAGMA database_list');
  const main = rows.find((row) => row.name === 'main');
  if (!main?.file) throw new Error('无法定位当前SQLite数据库文件');
  return main.file;
}

const check = (
  name: string,
  label: string,
  violations: number,
  sample?: string,
): IntegrityCheck => ({ name, label, violations, sample });

/** 库存余额必须等于该商品仓库全部流水的累计值。 */
async function stockLedger(client: Client): Promise<IntegrityCheck> {
  const [balances, grouped] = await Promise.all([
    client.stockBalance.findMany({
      select: { productId: true, warehouseId: true, quantity: true },
    }),
    client.stockMovement.groupBy({
      by: ['productId', 'warehouseId'],
      _sum: { quantity: true },
    }),
  ]);
  const totals = new Map(
    grouped.map((row) => [
      row.productId + ':' + row.warehouseId,
      row._sum.quantity ?? 0,
    ]),
  );
  let violations = 0;
  let sample: string | undefined;
  for (const balance of balances) {
    const key = balance.productId + ':' + balance.warehouseId;
    const expected = totals.get(key) ?? 0;
    totals.delete(key);
    if (expected !== balance.quantity) {
      violations += 1;
      sample ??= `余额${balance.quantity}≠流水累计${expected}`;
    }
  }
  // 有流水却没有余额行同样是账实不符。
  for (const [key, quantity] of totals) {
    if (quantity === 0) continue;
    violations += 1;
    sample ??= `缺失余额行 ${key} 流水累计${quantity}`;
  }
  return check('stock-ledger', '库存余额与流水累计一致', violations, sample);
}

/** 流水 before/after 必须首尾相接，且 after-before 等于本次数量。 */
async function movementChain(client: Client): Promise<IntegrityCheck> {
  const movements = await client.stockMovement.findMany({
    orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      productId: true,
      warehouseId: true,
      quantity: true,
      beforeQuantity: true,
      afterQuantity: true,
    },
  });
  let violations = 0;
  let sample: string | undefined;
  const running = new Map<string, number>();
  for (const movement of movements) {
    const key = movement.productId + ':' + movement.warehouseId;
    const expected = running.get(key) ?? 0;
    if (
      movement.beforeQuantity !== expected ||
      movement.afterQuantity !== movement.beforeQuantity + movement.quantity
    ) {
      violations += 1;
      sample ??= `${movement.id} 期望before=${expected} 实际${movement.beforeQuantity}/${movement.afterQuantity}`;
    }
    running.set(key, movement.afterQuantity);
  }
  return check('movement-chain', '库存流水前后数量连续', violations, sample);
}

/** 单据金额必须等于其明细金额合计。 */
async function documentAmounts(client: Client): Promise<IntegrityCheck> {
  const [receipts, shipments, purchases, sales] = await Promise.all([
    client.goodsReceipt.findMany({
      select: { id: true, totalAmount: true, items: { select: { amount: true } } },
    }),
    client.salesShipment.findMany({
      select: { id: true, totalAmount: true, items: { select: { amount: true } } },
    }),
    client.purchaseOrder.findMany({
      select: { id: true, totalAmount: true, items: { select: { amount: true } } },
    }),
    client.salesOrder.findMany({
      select: { id: true, totalAmount: true, items: { select: { amount: true } } },
    }),
  ]);
  let violations = 0;
  let sample: string | undefined;
  const inspect = (rows: { id: string; totalAmount: number; items: { amount: number }[] }[]) => {
    for (const row of rows) {
      const sum = row.items.reduce((total, item) => total + item.amount, 0);
      if (sum !== row.totalAmount) {
        violations += 1;
        sample ??= `${row.id} 合计${row.totalAmount}≠明细${sum}`;
      }
    }
  };
  inspect(receipts);
  inspect(shipments);
  inspect(purchases);
  inspect(sales);
  return check('document-amounts', '单据金额等于明细合计', violations, sample);
}

/** 订单累计入库/出库量必须等于明细单据累计值。 */
async function fulfilledQuantities(client: Client): Promise<IntegrityCheck> {
  const [purchaseItems, receiptItems, salesItems, shipmentItems] =
    await Promise.all([
      client.purchaseOrderItem.findMany({
        select: { id: true, quantity: true, receivedQuantity: true },
      }),
      client.goodsReceiptItem.groupBy({
        by: ['orderItemId'],
        _sum: { quantity: true },
      }),
      client.salesOrderItem.findMany({
        select: { id: true, quantity: true, shippedQuantity: true },
      }),
      client.salesShipmentItem.groupBy({
        by: ['orderItemId'],
        _sum: { quantity: true },
      }),
    ]);
  let violations = 0;
  let sample: string | undefined;
  const compare = (
    rows: { id: string; quantity: number; actual: number }[],
    sums: { orderItemId: string; _sum: { quantity: number | null } }[],
    label: string,
  ) => {
    const totals = new Map(sums.map((row) => [row.orderItemId, row._sum.quantity ?? 0]));
    for (const row of rows) {
      const total = totals.get(row.id) ?? 0;
      totals.delete(row.id);
      if (total !== row.actual || row.actual > row.quantity) {
        violations += 1;
        sample ??= `${label}${row.id} 累计${row.actual}≠明细${total}`;
      }
    }
    for (const [id, total] of totals) {
      if (total === 0) continue;
      violations += 1;
      sample ??= `${label}${id} 有明细${total}但累计为0`;
    }
  };
  compare(
    purchaseItems.map((row) => ({
      id: row.id,
      quantity: row.quantity,
      actual: row.receivedQuantity,
    })),
    receiptItems,
    '采购明细',
  );
  compare(
    salesItems.map((row) => ({
      id: row.id,
      quantity: row.quantity,
      actual: row.shippedQuantity,
    })),
    shipmentItems,
    '销售明细',
  );
  return check('fulfilled-quantities', '订单累计入出库量等于明细合计', violations, sample);
}

/** 应付/应收余额必须等于其结算流水合计。 */
async function settlementBalances(client: Client): Promise<IntegrityCheck> {
  const [payables, receivables, payments, receipts] = await Promise.all([
    client.payable.findMany({
      select: { id: true, originalAmount: true, paidAmount: true, status: true },
    }),
    client.receivable.findMany({
      select: { id: true, originalAmount: true, receivedAmount: true, status: true },
    }),
    client.settlementRecord.groupBy({
      by: ['payableId'],
      where: { type: 'PAYMENT' },
      _sum: { amount: true },
    }),
    client.settlementRecord.groupBy({
      by: ['receivableId'],
      where: { type: 'RECEIPT' },
      _sum: { amount: true },
    }),
  ]);
  let violations = 0;
  let sample: string | undefined;
  const paid = new Map(payments.map((row) => [row.payableId ?? '', row._sum.amount ?? 0]));
  for (const payable of payables) {
    const settled = paid.get(payable.id) ?? 0;
    paid.delete(payable.id);
    const expectedStatus =
      settled === payable.originalAmount
        ? 'SETTLED'
        : settled > 0
          ? 'PARTIAL'
          : 'UNSETTLED';
    if (settled !== payable.paidAmount || settled > payable.originalAmount || payable.status !== expectedStatus) {
      violations += 1;
      sample ??= `应付${payable.id} 已付${payable.paidAmount}≠流水${settled}`;
    }
  }
  for (const [id, settled] of paid) {
    if (!id || settled === 0) continue;
    violations += 1;
    sample ??= `应付${id} 有付款${settled}但单据缺失`;
  }
  const received = new Map(receipts.map((row) => [row.receivableId ?? '', row._sum.amount ?? 0]));
  for (const receivable of receivables) {
    const settled = received.get(receivable.id) ?? 0;
    received.delete(receivable.id);
    const expectedStatus =
      settled === receivable.originalAmount
        ? 'SETTLED'
        : settled > 0
          ? 'PARTIAL'
          : 'UNSETTLED';
    if (
      settled !== receivable.receivedAmount ||
      settled > receivable.originalAmount ||
      receivable.status !== expectedStatus
    ) {
      violations += 1;
      sample ??= `应收${receivable.id} 已收${receivable.receivedAmount}≠流水${settled}`;
    }
  }
  for (const [id, settled] of received) {
    if (!id || settled === 0) continue;
    violations += 1;
    sample ??= `应收${id} 有收款${settled}但单据缺失`;
  }
  return check('settlement-balances', '应收应付余额等于结算流水合计', violations, sample);
}

/** 每张正式单据必须生成且仅生成一张往来单，金额一致。 */
async function sourceDocuments(client: Client): Promise<IntegrityCheck> {
  const [receipts, payables, shipments, receivables] = await Promise.all([
    client.goodsReceipt.findMany({ select: { id: true, totalAmount: true } }),
    client.payable.findMany({ select: { receiptId: true, originalAmount: true } }),
    client.salesShipment.findMany({ select: { id: true, totalAmount: true } }),
    client.receivable.findMany({ select: { shipmentId: true, originalAmount: true } }),
  ]);
  let violations = 0;
  let sample: string | undefined;
  const payableMap = new Map(payables.map((row) => [row.receiptId, row.originalAmount]));
  for (const receipt of receipts) {
    const amount = payableMap.get(receipt.id);
    payableMap.delete(receipt.id);
    if (amount === undefined || amount !== receipt.totalAmount) {
      violations += 1;
      sample ??= `入库单${receipt.id}应付${amount ?? '缺失'}≠${receipt.totalAmount}`;
    }
  }
  for (const [id, amount] of payableMap) {
    violations += 1;
    sample ??= `应付来源${id}无对应入库单(${amount})`;
  }
  const receivableMap = new Map(receivables.map((row) => [row.shipmentId, row.originalAmount]));
  for (const shipment of shipments) {
    const amount = receivableMap.get(shipment.id);
    receivableMap.delete(shipment.id);
    if (amount === undefined || amount !== shipment.totalAmount) {
      violations += 1;
      sample ??= `出库单${shipment.id}应收${amount ?? '缺失'}≠${shipment.totalAmount}`;
    }
  }
  for (const [id, amount] of receivableMap) {
    violations += 1;
    sample ??= `应收来源${id}无对应出库单(${amount})`;
  }
  return check('source-documents', '正式单据与往来单一一对应且金额一致', violations, sample);
}

/** 流水必须且只能挂一个业务来源，正式单据不可出现游离流水。 */
async function movementSources(client: Client): Promise<IntegrityCheck> {
  const movements = await client.stockMovement.findMany({
    select: { id: true, type: true, receiptId: true, shipmentId: true, adjustmentId: true },
  });
  let violations = 0;
  let sample: string | undefined;
  for (const movement of movements) {
    const sources = [movement.receiptId, movement.shipmentId, movement.adjustmentId].filter(
      (value) => value !== null,
    );
    const expected =
      movement.type === 'PURCHASE_RECEIPT'
        ? 'receiptId'
        : movement.type === 'SALES_SHIPMENT'
          ? 'shipmentId'
          : movement.type === 'STOCK_ADJUSTMENT'
            ? 'adjustmentId'
            : '';
    const matches =
      sources.length === 1 &&
      (expected === 'receiptId'
        ? movement.receiptId !== null
        : expected === 'shipmentId'
          ? movement.shipmentId !== null
          : expected === 'adjustmentId'
            ? movement.adjustmentId !== null
            : false);
    if (!matches) {
      violations += 1;
      sample ??= `流水${movement.id}类型${movement.type}来源数${sources.length}`;
    }
  }
  return check('movement-sources', '库存流水来源唯一且与类型匹配', violations, sample);
}

export async function checkIntegrity(client: Client = prisma): Promise<IntegrityReport> {
  const checks = await Promise.all([
    stockLedger(client),
    movementChain(client),
    documentAmounts(client),
    fulfilledQuantities(client),
    settlementBalances(client),
    sourceDocuments(client),
    movementSources(client),
  ]);
  return {
    ok: checks.every((item) => item.violations === 0),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

const sha256File = async (path: string) => {
  const { readFile } = await import('node:fs/promises');
  return createHash('sha256').update(await readFile(path)).digest('hex');
};

/** 生成一致性快照备份；目标已存在时拒绝，避免覆盖既有备份。 */
export async function backupDatabase(
  destination: string,
  client: Client = prisma,
): Promise<BackupResult> {
  const target = resolve(destination);
  const source = await databaseFile(client);
  if (resolve(source) === target)
    throw new Error('备份目标不能与当前数据库相同');
  if (existsSync(target))
    throw new Error(`备份目标已存在，拒绝覆盖：${target}`);
  await mkdir(dirname(target), { recursive: true });
  // VACUUM INTO 由 SQLite 在事务一致性视图下写出快照，不会捕获到半个事务。
  await client.$executeRawUnsafe(`VACUUM INTO ${quoted(target)}`);
  const info = await stat(target);
  const integrity = await checkIntegrity(client);
  if (!integrity.ok)
    throw new Error(
      `源数据库账实核对未通过，拒绝备份：${integrity.checks
        .filter((item) => item.violations > 0)
        .map((item) => item.label)
        .join('、')}`,
    );
  return {
    path: target,
    bytes: info.size,
    sha256: await sha256File(target),
    createdAt: new Date().toISOString(),
  };
}

/** 从备份恢复到不存在的新库，校验完整性并清除历史会话。 */
export async function restoreDatabase(
  backup: string,
  target: string,
): Promise<RestoreResult> {
  const source = resolve(backup);
  const destination = resolve(target);
  if (source === destination) throw new Error('恢复目标不能与备份相同');
  if (!existsSync(source)) throw new Error(`备份文件不存在：${source}`);
  if (existsSync(destination))
    throw new Error(`恢复目标已存在，拒绝覆盖：${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const client = new PrismaClient({
    datasourceUrl: `file:${destination.replaceAll('\\', '/')}`,
  });
  try {
    const integrity = await checkIntegrity(client);
    if (!integrity.ok)
      throw new Error(
        `备份账实核对未通过，拒绝恢复：${integrity.checks
          .filter((item) => item.violations > 0)
          .map((item) => item.label)
          .join('、')}`,
      );
    const sessions = await client.session.deleteMany();
    return {
      ok: true,
      target: destination,
      source,
      sessionsCleared: sessions.count,
      integrity: await checkIntegrity(client),
    };
  } finally {
    await client.$disconnect();
  }
}

export interface RestoreDrillResult {
  backup: BackupResult;
  restore: RestoreResult;
  before: IntegrityReport;
  after: IntegrityReport;
}

/**
 * 恢复演练：备份当前库 → 恢复到独立新库 → 双库账实核对。
 * 全程不触碰生产库，失败时保留现场供排查。
 */
export async function restoreDrill(
  directory: string,
  stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19),
): Promise<RestoreDrillResult> {
  const before = await checkIntegrity();
  const backup = await backupDatabase(resolve(directory, `kingflow-${stamp}.db`));
  const restore = await restoreDatabase(
    backup.path,
    resolve(directory, `kingflow-restored-${stamp}.db`),
  );
  const after = restore.integrity;
  return { backup, restore, before, after };
}
