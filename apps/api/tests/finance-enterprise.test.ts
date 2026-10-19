import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, ORIGIN, type TestServer } from './server.js';
import { checkIntegrity } from '../src/services/recovery-service.js';

/**
 * 应收应付 / 收付款结算 / 财务概览的企业级深度验收。
 *
 * 全部断言落在真实 SQLite 与真实 HTTP 上：先建业务单据（采购入库→应付、
 * 销售出库→应收），再走收付款 API，最后回查数据库余额、结算流水、幂等记录、
 * 审计日志与跨模块账实一致性。
 */

const PASSWORD = 'Test@12345';
const DAY = 86400000;
/** 上海当日 00:00 对应的绝对时刻（半开区间左端）。 */
const shanghai = (date: string) => new Date(date + 'T00:00:00+08:00');
const today = () => new Date(Date.now() + 28800000).toISOString().slice(0, 10);

type TestAgent = ReturnType<TestServer['agent']>;
interface Client {
  agent: TestAgent;
  csrf: string;
  user: { id: string; username: string; role: { code: string; permissions: string[] } };
  get: (path: string) => ReturnType<TestAgent['get']>;
  post: (path: string, body: object, key?: string) => ReturnType<TestAgent['post']>;
}

let server: TestServer;
let admin: Client;
let finance: Client;
let financePeer: Client;
let salesUser: Client;
let purchaseUser: Client;
let warehouseUser: Client;
let guestUser: Client;
let categoryId = '';
let productId = '';
let warehouseId = '';
let supplierId = '';
let customerId = '';
let keySeq = 0;
const nextKey = (label: string) => `fin-${label}-${++keySeq}`;

async function makeClient(username: string): Promise<Client> {
  const agent = server.agent();
  const login = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password: PASSWORD });
  expect(login.status).toBe(200);
  const csrf = login.body.data.csrfToken as string;
  const post = (path: string, body: object, key?: string) => {
    const req = agent
      .post('/api/v1' + path)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  return {
    agent,
    csrf,
    user: login.body.data.user,
    // 允许传 '/receivables' 或完整 '/api/v1/receivables'，避免前缀重复拼接。
    get: (path: string) =>
      agent.get(path.startsWith('/api/v1/') ? path : '/api/v1' + path),
    post,
  };
}

async function seedRole(code: string, permissions: string[]) {
  const role = await prisma.role.create({
    data: { code, name: code, permissions: JSON.stringify(permissions) },
  });
  return role.id;
}

async function seedUser(username: string, roleId: string) {
  return prisma.user.create({
    data: {
      username,
      displayName: username,
      passwordHash: await hash(PASSWORD, 4),
      roleId,
    },
  });
}

/** 采购入库 → 生成一张应付；返回应付来源与原始金额。 */
async function receivePurchase(quantity: number, unitPrice: number) {
  const created = await admin.post('/purchase-orders', {
    supplierId,
    warehouseId,
    orderDate: today(),
    items: [{ productId, quantity, unitPrice }],
  });
  expect(created.status).toBe(201);
  const order = created.body.data;
  for (const action of ['submit', 'approve'])
    expect(
      (await admin.post(`/purchase-orders/${order.id}/${action}`, {})).status,
    ).toBe(200);
  const receipt = await admin.post(
    '/goods-receipts',
    {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity }],
    },
    nextKey('receipt'),
  );
  expect(receipt.status).toBe(201);
  const payable = await prisma.payable.findUniqueOrThrow({
    where: { receiptId: receipt.body.data.id },
  });
  return { order, receipt: receipt.body.data, payable };
}

/** 销售出库 → 生成一张应收；返回应收来源与原始金额。 */
async function shipSale(quantity: number, unitPrice: number) {
  const created = await admin.post('/sales-orders', {
    customerId,
    warehouseId,
    orderDate: today(),
    items: [{ productId, quantity, unitPrice }],
  });
  expect(created.status).toBe(201);
  const order = created.body.data;
  for (const action of ['submit', 'approve'])
    expect(
      (await admin.post(`/sales-orders/${order.id}/${action}`, {})).status,
    ).toBe(200);
  const shipment = await admin.post(
    '/sales-shipments',
    {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity }],
    },
    nextKey('shipment'),
  );
  expect(shipment.status).toBe(201);
  const receivable = await prisma.receivable.findUniqueOrThrow({
    where: { shipmentId: shipment.body.data.id },
  });
  return { order, shipment: shipment.body.data, receivable };
}

async function receivableState(id: string) {
  const row = await prisma.receivable.findUniqueOrThrow({ where: { id } });
  const records = await prisma.settlementRecord.findMany({
    where: { receivableId: id },
    orderBy: { createdAt: 'asc' },
  });
  return {
    originalAmount: row.originalAmount,
    receivedAmount: row.receivedAmount,
    status: row.status,
    count: records.length,
    sum: records.reduce((total, item) => total + item.amount, 0),
  };
}

async function payableState(id: string) {
  const row = await prisma.payable.findUniqueOrThrow({ where: { id } });
  const records = await prisma.settlementRecord.findMany({
    where: { payableId: id },
    orderBy: { createdAt: 'asc' },
  });
  return {
    originalAmount: row.originalAmount,
    paidAmount: row.paidAmount,
    status: row.status,
    count: records.length,
    sum: records.reduce((total, item) => total + item.amount, 0),
  };
}

beforeAll(async () => {
  server = await startTestServer();
  await cleanDatabase();
  const adminRole = await seedRole('ADMIN', ['*']);
  const financeRole = await seedRole('FINANCE', [
    'master:read',
    'shipments:read',
    'receipts:read',
    'payables:read',
    'receivables:read',
    'finance:read',
    'settlements:write',
  ]);
  const financePeerRole = await seedRole('FINANCE-PEER', [
    'master:read',
    'payables:read',
    'receivables:read',
    'finance:read',
    'settlements:write',
  ]);
  const salesRole = await seedRole('SALES', [
    'master:read',
    'customers:write',
    'inventory:read',
    'sales:read',
    'sales:write',
    'sales:approve',
    'shipments:read',
  ]);
  const purchaseRole = await seedRole('PURCHASE', [
    'master:read',
    'products:write',
    'categories:write',
    'suppliers:write',
    'purchase:read',
    'purchase:write',
    'purchase:approve',
    'receipts:read',
    'inventory:read',
  ]);
  const warehouseRole = await seedRole('WAREHOUSE', [
    'master:read',
    'purchase:read',
    'receipts:read',
    'receipts:post',
    'sales:read',
    'shipments:read',
    'shipments:post',
    'inventory:read',
    'inventory:adjust',
  ]);
  const guestRole = await seedRole('GUEST', [
    'master:read',
    'purchase:read',
    'receipts:read',
    'sales:read',
    'shipments:read',
    'inventory:read',
  ]);
  await seedUser('fin-admin', adminRole);
  await seedUser('fin-finance', financeRole);
  await seedUser('fin-peer', financePeerRole);
  await seedUser('fin-sales', salesRole);
  await seedUser('fin-purchase', purchaseRole);
  await seedUser('fin-warehouse', warehouseRole);
  await seedUser('fin-guest', guestRole);
  admin = await makeClient('fin-admin');
  finance = await makeClient('fin-finance');
  financePeer = await makeClient('fin-peer');
  salesUser = await makeClient('fin-sales');
  purchaseUser = await makeClient('fin-purchase');
  warehouseUser = await makeClient('fin-warehouse');
  guestUser = await makeClient('fin-guest');

  const category = await admin.post('/categories', {
    code: 'FNC',
    name: '财务验收分类',
  });
  expect(category.status).toBe(201);
  categoryId = category.body.data.id;
  const product = await admin.post('/products', {
    code: 'FNP1',
    name: '财务验收商品',
    categoryId,
    unit: '件',
    purchasePrice: 8000,
    salesPrice: 12000,
    minStock: 0,
  });
  expect(product.status).toBe(201);
  productId = product.body.data.id;
  warehouseId = (await admin.post('/warehouses', { code: 'FNW1', name: '财务验收仓' }))
    .body.data.id;
  supplierId = (await admin.post('/suppliers', { code: 'FNS1', name: '财务验收供应商' }))
    .body.data.id;
  customerId = (await admin.post('/customers', { code: 'FNC1', name: '财务验收客户' }))
    .body.data.id;
  const opening = await admin.post(
    '/stock-adjustments',
    { productId, warehouseId, quantity: 1000, reason: '财务验收期初' },
    nextKey('opening'),
  );
  expect(opening.status).toBe(201);
}, 60000);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

describe.sequential('财务往来企业级验收', { timeout: 120000 }, () => {
  it('金额边界：0/负数/小数/超上限/超余额全部拒绝，数据库无副作用', async () => {
    const { payable } = await receivePurchase(1, 1000);
    const before = await payableState(payable.id);
    const idempotencyBefore = await prisma.idempotencyRecord.count();
    expect(before).toMatchObject({
      originalAmount: 1000,
      paidAmount: 0,
      status: 'UNSETTLED',
      count: 0,
    });
    const base = {
      sourceId: payable.id,
      date: today(),
      method: '现金' as const,
    };
    for (const [index, amount] of [0, -1, 0.5, 0.01, 2_000_000_001].entries()) {
      const response = await admin.post(
        '/settlements/payments',
        { ...base, amount },
        nextKey('bad-amount-' + index),
      );
      expect(response.status, `金额 ${amount} 应被拒绝`).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const over = await admin.post(
      '/settlements/payments',
      { ...base, amount: 1001 },
      nextKey('over-balance'),
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('EXCESS_SETTLEMENT');
    // 失败请求不得留下余额、结算流水或幂等记录。
    expect(await payableState(payable.id)).toEqual(before);
    expect(await prisma.settlementRecord.count({ where: { payableId: payable.id } })).toBe(0);
    expect(await prisma.idempotencyRecord.count()).toBe(idempotencyBefore);
  });

  it('部分结清→全部结清→已结清再收付拒绝，余额/状态与流水一致', async () => {
    const { receivable } = await shipSale(3, 12000);
    expect(receivable.originalAmount).toBe(36000);
    const first = await admin.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 10000, date: today(), method: '银行转账', remark: '首笔' },
      nextKey('ar-first'),
    );
    expect(first.status).toBe(201);
    expect(await receivableState(receivable.id)).toMatchObject({
      receivedAmount: 10000,
      status: 'PARTIAL',
      count: 1,
      sum: 10000,
    });
    const second = await admin.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 26000, date: today(), method: '银行转账' },
      nextKey('ar-last'),
    );
    expect(second.status).toBe(201);
    const settled = await receivableState(receivable.id);
    expect(settled).toMatchObject({
      receivedAmount: 36000,
      status: 'SETTLED',
      count: 2,
      sum: 36000,
    });
    // 已结清再收款必须拒绝，且不产生任何新记录。
    const extra = await admin.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 1, date: today(), method: '现金' },
      nextKey('ar-after-settled'),
    );
    expect(extra.status).toBe(409);
    expect(extra.body.error.code).toBe('EXCESS_SETTLEMENT');
    expect(await receivableState(receivable.id)).toEqual(settled);
    // 付款侧对称：部分→全部→拒绝。
    const { payable } = await receivePurchase(2, 5000);
    expect(payable.originalAmount).toBe(10000);
    expect(
      (
        await admin.post(
          '/settlements/payments',
          { sourceId: payable.id, amount: 4000, date: today(), method: '现金' },
          nextKey('ap-part'),
        )
      ).status,
    ).toBe(201);
    expect(await payableState(payable.id)).toMatchObject({
      paidAmount: 4000,
      status: 'PARTIAL',
    });
    expect(
      (
        await admin.post(
          '/settlements/payments',
          { sourceId: payable.id, amount: 6000, date: today(), method: '现金' },
          nextKey('ap-last'),
        )
      ).status,
    ).toBe(201);
    expect(await payableState(payable.id)).toMatchObject({
      paidAmount: 10000,
      status: 'SETTLED',
    });
    expect(
      (
        await admin.post(
          '/settlements/payments',
          { sourceId: payable.id, amount: 1, date: today(), method: '现金' },
          nextKey('ap-after-settled'),
        )
      ).status,
    ).toBe(409);
  });

  it('来源不存在 404、收付类型与来源不匹配 404，且不泄露其他单据', async () => {
    const { receivable } = await shipSale(1, 12000);
    const { payable } = await receivePurchase(1, 8000);
    const arBefore = await receivableState(receivable.id);
    const apBefore = await payableState(payable.id);
    const missing = await admin.post(
      '/settlements/receipts',
      { sourceId: 'not-exists-id', amount: 1, date: today(), method: '现金' },
      nextKey('missing-source'),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    const wrongType = await admin.post(
      '/settlements/receipts',
      { sourceId: payable.id, amount: 1, date: today(), method: '现金' },
      nextKey('wrong-type-receipt'),
    );
    expect(wrongType.status).toBe(404);
    expect(wrongType.body.error.code).toBe('NOT_FOUND');
    const wrongType2 = await admin.post(
      '/settlements/payments',
      { sourceId: receivable.id, amount: 1, date: today(), method: '现金' },
      nextKey('wrong-type-payment'),
    );
    expect(wrongType2.status).toBe(404);
    // 错误请求不得改动任一侧余额，也不得泄露单据金额。
    expect(await receivableState(receivable.id)).toEqual(arBefore);
    expect(await payableState(payable.id)).toEqual(apBefore);
    expect(JSON.stringify(wrongType.body)).not.toContain(String(payable.originalAmount));
    expect(
      (await admin.get('/api/v1/receivables/not-exists-id')).status,
    ).toBe(404);
    // 用应付 id 查应收详情同样 404，不串类型。
    expect((await admin.get('/api/v1/receivables/' + payable.id)).status).toBe(404);
    expect((await admin.get('/api/v1/payables/' + receivable.id)).status).toBe(404);
  });

  it('幂等：同键重放返回同一单据，同键异内容/跨业务/跨用户 409', async () => {
    const { receivable } = await shipSale(2, 12000);
    const body = { sourceId: receivable.id, amount: 5000, date: today(), method: '现金' };
    const key = nextKey('idem');
    const first = await admin.post('/settlements/receipts', body, key);
    expect(first.status).toBe(201);
    const afterFirst = await receivableState(receivable.id);
    const replay = await admin.post('/settlements/receipts', body, key);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await receivableState(receivable.id)).toEqual(afterFirst);
    // 同键异内容：金额变化。
    const differentAmount = await admin.post(
      '/settlements/receipts',
      { ...body, amount: 5001 },
      key,
    );
    expect(differentAmount.status).toBe(409);
    expect(differentAmount.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 同键异内容：日期或方式变化。
    expect(
      (
        await admin.post(
          '/settlements/receipts',
          { ...body, date: '2026-10-18' },
          key,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await admin.post(
          '/settlements/receipts',
          { ...body, method: '其他' },
          key,
        )
      ).status,
    ).toBe(409);
    // 跨业务复用键：入库单幂等键不能用于结算。
    const { receipt } = await receivePurchase(1, 1000);
    const receiptKey = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { receiptId: receipt.id },
    });
    const crossBusiness = await admin.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 1, date: today(), method: '现金' },
      receiptKey.key,
    );
    expect(crossBusiness.status).toBe(409);
    expect(crossBusiness.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 跨用户复用键：另一个财务账号使用同一键必须冲突。
    const crossUser = await financePeer.post('/settlements/receipts', body, key);
    expect(crossUser.status).toBe(409);
    expect(crossUser.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 键格式非法或缺失一律 422。
    const badKey = await admin.agent
      .post('/api/v1/settlements/receipts')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .set('Idempotency-Key', 'short')
      .send(body);
    expect(badKey.status).toBe(422);
    expect((await admin.post('/settlements/receipts', body)).status).toBe(422);
    // 只有一条结算单与一条幂等记录。
    expect(await prisma.settlementRecord.count({ where: { receivableId: receivable.id } })).toBe(1);
    expect(await prisma.idempotencyRecord.count({ where: { settlementId: first.body.data.id } })).toBe(1);
  });

  it('20 路同键并发只生成一张结算单，重放返回同一单据', async () => {
    const { payable } = await receivePurchase(10, 8000);
    const body = {
      sourceId: payable.id,
      amount: payable.originalAmount,
      date: today(),
      method: '银行转账',
    };
    const key = nextKey('same-key');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        admin.post('/settlements/payments', body, key),
      ),
    );
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(19);
    const ids = new Set(results.map((result) => result.body.data.id));
    expect(ids.size).toBe(1);
    const state = await payableState(payable.id);
    expect(state).toMatchObject({
      paidAmount: payable.originalAmount,
      status: 'SETTLED',
      count: 1,
      sum: payable.originalAmount,
    });
    expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { resource: 'settlements', resourceId: [...ids][0] } })).toBe(1);
  });

  it('20 路不同键抢余额：恰好 10 次成功，合计等于原额且无超结', async () => {
    const { payable } = await receivePurchase(10, 8000);
    const original = payable.originalAmount;
    expect(original).toBe(80000);
    const amount = original / 10;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        admin.post(
          '/settlements/payments',
          { sourceId: payable.id, amount, date: today(), method: '银行转账' },
          nextKey('race-' + index),
        ),
      ),
    );
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(10);
    expect(statuses.filter((status) => status === 409)).toHaveLength(10);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
    const state = await payableState(payable.id);
    // 硬不变式：已付恰好等于原额，绝不超结。
    expect(state.paidAmount).toBe(original);
    expect(state.paidAmount).toBeLessThanOrEqual(state.originalAmount);
    expect(state.status).toBe('SETTLED');
    expect(state.count).toBe(10);
    expect(state.sum).toBe(original);
    expect(await prisma.settlementRecord.count({ where: { payableId: payable.id } })).toBe(10);
    const integrity = await checkIntegrity();
    expect(
      integrity.checks.filter((item) => item.violations > 0),
      JSON.stringify(integrity.checks),
    ).toEqual([]);
  });

  it('混合并发（收款/查询/概览/报表）后余额恒等且账实一致', async () => {
    const { receivable } = await shipSale(10, 12000);
    const original = receivable.originalAmount;
    const amount = 5000;
    const writes = Array.from({ length: 8 }, (_, index) =>
      admin.post(
        '/settlements/receipts',
        { sourceId: receivable.id, amount, date: today(), method: '银行转账' },
        nextKey('mixed-' + index),
      ),
    );
    const reads = [
      ...Array.from({ length: 6 }, () => admin.get('/api/v1/receivables/' + receivable.id)),
      ...Array.from({ length: 6 }, () => admin.get('/api/v1/finance/summary')),
      ...Array.from({ length: 6 }, () => admin.get('/api/v1/reports/finance')),
      ...Array.from({ length: 6 }, () => admin.get('/api/v1/settlements?pageSize=100')),
    ];
    const results = await Promise.all([...writes, ...reads]);
    expect(
      results.slice(0, 8).map((result) => result.status),
      JSON.stringify(results.slice(0, 8).map((result) => result.body?.error)),
    ).toEqual(Array(8).fill(201));
    expect(
      results.slice(8).map((result) => result.status),
      JSON.stringify(results.slice(8).map((result) => result.body?.error)),
    ).toEqual(Array(reads.length).fill(200));
    const state = await receivableState(receivable.id);
    expect(state).toMatchObject({
      originalAmount: original,
      receivedAmount: 8 * amount,
      status: 'PARTIAL',
      count: 8,
      sum: 8 * amount,
    });
    // 恒等式：已收 = 结算流水合计 = 汇总未结的补数。
    const summary = (await admin.get('/api/v1/finance/summary')).body.data;
    const dbReceived = await prisma.settlementRecord.aggregate({
      where: { type: 'RECEIPT' },
      _sum: { amount: true },
    });
    expect(summary.receipts).toBe(dbReceived._sum.amount ?? 0);
    expect(summary.receivableRemaining).toBe(summary.receivableTotal - summary.receipts);
    const integrity = await checkIntegrity();
    expect(
      integrity.checks.filter((item) => item.violations > 0),
      JSON.stringify(integrity.checks),
    ).toEqual([]);
  });

  it('应收应付列表按 createdAt 的上海半开区间过滤，00:00 与 23:59 边界不串日', async () => {
    const { receivable: first } = await shipSale(1, 100);
    const { receivable: second } = await shipSale(1, 200);
    await prisma.receivable.update({
      where: { id: first.id },
      data: { createdAt: new Date('2026-10-18T16:00:00Z') }, // 2026-10-19 00:00 CST
    });
    await prisma.receivable.update({
      where: { id: second.id },
      data: { createdAt: new Date('2026-10-18T15:59:59Z') }, // 2026-10-18 23:59:59 CST
    });
    const ids = async (query: string) =>
      (
        await admin.get('/api/v1/receivables?pageSize=100&' + query)
      ).body.data.items.map((item: { id: string }) => item.id);
    const day19 = await ids('dateFrom=2026-10-19&dateTo=2026-10-19');
    expect(day19).toContain(first.id);
    expect(day19).not.toContain(second.id);
    const day18 = await ids('dateFrom=2026-10-18&dateTo=2026-10-18');
    expect(day18).toContain(second.id);
    expect(day18).not.toContain(first.id);
    // 只给一端：dateFrom=19 排除 18 日；dateTo=18 排除 19 日。
    const from19 = await ids('dateFrom=2026-10-19');
    expect(from19).toContain(first.id);
    expect(from19).not.toContain(second.id);
    const to18 = await ids('dateTo=2026-10-18');
    expect(to18).toContain(second.id);
    expect(to18).not.toContain(first.id);
    // 应付侧同规则。
    const { payable } = await receivePurchase(1, 100);
    await prisma.payable.update({
      where: { id: payable.id },
      data: { createdAt: new Date('2026-10-18T16:00:00Z') },
    });
    const payableIds = (
      await admin.get('/api/v1/payables?pageSize=100&dateFrom=2026-10-19&dateTo=2026-10-19')
    ).body.data.items.map((item: { id: string }) => item.id);
    expect(payableIds).toContain(payable.id);
    expect(
      (
        await admin.get('/api/v1/payables?pageSize=100&dateTo=2026-10-18')
      ).body.data.items.map((item: { id: string }) => item.id),
    ).not.toContain(payable.id);
    // 反向日期被拒绝。
    expect(
      (await admin.get('/api/v1/receivables?dateFrom=2026-10-19&dateTo=2026-10-18')).status,
    ).toBe(422);
  });

  it('结算业务日期与 createdAt 分离：列表与概览都按业务日期口径', async () => {
    const { receivable } = await shipSale(3, 12000);
    const businessDate = '2026-10-05';
    const created = await admin.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 700, date: businessDate, method: '现金' },
      nextKey('business-date'),
    );
    expect(created.status).toBe(201);
    const record = await prisma.settlementRecord.findUniqueOrThrow({
      where: { id: created.body.data.id },
    });
    expect(record.date).toBe(businessDate);
    expect(record.createdAt.getTime()).toBeGreaterThan(shanghai('2026-10-19').getTime());
    // 列表按业务日期命中，按生成日期不命中。
    const byBusiness = (
      await admin.get(
        `/api/v1/settlements?pageSize=100&dateFrom=${businessDate}&dateTo=${businessDate}`,
      )
    ).body.data;
    expect(byBusiness.items.map((item: { id: string }) => item.id)).toContain(record.id);
    const byCreatedDay = (
      await admin.get(`/api/v1/settlements?pageSize=100&dateFrom=${today()}&dateTo=${today()}`)
    ).body.data;
    expect(byCreatedDay.items.map((item: { id: string }) => item.id)).not.toContain(record.id);
    // 概览收付款与列表口径一致。
    const period = (
      await admin.get(
        `/api/v1/finance/summary?dateFrom=${businessDate}&dateTo=${businessDate}`,
      )
    ).body.data;
    expect(period.receipts).toBe(700);
    const dbPeriod = await prisma.settlementRecord.aggregate({
      where: { type: 'RECEIPT', date: { gte: businessDate, lte: businessDate } },
      _sum: { amount: true },
    });
    expect(period.receipts).toBe(dbPeriod._sum.amount ?? 0);
  });

  it('结算记录筛选：类型/往来单位/来源单据/状态/关键词/排序/分页不重不漏', async () => {
    // 另建一组客户与供应商，构造可区分的来源单据。
    const otherCustomer = (
      await admin.post('/customers', { code: 'FNC2', name: '财务第二客户' })
    ).body.data;
    const otherSupplier = (
      await admin.post('/suppliers', { code: 'FNS2', name: '财务第二供应商' })
    ).body.data;
    const sale = await admin.post('/sales-orders', {
      customerId: otherCustomer.id,
      warehouseId,
      orderDate: today(),
      items: [{ productId, quantity: 1, unitPrice: 900 }],
    });
    const saleOrder = sale.body.data;
    for (const action of ['submit', 'approve'])
      expect((await admin.post(`/sales-orders/${saleOrder.id}/${action}`, {})).status).toBe(200);
    const shipment = await admin.post(
      '/sales-shipments',
      { orderId: saleOrder.id, items: [{ orderItemId: saleOrder.items[0].id, quantity: 1 }] },
      nextKey('filter-shipment'),
    );
    expect(shipment.status).toBe(201);
    const receivable = await prisma.receivable.findUniqueOrThrow({
      where: { shipmentId: shipment.body.data.id },
    });
    const purchase = await admin.post('/purchase-orders', {
      supplierId: otherSupplier.id,
      warehouseId,
      orderDate: today(),
      items: [{ productId, quantity: 1, unitPrice: 700 }],
    });
    const purchaseOrder = purchase.body.data;
    for (const action of ['submit', 'approve'])
      expect((await admin.post(`/purchase-orders/${purchaseOrder.id}/${action}`, {})).status).toBe(200);
    const receipt = await admin.post(
      '/goods-receipts',
      { orderId: purchaseOrder.id, items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 1 }] },
      nextKey('filter-receipt'),
    );
    expect(receipt.status).toBe(201);
    const payable = await prisma.payable.findUniqueOrThrow({
      where: { receiptId: receipt.body.data.id },
    });
    const receiptSettlement = await admin.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 300, date: '2026-10-06', method: '现金', remark: '第二客户收款' },
      nextKey('filter-ar'),
    );
    expect(receiptSettlement.status).toBe(201);
    const paymentSettlement = await admin.post(
      '/settlements/payments',
      { sourceId: payable.id, amount: 200, date: '2026-10-07', method: '现金', remark: '第二供应商付款' },
      nextKey('filter-ap'),
    );
    expect(paymentSettlement.status).toBe(201);
    const receiptRecordId = receiptSettlement.body.data.id;
    const paymentRecordId = paymentSettlement.body.data.id;
    const query = async (search: string) =>
      (await admin.get('/api/v1/settlements?pageSize=100&' + search)).body.data;

    const receiptsOnly = await query('type=RECEIPT');
    expect(receiptsOnly.items.every((item: { type: string }) => item.type === 'RECEIPT')).toBe(true);
    expect(receiptsOnly.total).toBe(
      await prisma.settlementRecord.count({ where: { type: 'RECEIPT' } }),
    );
    const byCustomer = await query('customerId=' + otherCustomer.id);
    expect(byCustomer.items.map((item: { id: string }) => item.id)).toContain(receiptRecordId);
    expect(byCustomer.items.map((item: { id: string }) => item.id)).not.toContain(paymentRecordId);
    expect(byCustomer.total).toBe(
      await prisma.settlementRecord.count({
        where: { receivable: { customerId: otherCustomer.id } },
      }),
    );
    const bySupplier = await query('supplierId=' + otherSupplier.id);
    expect(bySupplier.items.map((item: { id: string }) => item.id)).toContain(paymentRecordId);
    expect(bySupplier.items.map((item: { id: string }) => item.id)).not.toContain(receiptRecordId);
    const byReceipt = await query('receiptId=' + receipt.body.data.id);
    expect(byReceipt.items.map((item: { id: string }) => item.id)).toEqual([paymentRecordId]);
    const byShipment = await query('shipmentId=' + shipment.body.data.id);
    expect(byShipment.items.map((item: { id: string }) => item.id)).toEqual([receiptRecordId]);
    // 状态筛选作用在来源单据状态上。
    const partial = await query('status=PARTIAL');
    expect(partial.items.map((item: { id: string }) => item.id)).toContain(receiptRecordId);
    expect(partial.total).toBe(
      await prisma.settlementRecord.count({
        where: {
          OR: [{ receivable: { status: 'PARTIAL' } }, { payable: { status: 'PARTIAL' } }],
        },
      }),
    );
    // 关键词命中往来单位名称。
    const byKeyword = await query('q=' + encodeURIComponent('财务第二客户'));
    expect(byKeyword.items.map((item: { id: string }) => item.id)).toContain(receiptRecordId);
    expect(byKeyword.items.map((item: { id: string }) => item.id)).not.toContain(paymentRecordId);
    // 排序稳定且方向正确。
    const asc = await query('sortOrder=asc');
    const ascTimes = asc.items.map((item: { createdAt: string }) => new Date(item.createdAt).getTime());
    expect(ascTimes).toEqual([...ascTimes].sort((left, right) => left - right));
    const desc = await query('sortOrder=desc');
    const descTimes = desc.items.map((item: { createdAt: string }) => new Date(item.createdAt).getTime());
    expect(descTimes).toEqual([...descTimes].sort((left, right) => right - left));
    // 强制同一 createdAt，分页仍不重不漏（需要稳定的次级排序）。
    await prisma.settlementRecord.updateMany({
      data: { createdAt: new Date('2026-10-19T01:00:00Z') },
    });
    const dbTotal = await prisma.settlementRecord.count();
    const seen: string[] = [];
    let page = 0;
    for (;;) {
      const data = (await admin.get(`/api/v1/settlements?page=${++page}&pageSize=2`)).body.data;
      expect(data.total).toBe(dbTotal);
      if (!data.items.length) break;
      seen.push(...data.items.map((item: { id: string }) => item.id));
    }
    expect(seen).toHaveLength(dbTotal);
    expect(new Set(seen).size).toBe(dbTotal);
    // 页码越界返回空列表但 total 不变。
    const beyond = (await admin.get(`/api/v1/settlements?page=${page + 5}&pageSize=2`)).body.data;
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(dbTotal);
    // 非法分页与未知参数被拒绝。
    expect((await admin.get('/api/v1/settlements?pageSize=101')).status).toBe(422);
    expect((await admin.get('/api/v1/settlements?unknown=1')).status).toBe(422);
  });

  it('财务概览口径：往来余额为当前累计，收付款按业务日期；与明细/往来报表恒等', async () => {
    const dbReceivable = await prisma.receivable.aggregate({
      _sum: { originalAmount: true, receivedAmount: true },
    });
    const dbPayable = await prisma.payable.aggregate({
      _sum: { originalAmount: true, paidAmount: true },
    });
    const all = (await admin.get('/api/v1/finance/summary')).body.data;
    expect(all.receivableTotal).toBe(dbReceivable._sum.originalAmount ?? 0);
    expect(all.receivableRemaining).toBe(
      (dbReceivable._sum.originalAmount ?? 0) - (dbReceivable._sum.receivedAmount ?? 0),
    );
    expect(all.payableTotal).toBe(dbPayable._sum.originalAmount ?? 0);
    expect(all.payableRemaining).toBe(
      (dbPayable._sum.originalAmount ?? 0) - (dbPayable._sum.paidAmount ?? 0),
    );
    // 日期过滤不影响往来余额（口径：待收付按未结余额，全部有效往来）。
    const ranged = (
      await admin.get('/api/v1/finance/summary?dateFrom=2026-10-01&dateTo=2026-10-02')
    ).body.data;
    expect(ranged.receivableTotal).toBe(all.receivableTotal);
    expect(ranged.receivableRemaining).toBe(all.receivableRemaining);
    expect(ranged.payableTotal).toBe(all.payableTotal);
    expect(ranged.payableRemaining).toBe(all.payableRemaining);
    // 收付款严格按业务日期，且与结算记录明细一致。
    const range = { dateFrom: '2026-10-06', dateTo: '2026-10-07' };
    const rangedCash = (
      await admin.get(
        `/api/v1/finance/summary?dateFrom=${range.dateFrom}&dateTo=${range.dateTo}`,
      )
    ).body.data;
    const dbReceipts = await prisma.settlementRecord.aggregate({
      where: { type: 'RECEIPT', date: { gte: range.dateFrom, lte: range.dateTo } },
      _sum: { amount: true },
    });
    const dbPayments = await prisma.settlementRecord.aggregate({
      where: { type: 'PAYMENT', date: { gte: range.dateFrom, lte: range.dateTo } },
      _sum: { amount: true },
    });
    expect(rangedCash.receipts).toBe(dbReceipts._sum.amount ?? 0);
    expect(rangedCash.payments).toBe(dbPayments._sum.amount ?? 0);
    const recordsInRange = (
      await admin.get(
        `/api/v1/settlements?pageSize=100&dateFrom=${range.dateFrom}&dateTo=${range.dateTo}`,
      )
    ).body.data;
    const listReceipts = recordsInRange.items
      .filter((item: { type: string }) => item.type === 'RECEIPT')
      .reduce((sum: number, item: { amount: number }) => sum + item.amount, 0);
    const listPayments = recordsInRange.items
      .filter((item: { type: string }) => item.type === 'PAYMENT')
      .reduce((sum: number, item: { amount: number }) => sum + item.amount, 0);
    expect(listReceipts).toBe(rangedCash.receipts);
    expect(listPayments).toBe(rangedCash.payments);
    // 往来报表（无日期）与概览、结算流水三方恒等。
    const financeReport = (await admin.get('/api/v1/reports/finance?pageSize=100')).body.data;
    expect(financeReport.total).toBe(
      (await prisma.receivable.count()) + (await prisma.payable.count()),
    );
    expect(financeReport.totals.amount).toBe(all.receivableTotal + all.payableTotal);
    expect(financeReport.totals.balance).toBe(
      all.receivableRemaining + all.payableRemaining,
    );
    const dbSettled = await prisma.settlementRecord.aggregate({ _sum: { amount: true } });
    expect(financeReport.totals.settled).toBe(dbSettled._sum.amount ?? 0);
    expect(financeReport.totals.settled).toBe(all.receipts + all.payments);
    // 报表按来源生成日期过滤，概览余额不受影响：两种口径都要自洽。
    const periodReport = (
      await admin.get('/api/v1/reports/finance?dateFrom=2026-10-19&dateTo=2026-10-19&pageSize=100')
    ).body.data;
    const dbPeriodAmount = await prisma.$transaction([
      prisma.receivable.aggregate({
        where: {
          createdAt: { gte: shanghai('2026-10-19'), lt: new Date(shanghai('2026-10-19').getTime() + DAY) },
        },
        _sum: { originalAmount: true },
      }),
      prisma.payable.aggregate({
        where: {
          createdAt: { gte: shanghai('2026-10-19'), lt: new Date(shanghai('2026-10-19').getTime() + DAY) },
        },
        _sum: { originalAmount: true },
      }),
    ]);
    expect(periodReport.totals.amount).toBe(
      (dbPeriodAmount[0]._sum.originalAmount ?? 0) + (dbPeriodAmount[1]._sum.originalAmount ?? 0),
    );
    expect(ranged.receivableTotal).toBe(all.receivableTotal);
  });

  it('零额往来直接结清且不可再结算；不存在负余额与负结算', async () => {
    const { receivable } = await shipSale(1, 0);
    expect(receivable.originalAmount).toBe(0);
    expect(receivable.status).toBe('SETTLED');
    const before = await receivableState(receivable.id);
    const attempt = await admin.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 1, date: today(), method: '现金' },
      nextKey('zero-source'),
    );
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('EXCESS_SETTLEMENT');
    expect(await receivableState(receivable.id)).toEqual(before);
    // 全库不存在负余额或已结超原额。
    const badReceivables = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT COUNT(*) AS count FROM "Receivable" WHERE "receivedAmount" < 0 OR "receivedAmount" > "originalAmount"',
    );
    expect(Number(badReceivables[0].count)).toBe(0);
    const badPayables = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT COUNT(*) AS count FROM "Payable" WHERE "paidAmount" < 0 OR "paidAmount" > "originalAmount"',
    );
    expect(Number(badPayables[0].count)).toBe(0);
  });

  it('权限：销售/采购/仓库/访客 403 且不泄露金额；财务可读可写', async () => {
    for (const client of [salesUser, purchaseUser, warehouseUser, guestUser]) {
      for (const path of [
        '/receivables',
        '/payables',
        '/settlements',
        '/finance/summary',
      ]) {
        const response = await client.get(path);
        expect(response.status, `${client.user.username} ${path}`).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
        expect(JSON.stringify(response.body)).not.toMatch(/\d{4,}/);
        expect(JSON.stringify(response.body)).not.toMatch(
          /receivable|payable|originalAmount|receivedAmount/,
        );
      }
      const write = await client.post(
        '/settlements/receipts',
        { sourceId: 'whatever-id', amount: 1, date: today(), method: '现金' },
        nextKey('forbidden-' + client.user.username),
      );
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe('FORBIDDEN');
    }
    // 财务账号可读财务、可写结算，但无库存/采购/销售报表权限。
    for (const path of ['/receivables', '/payables', '/settlements', '/finance/summary', '/reports/finance']) {
      expect((await finance.get('/api/v1' + path)).status, path).toBe(200);
    }
    expect((await finance.get('/api/v1/reports/inventory')).status).toBe(403);
    expect((await finance.get('/api/v1/purchase-orders')).status).toBe(403);
    expect((await finance.get('/api/v1/sales-orders')).status).toBe(403);
    const { receivable } = await shipSale(1, 1000);
    const written = await finance.post(
      '/settlements/receipts',
      { sourceId: receivable.id, amount: 400, date: today(), method: '现金' },
      nextKey('finance-write'),
    );
    expect(written.status).toBe(201);
    expect(await receivableState(receivable.id)).toMatchObject({ receivedAmount: 400 });
    // 采购/仓库/访客不能收付款，也不能改结算。
    for (const client of [purchaseUser, warehouseUser, guestUser]) {
      expect(
        (
          await client.post(
            '/settlements/receipts',
            { sourceId: receivable.id, amount: 1, date: today(), method: '现金' },
            nextKey('readonly-' + client.user.username),
          )
        ).status,
      ).toBe(403);
    }
    expect(await receivableState(receivable.id)).toMatchObject({ receivedAmount: 400 });
  });

  it('审计与幂等记录绑定操作人，不保存敏感输入', async () => {
    const { receivable } = await shipSale(1, 1000);
    const response = await admin.post(
      '/settlements/receipts',
      {
        sourceId: receivable.id,
        amount: 500,
        date: today(),
        method: '现金',
        remark: '备注不应进入审计',
      },
      nextKey('audit'),
    );
    expect(response.status).toBe(201);
    const recordId = response.body.data.id;
    const logs = await prisma.auditLog.findMany({
      where: { resource: 'settlements', resourceId: recordId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorId: admin.user.id,
      action: 'SETTLE',
      resource: 'settlements',
      resourceId: recordId,
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('备注不应进入审计');
    expect(serialized).not.toContain('passwordHash');
    const idempotency = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { settlementId: recordId },
    });
    expect(idempotency).toMatchObject({
      scope: 'settlement',
      userId: admin.user.id,
      settlementId: recordId,
    });
    expect(idempotency.requestHash).toMatch(/^[a-f0-9]{64}$/);
    // 收付款单号唯一，且结算记录金额为正。
    const numbers = await prisma.settlementRecord.findMany({ select: { number: true, amount: true } });
    expect(new Set(numbers.map((row) => row.number)).size).toBe(numbers.length);
    expect(numbers.every((row) => Number.isInteger(row.amount) && row.amount > 0)).toBe(true);
  });

  it('跨模块对账恒等式：销售+采购报表金额 = 财务余额 = 结算流水', async () => {
    const salesReport = (await admin.get('/api/v1/reports/sales?pageSize=100')).body.data;
    const purchaseReport = (await admin.get('/api/v1/reports/purchases?pageSize=100')).body.data;
    const financeReport = (await admin.get('/api/v1/reports/finance?pageSize=100')).body.data;
    const summary = (await admin.get('/api/v1/finance/summary')).body.data;
    const dbSales = await prisma.salesShipmentItem.aggregate({ _sum: { amount: true, quantity: true } });
    const dbPurchases = await prisma.goodsReceiptItem.aggregate({ _sum: { amount: true, quantity: true } });
    const dbSettlements = await prisma.settlementRecord.aggregate({ _sum: { amount: true } });
    // 报表口径 = 正式出入库明细合计。
    expect(salesReport.totals.amount).toBe(dbSales._sum.amount ?? 0);
    expect(salesReport.totals.quantity).toBe(dbSales._sum.quantity ?? 0);
    expect(purchaseReport.totals.amount).toBe(dbPurchases._sum.amount ?? 0);
    expect(purchaseReport.totals.quantity).toBe(dbPurchases._sum.quantity ?? 0);
    // 出库/入库金额 = 应收/应付原始金额合计。
    expect(financeReport.totals.amount).toBe(salesReport.totals.amount + purchaseReport.totals.amount);
    expect(summary.receivableTotal).toBe(salesReport.totals.amount);
    expect(summary.payableTotal).toBe(purchaseReport.totals.amount);
    // 已结 = 结算流水合计；未结 = 余额合计。
    expect(financeReport.totals.settled).toBe(dbSettlements._sum.amount ?? 0);
    expect(summary.receipts + summary.payments).toBe(dbSettlements._sum.amount ?? 0);
    expect(financeReport.totals.balance).toBe(
      summary.receivableRemaining + summary.payableRemaining,
    );
    // 结算流水合计 = 各来源已收/已付合计。
    const dbReceived = await prisma.receivable.aggregate({ _sum: { receivedAmount: true } });
    const dbPaid = await prisma.payable.aggregate({ _sum: { paidAmount: true } });
    expect((dbReceived._sum.receivedAmount ?? 0) + (dbPaid._sum.paidAmount ?? 0)).toBe(
      dbSettlements._sum.amount ?? 0,
    );
    const integrity = await checkIntegrity();
    expect(integrity.ok).toBe(true);
    expect(
      integrity.checks.filter((item) => item.violations > 0),
      JSON.stringify(integrity.checks),
    ).toEqual([]);
  });
});
