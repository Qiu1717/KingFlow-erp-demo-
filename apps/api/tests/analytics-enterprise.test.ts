import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, ORIGIN, type TestServer } from './server.js';
import { checkIntegrity } from '../src/services/recovery-service.js';

/**
 * 经营报表（销售/采购/库存/往来）、CSV 导出与经营分析看板的企业级验收。
 *
 * 数据全部经真实 HTTP + 真实 SQLite 生成，再用 prisma 回写单据发生时间，
 * 以构造上海时区边界、历史期间和角色隔离场景。断言同时核对
 * 「HTTP 返回」「数据库真实状态」「跨模块对账恒等式」三层。
 */

const PASSWORD = 'Test@12345';
const CST = 28800000;
/** 上海某日 00:00 的绝对时刻。 */
const at = (date: string, time = '00:00:00') =>
  new Date(`${date}T${time}+08:00`);
const today = () => new Date(Date.now() + CST).toISOString().slice(0, 10);

type TestAgent = ReturnType<TestServer['agent']>;
interface Client {
  agent: TestAgent;
  user: { id: string; username: string; role: { code: string; permissions: string[] } };
  get: (path: string) => ReturnType<TestAgent['get']>;
  post: (path: string, body: object, key?: string) => ReturnType<TestAgent['post']>;
}

let server: TestServer;
let admin: Client;
let salesUser: Client;
let purchaseUser: Client;
let warehouseUser: Client;
let financeUser: Client;
let guestUser: Client;
let keySeq = 0;
const nextKey = (label: string) => `an-${label}-${++keySeq}`;

let p1 = '';
let p2 = '';
let emptyFlowProductId = '';
let w1 = '';
let w2 = '';
let supplierId = '';
let customerId = '';
let weirdCustomerId = '';

interface Fixture {
  shipmentIds: string[];
  receiptIds: string[];
  receivableByShipment: Record<string, { id: string; originalAmount: number }>;
  payableByReceipt: Record<string, { id: string; originalAmount: number }>;
  pendingSalesOrderId: string;
  pendingPurchaseOrderId: string;
  approvedPurchaseOrderId: string;
}
const fx: Fixture = {
  shipmentIds: [],
  receiptIds: [],
  receivableByShipment: {},
  payableByReceipt: {},
  pendingSalesOrderId: '',
  pendingPurchaseOrderId: '',
  approvedPurchaseOrderId: '',
};

async function makeClient(username: string): Promise<Client> {
  const agent = server.agent();
  const login = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password: PASSWORD });
  expect(login.status, `登录 ${username}`).toBe(200);
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
    user: login.body.data.user,
    get: (path: string) =>
      agent.get(path.startsWith('/api/v1/') ? path : '/api/v1' + path),
    post,
  };
}

async function seedRole(code: string, permissions: string[]) {
  return prisma.role.create({
    data: { code, name: code, permissions: JSON.stringify(permissions) },
  });
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

/** 极简 CSV 解析：支持 BOM、双引号包裹与 "" 转义。 */
function parseCsv(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && body[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function approvedPurchaseOrder(quantity: number, unitPrice: number) {
  const created = await admin.post('/purchase-orders', {
    supplierId,
    warehouseId: w1,
    orderDate: '2026-10-01',
    items: [{ productId: p1, quantity, unitPrice }],
  });
  expect(created.status).toBe(201);
  const order = created.body.data;
  for (const action of ['submit', 'approve'])
    expect(
      (await admin.post(`/purchase-orders/${order.id}/${action}`, {})).status,
    ).toBe(200);
  return order;
}

async function receive(order: { id: string; items: { id: string; quantity: number }[] }) {
  const receipt = await admin.post(
    '/goods-receipts',
    {
      orderId: order.id,
      items: order.items.map((item) => ({
        orderItemId: item.id,
        quantity: item.quantity,
      })),
    },
    nextKey('receipt'),
  );
  expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
  return receipt.body.data;
}

async function approvedSalesOrder(
  customer: string,
  warehouse: string,
  items: { productId: string; quantity: number; unitPrice: number }[],
  orderDate = '2026-10-01',
) {
  const created = await admin.post('/sales-orders', {
    customerId: customer,
    warehouseId: warehouse,
    orderDate,
    items,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const order = created.body.data;
  for (const action of ['submit', 'approve'])
    expect(
      (await admin.post(`/sales-orders/${order.id}/${action}`, {})).status,
    ).toBe(200);
  return order;
}

async function ship(order: { id: string; items: { id: string; quantity: number }[] }) {
  const shipment = await admin.post(
    '/sales-shipments',
    {
      orderId: order.id,
      items: order.items.map((item) => ({
        orderItemId: item.id,
        quantity: item.quantity,
      })),
    },
    nextKey('shipment'),
  );
  expect(shipment.status, JSON.stringify(shipment.body)).toBe(201);
  return shipment.body.data;
}

beforeAll(async () => {
  server = await startTestServer();
  await cleanDatabase();
  const adminRole = await seedRole('ADMIN', ['*']);
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
  const financeRole = await seedRole('FINANCE', [
    'master:read',
    'shipments:read',
    'receipts:read',
    'payables:read',
    'receivables:read',
    'finance:read',
    'settlements:write',
  ]);
  const guestRole = await seedRole('GUEST', [
    'master:read',
    'purchase:read',
    'receipts:read',
    'sales:read',
    'shipments:read',
    'inventory:read',
  ]);
  await seedUser('an-admin', adminRole.id);
  await seedUser('an-sales', salesRole.id);
  await seedUser('an-purchase', purchaseRole.id);
  await seedUser('an-warehouse', warehouseRole.id);
  await seedUser('an-finance', financeRole.id);
  await seedUser('an-guest', guestRole.id);
  admin = await makeClient('an-admin');
  salesUser = await makeClient('an-sales');
  purchaseUser = await makeClient('an-purchase');
  warehouseUser = await makeClient('an-warehouse');
  financeUser = await makeClient('an-finance');
  guestUser = await makeClient('an-guest');

  const category = await admin.post('/categories', {
    code: 'ANC',
    name: '报表验收分类',
  });
  expect(category.status).toBe(201);
  const categoryId = category.body.data.id;
  // 商品名以 = 开头，用于验证 CSV 公式注入防护。
  p1 = (
    await admin.post('/products', {
      code: 'ANP1',
      name: '=SUM(A1:A2)',
      categoryId,
      unit: '件',
      purchasePrice: 100,
      salesPrice: 200,
      minStock: 0,
    })
  ).body.data.id;
  p2 = (
    await admin.post('/products', {
      code: 'ANP2',
      name: '报表商品乙',
      categoryId,
      unit: '件',
      purchasePrice: 300,
      salesPrice: 400,
      minStock: 1000,
    })
  ).body.data.id;
  // 无任何库存流水的商品：库存报表按余额统计，不应出现。
  emptyFlowProductId = (
    await admin.post('/products', {
      code: 'ANP3',
      name: '无流水商品',
      categoryId,
      unit: '件',
      purchasePrice: 50,
      salesPrice: 60,
      minStock: 0,
    })
  ).body.data.id;
  w1 = (await admin.post('/warehouses', { code: 'ANW1', name: '报表一号仓' })).body
    .data.id;
  w2 = (await admin.post('/warehouses', { code: 'ANW2', name: '报表二号仓' })).body
    .data.id;
  supplierId = (
    await admin.post('/suppliers', { code: 'ANS1', name: '报表供应商' })
  ).body.data.id;
  customerId = (
    await admin.post('/customers', { code: 'ANC1', name: '报表客户' })
  ).body.data.id;
  // 客户名带公式与引号，用于 CSV 注入与转义验证。
  weirdCustomerId = (
    await admin.post('/customers', {
      code: 'ANC2',
      name: `=cmd|' /C calc'!A0`,
    })
  ).body.data.id;

  // 期初库存（9 月，落在 30 天窗口之前），三笔调整。
  for (const [index, [productId, warehouseId, quantity]] of [
    [p1, w1, 50],
    [p1, w2, 10],
    [p2, w1, 20],
  ].entries()) {
    const adjustment = await admin.post(
      '/stock-adjustments',
      { productId, warehouseId, quantity, reason: `报表期初${index}` },
      nextKey('opening'),
    );
    expect(adjustment.status).toBe(201);
  }

  // 采购入库：R1 = P1×10@100 → 一号仓；R2 = P2×5@300 → 二号仓。
  // 注意：必须先建 9 月的销售出库 S3，再建 10 月的入库，
  // 这样「插入顺序 == 回写后的时间顺序」，库存流水的 before/after 链条才自洽。
  const so3 = await approvedSalesOrder(customerId, w1, [
    { productId: p1, quantity: 1, unitPrice: 200 },
  ]);
  const s3 = await ship(so3);

  const po1 = await approvedPurchaseOrder(10, 100);
  const r1 = await receive(po1);
  const po2Order = await admin.post('/purchase-orders', {
    supplierId,
    warehouseId: w2,
    orderDate: '2026-10-02',
    items: [{ productId: p2, quantity: 5, unitPrice: 300 }],
  });
  expect(po2Order.status).toBe(201);
  for (const action of ['submit', 'approve'])
    expect(
      (await admin.post(`/purchase-orders/${po2Order.body.data.id}/${action}`, {})).status,
    ).toBe(200);
  const r2 = await receive(po2Order.body.data);
  fx.receiptIds = [r1.id, r2.id];

  // 销售出库：S2 在 10-14 23:59:59 CST，S1 在 10-15 00:00 CST（上海日期分属两天）。
  const so2 = await approvedSalesOrder(weirdCustomerId, w1, [
    { productId: p1, quantity: 2, unitPrice: 200 },
  ]);
  const s2 = await ship(so2);
  const so1 = await approvedSalesOrder(customerId, w1, [
    { productId: p1, quantity: 4, unitPrice: 200 },
  ]);
  const s1 = await ship(so1);
  fx.shipmentIds = [s3.id, s2.id, s1.id];

  // 草稿/待审核/已审核未过账的订单：一律不计入经营实现额。
  const draftSales = await admin.post('/sales-orders', {
    customerId,
    warehouseId: w1,
    orderDate: '2026-10-03',
    items: [{ productId: p1, quantity: 99, unitPrice: 200 }],
  });
  expect(draftSales.status).toBe(201);
  const pendingSales = await admin.post('/sales-orders', {
    customerId,
    warehouseId: w1,
    orderDate: '2026-10-03',
    items: [{ productId: p1, quantity: 50, unitPrice: 200 }],
  });
  expect(pendingSales.status).toBe(201);
  fx.pendingSalesOrderId = pendingSales.body.data.id;
  expect(
    (await admin.post(`/sales-orders/${fx.pendingSalesOrderId}/submit`, {})).status,
  ).toBe(200);
  const draftPurchase = await admin.post('/purchase-orders', {
    supplierId,
    warehouseId: w1,
    orderDate: '2026-10-03',
    items: [{ productId: p1, quantity: 77, unitPrice: 100 }],
  });
  expect(draftPurchase.status).toBe(201);
  const pendingPurchase = await admin.post('/purchase-orders', {
    supplierId,
    warehouseId: w1,
    orderDate: '2026-10-03',
    items: [{ productId: p1, quantity: 66, unitPrice: 100 }],
  });
  expect(pendingPurchase.status).toBe(201);
  fx.pendingPurchaseOrderId = pendingPurchase.body.data.id;
  expect(
    (await admin.post(`/purchase-orders/${fx.pendingPurchaseOrderId}/submit`, {})).status,
  ).toBe(200);
  const approvedPurchase = await approvedPurchaseOrder(5, 100);
  fx.approvedPurchaseOrderId = approvedPurchase.id;

  // 往来单据时间对齐来源单据时间。
  const receivables = await prisma.receivable.findMany();
  for (const receivable of receivables) {
    if (receivable.shipmentId === s3.id)
      fx.receivableByShipment[s3.id] = receivable;
    if (receivable.shipmentId === s2.id)
      fx.receivableByShipment[s2.id] = receivable;
    if (receivable.shipmentId === s1.id)
      fx.receivableByShipment[s1.id] = receivable;
  }
  const payables = await prisma.payable.findMany();
  for (const payable of payables) {
    if (payable.receiptId === r1.id) fx.payableByReceipt[r1.id] = payable;
    if (payable.receiptId === r2.id) fx.payableByReceipt[r2.id] = payable;
  }
  expect(Object.keys(fx.receivableByShipment)).toHaveLength(3);
  expect(Object.keys(fx.payableByReceipt)).toHaveLength(2);

  // 回写单据发生时间：期初 08-25；S3 09-25；R1 10-10；R2 10-12；S2 10-14 23:59:59；S1 10-15 00:00。
  // 顺序与插入顺序保持一致，库存流水的 before/after 链条才自洽。
  const timing: [string, Date][] = [
    ['2026-08-25', at('2026-08-25', '02:00:00')],
    ['2026-09-25', at('2026-09-25', '02:00:00')],
    ['2026-10-10', at('2026-10-10', '02:00:00')],
    ['2026-10-12', at('2026-10-12', '02:00:00')],
    ['2026-10-14T23:59:59', at('2026-10-14', '23:59:59')],
    ['2026-10-15', at('2026-10-15', '00:00:00')],
  ];
  const [openingAt, s3At, r1At, r2At, s2At, s1At] = timing.map(([, date]) => date);
  const adjustments = await prisma.stockAdjustment.findMany();
  for (const adjustment of adjustments)
    await prisma.stockAdjustment.update({
      where: { id: adjustment.id },
      data: { createdAt: openingAt },
    });
  await prisma.goodsReceipt.update({ where: { id: r1.id }, data: { createdAt: r1At } });
  await prisma.goodsReceipt.update({ where: { id: r2.id }, data: { createdAt: r2At } });
  await prisma.salesShipment.update({ where: { id: s3.id }, data: { createdAt: s3At } });
  await prisma.salesShipment.update({ where: { id: s2.id }, data: { createdAt: s2At } });
  await prisma.salesShipment.update({ where: { id: s1.id }, data: { createdAt: s1At } });
  // 库存流水时间必须与来源单据一致，否则库存报表期间口径失真。
  for (const movement of await prisma.stockMovement.findMany()) {
    const createdAt =
      movement.type === 'STOCK_ADJUSTMENT'
        ? openingAt
        : movement.type === 'PURCHASE_RECEIPT'
          ? movement.receiptId === r1.id
            ? r1At
            : r2At
          : movement.shipmentId === s3.id
            ? s3At
            : movement.shipmentId === s2.id
              ? s2At
              : s1At;
    await prisma.stockMovement.update({
      where: { id: movement.id },
      data: { createdAt },
    });
  }
  await prisma.receivable.update({
    where: { id: fx.receivableByShipment[s3.id].id },
    data: { createdAt: s3At },
  });
  await prisma.receivable.update({
    where: { id: fx.receivableByShipment[s2.id].id },
    data: { createdAt: s2At },
  });
  await prisma.receivable.update({
    where: { id: fx.receivableByShipment[s1.id].id },
    data: { createdAt: s1At },
  });
  await prisma.payable.update({
    where: { id: fx.payableByReceipt[r1.id].id },
    data: { createdAt: r1At },
  });
  await prisma.payable.update({
    where: { id: fx.payableByReceipt[r2.id].id },
    data: { createdAt: r2At },
  });

  // 结算：应收(S1) 收 300（10-16）；应付(R1) 付 400（10-17）。
  expect(
    (
      await admin.post(
        '/settlements/receipts',
        {
          sourceId: fx.receivableByShipment[s1.id].id,
          amount: 300,
          date: '2026-10-16',
          method: '银行转账',
        },
        nextKey('settle-ar'),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await admin.post(
        '/settlements/payments',
        {
          sourceId: fx.payableByReceipt[r1.id].id,
          amount: 400,
          date: '2026-10-17',
          method: '现金',
        },
        nextKey('settle-ap'),
      )
    ).status,
  ).toBe(201);
}, 120000);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

describe.sequential('经营报表企业级验收', { timeout: 120000 }, () => {
  it('销售/采购报表只统计正式出库/入库，草稿与未审核不计', async () => {
    const sales = (await admin.get('/api/v1/reports/sales?pageSize=100')).body.data;
    // S3 1 件 + S2 2 件 + S1 4 件 = 7 件 × 200 分。
    expect(sales.total).toBe(3);
    expect(sales.totals).toMatchObject({ quantity: 7, amount: 1400 });
    expect(sales.items.map((row: { quantity: number }) => row.quantity).sort()).toEqual([
      1, 2, 4,
    ]);
    // 草稿 99 件、待审核 50 件的订单不得出现在报表明细里（按来源单据识别）。
    const salesSources = sales.items.map((row: { sourcePath: string }) => row.sourcePath);
    expect(salesSources.some((path: string) => path.includes(fx.pendingSalesOrderId))).toBe(false);
    const purchases = (await admin.get('/api/v1/reports/purchases?pageSize=100')).body.data;
    expect(purchases.total).toBe(2);
    expect(purchases.totals).toMatchObject({ quantity: 15, amount: 2500 });
    // 草稿 77 件、待审核 66 件、已审核但未入库 5 件都不计入。
    const purchaseSources = purchases.items.map((row: { sourcePath: string }) => row.sourcePath);
    expect(purchaseSources.some((path: string) => path.includes(fx.pendingPurchaseOrderId))).toBe(
      false,
    );
    expect(
      purchaseSources.some((path: string) => path.includes(fx.approvedPurchaseOrderId)),
    ).toBe(false);
    // 该已审核订单确实没有入库单，说明「未过账不计入」不是靠缺数据碰巧成立。
    expect(
      await prisma.goodsReceipt.count({ where: { orderId: fx.approvedPurchaseOrderId } }),
    ).toBe(0);
    // 报表明细 = 正式单据明细的数据库合计。
    const dbSales = await prisma.salesShipmentItem.aggregate({
      _sum: { quantity: true, amount: true },
    });
    const dbPurchases = await prisma.goodsReceiptItem.aggregate({
      _sum: { quantity: true, amount: true },
    });
    expect(sales.totals.quantity).toBe(dbSales._sum.quantity);
    expect(sales.totals.amount).toBe(dbSales._sum.amount);
    expect(purchases.totals.quantity).toBe(dbPurchases._sum.quantity);
    expect(purchases.totals.amount).toBe(dbPurchases._sum.amount);
  });

  it('上海半开区间：00:00 CST 属于当天，前一日 23:59:59 不属于', async () => {
    const day = async (kind: string, date: string) =>
      (await admin.get(`/api/v1/reports/${kind}?dateFrom=${date}&dateTo=${date}&pageSize=100`))
        .body.data;
    const onlyS1 = await day('sales', '2026-10-15');
    expect(onlyS1.total).toBe(1);
    expect(onlyS1.totals).toMatchObject({ quantity: 4, amount: 800 });
    const onlyS2 = await day('sales', '2026-10-14');
    expect(onlyS2.total).toBe(1);
    expect(onlyS2.totals).toMatchObject({ quantity: 2, amount: 400 });
    // 只给一端：dateFrom=15 排除 14 日；dateTo=14 排除 15 日。
    const from15 = (
      await admin.get('/api/v1/reports/sales?dateFrom=2026-10-15&pageSize=100')
    ).body.data;
    expect(from15.totals).toMatchObject({ quantity: 4, amount: 800 });
    const to14 = (
      await admin.get('/api/v1/reports/sales?dateTo=2026-10-14&pageSize=100')
    ).body.data;
    expect(to14.totals).toMatchObject({ quantity: 3, amount: 600 });
    // 采购侧同口径：10-10 有 R1，10-09 没有。
    expect((await day('purchases', '2026-10-10')).totals).toMatchObject({
      quantity: 10,
      amount: 1000,
    });
    expect((await day('purchases', '2026-10-09')).total).toBe(0);
    // 反向区间 422。
    expect(
      (
        await admin.get('/api/v1/reports/sales?dateFrom=2026-10-15&dateTo=2026-10-14')
      ).status,
    ).toBe(422);
  });

  it('库存报表：期初/期间增减/截止库存覆盖四种日期组合且恒等', async () => {
    const report = async (query: string) =>
      (await admin.get('/api/v1/reports/inventory?pageSize=100&' + query)).body.data;
    // 都不给：当前余额，期初=当前，期间无增减。
    const current = await report('');
    expect(current.total).toBe(4);
    expect(current.totals.quantity).toBe(88);
    expect(
      current.items.every(
        (row: { openingQuantity: number; inboundQuantity: number; outboundQuantity: number }) =>
          row.inboundQuantity === 0 && row.outboundQuantity === 0,
      ),
    ).toBe(true);
    // 无流水商品不出现在库存报表（按余额统计）。
    expect(current.items.some((row: { number: string }) => row.number === 'ANP3')).toBe(false);
    // 该商品确实存在，排除「因为不存在所以查不到」的假阳性。
    expect(
      (await admin.get(`/api/v1/products/${emptyFlowProductId}`)).status,
    ).toBe(200);
    // 只给 dateFrom：期初=该日起点余额，quantity=当前余额。
    const from15 = await report('dateFrom=2026-10-15');
    const from15Row = from15.items.find(
      (row: { number: string; warehouse: string }) =>
        row.number === 'ANP1' && row.warehouse === '报表一号仓',
    );
    expect(from15Row).toMatchObject({
      openingQuantity: 57,
      outboundQuantity: 4,
      inboundQuantity: 0,
      quantity: 53,
    });
    // 只给 dateTo：期初为 0（无更早起点），quantity=截止日余额。
    const to14 = await report('dateTo=2026-10-14');
    expect(to14.totals.quantity).toBe(92);
    const to14Row = to14.items.find(
      (row: { number: string; warehouse: string }) =>
        row.number === 'ANP1' && row.warehouse === '报表一号仓',
    );
    expect(to14Row).toMatchObject({ quantity: 57, date: '2026-10-14' });
    // 都给：期初 + 期间增减 = 截止库存。
    const range = await report('dateFrom=2026-10-15&dateTo=2026-10-15');
    expect(range.total).toBe(4);
    for (const row of range.items as {
      openingQuantity: number;
      inboundQuantity: number;
      outboundQuantity: number;
      quantity: number;
    }[]) {
      expect(
        row.openingQuantity + row.inboundQuantity - row.outboundQuantity,
      ).toBe(row.quantity);
    }
    // 跨整个期间：期初=区间起点前累计（08-25 的三笔期初调整），期间含全部正式流水。
    const whole = await report('dateFrom=2026-09-01&dateTo=2026-10-31');
    expect(whole.totals.quantity).toBe(88);
    const wholeRow = whole.items.find(
      (row: { number: string; warehouse: string }) =>
        row.number === 'ANP1' && row.warehouse === '报表一号仓',
    );
    expect(wholeRow).toMatchObject({
      openingQuantity: 50,
      inboundQuantity: 10,
      outboundQuantity: 7,
      quantity: 53,
    });
    // 早于任何流水：明细行保留但数量为 0。
    const before = await report('dateTo=1970-01-01');
    expect(before.total).toBe(4);
    expect(before.totals.quantity).toBe(0);
    expect(
      before.items.every((row: { quantity: number }) => row.quantity === 0),
    ).toBe(true);
    // 数据库恒等：截止库存 = 该时点前流水累计。
    const cutoff = at('2026-10-14', '23:59:59');
    const dbMovements = await prisma.stockMovement.aggregate({
      where: { createdAt: { lte: cutoff } },
      _sum: { quantity: true },
    });
    expect(to14.totals.quantity).toBe(dbMovements._sum.quantity);
  });

  it('库存报表支持跨仓/跨商品筛选，movements 只到 dateTo 之前', async () => {
    const byWarehouse = (
      await admin.get(`/api/v1/reports/inventory?pageSize=100&warehouseId=${w2}`)
    ).body.data;
    expect(byWarehouse.total).toBe(2);
    expect(
      byWarehouse.items.every(
        (row: { warehouse: string }) => row.warehouse === '报表二号仓',
      ),
    ).toBe(true);
    expect(byWarehouse.totals.quantity).toBe(15);
    const byProduct = (
      await admin.get(`/api/v1/reports/inventory?pageSize=100&productId=${p2}`)
    ).body.data;
    expect(byProduct.total).toBe(2);
    expect(
      byProduct.items.every((row: { number: string }) => row.number === 'ANP2'),
    ).toBe(true);
    expect(byProduct.totals.quantity).toBe(25);
    // 两个筛选同时生效。
    const both = (
      await admin.get(
        `/api/v1/reports/inventory?pageSize=100&warehouseId=${w2}&productId=${p2}`,
      )
    ).body.data;
    expect(both.total).toBe(1);
    expect(both.totals.quantity).toBe(5);
    // 不存在的仓库返回空但 200。
    const none = (
      await admin.get('/api/v1/reports/inventory?pageSize=100&warehouseId=nope')
    ).body.data;
    expect(none.total).toBe(0);
    expect(none.totals.quantity).toBe(0);
    // movements 只到 dateTo 之前：截止 10-14 不得出现 10-15 的出库流水。
    const cutoff = at('2026-10-14', '23:59:59');
    const report = (
      await admin.get('/api/v1/reports/inventory?dateTo=2026-10-14')
    ).body.data;
    const movements = report.analysis.movements as { id: string; createdAt: string }[];
    expect(movements.length).toBeGreaterThan(0);
    expect(
      movements.every((row) => new Date(row.createdAt).getTime() <= cutoff.getTime()),
    ).toBe(true);
    const dbExpected = await prisma.stockMovement.count({
      where: { createdAt: { lte: cutoff } },
    });
    expect(movements.length).toBe(Math.min(dbExpected, 20));
    // 报表的 warehouseSummary 与明细合计一致。
    const summary = report.analysis.warehouseSummary as { name: string; quantity: number }[];
    expect(summary.reduce((sum, row) => sum + row.quantity, 0)).toBe(report.totals.quantity);
  });

  it('往来报表金额/已结/未结与财务余额一致，按来源生成日期筛选', async () => {
    const all = (await admin.get('/api/v1/reports/finance?pageSize=100')).body.data;
    expect(all.total).toBe(5);
    expect(all.totals).toMatchObject({ amount: 3900, settled: 700, balance: 3200 });
    const summary = all.analysis.financeSummary as {
      name: string;
      amount: number;
      settled: number;
      balance: number;
    }[];
    expect(summary.find((row) => row.name === '应收账款')).toMatchObject({
      amount: 1400,
      settled: 300,
      balance: 1100,
    });
    expect(summary.find((row) => row.name === '应付账款')).toMatchObject({
      amount: 2500,
      settled: 400,
      balance: 2100,
    });
    // 与财务概览、数据库三方一致。
    const overview = (await admin.get('/api/v1/finance/summary')).body.data;
    expect(all.totals.amount).toBe(overview.receivableTotal + overview.payableTotal);
    expect(all.totals.balance).toBe(
      overview.receivableRemaining + overview.payableRemaining,
    );
    expect(all.totals.settled).toBe(overview.receipts + overview.payments);
    const dbAr = await prisma.receivable.aggregate({
      _sum: { originalAmount: true, receivedAmount: true },
    });
    const dbAp = await prisma.payable.aggregate({
      _sum: { originalAmount: true, paidAmount: true },
    });
    expect(overview.receivableTotal).toBe(dbAr._sum.originalAmount);
    expect(overview.receivableRemaining).toBe(
      (dbAr._sum.originalAmount ?? 0) - (dbAr._sum.receivedAmount ?? 0),
    );
    expect(overview.payableTotal).toBe(dbAp._sum.originalAmount);
    expect(overview.payableRemaining).toBe(
      (dbAp._sum.originalAmount ?? 0) - (dbAp._sum.paidAmount ?? 0),
    );
    // 按来源生成日期：10-15 只有 S1 的应收；已结为当前累计（口径已记录）。
    const day15 = (
      await admin.get('/api/v1/reports/finance?dateFrom=2026-10-15&dateTo=2026-10-15&pageSize=100')
    ).body.data;
    expect(day15.total).toBe(1);
    expect(day15.totals).toMatchObject({ amount: 800, settled: 300, balance: 500 });
    const to14 = (
      await admin.get('/api/v1/reports/finance?dateTo=2026-10-14&pageSize=100')
    ).body.data;
    // dateTo=10-14 只排除 10-15 的 S1 应收（800），其余四张往来仍在。
    expect(to14.totals.amount).toBe(3900 - 800);
    // 已结为「所选来源的当前累计」：S1 的 300 收款随 S1 被排除而消失，只剩 R1 的 400 付款。
    expect(to14.totals.settled).toBe(400);
    // 往来报表无仓库/商品维度：显式拒绝而不是静默返回全量。
    expect(
      (await admin.get(`/api/v1/reports/finance?warehouseId=${w1}`)).status,
    ).toBe(422);
    expect(
      (await admin.get(`/api/v1/reports/finance?productId=${p1}`)).status,
    ).toBe(422);
    expect((await admin.get(`/api/v1/reports/finance?warehouseId=${w1}`)).body.error.code).toBe(
      'UNSUPPORTED_FILTER',
    );
  });

  it('关键词过滤不区分大小写，且作用于单号/商品/往来单位/仓库', async () => {
    const data = async (kind: string, query: string) =>
      (await admin.get(`/api/v1/reports/${kind}?pageSize=100&` + query)).body.data;
    // 商品编码 ANP1（大写）→ 小写同样命中。
    expect((await data('sales', 'q=anp1')).totals.amount).toBe(1400);
    expect((await data('sales', 'q=ANP1')).totals.amount).toBe(1400);
    // 仓库名。
    expect(
      (await data('purchases', 'q=' + encodeURIComponent('报表二号仓'))).totals.amount,
    ).toBe(1500);
    // 往来单位。
    expect((await data('sales', 'q=' + encodeURIComponent('报表客户'))).totals.amount).toBe(1000);
    // 无命中 → 0 且 totals 归零。
    const empty = await data('sales', 'q=' + encodeURIComponent('不存在的关键词'));
    expect(empty.total).toBe(0);
    expect(empty.totals).toEqual({ quantity: 0, amount: 0, settled: 0, balance: 0 });
    expect(empty.analysis.productRanking).toEqual([]);
    expect(empty.analysis.trend).toEqual([]);
    // 关键词在分页前生效：total 反映过滤结果。
    const filtered = (
      await admin.get('/api/v1/reports/sales?q=anp1&pageSize=1')
    ).body.data;
    expect(filtered.total).toBe(3);
    expect(filtered.items).toHaveLength(1);
  });

  it('rankBy=amount|quantity 排行取全量结果前 10，空数据与非法值边界正确', async () => {
    const byAmount = (await admin.get('/api/v1/reports/sales?rankBy=amount')).body.data;
    expect(byAmount.analysis.productRanking[0]).toMatchObject({
      name: 'ANP1 · =SUM(A1:A2)',
      quantity: 7,
      amount: 1400,
    });
    const byQuantity = (await admin.get('/api/v1/reports/sales?rankBy=quantity')).body.data;
    expect(byQuantity.analysis.productRanking[0].quantity).toBe(7);
    expect(byQuantity.totals.amount).toBe(byAmount.totals.amount);
    // 排行不受分页影响。
    const paged = (
      await admin.get('/api/v1/reports/sales?rankBy=quantity&pageSize=1&page=2')
    ).body.data;
    expect(paged.analysis.productRanking).toEqual(byQuantity.analysis.productRanking);
    // 非法 rankBy 422。
    expect((await admin.get('/api/v1/reports/sales?rankBy=unsafe')).status).toBe(422);
    // 空数据：200、空排行、零合计。
    const empty = (
      await admin.get('/api/v1/reports/purchases?dateFrom=1990-01-01&dateTo=1990-01-02')
    ).body.data;
    expect(empty.total).toBe(0);
    expect(empty.totals).toEqual({ quantity: 0, amount: 0, settled: 0, balance: 0 });
    expect(empty.analysis.productRanking).toEqual([]);
    expect(empty.analysis.partnerRanking).toEqual([]);
    expect(empty.analysis.trend).toEqual([]);
  });

  it('分页不重不漏，total 与实际条数一致，页码越界返回空', async () => {
    const full = (await admin.get('/api/v1/reports/sales?pageSize=100')).body.data;
    expect(full.total).toBe(3);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const chunk = (
        await admin.get(`/api/v1/reports/sales?page=${page}&pageSize=1`)
      ).body.data;
      expect(chunk.total).toBe(3);
      seen.push(...chunk.items.map((row: { id: string }) => row.id));
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set(full.items.map((row: { id: string }) => row.id)));
    const beyond = (await admin.get('/api/v1/reports/sales?page=99&pageSize=10')).body.data;
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(3);
    // totals 是过滤后全量合计，不是当前页合计。
    const pageOne = (await admin.get('/api/v1/reports/sales?page=1&pageSize=1')).body.data;
    expect(pageOne.totals.amount).toBe(full.totals.amount);
    // 非法分页参数拒绝。
    expect((await admin.get('/api/v1/reports/sales?page=0')).status).toBe(422);
    expect((await admin.get('/api/v1/reports/sales?pageSize=101')).status).toBe(422);
    expect((await admin.get('/api/v1/reports/sales?unknown=1')).status).toBe(422);
  });

  it('CSV：BOM、中文、公式注入防护、列数=表头、行数=明细', async () => {
    const response = await admin.get('/api/v1/reports/sales?format=csv');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('kingflow-sales.csv');
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(response.text);
    const [header, ...data] = rows;
    expect(header).toEqual([
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
    ]);
    const json = (await admin.get('/api/v1/reports/sales?pageSize=100')).body.data;
    expect(data).toHaveLength(json.total);
    for (const row of data) expect(row).toHaveLength(header.length);
    // 公式注入防护：位于单元格开头的 = 必须加单引号前缀。
    // 销售/采购报表的「往来单位」列以客户/供应商名开头，正好覆盖该风险。
    expect(response.text).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(response.text).not.toMatch(/"=cmd/);
    // 库存报表的「商品/类型」列以商品名开头，同样需要防护。
    const inventoryCsvText = (await admin.get('/api/v1/reports/inventory?format=csv')).text;
    expect(inventoryCsvText).toContain(`"'=SUM(A1:A2)"`);
    expect(inventoryCsvText).not.toMatch(/"=SUM/);
    // 中文编码正常。
    expect(response.text).toContain('报表一号仓');
    // 金额以元保留两位小数，且合计与 JSON 一致。
    const amountIndex = header.indexOf('金额（元）');
    const csvAmount = data.reduce(
      (sum, row) => sum + Math.round(Number(row[amountIndex]) * 100),
      0,
    );
    expect(csvAmount).toBe(json.totals.amount);
    // 采购 CSV 行数与明细一致。
    const purchases = await admin.get('/api/v1/reports/purchases?format=csv');
    const purchaseRows = parseCsv(purchases.text);
    expect(purchaseRows[0]).toHaveLength(10);
    expect(purchaseRows.slice(1)).toHaveLength(2);
    // 库存 CSV：未选日期不输出期初/期间列（否则会被误读为期间数据）。
    const inventoryCurrent = parseCsv(
      (await admin.get('/api/v1/reports/inventory?format=csv')).text,
    );
    expect(inventoryCurrent[0]).toHaveLength(10);
    for (const row of inventoryCurrent.slice(1))
      expect(row).toHaveLength(inventoryCurrent[0].length);
    // 选定日期后补出期初/期间增减三列，列数与表头一致。
    const inventoryPeriod = parseCsv(
      (
        await admin.get(
          '/api/v1/reports/inventory?format=csv&dateFrom=2026-10-15&dateTo=2026-10-15',
        )
      ).text,
    );
    expect(inventoryPeriod[0]).toHaveLength(13);
    expect(inventoryPeriod[0].slice(10)).toEqual(['期初数量', '期间增加', '期间减少']);
    for (const row of inventoryPeriod.slice(1))
      expect(row).toHaveLength(inventoryPeriod[0].length);
    expect(inventoryPeriod.slice(1)).toHaveLength(4);
    // 往来 CSV：行数=应收+应付，列数=10。
    const financeCsv = parseCsv(
      (await admin.get('/api/v1/reports/finance?format=csv')).text,
    );
    expect(financeCsv[0]).toHaveLength(10);
    expect(financeCsv.slice(1)).toHaveLength(5);
    // 空数据 CSV 只有表头。
    const emptyCsv = parseCsv(
      (
        await admin.get(
          '/api/v1/reports/sales?format=csv&dateFrom=1990-01-01&dateTo=1990-01-02',
        )
      ).text,
    );
    expect(emptyCsv).toHaveLength(1);
    expect(emptyCsv[0]).toHaveLength(10);
  });

  it('报表权限隔离：角色只能取到已授权报表，且不泄露他模块数据', async () => {
    const matrix: [Client, string[]][] = [
      [salesUser, ['sales', 'inventory']],
      [purchaseUser, ['purchases', 'inventory']],
      [warehouseUser, ['sales', 'purchases', 'inventory']],
      [financeUser, ['finance']],
      [guestUser, ['sales', 'purchases', 'inventory']],
    ];
    const kinds = ['sales', 'purchases', 'inventory', 'finance'];
    for (const [client, allowed] of matrix) {
      for (const kind of kinds) {
        const response = await client.get(`/api/v1/reports/${kind}`);
        const label = `${client.user.username}/${kind}`;
        if (allowed.includes(kind)) {
          expect(response.status, label).toBe(200);
          expect(response.body.data.totals).toBeDefined();
        } else {
          expect(response.status, label).toBe(403);
          expect(response.body.error.code).toBe('FORBIDDEN');
          expect(JSON.stringify(response.body)).not.toMatch(/amount|quantity|totals/);
        }
      }
      // CSV 导出同样受权限保护。
      for (const kind of kinds.filter((item) => !allowed.includes(item))) {
        expect(
          (await client.get(`/api/v1/reports/${kind}?format=csv`)).status,
          `${client.user.username} CSV ${kind}`,
        ).toBe(403);
      }
    }
    // 销售角色拿不到采购与财务的任何金额字段。
    const forbidden = [
      await salesUser.get('/api/v1/reports/purchases'),
      await salesUser.get('/api/v1/reports/finance'),
      await salesUser.get('/api/v1/finance/summary'),
    ];
    for (const response of forbidden)
      expect(JSON.stringify(response.body)).not.toMatch(/2500|3900|receivable|payable/);
    // 财务角色拿不到销售/采购/库存经营数据。
    expect((await financeUser.get('/api/v1/reports/sales')).status).toBe(403);
    expect((await financeUser.get('/api/v1/reports/inventory')).status).toBe(403);
  });

  it('经营看板指标真实：月销售/月采购/库存/待收付/待审核/预警', async () => {
    const business = (await admin.get('/api/v1/dashboard/business')).body.data;
    // 本月（2026-10）只有 S1+S2 = 1200；9 月的 S3 不计入本月。
    expect(business.metrics.monthSales).toBe(1200);
    expect(business.metrics.monthPurchases).toBe(2500);
    expect(business.metrics.stockQuantity).toBe(88);
    expect(business.metrics.receivable).toBe(1100);
    expect(business.metrics.payable).toBe(2100);
    // 待审核 = 1 张待审核销售单 + 1 张待审核采购单。
    expect(business.metrics.pendingApprovals).toBe(2);
    // 预警按商品去重：P2 在两个仓库都低于预警线 → 1 个商品。
    expect(business.metrics.stockAlerts).toBe(1);
    // 指标与数据库一致。
    const dbSales = await prisma.salesShipment.aggregate({
      where: { createdAt: { gte: at(today().slice(0, 7) + '-01') } },
      _sum: { totalAmount: true },
    });
    expect(business.metrics.monthSales).toBe(dbSales._sum.totalAmount ?? 0);
    const dbStock = await prisma.stockBalance.aggregate({ _sum: { quantity: true } });
    expect(business.metrics.stockQuantity).toBe(dbStock._sum.quantity ?? 0);
    // 30 天趋势：长度为 30、按上海日期升序、末日为今天。
    const trend = business.trend as { date: string; sales?: number; purchases?: number }[];
    expect(trend).toHaveLength(30);
    expect(trend.at(-1)?.date).toBe(today());
    expect(business.dateFrom).toBe(trend[0].date);
    expect(business.dateTo).toBe(today());
    const dates = trend.map((row) => row.date);
    expect([...dates].sort()).toEqual(dates);
    // 上海日期分桶：10-14 23:59:59 CST 与 10-15 00:00 CST 分属两天。
    expect(trend.find((row) => row.date === '2026-10-14')?.sales).toBe(400);
    expect(trend.find((row) => row.date === '2026-10-15')?.sales).toBe(800);
    expect(trend.find((row) => row.date === '2026-09-25')?.sales).toBe(200);
    expect(trend.find((row) => row.date === '2026-10-10')?.purchases).toBe(1000);
    // 趋势合计 = 窗口内正式单据合计。
    const trendSales = trend.reduce((sum, row) => sum + (row.sales ?? 0), 0);
    expect(trendSales).toBe(1400);
    const trendPurchases = trend.reduce((sum, row) => sum + (row.purchases ?? 0), 0);
    expect(trendPurchases).toBe(2500);
    // topProducts / orderStatuses 来自真实单据。
    expect(business.topProducts[0]).toMatchObject({
      name: '=SUM(A1:A2)',
      quantity: 7,
      amount: 1400,
    });
    const statuses = business.orderStatuses as { name: string; value: number }[];
    expect(statuses.find((row) => row.name === 'PENDING')).toMatchObject({ value: 1 });
    expect(statuses.find((row) => row.name === 'DRAFT')).toMatchObject({ value: 1 });
    // 3 张正式出库订单 + 1 张草稿 + 1 张待审核。
    expect(statuses.find((row) => row.name === 'SHIPPED')).toMatchObject({ value: 3 });
    expect(statuses.reduce((sum, row) => sum + row.value, 0)).toBe(
      await prisma.salesOrder.count(),
    );
  });

  it('看板按角色裁剪指标与趋势字段，不泄露未授权模块', async () => {
    const metrics = async (client: Client) =>
      (await client.get('/api/v1/dashboard/business')).body.data;
    const salesBusiness = await metrics(salesUser);
    expect(Object.keys(salesBusiness.metrics).sort()).toEqual(
      ['monthSales', 'pendingApprovals', 'stockAlerts', 'stockQuantity'].sort(),
    );
    expect(JSON.stringify(salesBusiness)).not.toMatch(/monthPurchases|receivable|payable/);
    expect(salesBusiness.trend[0]).toHaveProperty('sales');
    expect(salesBusiness.trend[0]).not.toHaveProperty('purchases');
    const purchaseBusiness = await metrics(purchaseUser);
    expect(Object.keys(purchaseBusiness.metrics).sort()).toEqual(
      ['monthPurchases', 'pendingApprovals', 'stockAlerts', 'stockQuantity'].sort(),
    );
    expect(JSON.stringify(purchaseBusiness)).not.toMatch(/monthSales|receivable|payable/);
    expect(purchaseBusiness.trend[0]).toHaveProperty('purchases');
    expect(purchaseBusiness.trend[0]).not.toHaveProperty('sales');
    const warehouseBusiness = await metrics(warehouseUser);
    expect(Object.keys(warehouseBusiness.metrics).sort()).toEqual(
      ['monthPurchases', 'monthSales', 'stockAlerts', 'stockQuantity'].sort(),
    );
    expect(JSON.stringify(warehouseBusiness)).not.toMatch(/receivable|payable|pendingApprovals/);
    const financeBusiness = await metrics(financeUser);
    expect(Object.keys(financeBusiness.metrics).sort()).toEqual(['payable', 'receivable']);
    expect(JSON.stringify(financeBusiness)).not.toMatch(/monthSales|monthPurchases|stockQuantity/);
    expect(financeBusiness.topProducts).toBeUndefined();
    expect(financeBusiness.orderStatuses).toBeUndefined();
    expect(financeBusiness.trend.every((row: object) => Object.keys(row).length === 1)).toBe(true);
    // 财务视角的余额与真实一致。
    expect(financeBusiness.metrics.receivable).toBe(1100);
    expect(financeBusiness.metrics.payable).toBe(2100);
    // 访客只读：可见销售/采购/库存，不泄露财务。
    const guestBusiness = await metrics(guestUser);
    expect(JSON.stringify(guestBusiness)).not.toMatch(/receivable|payable/);
    expect(guestBusiness.metrics.monthSales).toBe(1200);
  });

  it('待办按权限生成，路径可跳转到真实页面', async () => {
    const todo = async (client: Client) =>
      (await client.get('/api/v1/dashboard/todos')).body.data as {
        id: string;
        title: string;
        path: string;
        type: string;
      }[];
    const adminTodos = await todo(admin);
    const types = [...new Set(adminTodos.map((item) => item.type))].sort();
    expect(types).toEqual(['inventory', 'purchase', 'sales']);
    // 管理员同时具备审核权与过账权：采购侧待审核 + 待入库各一条，销售侧待审核一条，预警一条。
    const purchaseTodos = adminTodos.filter((item) => item.type === 'purchase');
    expect(purchaseTodos).toHaveLength(2);
    expect(purchaseTodos.map((item) => item.id).sort()).toEqual(
      [fx.pendingPurchaseOrderId, fx.approvedPurchaseOrderId].sort(),
    );
    expect(
      purchaseTodos.find((item) => item.id === fx.pendingPurchaseOrderId)?.title,
    ).toContain('待审核');
    expect(
      purchaseTodos.find((item) => item.id === fx.approvedPurchaseOrderId)?.title,
    ).toContain('待入库');
    expect(adminTodos.filter((item) => item.type === 'sales')).toHaveLength(1);
    const alertTodo = adminTodos.find((item) => item.type === 'inventory');
    expect(alertTodo?.path).toBe('/stock-alerts');
    expect(alertTodo?.title).toContain('项库存低于预警线');
    // 每条路径都必须是前端真实存在的路由。
    const routes = new Set([
      '/purchase-orders',
      '/sales-orders',
      '/stock-alerts',
      '/goods-receipts',
      '/sales-shipments',
    ]);
    for (const item of adminTodos) {
      const [pathname, search] = item.path.split('?');
      expect(routes.has(pathname), `${item.path} 不是真实页面`).toBe(true);
      if (search) {
        const params = new URLSearchParams(search);
        const view = params.get('view');
        expect(view).toBeTruthy();
        // view 参数必须能打开真实单据详情。
        const detail =
          pathname === '/purchase-orders'
            ? await admin.get(`/api/v1/purchase-orders/${view}`)
            : await admin.get(`/api/v1/sales-orders/${view}`);
        expect(detail.status, `${item.path} 详情不可打开`).toBe(200);
      }
    }
    // 待审核待办指向 pending 单据，待入库待办指向已审核单据。
    const salesTodo = adminTodos.find((item) => item.type === 'sales');
    expect(salesTodo?.id).toBe(fx.pendingSalesOrderId);
    expect(salesTodo?.title).toContain('待审核');
    // 仓库角色只拿到待入库（已审核）与预警，不拿待审核。
    const warehouseTodos = await todo(warehouseUser);
    expect(warehouseTodos.some((item) => item.type === 'purchase')).toBe(true);
    expect(warehouseTodos.find((item) => item.type === 'purchase')?.id).toBe(
      fx.approvedPurchaseOrderId,
    );
    expect(warehouseTodos.find((item) => item.type === 'purchase')?.title).toContain('待入库');
    expect(warehouseTodos.some((item) => item.title.includes('待审核'))).toBe(false);
    // 销售角色只拿销售待审核，不拿采购待办。
    const salesTodos = await todo(salesUser);
    expect(salesTodos.some((item) => item.type === 'purchase')).toBe(false);
    expect(salesTodos.find((item) => item.type === 'sales')?.id).toBe(
      fx.pendingSalesOrderId,
    );
    // 财务角色既无审核权也无出入库权，也不含财务金额待办。
    expect(await todo(financeUser)).toEqual([]);
    // 访客无审核/过账权，只剩库存预警（只读提示）。
    const guestTodos = await todo(guestUser);
    expect(guestTodos.every((item) => item.type === 'inventory')).toBe(true);
  });

  it('报表/看板/财务三方对账恒等式成立，且数据库完整性检查通过', async () => {
    const sales = (await admin.get('/api/v1/reports/sales?pageSize=100')).body.data;
    const purchases = (await admin.get('/api/v1/reports/purchases?pageSize=100')).body.data;
    const finance = (await admin.get('/api/v1/reports/finance?pageSize=100')).body.data;
    const overview = (await admin.get('/api/v1/finance/summary')).body.data;
    const business = (await admin.get('/api/v1/dashboard/business')).body.data;
    // 报表金额 = 正式出库/入库明细合计 = 应收/应付原始金额合计。
    expect(sales.totals.amount).toBe(overview.receivableTotal);
    expect(purchases.totals.amount).toBe(overview.payableTotal);
    expect(finance.totals.amount).toBe(sales.totals.amount + purchases.totals.amount);
    // 已结 = 结算流水合计；未结 = 余额合计。
    const dbSettlements = await prisma.settlementRecord.aggregate({ _sum: { amount: true } });
    expect(finance.totals.settled).toBe(dbSettlements._sum.amount ?? 0);
    expect(overview.receipts + overview.payments).toBe(dbSettlements._sum.amount ?? 0);
    expect(finance.totals.balance).toBe(
      overview.receivableRemaining + overview.payableRemaining,
    );
    // 看板待收付与概览一致。
    expect(business.metrics.receivable).toBe(overview.receivableRemaining);
    expect(business.metrics.payable).toBe(overview.payableRemaining);
    // 库存报表合计 = 库存余额合计 = 看板库存数量。
    const inventory = (await admin.get('/api/v1/reports/inventory?pageSize=100')).body.data;
    const dbStock = await prisma.stockBalance.aggregate({ _sum: { quantity: true } });
    expect(inventory.totals.quantity).toBe(dbStock._sum.quantity ?? 0);
    expect(business.metrics.stockQuantity).toBe(dbStock._sum.quantity ?? 0);
    // 期初 + 期间增减 - 期间减少 = 截止库存（跨模块口径闭环）。
    const period = (
      await admin.get('/api/v1/reports/inventory?pageSize=100&dateFrom=2026-09-01&dateTo=2026-10-31')
    ).body.data;
    const dbMovements = await prisma.stockMovement.aggregate({ _sum: { quantity: true } });
    expect(period.totals.quantity).toBe(dbMovements._sum.quantity ?? 0);
    const integrity = await checkIntegrity();
    expect(
      integrity.checks.filter((item) => item.violations > 0),
      JSON.stringify(integrity.checks),
    ).toEqual([]);
  });
});
