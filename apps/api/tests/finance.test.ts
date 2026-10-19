import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, type TestServer } from './server.js';
let server: TestServer;
let agent: ReturnType<TestServer['agent']>;
let token = '',
  payableId = '',
  receivableId = '';
let purchaseBody: object;
const post = (path: string, body: object, key?: string) => {
  const req = agent
    .post('/api/v1' + path)
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', token);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};
beforeAll(async () => {
  server = await startTestServer();
  agent = server.agent();
  await cleanDatabase();
  const role = await prisma.role.create({
    data: { code: 'FADMIN', name: '财务测试', permissions: '["*"]' },
  });
  const user = await prisma.user.create({
    data: {
      username: 'fadmin',
      displayName: '财务验收',
      passwordHash: await hash('Test@12345', 4),
      roleId: role.id,
    },
  });
  const login = await post('/auth/login', {
    username: 'fadmin',
    password: 'Test@12345',
  });
  token = login.body.data.csrfToken;
  const category = await prisma.productCategory.create({
    data: { code: 'FC', name: '财务商品', createdById: user.id },
  });
  const product = await prisma.product.create({
    data: {
      code: 'FA',
      name: '商品A',
      categoryId: category.id,
      unit: '件',
      purchasePrice: 8000,
      salesPrice: 12000,
      createdById: user.id,
    },
  });
  const supplier = await prisma.supplier.create({
    data: { code: 'FS', name: '供应商', createdById: user.id },
  });
  const customer = await prisma.customer.create({
    data: { code: 'FCU', name: '客户', createdById: user.id },
  });
  const warehouse = await prisma.warehouse.create({
    data: { code: 'FW', name: '仓库', createdById: user.id },
  });
  purchaseBody = {
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    orderDate: '2026-10-16',
    items: [{ productId: product.id, quantity: 10, unitPrice: 8000 }],
  };
  const purchase = await post('/purchase-orders', purchaseBody);
  const order = purchase.body.data;
  await post(`/purchase-orders/${order.id}/submit`, {});
  await post(`/purchase-orders/${order.id}/approve`, {});
  await post(
    '/goods-receipts',
    {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 10 }],
    },
    'finance-purchase-1',
  );
  payableId = (await prisma.payable.findFirstOrThrow()).id;
  const sale = await post('/sales-orders', {
    customerId: customer.id,
    warehouseId: warehouse.id,
    orderDate: '2026-10-16',
    items: [{ productId: product.id, quantity: 3, unitPrice: 12000 }],
  });
  expect(sale.status).toBe(201);
  {
    const so = sale.body.data;
    expect((await post(`/sales-orders/${so.id}/submit`, {})).status).toBe(200);
    expect((await post(`/sales-orders/${so.id}/approve`, {})).status).toBe(200);
    const shipped = await post(
      '/sales-shipments',
      { orderId: so.id, items: [{ orderItemId: so.items[0].id, quantity: 3 }] },
      'finance-sale-1',
    );
    expect(shipped.body).not.toHaveProperty('error');
    expect(shipped.status).toBe(201);
    receivableId = (await agent.get('/api/v1/receivables')).body.data.items[0]
      .id;
  }
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});
describe.sequential('真实财务结算', () => {
  it('应收360元先收100元，再收260元；原键重放不会重复', async () => {
    const body = {
      sourceId: receivableId,
      amount: 10000,
      date: '2026-10-16',
      method: '银行转账',
      remark: '首笔',
    };
    const first = await post('/settlements/receipts', body, 'finance-ar-first');
    expect(first.status).toBe(201);
    const repeat = await post(
      '/settlements/receipts',
      body,
      'finance-ar-first',
    );
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.id).toBe(first.body.data.id);
    let detail = await agent.get('/api/v1/receivables/' + receivableId);
    expect(detail.body.data).toMatchObject({
      originalAmount: 36000,
      receivedAmount: 10000,
      status: 'PARTIAL',
    });
    const second = await post(
      '/settlements/receipts',
      { ...body, amount: 26000 },
      'finance-ar-last',
    );
    expect(second.status).toBe(201);
    detail = await agent.get('/api/v1/receivables/' + receivableId);
    expect(detail.body.data).toMatchObject({
      receivedAmount: 36000,
      status: 'SETTLED',
    });
    expect(
      (
        await post(
          '/settlements/receipts',
          { ...body, amount: 1 },
          'finance-ar-over',
        )
      ).status,
    ).toBe(409);
  });
  it('付款支持部分、全额，拒绝超额和同键异请求', async () => {
    const body = {
      sourceId: payableId,
      amount: 30000,
      date: '2026-10-16',
      method: '现金',
    };
    expect(
      (await post('/settlements/payments', body, 'finance-ap-first')).status,
    ).toBe(201);
    expect(
      (
        await post(
          '/settlements/payments',
          { ...body, amount: 40000 },
          'finance-ap-first',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          '/settlements/payments',
          { ...body, amount: 50001 },
          'finance-ap-over',
        )
      ).status,
    ).toBe(409);
    const partial = await agent.get('/api/v1/payables/' + payableId);
    expect(partial.body.data).toMatchObject({
      paidAmount: 30000,
      status: 'PARTIAL',
    });
    expect(
      (
        await post(
          '/settlements/payments',
          { ...body, amount: 50000 },
          'finance-ap-last',
        )
      ).status,
    ).toBe(201);
    expect(
      (await agent.get('/api/v1/payables/' + payableId)).body.data.status,
    ).toBe('SETTLED');
  });
  it('拒绝零数、负数、小数、日期错误及任意状态', async () => {
    for (const amount of [0, -1, 0.1])
      expect(
        (
          await post(
            '/settlements/payments',
            { sourceId: payableId, amount, date: '2026-10-16', method: '现金' },
            'finance-bad-' + amount,
          )
        ).status,
      ).toBe(422);
    expect(
      (
        await post(
          '/settlements/payments',
          {
            sourceId: payableId,
            amount: 1,
            date: '2026-02-30',
            method: '现金',
          },
          'finance-bad-date',
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          '/settlements/payments',
          {
            sourceId: payableId,
            amount: 1,
            date: '2026-10-16',
            method: '现金',
            status: 'SETTLED',
          },
          'finance-bad-state',
        )
      ).status,
    ).toBe(422);
  });
  it('历史结算只读，财务概览与实际结算一致', async () => {
    const result = await agent.get('/api/v1/settlements');
    expect(result.status).toBe(200);
    expect(result.body.data.total).toBe(4);
    const overview = await agent.get('/api/v1/finance/summary');
    expect(overview.status).toBe(200);
    expect(overview.body.data).toMatchObject({
      receivableTotal: 36000,
      receivableRemaining: 0,
      payableTotal: 80000,
      payableRemaining: 0,
      receipts: 36000,
      payments: 80000,
    });
  });
  it('下游写入失败会回滚余额；并发付款不能超额', async () => {
    const order = (await post('/purchase-orders', purchaseBody)).body.data;
    await post(`/purchase-orders/${order.id}/submit`, {});
    await post(`/purchase-orders/${order.id}/approve`, {});
    const receipt = (
      await post(
        '/goods-receipts',
        {
          orderId: order.id,
          items: [{ orderItemId: order.items[0].id, quantity: 10 }],
        },
        'finance-concurrent-stock',
      )
    ).body.data;
    const ap = await prisma.payable.findUniqueOrThrow({
      where: { receiptId: receipt.id },
    });
    const body = {
      sourceId: ap.id,
      amount: 60000,
      date: '2026-10-16',
      method: '现金',
    };
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER finance_test_failure BEFORE INSERT ON SettlementRecord BEGIN SELECT RAISE(ABORT, 'TEST_FAILURE'); END",
    );
    try {
      expect(
        (await post('/settlements/payments', body, 'finance-fault-test'))
          .status,
      ).toBe(409);
      expect(
        (await prisma.payable.findUniqueOrThrow({ where: { id: ap.id } }))
          .paidAmount,
      ).toBe(0);
      expect(
        await prisma.idempotencyRecord.count({
          where: { key: 'finance-fault-test' },
        }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER finance_test_failure');
    }
    const results = await Promise.all([
      post('/settlements/payments', body, 'finance-race-1'),
      post('/settlements/payments', body, 'finance-race-2'),
    ]);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(
      results.filter((result) => [409, 503].includes(result.status)),
    ).toHaveLength(1);
    expect(
      (await prisma.payable.findUniqueOrThrow({ where: { id: ap.id } }))
        .paidAmount,
    ).toBe(60000);
    expect(
      await prisma.settlementRecord.count({ where: { payableId: ap.id } }),
    ).toBe(1);
  });
  it('销售角色不能读取或修改财务，审计不含敏感输入', async () => {
    const role = await prisma.role.create({
      data: { code: 'FSALES', name: '销售', permissions: '["sales:read"]' },
    });
    await prisma.user.create({
      data: {
        username: 'fsales',
        displayName: '销售',
        passwordHash: await hash('Test@12345', 4),
        roleId: role.id,
      },
    });
    const sales = server.agent();
    const login = await sales
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ username: 'fsales', password: 'Test@12345' });
    for (const endpoint of [
      '/payables',
      '/receivables',
      '/settlements',
      '/finance/summary',
    ])
      expect((await sales.get('/api/v1' + endpoint)).status).toBe(403);
    expect(
      (
        await sales
          .post('/api/v1/settlements/payments')
          .set('Origin', 'http://localhost:5173')
          .set('X-CSRF-Token', login.body.data.csrfToken)
          .set('Idempotency-Key', 'sales-forbidden-pay')
          .send({
            sourceId: payableId,
            amount: 1,
            date: '2026-10-16',
            method: '现金',
          })
      ).status,
    ).toBe(403);
    const logs = JSON.stringify(
      await prisma.auditLog.findMany({ where: { resource: 'settlements' } }),
    );
    expect(logs).not.toContain('Test@12345');
    expect(logs).not.toContain('passwordHash');
  });
});
