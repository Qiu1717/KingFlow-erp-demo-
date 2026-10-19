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
let customerId = '';
let warehouseId = '';
let orderId = '';
let itemId = '';
let firstShipmentId = '';
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
      path.startsWith('/sales-orders/')
        ? { version: current?.version, ...body }
        : body,
    );
};
beforeAll(async () => {
  server = await startTestServer();
  agent = server.agent();
  await cleanDatabase();
  const role = await prisma.role.upsert({
    where: { code: 'P4ADMIN' },
    update: {},
    create: { code: 'P4ADMIN', name: '销售测试管理员', permissions: '["*"]' },
  });
  const user = await prisma.user.upsert({
    where: { username: 'p4admin' },
    update: { passwordHash: await hash('Test@12345', 4), status: 'ACTIVE' },
    create: {
      username: 'p4admin',
      passwordHash: await hash('Test@12345', 4),
      displayName: '销售测试',
      roleId: role.id,
    },
  });
  const login = await agent
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ username: 'p4admin', password: 'Test@12345' });
  token = login.body.data.csrfToken;
  const cat = await prisma.productCategory.create({
    data: { code: 'P4-CAT', name: '销售测试分类', createdById: user.id },
  });
  productId = (
    await prisma.product.create({
      data: {
        code: 'P4-A',
        name: '商品 A',
        categoryId: cat.id,
        unit: '件',
        purchasePrice: 8000,
        salesPrice: 12000,
        createdById: user.id,
      },
    })
  ).id;
  customerId = (
    await prisma.customer.create({
      data: { code: 'P4-S', name: '销售测试客户', createdById: user.id },
    })
  ).id;
  warehouseId = (
    await prisma.warehouse.create({
      data: { code: 'P4-W', name: '验收仓', createdById: user.id },
    })
  ).id;
  const po = await post('/purchase-orders', {
    supplierId: (
      await prisma.supplier.create({
        data: { code: 'P4-S', name: '备货供应商', createdById: user.id },
      })
    ).id,
    warehouseId,
    orderDate: '2026-10-16',
    items: [{ productId, quantity: 10, unitPrice: 8000 }],
  });
  await post(`/purchase-orders/${po.body.data.id}/submit`, {});
  await post(`/purchase-orders/${po.body.data.id}/approve`, {});
  await post(
    '/goods-receipts',
    {
      orderId: po.body.data.id,
      items: [{ orderItemId: po.body.data.items[0].id, quantity: 10 }],
    },
    'p4-opening-stock',
  );
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});
const orderBody = () => ({
  customerId,
  warehouseId,
  orderDate: '2026-10-16',
  expectedDate: '2026-10-20',
  remark: '6+4验收',
  items: [{ productId, quantity: 3, unitPrice: 12000 }],
});
describe.sequential('销售与出库真实业务闭环', () => {
  it('创建草稿，后端计算360元且保存商品快照', async () => {
    const res = await post('/sales-orders', orderBody());
    expect(res.status).toBe(201);
    orderId = res.body.data.id;
    itemId = res.body.data.items[0].id;
    expect(res.body.data.totalAmount).toBe(36000);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.items[0].productName).toBe('商品 A');
  });

  it('未审核及直接跳状态拒绝', async () => {
    expect(
      (
        await post(
          '/sales-shipments',
          { orderId, items: [{ orderItemId: itemId, quantity: 3 }] },
          'p4-unapproved',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await patch(`/sales-orders/${orderId}`, {
          ...orderBody(),
          status: 'APPROVED',
        })
      ).status,
    ).toBe(422);
  });
  it('草稿可改，提交审核驳回重新提交，审核后不可改', async () => {
    const updated = await patch(`/sales-orders/${orderId}`, orderBody());
    itemId = updated.body.data.items[0].id;
    expect(
      (await post(`/sales-orders/${orderId}/submit`, {})).body.data.status,
    ).toBe('PENDING');
    expect(
      (await post(`/sales-orders/${orderId}/reject`, { reason: '核对交期' }))
        .body.data.rejectionReason,
    ).toBe('核对交期');
    await post(`/sales-orders/${orderId}/submit`, {});
    expect(
      (await post(`/sales-orders/${orderId}/approve`, {})).body.data.status,
    ).toBe('APPROVED');
    expect((await patch(`/sales-orders/${orderId}`, orderBody())).status).toBe(
      409,
    );
  });
  it('出3件：库存10降至7、应收360元、流水-3、已出库', async () => {
    const result = await post(
      '/sales-shipments',
      { orderId, items: [{ orderItemId: itemId, quantity: 3 }] },
      'p4-first-shipment',
    );
    expect(result.status).toBe(201);
    firstShipmentId = result.body.data.id;
    expect(result.body.data.totalAmount).toBe(36000);
    expect(
      (
        await prisma.stockBalance.findUniqueOrThrow({
          where: { productId_warehouseId: { productId, warehouseId } },
        })
      ).quantity,
    ).toBe(7);
    expect(
      await prisma.stockMovement.findFirst({
        where: { shipmentId: firstShipmentId },
      }),
    ).toMatchObject({ quantity: -3, beforeQuantity: 10, afterQuantity: 7 });
    expect(
      await prisma.receivable.findUnique({
        where: { shipmentId: firstShipmentId },
      }),
    ).toMatchObject({
      originalAmount: 36000,
      receivedAmount: 0,
      status: 'UNSETTLED',
    });
    expect(
      (await agent.get(`/api/v1/sales-orders/${orderId}`)).body.data.status,
    ).toBe('SHIPPED');
  });
  it('完成后同键可重放，异请求不能复用键且单据不可改', async () => {
    const body = { orderId, items: [{ orderItemId: itemId, quantity: 3 }] };
    expect(
      (await post('/sales-shipments', body, 'p4-first-shipment')).body.data.id,
    ).toBe(firstShipmentId);
    expect(
      (
        await post(
          '/sales-shipments',
          { ...body, remark: '变化' },
          'p4-first-shipment',
        )
      ).status,
    ).toBe(409);
    expect(await prisma.salesShipment.count()).toBe(1);
    expect(
      (await patch(`/sales-shipments/${firstShipmentId}`, { remark: '不能改' }))
        .status,
    ).toBe(405);
  });
  it('库存不足/超订单/外来行/非法数量全部回滚', async () => {
    const created = await post('/sales-orders', {
      ...orderBody(),
      items: [{ productId, quantity: 100, unitPrice: 12000 }],
    });
    const id = created.body.data.id,
      line = created.body.data.items[0].id;
    await post(`/sales-orders/${id}/submit`, {});
    await post(`/sales-orders/${id}/approve`, {});
    const before = await prisma.salesShipment.count();
    expect(
      (
        await post(
          '/sales-shipments',
          { orderId: id, items: [{ orderItemId: line, quantity: 100 }] },
          'p4-no-stock',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          '/sales-shipments',
          { orderId: id, items: [{ orderItemId: line, quantity: 101 }] },
          'p4-over-order',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          '/sales-shipments',
          { orderId: id, items: [{ orderItemId: itemId, quantity: 1 }] },
          'p4-foreign-item',
        )
      ).status,
    ).toBe(422);
    for (const quantity of [0, -1, 1.5])
      expect(
        (
          await post(
            '/sales-shipments',
            { orderId: id, items: [{ orderItemId: line, quantity }] },
            'p4-invalid-quantity',
          )
        ).status,
      ).toBe(422);
    expect(
      (
        await post(
          '/sales-shipments',
          {
            orderId: id,
            items: [
              { orderItemId: line, quantity: 1 },
              { orderItemId: line, quantity: 1 },
            ],
          },
          'p4-duplicate-line',
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post('/sales-shipments', {
          orderId: id,
          items: [{ orderItemId: line, quantity: 1 }],
        })
      ).status,
    ).toBe(422);
    expect(await prisma.salesShipment.count()).toBe(before);
    expect(
      (
        await prisma.stockBalance.findUniqueOrThrow({
          where: { productId_warehouseId: { productId, warehouseId } },
        })
      ).quantity,
    ).toBe(7);
  });
  it('应收故障回滚所有写入，原键重试可恢复', async () => {
    const created = await post('/sales-orders', orderBody());
    const id = created.body.data.id,
      line = created.body.data.items[0].id;
    await post(`/sales-orders/${id}/submit`, {});
    await post(`/sales-orders/${id}/approve`, {});
    const counts = () =>
      Promise.all([
        prisma.salesShipment.count(),
        prisma.stockMovement.count(),
        prisma.receivable.count(),
        prisma.idempotencyRecord.count(),
        prisma.auditLog.count(),
      ]);
    const before = await counts();
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER test_fail_receivable BEFORE INSERT ON Receivable BEGIN SELECT RAISE(ABORT, 'TEST_DOWNSTREAM_FAILURE'); END;",
    );
    const body = { orderId: id, items: [{ orderItemId: line, quantity: 1 }] };
    try {
      expect(
        (await post('/sales-shipments', body, 'p4-rollback-key')).status,
      ).toBeGreaterThanOrEqual(400);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_fail_receivable');
    }
    expect(await counts()).toEqual(before);
    expect(
      (
        await prisma.stockBalance.findUniqueOrThrow({
          where: { productId_warehouseId: { productId, warehouseId } },
        })
      ).quantity,
    ).toBe(7);
    expect(
      (await agent.get(`/api/v1/sales-orders/${id}`)).body.data,
    ).toMatchObject({ status: 'APPROVED', items: [{ shippedQuantity: 0 }] });
    expect(
      (await post('/sales-shipments', body, 'p4-rollback-key')).status,
    ).toBe(201);
  });
  it('两个订单并发争抢库存，条件扣减不出现负数', async () => {
    const orders = [];
    for (let i = 0; i < 2; i++) {
      const c = await post('/sales-orders', {
        ...orderBody(),
        items: [{ productId, quantity: 5, unitPrice: 12000 }],
      });
      const o = c.body.data;
      await post(`/sales-orders/${o.id}/submit`, {});
      await post(`/sales-orders/${o.id}/approve`, {});
      orders.push(o);
    }
    const results = await Promise.all(
      orders.map((o, i) =>
        post(
          '/sales-shipments',
          {
            orderId: o.id,
            items: [{ orderItemId: o.items[0].id, quantity: 5 }],
          },
          `p4-concurrent-${i}`,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => [201, 409, 503].includes(r.status))).toBe(true);
    expect(
      (
        await prisma.stockBalance.findUniqueOrThrow({
          where: { productId_warehouseId: { productId, warehouseId } },
        })
      ).quantity,
    ).toBe(1);
  });
  it('部分出库后库存不足拒绝余量，零价应收直接结清', async () => {
    const c = await post('/sales-orders', {
      ...orderBody(),
      items: [{ productId, quantity: 2, unitPrice: 0 }],
    });
    const o = c.body.data;
    await post(`/sales-orders/${o.id}/submit`, {});
    await post(`/sales-orders/${o.id}/approve`, {});
    expect(
      (
        await post(
          '/sales-shipments',
          {
            orderId: o.id,
            items: [{ orderItemId: o.items[0].id, quantity: 1 }],
          },
          'p4-partial-zero',
        )
      ).status,
    ).toBe(201);
    expect(
      (await agent.get(`/api/v1/sales-orders/${o.id}`)).body.data.status,
    ).toBe('PARTIAL');
    expect(
      await prisma.receivable.findFirst({
        where: { shipment: { orderId: o.id } },
      }),
    ).toMatchObject({ originalAmount: 0, status: 'SETTLED' });
    expect(
      (
        await post(
          '/sales-shipments',
          {
            orderId: o.id,
            items: [{ orderItemId: o.items[0].id, quantity: 1 }],
          },
          'p4-finish-no-stock',
        )
      ).status,
    ).toBe(409);
  });
  it('成交价格和名称保留快照，引用客户不可删除', async () => {
    await patch(`/products/${productId}`, {
      name: '销售后改名',
      salesPrice: 99999,
    });
    expect(
      (await agent.get(`/api/v1/sales-orders/${orderId}`)).body.data.items[0],
    ).toMatchObject({ productName: '商品 A', unitPrice: 12000 });
    expect(
      (
        await agent
          .delete(`/api/v1/customers/${customerId}`)
          .set('Origin', origin)
          .set('X-CSRF-Token', token)
      ).status,
    ).toBe(409);
  });
  it('销售能开单不能出库及财务，仓库能出库不能审核', async () => {
    const { roleDefinitions } = await import('@kingflow/shared');
    for (const code of ['SALES', 'WAREHOUSE']) {
      const definition = roleDefinitions.find((r) => r.code === code)!;
      const role = await prisma.role.create({
        data: {
          code,
          name: definition.name,
          permissions: JSON.stringify(definition.permissions),
        },
      });
      const username = 'p4-' + code.toLowerCase();
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
      expect((await user.get('/api/v1/sales-orders')).status).toBe(200);
      expect(
        (
          await user
            .post(
              '/api/v1' +
                (code === 'SALES'
                  ? '/sales-shipments'
                  : `/sales-orders/${orderId}/approve`),
            )
            .set('Origin', origin)
            .set('X-CSRF-Token', login.body.data.csrfToken)
            .send({})
        ).status,
      ).toBe(403);
      expect((await user.get('/api/v1/receivables')).status).toBe(403);
    }
  });
});
