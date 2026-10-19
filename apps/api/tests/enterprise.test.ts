import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import { hash } from 'bcryptjs';
import { app } from '../src/app.js';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';

const server = createServer(app);
const agent = request.agent(server);
const origin = 'http://localhost:5173';
let token = '',
  productId = '',
  secondProductId = '',
  warehouseId = '',
  secondWarehouseId = '',
  supplierId = '',
  customerId = '';
const post = (path: string, body: object, key?: string) => {
  const r = agent
    .post('/api/v1' + path)
    .set('Origin', origin)
    .set('X-CSRF-Token', token);
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};
const patch = (path: string, body: object, match?: string) => {
  const r = agent
    .patch('/api/v1' + path)
    .set('Origin', origin)
    .set('X-CSRF-Token', token);
  if (match) r.set('If-Match', `"${match}"`);
  return r.send(body);
};
const body = (kind: 'purchase' | 'sales', quantity = 10, unitPrice = 100) => ({
  ...(kind === 'purchase' ? { supplierId } : { customerId }),
  warehouseId,
  orderDate: '2026-10-19',
  items: [{ productId, quantity, unitPrice }],
});
async function approved(kind: 'purchase' | 'sales', input: object) {
  const created = await post(`/${kind}-orders`, input);
  expect(created.status).toBe(201);
  for (const action of ['submit', 'approve'])
    expect(
      (await post(`/${kind}-orders/${created.body.data.id}/${action}`, {}))
        .status,
    ).toBe(200);
  return (await agent.get(`/api/v1/${kind}-orders/${created.body.data.id}`))
    .body.data;
}
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await cleanDatabase();
  const role = await prisma.role.create({
    data: { code: 'ENTERPRISE', name: '企业验收', permissions: '["*"]' },
  });
  const user = await prisma.user.create({
    data: {
      username: 'enterprise',
      passwordHash: await hash('Test@12345', 4),
      displayName: '交付验收',
      roleId: role.id,
    },
  });
  const login = await agent
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ username: 'enterprise', password: 'Test@12345' });
  token = login.body.data.csrfToken;
  const cat = await post('/categories', { code: 'EC', name: '验收分类' });
  for (const code of ['EP1', 'EP2']) {
    const p = await post('/products', {
      code,
      name: code,
      categoryId: cat.body.data.id,
      unit: '件',
      purchasePrice: 100,
      salesPrice: 200,
      minStock: 0,
    });
    expect(p.status).toBe(201);
    if (code === 'EP1') productId = p.body.data.id;
    else secondProductId = p.body.data.id;
  }
  warehouseId = (await post('/warehouses', { code: 'EW1', name: '验收仓1' }))
    .body.data.id;
  secondWarehouseId = (
    await post('/warehouses', { code: 'EW2', name: '验收仓2' })
  ).body.data.id;
  supplierId = (await post('/suppliers', { code: 'ES', name: '验收供应商' }))
    .body.data.id;
  customerId = (await post('/customers', { code: 'EU', name: '验收客户' })).body
    .data.id;
  expect(user.id).toBeTruthy();
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await prisma.$disconnect();
});

describe.sequential('企业交付真实业务与并发验收', { timeout: 30000 }, () => {
  it.each(['purchase', 'sales'] as const)(
    '%s草稿过期版本不得覆盖其他用户明细',
    async (kind) => {
      const created = (await post(`/${kind}-orders`, body(kind))).body.data;
      const path = `/${kind}-orders/${created.id}`;
      const version = created.version;
      const first = await patch(path, { ...body(kind, 8), version });
      expect(first.status).toBe(200);
      const stale = await patch(path, { ...body(kind, 4), version });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect(
        (await agent.get('/api/v1' + path)).body.data.items[0].quantity,
      ).toBe(8);
      expect((await patch(path, body(kind))).status).toBe(428);
      const raced = await Promise.all([
        patch(path, { ...body(kind, 6), version: first.body.data.version }),
        patch(path, { ...body(kind, 7), version: first.body.data.version }),
      ]);
      expect(raced.filter((r) => r.status === 200)).toHaveLength(1);
      expect(raced.filter((r) => r.status === 409)).toHaveLength(1);
    },
  );
  it('基础资料过期编辑不能覆盖新名称，缺少版本条件被拒绝', async () => {
    const path = '/customers/' + customerId;
    const old = (await agent.get('/api/v1' + path)).body.data;
    expect(
      (await patch(path, { name: '客户最新名称' }, old.updatedAt)).status,
    ).toBe(200);
    expect(
      (await patch(path, { name: '客户过期名称' }, old.updatedAt)).status,
    ).toBe(409);
    expect((await patch(path, { name: '无条件覆盖' })).status).toBe(428);
    expect((await agent.get('/api/v1' + path)).body.data.name).toBe(
      '客户最新名称',
    );
  });
  it('多商品出库第二行库存不足时第一行库存、流水、应收和幂等全部回滚', async () => {
    await post(
      '/stock-adjustments',
      { productId, warehouseId, quantity: 5, reason: '多行回滚期初' },
      'enterprise-opening',
    );
    const order = await approved('sales', {
      ...body('sales'),
      items: [
        { productId, quantity: 3, unitPrice: 100 },
        { productId: secondProductId, quantity: 3, unitPrice: 100 },
      ],
    });
    const before = await prisma.stockMovement.count();
    const r = await post(
      '/sales-shipments',
      {
        orderId: order.id,
        items: order.items.map((i: { id: string }) => ({
          orderItemId: i.id,
          quantity: 3,
        })),
      },
      'enterprise-multi-rollback',
    );
    expect(r.status).toBe(409);
    expect(
      (
        await prisma.stockBalance.findUniqueOrThrow({
          where: { productId_warehouseId: { productId, warehouseId } },
        })
      ).quantity,
    ).toBe(5);
    expect(await prisma.stockMovement.count()).toBe(before);
    expect(
      await prisma.salesShipment.count({ where: { orderId: order.id } }),
    ).toBe(0);
    expect(
      await prisma.idempotencyRecord.findUnique({
        where: { key: 'enterprise-multi-rollback' },
      }),
    ).toBeNull();
    expect(
      (
        await prisma.salesOrderItem.findMany({ where: { orderId: order.id } })
      ).every((i) => i.shippedQuantity === 0),
    ).toBe(true);
  });
  it('20路同键入库只生成一次库存、应付、流水及审计，重试返回同一单据', async () => {
    const order = await approved('purchase', body('purchase', 10));
    const input = {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 10 }],
    };
    const key = 'enterprise-receipt-20';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => post('/goods-receipts', input, key)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => [200, 201, 409, 503].includes(r.status))).toBe(
      true,
    );
    const replay = await post('/goods-receipts', input, key);
    expect(replay.status).toBe(200);
    const id = replay.body.data.id;
    expect(
      results.filter((r) => r.status < 300).every((r) => r.body.data.id === id),
    ).toBe(true);
    expect(
      await prisma.goodsReceipt.count({ where: { orderId: order.id } }),
    ).toBe(1);
    expect(await prisma.stockMovement.count({ where: { receiptId: id } })).toBe(
      1,
    );
    expect(await prisma.payable.count({ where: { receiptId: id } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { resource: 'goods-receipts', resourceId: id },
      }),
    ).toBe(1);
    expect(
      (await post('/goods-receipts', { ...input, remark: '改变原始请求' }, key))
        .status,
    ).toBe(409);
    expect(
      (
        await post(
          '/stock-adjustments',
          { productId, warehouseId, quantity: 1, reason: '跨业务键' },
          key,
        )
      ).status,
    ).toBe(409);
  });
  it('20路不同键抢15件库存，恰好15次成功且订单不超出、库存非负', async () => {
    const order = await approved('sales', body('sales', 20));
    const input = {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post('/sales-shipments', input, `enterprise-ship-${i}`),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(15);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const balance = await prisma.stockBalance.findUniqueOrThrow({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
    expect(balance.quantity).toBe(0);
    expect(
      (
        await prisma.salesOrderItem.findUniqueOrThrow({
          where: { id: order.items[0].id },
        })
      ).shippedQuantity,
    ).toBe(15);
    expect(
      await prisma.salesShipment.count({ where: { orderId: order.id } }),
    ).toBe(15);
    expect(await prisma.receivable.count()).toBe(15);
  });
  it.each(['receipts', 'payments'] as const)(
    '20路%s争抢余额，只能结清一次且结算合计一致',
    async (type) => {
      const source =
        type === 'receipts'
          ? await prisma.receivable.findFirstOrThrow()
          : await prisma.payable.findFirstOrThrow();
      const amount = source.originalAmount / 10;
      const input = {
        sourceId: source.id,
        amount,
        date: '2026-10-19',
        method: '银行转账',
      };
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          post('/settlements/' + type, input, `enterprise-${type}-${i}`),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(10);
      expect(results.filter((r) => r.status === 409)).toHaveLength(10);
      const records = await prisma.settlementRecord.findMany({
        where:
          type === 'receipts'
            ? { receivableId: source.id }
            : { payableId: source.id },
      });
      expect(records.reduce((s, r) => s + r.amount, 0)).toBe(
        source.originalAmount,
      );
    },
  );
  it('其他仓库有库存也不能从空仓出库', async () => {
    expect(
      (
        await post(
          '/stock-adjustments',
          {
            productId,
            warehouseId: secondWarehouseId,
            quantity: 100,
            reason: '隔离仓库存',
          },
          'enterprise-other-warehouse',
        )
      ).status,
    ).toBe(201);
    const order = await approved('sales', body('sales', 1));
    expect(
      (
        await post(
          '/sales-shipments',
          {
            orderId: order.id,
            items: [{ orderItemId: order.items[0].id, quantity: 1 }],
          },
          'enterprise-wrong-warehouse',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await prisma.stockBalance.findUniqueOrThrow({
          where: {
            productId_warehouseId: {
              productId,
              warehouseId: secondWarehouseId,
            },
          },
        })
      ).quantity,
    ).toBe(100);
  });
  it('批准后停用商品仍拒绝过账，不留下业务副作用', async () => {
    const order = await approved('purchase', body('purchase', 1));
    const product = (await agent.get('/api/v1/products/' + productId)).body
      .data;
    expect(
      (
        await patch(
          '/products/' + productId,
          { status: 'INACTIVE' },
          product.updatedAt,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          '/goods-receipts',
          {
            orderId: order.id,
            items: [{ orderItemId: order.items[0].id, quantity: 1 }],
          },
          'enterprise-disabled-post',
        )
      ).status,
    ).toBe(422);
    expect(
      await prisma.goodsReceipt.count({ where: { orderId: order.id } }),
    ).toBe(0);
  });
});
