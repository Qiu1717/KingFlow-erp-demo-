import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, type TestServer } from './server.js';
const origin = 'http://localhost:5173';
let server: TestServer;
let agent: ReturnType<TestServer['agent']>;
let token = '';
let productId = '';
let supplierId = '';
let warehouseId = '';
let secondWarehouseId = '';
let orderId = '';
let itemId = '';
let firstReceiptId = '';
const post = (path: string, body: object, key?: string) => {
  const req = agent
    .post('/api/v1' + path)
    .set('Origin', origin)
    .set('X-CSRF-Token', token);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};
const patch = async (path: string, body: object) => {
  const current = (await agent.get('/api/v1' + path)).body.data;
  return agent
    .patch('/api/v1' + path)
    .set('Origin', origin)
    .set('X-CSRF-Token', token)
    .set(
      'If-Match',
      '"' + (current?.updatedAt ?? '1970-01-01T00:00:00.000Z') + '"',
    )
    .send(
      path.startsWith('/purchase-orders/')
        ? { version: current?.version, ...body }
        : body,
    );
};
beforeAll(async () => {
  server = await startTestServer();
  agent = server.agent();
  await cleanDatabase();
  const role = await prisma.role.upsert({
    where: { code: 'P3ADMIN' },
    update: {},
    create: { code: 'P3ADMIN', name: '采购测试管理员', permissions: '["*"]' },
  });
  const user = await prisma.user.upsert({
    where: { username: 'p3admin' },
    update: { passwordHash: await hash('Test@12345', 4), status: 'ACTIVE' },
    create: {
      username: 'p3admin',
      passwordHash: await hash('Test@12345', 4),
      displayName: '采购测试',
      roleId: role.id,
    },
  });
  const login = await agent
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ username: 'p3admin', password: 'Test@12345' });
  token = login.body.data.csrfToken;
  const cat = await prisma.productCategory.create({
    data: { code: 'P3-CAT', name: '采购测试分类', createdById: user.id },
  });
  productId = (
    await prisma.product.create({
      data: {
        code: 'P3-A',
        name: '商品 A',
        categoryId: cat.id,
        unit: '件',
        purchasePrice: 8000,
        salesPrice: 12000,
        createdById: user.id,
      },
    })
  ).id;
  supplierId = (
    await prisma.supplier.create({
      data: { code: 'P3-S', name: '采购测试供应商', createdById: user.id },
    })
  ).id;
  warehouseId = (
    await prisma.warehouse.create({
      data: { code: 'P3-W', name: '验收仓', createdById: user.id },
    })
  ).id;
  secondWarehouseId = (
    await prisma.warehouse.create({
      data: { code: 'P3-W2', name: '第二仓', createdById: user.id },
    })
  ).id;
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});
const orderBody = () => ({
  supplierId,
  warehouseId,
  orderDate: '2026-10-16',
  expectedDate: '2026-10-20',
  remark: '6+4验收',
  items: [{ productId, quantity: 10, unitPrice: 8000 }],
});
describe.sequential('采购与入库真实业务闭环', () => {
  it('创建草稿，后端计算800元且保存商品快照', async () => {
    const res = await post('/purchase-orders', orderBody());
    expect(res.status).toBe(201);
    orderId = res.body.data.id;
    itemId = res.body.data.items[0].id;
    expect(res.body.data.totalAmount).toBe(80000);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.items[0].productName).toBe('商品 A');
  });
  it('未审核不能入库，不能普通PATCH跳过状态', async () => {
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId, items: [{ orderItemId: itemId, quantity: 6 }] },
          'p3-unapproved',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await patch(`/purchase-orders/${orderId}`, {
          ...orderBody(),
          status: 'APPROVED',
        })
      ).status,
    ).toBe(422);
    expect((await agent.get('/api/v1/goods-receipts')).body.data.total).toBe(0);
  });
  it('草稿可编辑，提交后禁止编辑，驳回后可重新提交审核', async () => {
    const edited = await patch(`/purchase-orders/${orderId}`, orderBody());
    expect(edited.status).toBe(200);
    itemId = edited.body.data.items[0].id;
    expect(
      (await post(`/purchase-orders/${orderId}/submit`, {})).body.data.status,
    ).toBe('PENDING');
    expect(
      (await patch(`/purchase-orders/${orderId}`, orderBody())).status,
    ).toBe(409);
    expect(
      (await post(`/purchase-orders/${orderId}/reject`, { reason: '核对交期' }))
        .body.data.status,
    ).toBe('DRAFT');
    expect((await post(`/purchase-orders/${orderId}/submit`, {})).status).toBe(
      200,
    );
    expect(
      (await post(`/purchase-orders/${orderId}/approve`, {})).body.data.status,
    ).toBe('APPROVED');
    expect((await post(`/purchase-orders/${orderId}/approve`, {})).status).toBe(
      409,
    );
  });
  it('入6件：库存+6、流水6、应付480元、订单部分入库', async () => {
    const res = await post(
      '/goods-receipts',
      { orderId, items: [{ orderItemId: itemId, quantity: 6 }] },
      'p3-first',
    );
    expect(res.status).toBe(201);
    firstReceiptId = res.body.data.id;
    expect(res.body.data.totalAmount).toBe(48000);
    const order = (await agent.get(`/api/v1/purchase-orders/${orderId}`)).body
      .data;
    expect(order.status).toBe('PARTIAL');
    expect(order.items[0].receivedQuantity).toBe(6);
    const stocks = (
      await agent.get('/api/v1/stocks').query({ productId, warehouseId })
    ).body.data;
    expect(stocks.items[0].quantity).toBe(6);
    const movements = (
      await agent.get('/api/v1/stock-movements').query({ productId })
    ).body.data;
    expect(movements.items[0]).toMatchObject({
      quantity: 6,
      beforeQuantity: 0,
      afterQuantity: 6,
    });
    const payable = (
      await agent.get('/api/v1/payables').query({ receiptId: firstReceiptId })
    ).body.data.items[0];
    expect(payable).toMatchObject({
      originalAmount: 48000,
      paidAmount: 0,
      status: 'UNSETTLED',
    });
  });
  it('同键同请求返回原单，同键不同请求冲突，不能重复增加库存', async () => {
    const replay = await post(
      '/goods-receipts',
      { orderId, items: [{ orderItemId: itemId, quantity: 6 }] },
      'p3-first',
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(firstReceiptId);
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId, items: [{ orderItemId: itemId, quantity: 1 }] },
          'p3-first',
        )
      ).status,
    ).toBe(409);
    expect(
      (await agent.get('/api/v1/stocks').query({ productId })).body.data
        .items[0].quantity,
    ).toBe(6);
  });
  it('超量、零、负、重复行、异单行、无幂等键均拒绝且无副作用', async () => {
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId, items: [{ orderItemId: itemId, quantity: 5 }] },
          'p3-overflow',
        )
      ).status,
    ).toBe(409);
    for (const quantity of [0, -1, 1.5])
      expect(
        (
          await post(
            '/goods-receipts',
            { orderId, items: [{ orderItemId: itemId, quantity }] },
            'p3-invalid',
          )
        ).status,
      ).toBe(422);
    expect(
      (
        await post(
          '/goods-receipts',
          {
            orderId,
            items: [
              { orderItemId: itemId, quantity: 1 },
              { orderItemId: itemId, quantity: 1 },
            ],
          },
          'p3-dupe',
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId, items: [{ orderItemId: 'foreign-item', quantity: 1 }] },
          'p3-foreign',
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post('/goods-receipts', {
          orderId,
          items: [{ orderItemId: itemId, quantity: 1 }],
        })
      ).status,
    ).toBe(422);
    expect((await agent.get('/api/v1/goods-receipts')).body.data.total).toBe(1);
  });
  it('再入4件：库存累计10、应付800元、已入库；已完成仍可重放旧键', async () => {
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId, items: [{ orderItemId: itemId, quantity: 4 }] },
          'p3-second',
        )
      ).status,
    ).toBe(201);
    expect(
      (await agent.get(`/api/v1/purchase-orders/${orderId}`)).body.data.status,
    ).toBe('RECEIVED');
    expect(
      (await agent.get('/api/v1/stocks').query({ productId })).body.data
        .items[0].quantity,
    ).toBe(10);
    const payables = (await agent.get('/api/v1/payables')).body.data.items;
    expect(
      payables.reduce(
        (sum: number, p: { originalAmount: number }) => sum + p.originalAmount,
        0,
      ),
    ).toBe(80000);
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId, items: [{ orderItemId: itemId, quantity: 6 }] },
          'p3-first',
        )
      ).body.data.id,
    ).toBe(firstReceiptId);
    expect(
      (
        await agent
          .patch(`/api/v1/goods-receipts/${firstReceiptId}`)
          .set('Origin', origin)
          .set('X-CSRF-Token', token)
          .send({ remark: '不能改' })
      ).status,
    ).toBe(405);
  });
  it('价格名称快照不随商品改动，业务引用主数据禁止删除', async () => {
    await patch(`/products/${productId}`, {
      name: '改名商品',
      purchasePrice: 9900,
    });
    const order = (await agent.get(`/api/v1/purchase-orders/${orderId}`)).body
      .data;
    expect(order.items[0].productName).toBe('商品 A');
    expect(order.totalAmount).toBe(80000);
    for (const [resource, id] of [
      ['products', productId],
      ['suppliers', supplierId],
      ['warehouses', warehouseId],
    ])
      expect(
        (
          await agent
            .delete(`/api/v1/${resource}/${id}`)
            .set('Origin', origin)
            .set('X-CSRF-Token', token)
        ).status,
      ).toBe(409);
    expect(
      (
        await agent
          .get('/api/v1/stocks')
          .query({ warehouseId: secondWarehouseId })
      ).body.data.total,
    ).toBe(0);
  });
  it('非法金额、数量、重复商品和无效日期不能建单', async () => {
    for (const changes of [
      { orderDate: '2026-02-30' },
      { expectedDate: '2026-10-01' },
      { items: [{ productId, quantity: 0, unitPrice: 8000 }] },
      { items: [{ productId, quantity: 1000000, unitPrice: 1000000000 }] },
      { items: [{ productId, quantity: 1, unitPrice: 1.5 }] },
      {
        items: [
          { productId, quantity: 1, unitPrice: 100 },
          { productId, quantity: 1, unitPrice: 100 },
        ],
      },
    ])
      expect(
        (await post('/purchase-orders', { ...orderBody(), ...changes })).status,
      ).toBe(422);
  });
  it('下游应付写入失败时，库存/流水/单据/状态/幂等记录全部回滚', async () => {
    const created = await post('/purchase-orders', {
      ...orderBody(),
      warehouseId: secondWarehouseId,
    });
    const id = created.body.data.id;
    const line = created.body.data.items[0].id;
    await post(`/purchase-orders/${id}/submit`, {});
    await post(`/purchase-orders/${id}/approve`, {});
    const before = await Promise.all([
      prisma.goodsReceipt.count(),
      prisma.stockMovement.count(),
      prisma.payable.count(),
      prisma.idempotencyRecord.count(),
      prisma.auditLog.count(),
    ]);
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER test_fail_payable BEFORE INSERT ON Payable BEGIN SELECT RAISE(ABORT, 'TEST_DOWNSTREAM_FAILURE'); END;",
    );
    try {
      expect(
        (
          await post(
            '/goods-receipts',
            { orderId: id, items: [{ orderItemId: line, quantity: 1 }] },
            'p3-rollback',
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_fail_payable');
    }
    expect(
      await Promise.all([
        prisma.goodsReceipt.count(),
        prisma.stockMovement.count(),
        prisma.payable.count(),
        prisma.idempotencyRecord.count(),
        prisma.auditLog.count(),
      ]),
    ).toEqual(before);
    const order = (await agent.get(`/api/v1/purchase-orders/${id}`)).body.data;
    expect(order.status).toBe('APPROVED');
    expect(order.items[0].receivedQuantity).toBe(0);
    expect(
      (
        await agent
          .get('/api/v1/stocks')
          .query({ warehouseId: secondWarehouseId })
      ).body.data.total,
    ).toBe(0);
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId: id, items: [{ orderItemId: line, quantity: 1 }] },
          'p3-rollback',
        )
      ).status,
    ).toBe(201);
  });
  it('两个并发不同键不能超额入库，同键并发不会重复过账', async () => {
    const created = await post('/purchase-orders', {
      ...orderBody(),
      items: [{ productId, quantity: 2, unitPrice: 8000 }],
    });
    const id = created.body.data.id;
    const line = created.body.data.items[0].id;
    await post(`/purchase-orders/${id}/submit`, {});
    await post(`/purchase-orders/${id}/approve`, {});
    const body = { orderId: id, items: [{ orderItemId: line, quantity: 2 }] };
    const results = await Promise.all([
      post('/goods-receipts', body, 'p3-concurrent-a'),
      post('/goods-receipts', body, 'p3-concurrent-b'),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => [201, 409, 503].includes(r.status))).toBe(true);
    expect(await prisma.goodsReceipt.count({ where: { orderId: id } })).toBe(1);
    const winner = results.findIndex((r) => r.status === 201);
    const key = winner === 0 ? 'p3-concurrent-a' : 'p3-concurrent-b';
    const replays = await Promise.all([
      post('/goods-receipts', body, key),
      post('/goods-receipts', body, key),
    ]);
    expect(replays.map((r) => r.status)).toEqual([200, 200]);
    expect(
      (await agent.get(`/api/v1/purchase-orders/${id}`)).body.data.items[0]
        .receivedQuantity,
    ).toBe(2);
  });
  it('停用商品阻止新建/过账且可查看历史', async () => {
    await patch(`/products/${productId}`, { status: 'INACTIVE' });
    expect((await post('/purchase-orders', orderBody())).status).toBe(422);
    expect((await agent.get(`/api/v1/purchase-orders/${orderId}`)).status).toBe(
      200,
    );
    await patch(`/products/${productId}`, { status: 'ACTIVE' });
  });
  it('较长驳回原因独立保存，不覆盖备注且草稿可原样再保存', async () => {
    const body = { ...orderBody(), remark: '原'.repeat(100) };
    const created = await post('/purchase-orders', body);
    const id = created.body.data.id;
    await post(`/purchase-orders/${id}/submit`, {});
    const rejected = await post(`/purchase-orders/${id}/reject`, {
      reason: '因'.repeat(450),
    });
    expect(rejected.body.data.remark).toBe(body.remark);
    expect(rejected.body.data.rejectionReason).toBe('因'.repeat(450));
    expect((await patch(`/purchase-orders/${id}`, body)).status).toBe(200);
  });
  it('零单价入库可记录库存，零额应付直接结清', async () => {
    const created = await post('/purchase-orders', {
      ...orderBody(),
      items: [{ productId, quantity: 1, unitPrice: 0 }],
    });
    const order = created.body.data;
    await post(`/purchase-orders/${order.id}/submit`, {});
    await post(`/purchase-orders/${order.id}/approve`, {});
    const receipt = await post(
      '/goods-receipts',
      {
        orderId: order.id,
        items: [{ orderItemId: order.items[0].id, quantity: 1 }],
      },
      'p3-zero-price',
    );
    expect(receipt.status).toBe(201);
    const payable = (
      await agent
        .get('/api/v1/payables')
        .query({ receiptId: receipt.body.data.id })
    ).body.data.items[0];
    expect(payable.originalAmount).toBe(0);
    expect(payable.status).toBe('SETTLED');
  });
  it('采购不能执行入库，仓库不能审核，销售不能看应付，财务可查', async () => {
    const { roleDefinitions } = await import('@kingflow/shared');
    for (const [code, allowed, denied, method] of [
      ['PURCHASE', '/purchase-orders', '/goods-receipts', 'post'],
      ['WAREHOUSE', '/stocks', `/purchase-orders/${orderId}/approve`, 'post'],
      ['SALES', '/stocks', '/payables', 'get'],
      ['FINANCE', '/payables', '/purchase-orders', 'get'],
    ]) {
      const definition = roleDefinitions.find((r) => r.code === code)!;
      const role = await prisma.role.create({
        data: {
          code,
          name: definition.name,
          permissions: JSON.stringify(definition.permissions),
        },
      });
      const username = 'p3-' + code.toLowerCase();
      await prisma.user.create({
        data: {
          username,
          passwordHash: await hash('Test@12345', 4),
          displayName: code,
          roleId: role.id,
        },
      });
      const user = server.agent();
      const login = await user
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send({ username, password: 'Test@12345' });
      const csrf = login.body.data.csrfToken;
      expect((await user.get('/api/v1' + allowed)).status).toBe(200);
      expect(
        (
          await (method === 'get'
            ? user.get('/api/v1' + denied)
            : user
                .post('/api/v1' + denied)
                .set('Origin', origin)
                .set('X-CSRF-Token', csrf)
                .send({}))
        ).status,
      ).toBe(403);
    }
  });
});
