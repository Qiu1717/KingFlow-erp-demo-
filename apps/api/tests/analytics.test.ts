import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, type TestServer } from './server.js';
let server: TestServer;
let agent: ReturnType<TestServer['agent']>;
const origin = 'http://localhost:5173';
let token = '',
  productId = '',
  warehouseId = '';
const post = (body: object, key: string) =>
  agent
    .post('/api/v1/stock-adjustments')
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', token)
    .set('Idempotency-Key', key)
    .send(body);
beforeAll(async () => {
  server = await startTestServer();
  agent = server.agent();
  await cleanDatabase();
  const role = await prisma.role.create({
    data: { code: 'ANALYTICS', name: '报表测试', permissions: '["*"]' },
  });
  const user = await prisma.user.create({
    data: {
      username: 'analytics',
      displayName: '报表测试',
      passwordHash: await hash('Test@12345', 4),
      roleId: role.id,
    },
  });
  const login = await agent
    .post('/api/v1/auth/login')
    .set('Origin', 'http://localhost:5173')
    .send({ username: 'analytics', password: 'Test@12345' });
  token = login.body.data.csrfToken;
  const category = await prisma.productCategory.create({
    data: { code: 'AC', name: '报表', createdById: user.id },
  });
  productId = (
    await prisma.product.create({
      data: {
        code: 'AP',
        name: '=危险公式',
        unit: '件',
        categoryId: category.id,
        minStock: 5,
        purchasePrice: 8000,
        salesPrice: 12000,
        createdById: user.id,
      },
    })
  ).id;
  warehouseId = (
    await prisma.warehouse.create({
      data: { code: 'AW', name: '报表仓', createdById: user.id },
    })
  ).id;
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});
describe.sequential('经营分析与库存调整', () => {
  it('缺失余额的启用商品仓库按0预警', async () => {
    const r = await agent.get('/api/v1/stock-alerts');
    expect(r.status).toBe(200);
    expect(r.body.data.items[0]).toMatchObject({
      productId,
      warehouseId,
      quantity: 0,
      shortage: 5,
    });
  });
  it('原因必填、整数非零且不得产生负库存', async () => {
    for (const quantity of [0, 1.5, -1])
      expect(
        (
          await post(
            { productId, warehouseId, quantity, reason: '盘点' },
            `invalid-${quantity}`,
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await post(
          { productId, warehouseId, quantity: 2, reason: '' },
          'reason-invalid',
        )
      ).status,
    ).toBe(422);
    expect(await prisma.stockBalance.count()).toBe(0);
  });
  it('调整、流水、幂等和审计同时保存，重复请求不重复调整', async () => {
    const body = { productId, warehouseId, quantity: 10, reason: '期初盘点' };
    const first = await post(body, 'analytics-adjust-1');
    expect(first.status).toBe(201);
    expect((await post(body, 'analytics-adjust-1')).body.data.id).toBe(
      first.body.data.id,
    );
    expect(
      (await post({ ...body, quantity: 11 }, 'analytics-adjust-1')).status,
    ).toBe(409);
    expect((await prisma.stockBalance.findFirstOrThrow()).quantity).toBe(10);
    expect(await prisma.stockMovement.count()).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { resource: 'stock-adjustments' } }),
    ).toBe(1);
  });
  it('并发扣减不会出现负库存', async () => {
    const results = await Promise.all([
      post(
        { productId, warehouseId, quantity: -7, reason: '盘亏' },
        'analytics-concurrent-a',
      ),
      post(
        { productId, warehouseId, quantity: -7, reason: '盘亏' },
        'analytics-concurrent-b',
      ),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await prisma.stockBalance.findFirstOrThrow()).quantity).toBe(3);
  });
  it('库存报表、CSV和仪表盘使用实际数据', async () => {
    const report = await agent.get('/api/v1/reports/inventory');
    expect(report.status).toBe(200);
    expect(report.body.data.totals.quantity).toBe(3);
    const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
    const period = await agent
      .get('/api/v1/reports/inventory')
      .query({ dateFrom: today, dateTo: today });
    expect(period.body.data.items[0]).toMatchObject({
      openingQuantity: 0,
      inboundQuantity: 10,
      outboundQuantity: 7,
      quantity: 3,
    });
    const historical = await agent.get(
      '/api/v1/reports/inventory?dateTo=1970-01-01',
    );
    expect(historical.body.data.totals.quantity).toBe(0);
    const csv = await agent.get('/api/v1/reports/inventory?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("'=危险公式");
    const dashboard = await agent.get('/api/v1/dashboard/business');
    expect(dashboard.body.data.metrics.stockQuantity).toBe(3);
    expect(dashboard.body.data.trend).toHaveLength(30);
  });
  it('非法日期及反向日期拒绝，未登录拒绝', async () => {
    expect(
      (await agent.get('/api/v1/reports/sales?dateFrom=2026-02-30')).status,
    ).toBe(422);
    expect(
      (
        await agent.get(
          '/api/v1/reports/sales?dateFrom=2026-10-20&dateTo=2026-10-01',
        )
      ).status,
    ).toBe(422);
    expect(
      (await request(server.server).get('/api/v1/dashboard/business')).status,
    ).toBe(401);
  });
  it('正式采购销售报表、商品排行及收款余额与业务一致，上海边界不串日', async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { username: 'analytics' },
    });
    const supplier = await prisma.supplier.create({
      data: { code: 'AS', name: '报表供应商', createdById: user.id },
    });
    const customer = await prisma.customer.create({
      data: { code: 'ACU', name: '报表客户', createdById: user.id },
    });
    const apiPost = (path: string, body: object, key?: string) => {
      const req = agent
        .post('/api/v1' + path)
        .set('Origin', origin)
        .set('X-CSRF-Token', token);
      if (key) req.set('Idempotency-Key', key);
      return req.send(body);
    };
    const purchase = await apiPost('/purchase-orders', {
      supplierId: supplier.id,
      warehouseId,
      orderDate: '2026-10-16',
      items: [{ productId, quantity: 10, unitPrice: 8000 }],
    });
    expect(purchase.status).toBe(201);
    for (const action of ['submit', 'approve'])
      expect(
        (
          await apiPost(
            `/purchase-orders/${purchase.body.data.id}/${action}`,
            {},
          )
        ).status,
      ).toBe(200);
    const receipt = await apiPost(
      '/goods-receipts',
      {
        orderId: purchase.body.data.id,
        items: [{ orderItemId: purchase.body.data.items[0].id, quantity: 10 }],
      },
      'analytics-receipt',
    );
    expect(receipt.status).toBe(201);
    const sale = await apiPost('/sales-orders', {
      customerId: customer.id,
      warehouseId,
      orderDate: '2026-10-16',
      items: [{ productId, quantity: 3, unitPrice: 12000 }],
    });
    expect(sale.status).toBe(201);
    // Draft sales do not count as revenue.
    expect(
      (await agent.get('/api/v1/reports/sales')).body.data.totals.amount,
    ).toBe(0);
    for (const action of ['submit', 'approve'])
      expect(
        (await apiPost(`/sales-orders/${sale.body.data.id}/${action}`, {}))
          .status,
      ).toBe(200);
    const shipment = await apiPost(
      '/sales-shipments',
      {
        orderId: sale.body.data.id,
        items: [{ orderItemId: sale.body.data.items[0].id, quantity: 3 }],
      },
      'analytics-shipment',
    );
    expect(shipment.status).toBe(201);
    // Shanghai 00:00 belongs to 16th, UTC still 15th.
    await prisma.salesShipment.update({
      where: { id: shipment.body.data.id },
      data: { createdAt: new Date('2026-10-15T16:00:00Z') },
    });
    const dateRange = '?dateFrom=2026-10-16&dateTo=2026-10-16';
    const sales = await agent.get('/api/v1/reports/sales' + dateRange);
    expect(sales.body.data.totals).toMatchObject({
      quantity: 3,
      amount: 36000,
    });
    expect(sales.body.data.analysis.partnerRanking[0]).toMatchObject({
      quantity: 3,
      amount: 36000,
    });
    expect(sales.body.data.analysis.productRanking[0]).toMatchObject({
      quantity: 3,
      amount: 36000,
    });
    expect(sales.body.data.analysis.trend).toContainEqual({
      name: '2026-10-16',
      quantity: 3,
      amount: 36000,
    });
    expect(
      (await agent.get('/api/v1/reports/sales?dateTo=2026-10-15')).body.data
        .total,
    ).toBe(0);
    await prisma.salesShipment.update({
      where: { id: shipment.body.data.id },
      data: { createdAt: new Date('2026-10-16T16:00:00Z') },
    });
    expect(
      (await agent.get('/api/v1/reports/sales' + dateRange)).body.data.total,
    ).toBe(0);
    await prisma.salesShipment.update({
      where: { id: shipment.body.data.id },
      data: { createdAt: new Date('2026-10-15T16:00:00Z') },
    });
    const purchases = await agent.get('/api/v1/reports/purchases');
    expect(purchases.body.data.totals).toMatchObject({
      quantity: 10,
      amount: 80000,
    });
    const receivable = await prisma.receivable.findUniqueOrThrow({
      where: { shipmentId: shipment.body.data.id },
    });
    expect(
      (
        await apiPost(
          '/settlements/receipts',
          {
            sourceId: receivable.id,
            amount: 10000,
            date: '2026-10-16',
            method: '银行转账',
          },
          'analytics-settle',
        )
      ).status,
    ).toBe(201);
    const finance = await agent.get('/api/v1/reports/finance');
    expect(
      finance.body.data.items.find(
        (r: { id: string }) => r.id === receivable.id,
      ),
    ).toMatchObject({ amount: 36000, settled: 10000, balance: 26000 });
    expect(
      finance.body.data.analysis.financeSummary.find(
        (r: { name: string }) => r.name === '应收账款',
      ),
    ).toMatchObject({ amount: 36000, settled: 10000, balance: 26000 });
    const dashboard = await agent.get('/api/v1/dashboard/business');
    expect(dashboard.body.data.metrics).toMatchObject({
      receivable: 26000,
      payable: 80000,
    });
    expect(dashboard.body.data.orderStatuses).toContainEqual({
      name: 'SHIPPED',
      value: 1,
    });
  });
  it('可视化排行支持数量指标，按全量筛选结果汇总并验证参数', async () => {
    const response = await agent.get('/api/v1/reports/sales').query({
      rankBy: 'quantity',
      warehouseId,
      pageSize: 1,
      dateFrom: '2026-10-16',
      dateTo: '2026-10-16',
    });
    expect(response.status).toBe(200);
    expect(response.body.data.analysis.productRanking[0]).toMatchObject({
      quantity: 3,
      amount: 36000,
    });
    expect(response.body.data.totals.amount).toBe(36000);
    const empty = await agent.get('/api/v1/reports/sales').query({
      rankBy: 'quantity',
      warehouseId: 'not-a-warehouse',
    });
    expect(empty.body.data.analysis.productRanking).toEqual([]);
    expect(empty.body.data.totals.amount).toBe(0);
    expect(
      (await agent.get('/api/v1/reports/sales?rankBy=unsafe')).status,
    ).toBe(422);
  });
  it('数量前10名由全部业务明细排序后截取，不受分页或金额排行影响', async () => {
    const apiPost = (path: string, body: object, key?: string) => {
      const req = agent
        .post('/api/v1' + path)
        .set('Origin', origin)
        .set('X-CSRF-Token', token);
      if (key) req.set('Idempotency-Key', key);
      return req.send(body);
    };
    const categoryId = (
      await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    ).categoryId;
    const items: { productId: string; quantity: number; unitPrice: number }[] =
      [];
    for (let i = 1; i <= 11; i++) {
      const product = await apiPost('/products', {
        code: `RANK-${i}`,
        name: `排行验收${i}`,
        categoryId,
        unit: '件',
        purchasePrice: 1,
        salesPrice: 1,
        minStock: 0,
      });
      expect(product.status).toBe(201);
      const id = product.body.data.id;
      expect(
        (
          await post(
            {
              productId: id,
              warehouseId,
              quantity: i,
              reason: '排行验收期初库存',
            },
            `ranking-stock-${i}`,
          )
        ).status,
      ).toBe(201);
      items.push({
        productId: id,
        quantity: i,
        unitPrice: i === 1 ? 100000 : 1,
      });
    }
    const customer = await prisma.customer.findFirstOrThrow();
    const order = await apiPost('/sales-orders', {
      customerId: customer.id,
      warehouseId,
      orderDate: '2026-10-19',
      items,
    });
    expect(order.status).toBe(201);
    for (const action of ['submit', 'approve'])
      expect(
        (await apiPost(`/sales-orders/${order.body.data.id}/${action}`, {}))
          .status,
      ).toBe(200);
    expect(
      (
        await apiPost(
          '/sales-shipments',
          {
            orderId: order.body.data.id,
            items: order.body.data.items.map(
              (i: { id: string; quantity: number }) => ({
                orderItemId: i.id,
                quantity: i.quantity,
              }),
            ),
          },
          'ranking-shipment',
        )
      ).status,
    ).toBe(201);
    const query = { q: 'RANK-', pageSize: 1 };
    const amount = (await agent.get('/api/v1/reports/sales').query(query)).body
      .data;
    const quantity = (
      await agent
        .get('/api/v1/reports/sales')
        .query({ ...query, rankBy: 'quantity' })
    ).body.data;
    expect(amount.analysis.productRanking[0].quantity).toBe(1);
    expect(quantity.analysis.productRanking).toHaveLength(10);
    expect(quantity.analysis.productRanking[0].quantity).toBe(11);
    expect(quantity.analysis.productRanking[9].quantity).toBe(2);
    expect(quantity.items).toHaveLength(1);
    expect(quantity.total).toBe(11);
    expect(quantity.totals.quantity).toBe(66);
    expect(quantity.totals.amount).toBe(amount.totals.amount);
  });
  it('销售账号不能查财务，仪表盘和待办均不泄露财务', async () => {
    const role = await prisma.role.create({
      data: {
        code: 'ANALYTICS-SALES',
        name: '销售',
        permissions:
          '["sales:read","sales:write","sales:approve","inventory:read"]',
      },
    });
    await prisma.user.create({
      data: {
        username: 'analytics-sales',
        displayName: '销售测试',
        passwordHash: await hash('Test@12345', 4),
        roleId: role.id,
      },
    });
    const sales = server.agent();
    await sales
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: 'analytics-sales', password: 'Test@12345' });
    expect((await sales.get('/api/v1/reports/finance')).status).toBe(403);
    expect((await sales.get('/api/v1/reports/purchases')).status).toBe(403);
    const business = await sales.get('/api/v1/dashboard/business');
    expect(business.body.data.metrics).not.toHaveProperty('receivable');
    expect(business.body.data.metrics).not.toHaveProperty('payable');
    expect(business.body.data.metrics).not.toHaveProperty('monthPurchases');
    expect(business.body.data.trend[0]).not.toHaveProperty('purchases');
    expect(
      JSON.stringify((await sales.get('/api/v1/dashboard/todos')).body),
    ).not.toMatch(/receivable|payable|26000|80000/);
  });
  it('下游审计失败则调整、余额、流水、幂等全部回滚', async () => {
    const before = await prisma.stockBalance.findFirstOrThrow();
    const count = await prisma.stockMovement.count();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER analytics_fail_audit BEFORE INSERT ON AuditLog WHEN NEW.resource = 'stock-adjustments' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
    );
    try {
      expect(
        (
          await post(
            { productId, warehouseId, quantity: 1, reason: '验证回滚' },
            'analytics-rollback',
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect((await prisma.stockBalance.findFirstOrThrow()).quantity).toBe(
        before.quantity,
      );
      expect(await prisma.stockMovement.count()).toBe(count);
      expect(
        await prisma.idempotencyRecord.findUnique({
          where: { key: 'analytics-rollback' },
        }),
      ).toBeNull();
      expect(
        await prisma.stockAdjustment.count({ where: { reason: '验证回滚' } }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER analytics_fail_audit');
    }
  });
});
