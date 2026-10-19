import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, ORIGIN, type TestServer } from './server.js';

/**
 * 交易与库存企业级验收：采购订单/入库、销售订单/出库、库存余额/流水/调整/预警/报表口径。
 *
 * 所有断言落在真实 SQLite 状态（Prisma 查询）而不只是 HTTP 状态码；
 * 并发用例断言业务不变量（无超发、无负库存、账实一致、恰好 N 次成功）。
 */
let server: TestServer;
let agent: ReturnType<TestServer['agent']>;
let csrf = '';
let keySeq = 0;

const key = (name: string) => `trade-${name}-${(keySeq += 1)}`;

interface ApiError {
  error?: { code?: string; message?: string };
}
interface OrderItemRow {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  quantity: number;
  receivedQuantity: number;
  shippedQuantity: number;
  unitPrice: number;
  amount: number;
}
interface OrderRow {
  id: string;
  number: string;
  status: string;
  version: number;
  totalAmount: number;
  rejectionReason: string;
  remark: string;
  supplierId: string;
  customerId: string;
  warehouseId: string;
  items: OrderItemRow[];
}
interface DocumentRow {
  id: string;
  number: string;
  orderId: string;
  warehouseId: string;
  totalAmount: number;
  items: {
    id: string;
    productId: string;
    orderItemId: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }[];
}
interface MovementRow {
  id: string;
  productId: string;
  warehouseId: string;
  type: string;
  quantity: number;
  beforeQuantity: number;
  afterQuantity: number;
  receiptId: string | null;
  shipmentId: string | null;
  adjustmentId: string | null;
}
interface AlertRow {
  productId: string;
  warehouseId: string;
  quantity: number;
  shortage: number;
  product: { code: string; minStock: number };
  warehouse: { name: string };
}
interface ListRow<T> {
  items: T[];
  total: number;
}

const bodyOf = <T>(response: { body: unknown }): T =>
  (response.body as { data: T }).data;
const errorCode = (response: { body: unknown }): string | undefined =>
  (response.body as ApiError).error?.code;

const get = (path: string) =>
  agent.get('/api/v1' + path).set('Origin', ORIGIN);
const post = (path: string, body: object, idempotencyKey?: string) => {
  const request = agent
    .post('/api/v1' + path)
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', csrf);
  if (idempotencyKey) request.set('Idempotency-Key', idempotencyKey);
  return request.send(body);
};
const patch = (path: string, body: object) =>
  agent
    .patch('/api/v1' + path)
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', csrf)
    .send(body);
const remove = (path: string) =>
  agent.delete('/api/v1' + path).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);

const ids = {
  category: '',
  category2: '',
  productA: '',
  productB: '',
  productMin: '',
  productOff: '',
  productCategoryOff: '',
  supplier: '',
  supplierOff: '',
  customer: '',
  customerOff: '',
  warehouse: '',
  warehouse2: '',
  warehouseOff: '',
};

const purchaseBody = (over: object = {}) => ({
  supplierId: ids.supplier,
  warehouseId: ids.warehouse,
  orderDate: '2026-10-19',
  items: [{ productId: ids.productA, quantity: 10, unitPrice: 8000 }],
  ...over,
});
const salesBody = (over: object = {}) => ({
  customerId: ids.customer,
  warehouseId: ids.warehouse,
  orderDate: '2026-10-19',
  items: [{ productId: ids.productA, quantity: 3, unitPrice: 12000 }],
  ...over,
});

async function createOrder(
  kind: 'purchase' | 'sales',
  over: object = {},
): Promise<OrderRow> {
  const response = await post(
    `/${kind}-orders`,
    kind === 'purchase' ? purchaseBody(over) : salesBody(over),
  );
  expect(response.status).toBe(201);
  return bodyOf<OrderRow>(response);
}
async function detail(kind: 'purchase' | 'sales', id: string): Promise<OrderRow> {
  const response = await get(`/${kind}-orders/${id}`);
  expect(response.status).toBe(200);
  return bodyOf<OrderRow>(response);
}
async function approve(kind: 'purchase' | 'sales', id: string) {
  expect((await post(`/${kind}-orders/${id}/submit`, {})).status).toBe(200);
  expect((await post(`/${kind}-orders/${id}/approve`, {})).status).toBe(200);
}
async function approvedOrder(
  kind: 'purchase' | 'sales',
  over: object = {},
): Promise<OrderRow> {
  const created = await createOrder(kind, over);
  await approve(kind, created.id);
  return detail(kind, created.id);
}
async function editOrder(
  kind: 'purchase' | 'sales',
  id: string,
  over: object = {},
) {
  const current = await detail(kind, id);
  return agent
    .patch(`/api/v1/${kind}-orders/${id}`)
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', csrf)
    .set('If-Match', `"${new Date().toISOString()}"`)
    .send({
      version: current.version,
      ...(kind === 'purchase' ? purchaseBody(over) : salesBody(over)),
      ...over,
    });
}
async function seedStock(
  productId: string,
  warehouseId: string,
  quantity: number,
  tag: string,
) {
  const response = await post(
    '/stock-adjustments',
    { productId, warehouseId, quantity, reason: `测试期初 ${tag}` },
    key(`seed-${tag}`),
  );
  expect(response.status).toBe(201);
}
async function stockOf(productId: string, warehouseId: string) {
  return (
    await prisma.stockBalance.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    })
  )?.quantity ?? 0;
}
async function newProduct(code: string, minStock = 0) {
  return prisma.product.create({
    data: {
      code,
      name: `商品 ${code}`,
      categoryId: ids.category,
      unit: '件',
      purchasePrice: 100,
      salesPrice: 200,
      minStock,
      createdById: await adminId(),
    },
  });
}
let cachedAdminId = '';
async function adminId() {
  if (!cachedAdminId)
    cachedAdminId = (
      await prisma.user.findUniqueOrThrow({ where: { username: 'trade-admin' } })
    ).id;
  return cachedAdminId;
}

let fixtureSeq = 0;
/**
 * 每个用例使用独立的商品与仓库，避免共享余额让绝对数量断言互相污染。
 * 仓库按用例新建，保证「无余额组合」「跨仓隔离」等口径可独立验证。
 */
async function freshFixture(tag: string, options: { minStock?: number } = {}) {
  fixtureSeq += 1;
  const admin = await adminId();
  const product = await prisma.product.create({
    data: {
      code: `TF-${tag}-${fixtureSeq}`,
      name: `验收商品 ${tag} ${fixtureSeq}`,
      categoryId: ids.category,
      unit: '件',
      purchasePrice: 100,
      salesPrice: 200,
      minStock: options.minStock ?? 0,
      createdById: admin,
    },
  });
  const warehouse = await prisma.warehouse.create({
    data: {
      code: `TFW-${tag}-${fixtureSeq}`,
      name: `验收仓 ${tag} ${fixtureSeq}`,
      createdById: admin,
    },
  });
  return { product, warehouse };
}

beforeAll(async () => {
  server = await startTestServer();
  agent = server.agent();
  await cleanDatabase();
  const role = await prisma.role.create({
    data: { code: 'TRADE-ADMIN', name: '交易验收管理员', permissions: '["*"]' },
  });
  const admin = await prisma.user.create({
    data: {
      username: 'trade-admin',
      passwordHash: await hash('Test@12345', 4),
      displayName: '交易验收',
      roleId: role.id,
    },
  });
  const login = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ username: 'trade-admin', password: 'Test@12345' });
  expect(login.status).toBe(200);
  csrf = bodyOf<{ csrfToken: string }>(login).csrfToken;

  const category = await prisma.productCategory.create({
    data: { code: 'TC', name: '交易验收分类', createdById: admin.id },
  });
  const category2 = await prisma.productCategory.create({
    data: { code: 'TC2', name: '备用分类', createdById: admin.id },
  });
  ids.category = category.id;
  ids.category2 = category2.id;
  const product = (code: string, minStock = 0) =>
    prisma.product.create({
      data: {
        code,
        name: `商品 ${code}`,
        categoryId: category.id,
        unit: '件',
        purchasePrice: 8000,
        salesPrice: 12000,
        minStock,
        createdById: admin.id,
      },
    });
  ids.productA = (await product('TA')).id;
  ids.productB = (await product('TB')).id;
  ids.productMin = (await product('TMIN', 5)).id;
  ids.productOff = (await product('TOFF')).id;
  ids.productCategoryOff = (
    await prisma.product.create({
      data: {
        code: 'TCOFF',
        name: '停用分类商品',
        categoryId: category2.id,
        unit: '件',
        purchasePrice: 100,
        salesPrice: 200,
        createdById: admin.id,
      },
    })
  ).id;
  ids.supplier = (
    await prisma.supplier.create({
      data: { code: 'TS', name: '交易供应商', createdById: admin.id },
    })
  ).id;
  ids.supplierOff = (
    await prisma.supplier.create({
      data: { code: 'TSOFF', name: '停用供应商', createdById: admin.id },
    })
  ).id;
  ids.customer = (
    await prisma.customer.create({
      data: { code: 'TU', name: '交易客户', createdById: admin.id },
    })
  ).id;
  ids.customerOff = (
    await prisma.customer.create({
      data: { code: 'TUOFF', name: '停用客户', createdById: admin.id },
    })
  ).id;
  ids.warehouse = (
    await prisma.warehouse.create({
      data: { code: 'TW', name: '验收仓一', createdById: admin.id },
    })
  ).id;
  ids.warehouse2 = (
    await prisma.warehouse.create({
      data: { code: 'TW2', name: '验收仓二', createdById: admin.id },
    })
  ).id;
  ids.warehouseOff = (
    await prisma.warehouse.create({
      data: { code: 'TWOFF', name: '停用仓库', createdById: admin.id },
    })
  ).id;
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

describe.sequential('采购订单状态机', () => {
  it('创建草稿：后端计算总额、保存商品快照、写入一条审计', async () => {
    const order = await createOrder('purchase', {
      items: [
        { productId: ids.productA, quantity: 10, unitPrice: 8000 },
        { productId: ids.productB, quantity: 3, unitPrice: 101 },
      ],
      remark: '状态机用例',
    });
    expect(order.totalAmount).toBe(80303);
    expect(order.status).toBe('DRAFT');
    expect(order.version).toBe(0);
    expect(order.items).toHaveLength(2);
    expect(order.items[0]).toMatchObject({
      productCode: 'TA',
      productName: '商品 TA',
      quantity: 10,
      receivedQuantity: 0,
      unitPrice: 8000,
      amount: 80000,
    });
    const stored = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(stored.totalAmount).toBe(80303);
    expect(stored.items.reduce((sum, row) => sum + row.amount, 0)).toBe(80303);
    expect(
      await prisma.auditLog.count({
        where: { resource: 'purchase-orders', resourceId: order.id },
      }),
    ).toBe(1);
  });

  it('非法状态转移全部拒绝且不改状态：审核草稿、驳回草稿、重复审核、驳回已审核、提交已审核、编辑已审核', async () => {
    const draft = await createOrder('purchase');
    const matrix: [string, number][] = [
      ['approve', (await post(`/purchase-orders/${draft.id}/approve`, {})).status],
      [
        'reject-draft',
        (await post(`/purchase-orders/${draft.id}/reject`, { reason: '草稿驳回' }))
          .status,
      ],
    ];
    expect(matrix).toEqual([
      ['approve', 409],
      ['reject-draft', 409],
    ]);
    expect((await detail('purchase', draft.id)).status).toBe('DRAFT');
    expect((await post(`/purchase-orders/${draft.id}/submit`, {})).status).toBe(
      200,
    );
    expect(
      (await post(`/purchase-orders/${draft.id}/submit`, {})).status,
    ).toBe(409);
    expect(
      (await post(`/purchase-orders/${draft.id}/approve`, {})).status,
    ).toBe(200);
    expect(
      (await post(`/purchase-orders/${draft.id}/approve`, {})).status,
    ).toBe(409);
    expect(
      (await post(`/purchase-orders/${draft.id}/reject`, { reason: '已审核驳回' }))
        .status,
    ).toBe(409);
    expect(
      (await post(`/purchase-orders/${draft.id}/submit`, {})).status,
    ).toBe(409);
    expect((await editOrder('purchase', draft.id)).status).toBe(409);
    expect(
      (await post('/purchase-orders/not-a-real-order/approve', {})).status,
    ).toBe(404);
    const stored = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(stored.status).toBe('APPROVED');
    expect(stored.rejectionReason).toBe('');
    // 只有 submit/approve 两次成功写入审计，失败转移不落审计。
    expect(
      await prisma.auditLog.count({
        where: { resource: 'purchase-orders', resourceId: draft.id },
      }),
    ).toBe(3);
  });

  it('驳回原因独立保存、可再次提交审核，空/超长/缺失原因均 422 且不改状态', async () => {
    const order = await createOrder('purchase', { remark: '原始备注' });
    await post(`/purchase-orders/${order.id}/submit`, {});
    for (const invalid of [
      { reason: '' },
      { reason: '   ' },
      { reason: '因'.repeat(501) },
      {},
    ])
      expect(
        (await post(`/purchase-orders/${order.id}/reject`, invalid)).status,
      ).toBe(422);
    expect((await detail('purchase', order.id)).status).toBe('PENDING');
    const rejected = bodyOf<OrderRow>(
      await post(`/purchase-orders/${order.id}/reject`, { reason: '交期不符' }),
    );
    expect(rejected.status).toBe('DRAFT');
    expect(rejected.rejectionReason).toBe('交期不符');
    expect(rejected.remark).toBe('原始备注');
    await post(`/purchase-orders/${order.id}/submit`, {});
    expect((await post(`/purchase-orders/${order.id}/approve`, {})).status).toBe(
      200,
    );
  });

  it('并发重复提交 10 路只有一次成功，其余 409，版本与审计各只增加一次', async () => {
    const order = await createOrder('purchase');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(`/purchase-orders/${order.id}/submit`, {}),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const stored = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe('PENDING');
    expect(stored.version).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          resource: 'purchase-orders',
          resourceId: order.id,
          action: 'SUBMIT',
        },
      }),
    ).toBe(1);
  });

  it('版本冲突：缺版本 428、过期版本 409、并发编辑只成功一次且不覆盖对方明细', async () => {
    const order = await createOrder('purchase');
    const missing = await patch(`/purchase-orders/${order.id}`, {
      supplierId: ids.supplier,
      warehouseId: ids.warehouse,
      orderDate: '2026-10-19',
      items: [{ productId: ids.productA, quantity: 1, unitPrice: 100 }],
    });
    expect(missing.status).toBe(428);
    expect(errorCode(missing)).toBe('VERSION_REQUIRED');
    const current = await detail('purchase', order.id);
    const first = await patch(`/purchase-orders/${order.id}`, {
      version: current.version,
      supplierId: ids.supplier,
      warehouseId: ids.warehouse,
      orderDate: '2026-10-19',
      items: [{ productId: ids.productA, quantity: 8, unitPrice: 8000 }],
    });
    expect(first.status).toBe(200);
    const stale = await patch(`/purchase-orders/${order.id}`, {
      version: current.version,
      supplierId: ids.supplier,
      warehouseId: ids.warehouse,
      orderDate: '2026-10-19',
      items: [{ productId: ids.productA, quantity: 4, unitPrice: 8000 }],
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('VERSION_CONFLICT');
    const raced = await Promise.all([
      patch(`/purchase-orders/${order.id}`, {
        version: bodyOf<OrderRow>(first).version,
        supplierId: ids.supplier,
        warehouseId: ids.warehouse,
        orderDate: '2026-10-19',
        items: [{ productId: ids.productA, quantity: 6, unitPrice: 8000 }],
      }),
      patch(`/purchase-orders/${order.id}`, {
        version: bodyOf<OrderRow>(first).version,
        supplierId: ids.supplier,
        warehouseId: ids.warehouse,
        orderDate: '2026-10-19',
        items: [{ productId: ids.productA, quantity: 7, unitPrice: 8000 }],
      }),
    ]);
    expect(raced.filter((r) => r.status === 200)).toHaveLength(1);
    expect(raced.filter((r) => r.status === 409)).toHaveLength(1);
    // 并发编辑只有一方生效，最终明细必须是其中一次完整提交（不会被部分覆盖）。
    const stored = await detail('purchase', order.id);
    expect([6, 7]).toContain(stored.items[0].quantity);
    expect(stored.items).toHaveLength(1);
    expect(stored.totalAmount).toBe(stored.items[0].quantity * 8000);
  });
});

describe.sequential('采购明细与基础资料校验', () => {
  it('100 行可建单，101 行、重复商品、非法数量价格、金额溢出与未知字段全部 422', async () => {
    const products: string[] = [];
    for (let index = 0; index < 100; index += 1)
      products.push((await newProduct(`T100-${index}`)).id);
    const hundred = await post('/purchase-orders', {
      ...purchaseBody(),
      items: products.map((productId) => ({
        productId,
        quantity: 1,
        unitPrice: 1,
      })),
    });
    expect(hundred.status).toBe(201);
    expect(bodyOf<OrderRow>(hundred).items).toHaveLength(100);
    expect(bodyOf<OrderRow>(hundred).totalAmount).toBe(100);

    const overLines = await post('/purchase-orders', {
      ...purchaseBody(),
      items: [
        ...products.map((productId) => ({
          productId,
          quantity: 1,
          unitPrice: 1,
        })),
        { productId: ids.productA, quantity: 1, unitPrice: 1 },
      ],
    });
    expect(overLines.status).toBe(422);

    for (const invalid of [
      { items: [{ productId: ids.productA, quantity: 0, unitPrice: 8000 }] },
      { items: [{ productId: ids.productA, quantity: -1, unitPrice: 8000 }] },
      { items: [{ productId: ids.productA, quantity: 1.5, unitPrice: 8000 }] },
      { items: [{ productId: ids.productA, quantity: 1, unitPrice: -1 }] },
      { items: [{ productId: ids.productA, quantity: 1, unitPrice: 1.5 }] },
      {
        items: [
          { productId: ids.productA, quantity: 1, unitPrice: 100 },
          { productId: ids.productA, quantity: 1, unitPrice: 100 },
        ],
      },
      {
        items: [
          { productId: ids.productA, quantity: 1_000_000, unitPrice: 1_000_000 },
        ],
      },
      { items: [] },
      { status: 'APPROVED' },
      { totalAmount: 1 },
      { orderDate: '2026-02-30' },
      { expectedDate: '2026-10-01' },
    ])
      expect(
        (await post('/purchase-orders', { ...purchaseBody(), ...invalid }))
          .status,
      ).toBe(422);
  });

  it('停用供应商/仓库/商品/分类在创建、提交、审核、过账各环节被拦截且不产生副作用', async () => {
    const setStatus = (
      model: 'supplier' | 'warehouse' | 'product' | 'productCategory',
      id: string,
      status: 'ACTIVE' | 'INACTIVE',
    ) =>
      (
        prisma as unknown as Record<
          string,
          { update: (args: object) => Promise<unknown> }
        >
      )[model].update({ where: { id }, data: { status } });

    const counts = () =>
      Promise.all([
        prisma.purchaseOrder.count(),
        prisma.goodsReceipt.count(),
        prisma.stockMovement.count(),
        prisma.payable.count(),
        prisma.idempotencyRecord.count(),
      ]);

    // 创建阶段
    await setStatus('supplier', ids.supplierOff, 'INACTIVE');
    expect(
      (
        await post('/purchase-orders', {
          ...purchaseBody(),
          supplierId: ids.supplierOff,
        })
      ).status,
    ).toBe(422);
    await setStatus('supplier', ids.supplierOff, 'ACTIVE');
    await setStatus('warehouse', ids.warehouseOff, 'INACTIVE');
    expect(
      (
        await post('/purchase-orders', {
          ...purchaseBody(),
          warehouseId: ids.warehouseOff,
        })
      ).status,
    ).toBe(422);
    await setStatus('warehouse', ids.warehouseOff, 'ACTIVE');
    await setStatus('product', ids.productOff, 'INACTIVE');
    expect(
      (
        await post('/purchase-orders', {
          ...purchaseBody(),
          items: [{ productId: ids.productOff, quantity: 1, unitPrice: 100 }],
        })
      ).status,
    ).toBe(422);
    await setStatus('product', ids.productOff, 'ACTIVE');
    await setStatus('productCategory', ids.category2, 'INACTIVE');
    expect(
      (
        await post('/purchase-orders', {
          ...purchaseBody(),
          items: [
            { productId: ids.productCategoryOff, quantity: 1, unitPrice: 100 },
          ],
        })
      ).status,
    ).toBe(422);
    await setStatus('productCategory', ids.category2, 'ACTIVE');

    // 提交阶段：停用商品
    const submitCase = await createOrder('purchase', {
      items: [{ productId: ids.productCategoryOff, quantity: 2, unitPrice: 100 }],
    });
    await setStatus('product', ids.productCategoryOff, 'INACTIVE');
    const beforeSubmit = await counts();
    expect(
      (await post(`/purchase-orders/${submitCase.id}/submit`, {})).status,
    ).toBe(422);
    expect(await counts()).toEqual(beforeSubmit);
    expect((await detail('purchase', submitCase.id)).status).toBe('DRAFT');
    await setStatus('product', ids.productCategoryOff, 'ACTIVE');
    expect(
      (await post(`/purchase-orders/${submitCase.id}/submit`, {})).status,
    ).toBe(200);

    // 审核阶段：停用分类
    await setStatus('productCategory', ids.category2, 'INACTIVE');
    expect(
      (await post(`/purchase-orders/${submitCase.id}/approve`, {})).status,
    ).toBe(422);
    expect((await detail('purchase', submitCase.id)).status).toBe('PENDING');
    await setStatus('productCategory', ids.category2, 'ACTIVE');
    expect(
      (await post(`/purchase-orders/${submitCase.id}/approve`, {})).status,
    ).toBe(200);

    // 过账阶段：停用供应商 / 仓库
    const approved = await detail('purchase', submitCase.id);
    await setStatus('supplier', ids.supplier, 'INACTIVE');
    const beforePost = await counts();
    expect(
      (
        await post(
          '/goods-receipts',
          {
            orderId: approved.id,
            items: [{ orderItemId: approved.items[0].id, quantity: 1 }],
          },
          key('inactive-supplier'),
        )
      ).status,
    ).toBe(422);
    expect(await counts()).toEqual(beforePost);
    await setStatus('supplier', ids.supplier, 'ACTIVE');
    await setStatus('warehouse', ids.warehouse, 'INACTIVE');
    expect(
      (
        await post(
          '/goods-receipts',
          {
            orderId: approved.id,
            items: [{ orderItemId: approved.items[0].id, quantity: 1 }],
          },
          key('inactive-warehouse'),
        )
      ).status,
    ).toBe(422);
    expect(await counts()).toEqual(beforePost);
    await setStatus('warehouse', ids.warehouse, 'ACTIVE');
    expect(
      (
        await post(
          '/goods-receipts',
          {
            orderId: approved.id,
            items: [{ orderItemId: approved.items[0].id, quantity: 1 }],
          },
          key('reactivated-post'),
        )
      ).status,
    ).toBe(201);
  });
});

describe.sequential('采购入库', () => {
  it('6+4 分批入库：库存、流水、应付、累计量与状态逐笔一致，金额与应付恒等', async () => {
    const fixture = await freshFixture('rec');
    const order = await approvedOrder('purchase', {
      warehouseId: fixture.warehouse.id,
      items: [{ productId: fixture.product.id, quantity: 10, unitPrice: 8000 }],
    });
    const itemId = order.items[0].id;

    const first = await post(
      '/goods-receipts',
      { orderId: order.id, items: [{ orderItemId: itemId, quantity: 6 }] },
      key('receipt-6'),
    );
    expect(first.status).toBe(201);
    const firstReceipt = bodyOf<DocumentRow>(first);
    expect(firstReceipt.totalAmount).toBe(48000);
    expect(firstReceipt.warehouseId).toBe(fixture.warehouse.id);
    expect((await detail('purchase', order.id)).status).toBe('PARTIAL');
    expect((await detail('purchase', order.id)).items[0].receivedQuantity).toBe(
      6,
    );
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(6);
    expect(await stockOf(fixture.product.id, ids.warehouse2)).toBe(0);

    const firstMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { receiptId: firstReceipt.id },
    });
    expect(firstMovement).toMatchObject({
      type: 'PURCHASE_RECEIPT',
      quantity: 6,
      beforeQuantity: 0,
      afterQuantity: 6,
    });
    const firstPayable = await prisma.payable.findUniqueOrThrow({
      where: { receiptId: firstReceipt.id },
    });
    expect(firstPayable).toMatchObject({
      originalAmount: 48000,
      paidAmount: 0,
      status: 'UNSETTLED',
    });

    const second = await post(
      '/goods-receipts',
      { orderId: order.id, items: [{ orderItemId: itemId, quantity: 4 }] },
      key('receipt-4'),
    );
    expect(second.status).toBe(201);
    expect(bodyOf<DocumentRow>(second).totalAmount).toBe(32000);
    const completed = await detail('purchase', order.id);
    expect(completed.status).toBe('RECEIVED');
    expect(completed.items[0].receivedQuantity).toBe(10);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(10);
    const movements = await prisma.stockMovement.findMany({
      where: {
        productId: fixture.product.id,
        warehouseId: fixture.warehouse.id,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(movements.map((row) => [row.beforeQuantity, row.afterQuantity])).toEqual(
      [
        [0, 6],
        [6, 10],
      ],
    );
    const receipts = await prisma.goodsReceipt.findMany({
      where: { orderId: order.id },
    });
    expect(receipts.reduce((sum, row) => sum + row.totalAmount, 0)).toBe(
      completed.totalAmount,
    );
    const payables = await prisma.payable.findMany({
      where: { receiptId: { in: receipts.map((row) => row.id) } },
    });
    expect(payables).toHaveLength(2);
    expect(payables.reduce((sum, row) => sum + row.originalAmount, 0)).toBe(
      completed.totalAmount,
    );
    for (const payable of payables) {
      const receipt = receipts.find((row) => row.id === payable.receiptId)!;
      expect(payable.originalAmount).toBe(receipt.totalAmount);
      const itemSum = await prisma.goodsReceiptItem.aggregate({
        where: { receiptId: receipt.id },
        _sum: { amount: true },
      });
      expect(itemSum._sum.amount).toBe(receipt.totalAmount);
    }
    // 每笔过账恰好一条审计。
    for (const receipt of receipts)
      expect(
        await prisma.auditLog.count({
          where: { resource: 'goods-receipts', resourceId: receipt.id },
        }),
      ).toBe(1);
  });

  it('超收、零/负/小数、重复明细、异单明细、缺幂等键、非法幂等键全部拒绝且无副作用', async () => {
    const fixture = await freshFixture('reject');
    const order = await approvedOrder('purchase', {
      warehouseId: fixture.warehouse.id,
      items: [{ productId: fixture.product.id, quantity: 10, unitPrice: 8000 }],
    });
    const other = await approvedOrder('purchase', {
      items: [{ productId: ids.productB, quantity: 1, unitPrice: 100 }],
    });
    const itemId = order.items[0].id;
    const counts = () =>
      Promise.all([
        prisma.goodsReceipt.count(),
        prisma.stockMovement.count(),
        prisma.payable.count(),
        prisma.idempotencyRecord.count(),
        prisma.auditLog.count(),
      ]);
    const before = await counts();
    const rejected: [number, string | undefined][] = [];
    const attempt = async (body: object, idempotencyKey?: string) => {
      const response = await post('/goods-receipts', body, idempotencyKey);
      rejected.push([response.status, errorCode(response)]);
      return response;
    };
    await attempt(
      { orderId: order.id, items: [{ orderItemId: itemId, quantity: 11 }] },
      key('over-receipt'),
    );
    await attempt(
      { orderId: order.id, items: [{ orderItemId: itemId, quantity: 1 }] },
      undefined,
    );
    await attempt(
      { orderId: order.id, items: [{ orderItemId: itemId, quantity: 1 }] },
      'short',
    );
    await attempt(
      {
        orderId: order.id,
        items: [
          { orderItemId: itemId, quantity: 1 },
          { orderItemId: itemId, quantity: 1 },
        ],
      },
      key('duplicate-line'),
    );
    await attempt(
      {
        orderId: order.id,
        items: [{ orderItemId: other.items[0].id, quantity: 1 }],
      },
      key('foreign-line'),
    );
    await attempt(
      {
        orderId: order.id,
        warehouseId: ids.warehouse2,
        items: [{ orderItemId: itemId, quantity: 1 }],
      },
      key('cross-warehouse-field'),
    );
    for (const quantity of [0, -1, 1.5])
      await attempt(
        { orderId: order.id, items: [{ orderItemId: itemId, quantity }] },
        key(`invalid-${quantity}`),
      );
    expect(rejected).toEqual([
      [409, 'EXCESS_RECEIPT'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
      [422, 'FOREIGN_ITEM'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
    ]);
    expect(await counts()).toEqual(before);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(0);
    expect((await detail('purchase', order.id)).status).toBe('APPROVED');
  });

  it('未审核/已入库订单不可过账；已过账入库单 PATCH/DELETE 返回 405', async () => {
    const draft = await createOrder('purchase');
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId: draft.id, items: [{ orderItemId: draft.items[0].id, quantity: 1 }] },
          key('draft-receipt'),
        )
      ).status,
    ).toBe(409);
    const order = await approvedOrder('purchase', {
      items: [{ productId: ids.productB, quantity: 1, unitPrice: 100 }],
    });
    const receipt = bodyOf<DocumentRow>(
      await post(
        '/goods-receipts',
        { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 1 }] },
        key('single-receipt'),
      ),
    );
    expect(
      (
        await post(
          '/goods-receipts',
          { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 1 }] },
          key('after-complete'),
        )
      ).status,
    ).toBe(409);
    expect((await patch(`/goods-receipts/${receipt.id}`, { remark: '改' })).status).toBe(
      405,
    );
    expect((await remove(`/goods-receipts/${receipt.id}`)).status).toBe(405);
    const stored = await prisma.goodsReceipt.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    expect(stored.remark).toBe('');
  });

  it('幂等：同键重放返回原单不重复过账，同键异内容/跨业务/跨用户 409', async () => {
    const fixture = await freshFixture('idem');
    const order = await approvedOrder('purchase', {
      warehouseId: fixture.warehouse.id,
      items: [{ productId: fixture.product.id, quantity: 4, unitPrice: 500 }],
    });
    const receiptKey = key('idempotent-receipt');
    const input = {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 4 }],
    };
    const created = await post('/goods-receipts', input, receiptKey);
    expect(created.status).toBe(201);
    const receiptId = bodyOf<DocumentRow>(created).id;
    const snapshot = () =>
      Promise.all([
        prisma.goodsReceipt.count({ where: { orderId: order.id } }),
        prisma.stockMovement.count({ where: { receiptId } }),
        prisma.payable.count({ where: { receiptId } }),
        prisma.auditLog.count({ where: { resource: 'goods-receipts', resourceId: receiptId } }),
        prisma.idempotencyRecord.count({ where: { key: receiptKey } }),
      ]);
    const before = await snapshot();
    const replay = await post('/goods-receipts', input, receiptKey);
    expect(replay.status).toBe(200);
    expect(bodyOf<DocumentRow>(replay).id).toBe(receiptId);
    expect(await snapshot()).toEqual(before);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(4);

    const conflict = await post(
      '/goods-receipts',
      { ...input, remark: '改变了内容' },
      receiptKey,
    );
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    const crossBusiness = await post(
      '/stock-adjustments',
      {
        productId: ids.productA,
        warehouseId: ids.warehouse,
        quantity: 1,
        reason: '跨业务复用',
      },
      receiptKey,
    );
    expect(crossBusiness.status).toBe(409);

    // 跨用户复用同一幂等键
    const role = await prisma.role.create({
      data: { code: 'TRADE-RIVAL', name: '并发同事', permissions: '["*"]' },
    });
    await prisma.user.create({
      data: {
        username: 'trade-rival',
        passwordHash: await hash('Test@12345', 4),
        displayName: '并发同事',
        roleId: role.id,
      },
    });
    const rival = server.agent();
    const rivalLogin = await rival
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'trade-rival', password: 'Test@12345' });
    const rivalCsrf = bodyOf<{ csrfToken: string }>(rivalLogin).csrfToken;
    const otherOrder = await approvedOrder('purchase', {
      items: [{ productId: ids.productA, quantity: 1, unitPrice: 100 }],
    });
    const rivalResponse = await rival
      .post('/api/v1/goods-receipts')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', rivalCsrf)
      .set('Idempotency-Key', receiptKey)
      .send({
        orderId: otherOrder.id,
        items: [{ orderItemId: otherOrder.items[0].id, quantity: 1 }],
      });
    expect(rivalResponse.status).toBe(409);
    expect(errorCode(rivalResponse)).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('多行入库第二行超收或下游应付失败时，库存/流水/应付/累计量/幂等/审计全部回滚', async () => {
    const fixture = await freshFixture('multi');
    const second = await newProduct('T-MULTI-REC-2');
    const order = await approvedOrder('purchase', {
      warehouseId: fixture.warehouse.id,
      items: [
        { productId: fixture.product.id, quantity: 5, unitPrice: 8000 },
        { productId: second.id, quantity: 2, unitPrice: 5000 },
      ],
    });
    const snapshot = () =>
      Promise.all([
        prisma.goodsReceipt.count(),
        prisma.stockMovement.count(),
        prisma.payable.count(),
        prisma.idempotencyRecord.count(),
        prisma.auditLog.count(),
      ]);
    const before = await snapshot();

    // 第二行超收
    const overflow = await post(
      '/goods-receipts',
      {
        orderId: order.id,
        items: [
          { orderItemId: order.items[0].id, quantity: 5 },
          { orderItemId: order.items[1].id, quantity: 3 },
        ],
      },
      key('multi-overflow'),
    );
    expect(overflow.status).toBe(409);
    expect(errorCode(overflow)).toBe('EXCESS_RECEIPT');
    expect(await snapshot()).toEqual(before);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(0);
    expect(await stockOf(second.id, fixture.warehouse.id)).toBe(0);
    expect(
      (
        await prisma.purchaseOrderItem.findMany({
          where: { orderId: order.id },
        })
      ).every((row) => row.receivedQuantity === 0),
    ).toBe(true);

    // 下游应付写入失败
    const downstreamKey = key('multi-downstream');
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER trade_fail_payable BEFORE INSERT ON Payable BEGIN SELECT RAISE(ABORT, 'TRADE_DOWNSTREAM_FAILURE'); END;",
    );
    try {
      const failed = await post(
        '/goods-receipts',
        {
          orderId: order.id,
          items: [
            { orderItemId: order.items[0].id, quantity: 5 },
            { orderItemId: order.items[1].id, quantity: 2 },
          ],
        },
        downstreamKey,
      );
      expect(failed.status).toBeGreaterThanOrEqual(400);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER trade_fail_payable');
    }
    expect(await snapshot()).toEqual(before);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(0);
    expect(await stockOf(second.id, fixture.warehouse.id)).toBe(0);
    const rolledBack = await detail('purchase', order.id);
    expect(rolledBack.status).toBe('APPROVED');
    expect(rolledBack.items.map((row) => row.receivedQuantity)).toEqual([0, 0]);
    expect(
      await prisma.idempotencyRecord.findFirst({ where: { key: downstreamKey } }),
    ).toBeNull();
    // 原键重试仍可成功过账（失败不烧掉幂等键）
    const retried = await post(
      '/goods-receipts',
      {
        orderId: order.id,
        items: [
          { orderItemId: order.items[0].id, quantity: 5 },
          { orderItemId: order.items[1].id, quantity: 2 },
        ],
      },
      downstreamKey,
    );
    expect(retried.status).toBe(201);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(5);
    expect(await stockOf(second.id, fixture.warehouse.id)).toBe(2);
  });

  it('并发超收：20 路各入 1 件（订单 10 件）恰好 10 次成功，累计量与库存不超额', async () => {
    const product = await newProduct('T-CONC-REC');
    const order = await approvedOrder('purchase', {
      items: [{ productId: product.id, quantity: 10, unitPrice: 100 }],
    });
    const input = {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        post('/goods-receipts', input, key(`conc-receipt-${index}`)),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(10);
    expect(await stockOf(product.id, ids.warehouse)).toBe(10);
    expect(await prisma.goodsReceipt.count({ where: { orderId: order.id } })).toBe(
      10,
    );
    expect(
      await prisma.stockMovement.count({ where: { productId: product.id } }),
    ).toBe(10);
    expect(
      (
        await prisma.purchaseOrderItem.findUniqueOrThrow({
          where: { id: order.items[0].id },
        })
      ).receivedQuantity,
    ).toBe(10);
    expect((await detail('purchase', order.id)).status).toBe('RECEIVED');
    const movements = await prisma.stockMovement.findMany({
      where: { productId: product.id },
      orderBy: { beforeQuantity: 'asc' },
    });
    for (let index = 1; index < movements.length; index += 1)
      expect(movements[index].beforeQuantity).toBe(
        movements[index - 1].afterQuantity,
      );
    expect(movements.at(-1)?.afterQuantity).toBe(10);
  });

  it('同键并发 20 路入库只过账一次，全部成功响应指向同一单据', async () => {
    const product = await newProduct('T-SAME-REC');
    const order = await approvedOrder('purchase', {
      items: [{ productId: product.id, quantity: 10, unitPrice: 100 }],
    });
    const input = {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 10 }],
    };
    const sharedKey = key('same-key-receipt');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => post('/goods-receipts', input, sharedKey)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(19);
    const receiptIds = new Set(
      results
        .filter((r) => r.status < 300)
        .map((r) => bodyOf<DocumentRow>(r).id),
    );
    expect(receiptIds.size).toBe(1);
    const receiptId = [...receiptIds][0];
    expect(await prisma.goodsReceipt.count({ where: { orderId: order.id } })).toBe(
      1,
    );
    expect(await prisma.stockMovement.count({ where: { receiptId } })).toBe(1);
    expect(await prisma.payable.count({ where: { receiptId } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { resource: 'goods-receipts', resourceId: receiptId },
      }),
    ).toBe(1);
    expect(await prisma.idempotencyRecord.count({ where: { key: sharedKey } })).toBe(
      1,
    );
    expect(await stockOf(product.id, ids.warehouse)).toBe(10);
  });
});

describe.sequential('销售订单与出库', () => {
  it('销售状态机：未审核不可出库，非法转移与并发重复提交被拒绝', async () => {
    const draft = await createOrder('sales');
    expect(
      (
        await post(
          '/sales-shipments',
          { orderId: draft.id, items: [{ orderItemId: draft.items[0].id, quantity: 1 }] },
          key('draft-shipment'),
        )
      ).status,
    ).toBe(409);
    expect((await post(`/sales-orders/${draft.id}/approve`, {})).status).toBe(409);
    expect(
      (await post(`/sales-orders/${draft.id}/reject`, { reason: '草稿驳回' })).status,
    ).toBe(409);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(`/sales-orders/${draft.id}/submit`, {}),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await post(`/sales-orders/${draft.id}/approve`, {})).status).toBe(200);
    expect((await post(`/sales-orders/${draft.id}/approve`, {})).status).toBe(409);
    expect(
      (await post(`/sales-orders/${draft.id}/reject`, { reason: '已审核驳回' })).status,
    ).toBe(409);
    expect((await editOrder('sales', draft.id)).status).toBe(409);
    expect(
      await prisma.auditLog.count({
        where: { resource: 'sales-orders', resourceId: draft.id },
      }),
    ).toBe(3);
  });

  it('库存不足/超发/异单明细/重复明细全部拒绝，库存与单据无变化', async () => {
    const product = await newProduct('T-SHORT');
    await seedStock(product.id, ids.warehouse, 2, 'short');
    const order = await approvedOrder('sales', {
      items: [{ productId: product.id, quantity: 5, unitPrice: 100 }],
    });
    const other = await approvedOrder('sales', {
      items: [{ productId: ids.productA, quantity: 1, unitPrice: 100 }],
    });
    const counts = () =>
      Promise.all([
        prisma.salesShipment.count(),
        prisma.stockMovement.count(),
        prisma.receivable.count(),
        prisma.idempotencyRecord.count(),
      ]);
    const before = await counts();
    const rejected: [number, string | undefined][] = [];
    const attempt = async (body: object, idempotencyKey?: string) => {
      const response = await post('/sales-shipments', body, idempotencyKey);
      rejected.push([response.status, errorCode(response)]);
    };
    // 库存 2 < 订单 5
    await attempt(
      { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 5 }] },
      key('insufficient'),
    );
    // 超发
    await attempt(
      { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 6 }] },
      key('excess-shipment'),
    );
    // 异单明细
    await attempt(
      { orderId: order.id, items: [{ orderItemId: other.items[0].id, quantity: 1 }] },
      key('foreign-shipment'),
    );
    // 重复明细
    await attempt(
      {
        orderId: order.id,
        items: [
          { orderItemId: order.items[0].id, quantity: 1 },
          { orderItemId: order.items[0].id, quantity: 1 },
        ],
      },
      key('duplicate-shipment'),
    );
    for (const quantity of [0, -1, 1.5])
      await attempt(
        { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity }] },
        key(`invalid-ship-${quantity}`),
      );
    expect(rejected).toEqual([
      [409, 'INSUFFICIENT_STOCK'],
      [409, 'EXCESS_SHIPMENT'],
      [422, 'FOREIGN_ITEM'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
      [422, 'VALIDATION_ERROR'],
    ]);
    expect(await counts()).toEqual(before);
    expect(await stockOf(product.id, ids.warehouse)).toBe(2);
    expect((await detail('sales', order.id)).items[0].shippedQuantity).toBe(0);
  });

  it('跨仓隔离：另一仓有货不能从空仓出库，入库也只进订单头仓库', async () => {
    const product = await newProduct('T-CROSS-WH');
    await seedStock(product.id, ids.warehouse2, 100, 'cross-wh');
    const order = await approvedOrder('sales', {
      items: [{ productId: product.id, quantity: 5, unitPrice: 100 }],
    });
    const blocked = await post(
      '/sales-shipments',
      { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 5 }] },
      key('cross-warehouse'),
    );
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked)).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(product.id, ids.warehouse)).toBe(0);
    expect(await stockOf(product.id, ids.warehouse2)).toBe(100);

    const purchaseOrder = await approvedOrder('purchase', {
      items: [{ productId: product.id, quantity: 3, unitPrice: 100 }],
    });
    const receipt = bodyOf<DocumentRow>(
      await post(
        '/goods-receipts',
        {
          orderId: purchaseOrder.id,
          items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 3 }],
        },
        key('cross-warehouse-receipt'),
      ),
    );
    expect(receipt.warehouseId).toBe(ids.warehouse);
    expect(await stockOf(product.id, ids.warehouse)).toBe(3);
    expect(await stockOf(product.id, ids.warehouse2)).toBe(100);
    const shipped = await post(
      '/sales-shipments',
      { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 3 }] },
      key('cross-warehouse-ship'),
    );
    expect(shipped.status).toBe(201);
    expect((await detail('sales', order.id)).status).toBe('PARTIAL');
    expect((await detail('sales', order.id)).items[0].shippedQuantity).toBe(3);
    expect(await stockOf(product.id, ids.warehouse)).toBe(0);
    expect(await stockOf(product.id, ids.warehouse2)).toBe(100);
  });

  it('出库流水为负数且 before/after 连续，应收与出库金额一致，零价应收直接结清', async () => {
    const product = await newProduct('T-SHIP-CHAIN');
    await seedStock(product.id, ids.warehouse, 10, 'ship-chain');
    const order = await approvedOrder('sales', {
      items: [{ productId: product.id, quantity: 3, unitPrice: 12000 }],
    });
    const shipment = bodyOf<DocumentRow>(
      await post(
        '/sales-shipments',
        { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 3 }] },
        key('ship-chain'),
      ),
    );
    expect(shipment.totalAmount).toBe(36000);
    expect(await stockOf(product.id, ids.warehouse)).toBe(7);
    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { shipmentId: shipment.id },
    });
    expect(movement).toMatchObject({
      type: 'SALES_SHIPMENT',
      quantity: -3,
      beforeQuantity: 10,
      afterQuantity: 7,
    });
    const receivable = await prisma.receivable.findUniqueOrThrow({
      where: { shipmentId: shipment.id },
    });
    expect(receivable).toMatchObject({
      originalAmount: 36000,
      receivedAmount: 0,
      status: 'UNSETTLED',
    });
    const itemSum = await prisma.salesShipmentItem.aggregate({
      where: { shipmentId: shipment.id },
      _sum: { amount: true },
    });
    expect(itemSum._sum.amount).toBe(receivable.originalAmount);
    expect((await detail('sales', order.id)).status).toBe('SHIPPED');
    expect(
      await prisma.auditLog.count({
        where: { resource: 'sales-shipments', resourceId: shipment.id },
      }),
    ).toBe(1);

    // 零价出库：应收 0 且直接结清
    const freeOrder = await approvedOrder('sales', {
      items: [{ productId: product.id, quantity: 1, unitPrice: 0 }],
    });
    const freeShipment = bodyOf<DocumentRow>(
      await post(
        '/sales-shipments',
        { orderId: freeOrder.id, items: [{ orderItemId: freeOrder.items[0].id, quantity: 1 }] },
        key('ship-zero-price'),
      ),
    );
    expect(freeShipment.totalAmount).toBe(0);
    expect(
      await prisma.receivable.findUniqueOrThrow({
        where: { shipmentId: freeShipment.id },
      }),
    ).toMatchObject({ originalAmount: 0, status: 'SETTLED' });
  });

  it('多行出库第二行库存不足时第一行库存、流水、应收、幂等、累计量全部回滚', async () => {
    const first = await newProduct('T-MULTI-1');
    const second = await newProduct('T-MULTI-2');
    await seedStock(first.id, ids.warehouse, 5, 'multi-1');
    const order = await approvedOrder('sales', {
      items: [
        { productId: first.id, quantity: 3, unitPrice: 100 },
        { productId: second.id, quantity: 3, unitPrice: 100 },
      ],
    });
    const snapshot = () =>
      Promise.all([
        prisma.salesShipment.count(),
        prisma.stockMovement.count(),
        prisma.receivable.count(),
        prisma.idempotencyRecord.count(),
        prisma.auditLog.count(),
      ]);
    const before = await snapshot();
    const failed = await post(
      '/sales-shipments',
      {
        orderId: order.id,
        items: order.items.map((row) => ({ orderItemId: row.id, quantity: 3 })),
      },
      key('multi-shipment-rollback'),
    );
    expect(failed.status).toBe(409);
    expect(errorCode(failed)).toBe('INSUFFICIENT_STOCK');
    expect(await snapshot()).toEqual(before);
    expect(await stockOf(first.id, ids.warehouse)).toBe(5);
    expect(await stockOf(second.id, ids.warehouse)).toBe(0);
    const stored = await detail('sales', order.id);
    expect(stored.status).toBe('APPROVED');
    expect(stored.items.map((row) => row.shippedQuantity)).toEqual([0, 0]);
  });

  it('并发抢库存：20 路不同键抢 15 件恰好 15 次成功、5 次 409，账实一致', async () => {
    const fixture = await freshFixture('rush');
    await seedStock(fixture.product.id, fixture.warehouse.id, 15, 'rush');
    const order = await approvedOrder('sales', {
      warehouseId: fixture.warehouse.id,
      items: [{ productId: fixture.product.id, quantity: 20, unitPrice: 200 }],
    });
    const input = {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        post('/sales-shipments', input, key(`rush-${index}`)),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(15);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(0);
    expect(await prisma.salesShipment.count({ where: { orderId: order.id } })).toBe(
      15,
    );
    // 期初调整 1 条 + 15 次出库 = 16 条流水，其中出库流水恰好 15 条。
    expect(
      await prisma.stockMovement.count({
        where: { productId: fixture.product.id, shipmentId: { not: null } },
      }),
    ).toBe(15);
    expect(
      await prisma.stockMovement.count({ where: { productId: fixture.product.id } }),
    ).toBe(16);
    expect(
      await prisma.receivable.count({
        where: { shipment: { orderId: order.id } },
      }),
    ).toBe(15);
    const orderAfter = await detail('sales', order.id);
    expect(orderAfter.status).toBe('PARTIAL');
    expect(orderAfter.items[0].shippedQuantity).toBe(15);
    const shippedAmount = await prisma.salesShipment.aggregate({
      where: { orderId: order.id },
      _sum: { totalAmount: true },
    });
    expect(shippedAmount._sum.totalAmount).toBe(15 * 200);
    // 按发生顺序校验整条链路：期初 0→15，随后 15 笔出库逐笔 -1 直到 0。
    const movements = await prisma.stockMovement.findMany({
      where: { productId: fixture.product.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(movements).toHaveLength(16);
    expect(movements[0]).toMatchObject({
      type: 'STOCK_ADJUSTMENT',
      beforeQuantity: 0,
      quantity: 15,
      afterQuantity: 15,
    });
    for (let index = 0; index < 15; index += 1) {
      const movement = movements[index + 1];
      expect(movement.type).toBe('SALES_SHIPMENT');
      expect(movement.quantity).toBe(-1);
      expect(movement.beforeQuantity).toBe(15 - index);
      expect(movement.afterQuantity).toBe(14 - index);
    }
    expect(movements.at(-1)?.afterQuantity).toBe(0);
  });

  it('同键并发 20 路出库只过账一次，剩余可发量与库存只减少一次', async () => {
    const fixture = await freshFixture('same-ship');
    await seedStock(fixture.product.id, fixture.warehouse.id, 10, 'same-ship');
    const order = await approvedOrder('sales', {
      warehouseId: fixture.warehouse.id,
      items: [{ productId: fixture.product.id, quantity: 10, unitPrice: 100 }],
    });
    const input = {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 4 }],
    };
    const sharedKey = key('same-key-shipment');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => post('/sales-shipments', input, sharedKey)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(19);
    const shipmentIds = new Set(
      results.filter((r) => r.status < 300).map((r) => bodyOf<DocumentRow>(r).id),
    );
    expect(shipmentIds.size).toBe(1);
    expect(await stockOf(fixture.product.id, fixture.warehouse.id)).toBe(6);
    expect(
      await prisma.salesShipment.count({ where: { orderId: order.id } }),
    ).toBe(1);
    expect(
      await prisma.receivable.count({
        where: { shipment: { orderId: order.id } },
      }),
    ).toBe(1);
    expect(
      (await detail('sales', order.id)).items[0].shippedQuantity,
    ).toBe(4);
  });

  it('停用客户/仓库/商品在创建、提交、审核、过账各环节被拦截', async () => {
    await prisma.customer.update({
      where: { id: ids.customerOff },
      data: { status: 'INACTIVE' },
    });
    expect(
      (
        await post('/sales-orders', {
          ...salesBody(),
          customerId: ids.customerOff,
        })
      ).status,
    ).toBe(422);
    await prisma.customer.update({
      where: { id: ids.customerOff },
      data: { status: 'ACTIVE' },
    });
    await prisma.warehouse.update({
      where: { id: ids.warehouseOff },
      data: { status: 'INACTIVE' },
    });
    expect(
      (
        await post('/sales-orders', {
          ...salesBody(),
          warehouseId: ids.warehouseOff,
        })
      ).status,
    ).toBe(422);
    await prisma.warehouse.update({
      where: { id: ids.warehouseOff },
      data: { status: 'ACTIVE' },
    });
    await prisma.product.update({
      where: { id: ids.productOff },
      data: { status: 'INACTIVE' },
    });
    expect(
      (
        await post('/sales-orders', {
          ...salesBody(),
          items: [{ productId: ids.productOff, quantity: 1, unitPrice: 100 }],
        })
      ).status,
    ).toBe(422);
    await prisma.product.update({
      where: { id: ids.productOff },
      data: { status: 'ACTIVE' },
    });

    const product = await newProduct('T-OFF-CHAIN');
    await seedStock(product.id, ids.warehouse, 5, 'off-chain');
    const order = await createOrder('sales', {
      items: [{ productId: product.id, quantity: 2, unitPrice: 100 }],
    });
    await post(`/sales-orders/${order.id}/submit`, {});
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'INACTIVE' },
    });
    expect((await post(`/sales-orders/${order.id}/approve`, {})).status).toBe(422);
    expect((await detail('sales', order.id)).status).toBe('PENDING');
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'ACTIVE' },
    });
    expect((await post(`/sales-orders/${order.id}/approve`, {})).status).toBe(200);
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'INACTIVE' },
    });
    const blocked = await post(
      '/sales-shipments',
      { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 2 }] },
      key('off-chain-ship'),
    );
    expect(blocked.status).toBe(422);
    expect(await stockOf(product.id, ids.warehouse)).toBe(5);
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'ACTIVE' },
    });
    expect(
      (
        await post(
          '/sales-shipments',
          { orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 2 }] },
          key('off-chain-ship-retry'),
        )
      ).status,
    ).toBe(201);
  });
});

describe.sequential('库存调整、预警与报表口径', () => {
  it('调整校验：0/小数/超范围/原因必填 422，负库存 409，且不产生余额与流水', async () => {
    const product = await newProduct('T-ADJ-VALID');
    const rejected: number[] = [];
    for (const payload of [
      { quantity: 0, reason: '零' },
      { quantity: 1.5, reason: '小数' },
      { quantity: 2_000_000_001, reason: '超范围' },
      { quantity: 1, reason: '' },
      { quantity: 1, reason: '   ' },
      { quantity: 1, reason: 'x'.repeat(501) },
    ])
      rejected.push(
        (
          await post(
            '/stock-adjustments',
            { productId: product.id, warehouseId: ids.warehouse, ...payload },
            key('adj-invalid'),
          )
        ).status,
      );
    expect(rejected).toEqual([422, 422, 422, 422, 422, 422]);
    const negative = await post(
      '/stock-adjustments',
      { productId: product.id, warehouseId: ids.warehouse, quantity: -1, reason: '负库存' },
      key('adj-negative'),
    );
    expect(negative.status).toBe(409);
    expect(errorCode(negative)).toBe('INSUFFICIENT_STOCK');
    expect(await prisma.stockBalance.count({ where: { productId: product.id } })).toBe(
      0,
    );
    expect(
      await prisma.stockMovement.count({ where: { productId: product.id } }),
    ).toBe(0);
    expect(await prisma.stockAdjustment.count({ where: { productId: product.id } })).toBe(
      0,
    );
  });

  it('调整上限 2,000,000,000 可过账，再 +1 返回 STOCK_OVERFLOW 且余额不变', async () => {
    const product = await newProduct('T-ADJ-MAX');
    const toMax = await post(
      '/stock-adjustments',
      { productId: product.id, warehouseId: ids.warehouse, quantity: 2_000_000_000, reason: '到上限' },
      key('adj-max'),
    );
    expect(toMax.status).toBe(201);
    expect(await stockOf(product.id, ids.warehouse)).toBe(2_000_000_000);
    const overflow = await post(
      '/stock-adjustments',
      { productId: product.id, warehouseId: ids.warehouse, quantity: 1, reason: '溢出' },
      key('adj-overflow'),
    );
    expect(overflow.status).toBe(409);
    expect(errorCode(overflow)).toBe('STOCK_OVERFLOW');
    expect(await stockOf(product.id, ids.warehouse)).toBe(2_000_000_000);
    expect(
      await prisma.stockMovement.count({ where: { productId: product.id } }),
    ).toBe(1);
  });

  it('调整幂等：重放返回原单不重复调整，同键异内容 409，审计恰好一条', async () => {
    const product = await newProduct('T-ADJ-IDEM');
    const input = {
      productId: product.id,
      warehouseId: ids.warehouse,
      quantity: 10,
      reason: '盘点',
    };
    const adjustmentKey = key('adj-idempotent');
    const created = await post('/stock-adjustments', input, adjustmentKey);
    expect(created.status).toBe(201);
    const adjustmentId = bodyOf<{ id: string }>(created).id;
    const replay = await post('/stock-adjustments', input, adjustmentKey);
    expect(replay.status).toBe(200);
    expect(bodyOf<{ id: string }>(replay).id).toBe(adjustmentId);
    expect(await stockOf(product.id, ids.warehouse)).toBe(10);
    expect(
      await prisma.stockMovement.count({ where: { productId: product.id } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { resource: 'stock-adjustments', resourceId: adjustmentId },
      }),
    ).toBe(1);
    const conflict = await post(
      '/stock-adjustments',
      { ...input, quantity: 11 },
      adjustmentKey,
    );
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    expect(await stockOf(product.id, ids.warehouse)).toBe(10);
  });

  it('调整并发扣减：库存 10，20 路 -1 恰好 10 次成功且不会出现负库存', async () => {
    const product = await newProduct('T-ADJ-CONC');
    await seedStock(product.id, ids.warehouse, 10, 'adj-conc');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        post(
          '/stock-adjustments',
          {
            productId: product.id,
            warehouseId: ids.warehouse,
            quantity: -1,
            reason: `盘亏 ${index}`,
          },
          key(`adj-conc-${index}`),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(10);
    expect(await stockOf(product.id, ids.warehouse)).toBe(0);
    expect(
      await prisma.stockMovement.count({
        where: { productId: product.id, quantity: -1 },
      }),
    ).toBe(10);
    const movements = await prisma.stockMovement.findMany({
      where: { productId: product.id, quantity: -1 },
      orderBy: { beforeQuantity: 'desc' },
    });
    for (let index = 1; index < movements.length; index += 1)
      expect(movements[index].beforeQuantity).toBe(
        movements[index - 1].afterQuantity,
      );
    expect(movements.at(-1)?.afterQuantity).toBe(0);
  });

  it('余额与流水汇总恒等、流水链连续、变动量恒等于前后差值', async () => {
    const balances = await prisma.stockBalance.findMany();
    expect(balances.length).toBeGreaterThan(0);
    for (const balance of balances) {
      const summed = await prisma.stockMovement.aggregate({
        where: {
          productId: balance.productId,
          warehouseId: balance.warehouseId,
        },
        _sum: { quantity: true },
      });
      expect(summed._sum.quantity ?? 0).toBe(balance.quantity);
    }
    const movements = await prisma.stockMovement.findMany();
    expect(movements.length).toBeGreaterThan(0);
    for (const movement of movements) {
      expect(movement.afterQuantity).toBe(
        movement.beforeQuantity + movement.quantity,
      );
      expect(movement.beforeQuantity).toBeGreaterThanOrEqual(0);
      expect(movement.afterQuantity).toBeGreaterThanOrEqual(0);
      const sources = [
        movement.receiptId,
        movement.shipmentId,
        movement.adjustmentId,
      ].filter(Boolean);
      expect(sources).toHaveLength(1);
      if (movement.type === 'PURCHASE_RECEIPT') expect(movement.quantity).toBeGreaterThan(0);
      if (movement.type === 'SALES_SHIPMENT') expect(movement.quantity).toBeLessThan(0);
      if (movement.type === 'STOCK_ADJUSTMENT') expect(movement.quantity).not.toBe(0);
    }
  });

  it('库存预警：无余额组合按 0 计算、minStock=0 不预警、停用商品/仓库不预警、支持过滤与分页', async () => {
    // 只用本用例自建的最小库存商品做断言，不依赖共享夹具在该用例之前未被改动。
    const alertProduct = await newProduct('T-ALERT');
    await prisma.product.update({
      where: { id: alertProduct.id },
      data: { minStock: 5 },
    });
    // 前面用例通过 freshFixture 陆续建了多个启用仓库，这里以数据库真实启用仓库为准。
    const activeWarehouses = await prisma.warehouse.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(activeWarehouses.length).toBeGreaterThanOrEqual(2);
    const activeWarehouseIds = activeWarehouses.map((row) => row.id);

    const alerts = bodyOf<ListRow<AlertRow>>(
      await get(`/stock-alerts?productId=${alertProduct.id}`),
    );
    // 每个启用仓库在无余额时都应按 0 预警，缺口等于 minStock。
    expect(alerts.total).toBe(activeWarehouseIds.length);
    expect(alerts.items.map((row) => row.warehouseId).sort()).toEqual(
      [...activeWarehouseIds].sort(),
    );
    for (const row of alerts.items) {
      expect(row.quantity).toBe(0);
      expect(row.shortage).toBe(5);
      expect(row.product.minStock).toBe(5);
    }
    // minStock=0 且无余额的商品不应预警：按商品精确查询，避免被其它用例的商品干扰。
    const productAAlerts = bodyOf<ListRow<AlertRow>>(
      await get(`/stock-alerts?productId=${ids.productA}`),
    );
    expect(
      productAAlerts.items.some((row) => row.productId === ids.productA),
    ).toBe(false);

    const byProduct = bodyOf<ListRow<AlertRow>>(
      await get(`/stock-alerts?productId=${alertProduct.id}`),
    );
    expect(byProduct.total).toBe(activeWarehouseIds.length);
    expect(
      byProduct.items.every((row) => row.productId === alertProduct.id),
    ).toBe(true);

    const byWarehouse = bodyOf<ListRow<AlertRow>>(
      await get(
        `/stock-alerts?productId=${alertProduct.id}&warehouseId=${ids.warehouse2}`,
      ),
    );
    expect(byWarehouse.total).toBe(1);
    expect(byWarehouse.items[0].warehouseId).toBe(ids.warehouse2);

    const paged = bodyOf<ListRow<AlertRow>>(
      await get(
        `/stock-alerts?productId=${alertProduct.id}&pageSize=1&page=2`,
      ),
    );
    expect(paged.items).toHaveLength(byProduct.total > 1 ? 1 : 0);
    expect(paged.total).toBe(byProduct.total);

    await prisma.product.update({
      where: { id: alertProduct.id },
      data: { status: 'INACTIVE' },
    });
    expect(
      bodyOf<ListRow<AlertRow>>(
        await get(`/stock-alerts?productId=${alertProduct.id}`),
      ).total,
    ).toBe(0);
    await prisma.product.update({
      where: { id: alertProduct.id },
      data: { status: 'ACTIVE' },
    });
    // 停用一个启用仓库后，预警组合数应减少 1。
    await prisma.warehouse.update({
      where: { id: ids.warehouse2 },
      data: { status: 'INACTIVE' },
    });
    expect(
      bodyOf<ListRow<AlertRow>>(
        await get(`/stock-alerts?productId=${alertProduct.id}`),
      ).total,
    ).toBe(activeWarehouseIds.length - 1);
    await prisma.warehouse.update({
      where: { id: ids.warehouse2 },
      data: { status: 'ACTIVE' },
    });
  });

  it('库存流水可按入库/出库/调整三种来源追溯，来源唯一且与单据对应', async () => {
    const product = await newProduct('T-TRACE');
    const purchaseOrder = await approvedOrder('purchase', {
      items: [{ productId: product.id, quantity: 4, unitPrice: 100 }],
    });
    const receipt = bodyOf<DocumentRow>(
      await post(
        '/goods-receipts',
        { orderId: purchaseOrder.id, items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 4 }] },
        key('trace-receipt'),
      ),
    );
    const salesOrder = await approvedOrder('sales', {
      items: [{ productId: product.id, quantity: 1, unitPrice: 200 }],
    });
    const shipment = bodyOf<DocumentRow>(
      await post(
        '/sales-shipments',
        { orderId: salesOrder.id, items: [{ orderItemId: salesOrder.items[0].id, quantity: 1 }] },
        key('trace-shipment'),
      ),
    );
    const adjustment = bodyOf<{ id: string }>(
      await post(
        '/stock-adjustments',
        { productId: product.id, warehouseId: ids.warehouse, quantity: -1, reason: '盘亏' },
        key('trace-adjustment'),
      ),
    );
    const byReceipt = bodyOf<ListRow<MovementRow>>(
      await get(`/stock-movements?receiptId=${receipt.id}`),
    );
    expect(byReceipt.total).toBe(1);
    expect(byReceipt.items[0]).toMatchObject({
      receiptId: receipt.id,
      shipmentId: null,
      adjustmentId: null,
      quantity: 4,
    });
    const byShipment = bodyOf<ListRow<MovementRow>>(
      await get(`/stock-movements?shipmentId=${shipment.id}`),
    );
    expect(byShipment.total).toBe(1);
    expect(byShipment.items[0]).toMatchObject({
      shipmentId: shipment.id,
      receiptId: null,
      adjustmentId: null,
      quantity: -1,
    });
    const byAdjustment = bodyOf<ListRow<MovementRow>>(
      await get(`/stock-movements?adjustmentId=${adjustment.id}`),
    );
    expect(byAdjustment.total).toBe(1);
    expect(byAdjustment.items[0]).toMatchObject({
      adjustmentId: adjustment.id,
      receiptId: null,
      shipmentId: null,
      quantity: -1,
    });
    const byProduct = bodyOf<ListRow<MovementRow>>(
      await get(`/stock-movements?productId=${product.id}`),
    );
    expect(byProduct.total).toBe(3);
    expect(await stockOf(product.id, ids.warehouse)).toBe(2);
  });

  it('库存报表口径：期初 + 期间增减 = 截止库存，历史截止与实时余额一致', async () => {
    const product = await newProduct('T-REPORT');
    const adjustments = [
      { quantity: 100, reason: '期初 10-01' },
      { quantity: -20, reason: '期间 10-10' },
      { quantity: 5, reason: '期间 10-20' },
    ];
    for (const [index, adjustment] of adjustments.entries())
      expect(
        (
          await post(
            '/stock-adjustments',
            {
              productId: product.id,
              warehouseId: ids.warehouse,
              ...adjustment,
            },
            key(`report-adj-${index}`),
          )
        ).status,
      ).toBe(201);
    const movements = await prisma.stockMovement.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(movements).toHaveLength(3);
    const dates = ['2026-10-01T02:00:00Z', '2026-10-10T02:00:00Z', '2026-10-20T02:00:00Z'];
    for (const [index, movement] of movements.entries())
      await prisma.stockMovement.update({
        where: { id: movement.id },
        data: { createdAt: new Date(dates[index]) },
      });
    expect(await stockOf(product.id, ids.warehouse)).toBe(85);

    const live = bodyOf<{
      items: { product: string; quantity: number }[];
    }>(await get(`/reports/inventory?productId=${product.id}`));
    expect(live.items).toHaveLength(1);
    expect(live.items[0].quantity).toBe(85);

    const ranged = bodyOf<{
      items: {
        openingQuantity: number;
        inboundQuantity: number;
        outboundQuantity: number;
        quantity: number;
      }[];
    }>(
      await get(
        `/reports/inventory?productId=${product.id}&dateFrom=2026-10-05&dateTo=2026-10-15`,
      ),
    );
    expect(ranged.items[0]).toMatchObject({
      openingQuantity: 100,
      inboundQuantity: 0,
      outboundQuantity: 20,
      quantity: 80,
    });

    const cutoff = bodyOf<{
      items: {
        openingQuantity: number;
        inboundQuantity: number;
        outboundQuantity: number;
        quantity: number;
      }[];
    }>(await get(`/reports/inventory?productId=${product.id}&dateTo=2026-10-04`));
    expect(cutoff.items[0]).toMatchObject({
      openingQuantity: 0,
      inboundQuantity: 100,
      outboundQuantity: 0,
      quantity: 100,
    });

    const secondCutoff = bodyOf<{
      items: {
        openingQuantity: number;
        inboundQuantity: number;
        outboundQuantity: number;
        quantity: number;
      }[];
    }>(await get(`/reports/inventory?productId=${product.id}&dateTo=2026-10-10`));
    expect(secondCutoff.items[0]).toMatchObject({
      openingQuantity: 0,
      inboundQuantity: 100,
      outboundQuantity: 20,
      quantity: 80,
    });

    const csv = await get(
      `/reports/inventory?format=csv&productId=${product.id}&dateFrom=2026-10-05&dateTo=2026-10-15`,
    );
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('期初数量');
    expect(csv.text).toContain('期间增加');
    expect(csv.text).toContain('期间减少');
    expect((await get('/reports/inventory?dateFrom=2026-02-30')).status).toBe(422);
    expect(
      (
        await get(
          '/reports/inventory?dateFrom=2026-10-20&dateTo=2026-10-01',
        )
      ).status,
    ).toBe(422);
  });

  it('列表分页与参数校验：非法分页/排序/未知参数 422，库存按商品仓库过滤', async () => {
    for (const path of [
      '/stocks?page=0',
      '/stocks?pageSize=101',
      '/stock-movements?status=NOPE',
      '/goods-receipts?pageSize=0',
      '/stock-alerts?pageSize=101',
      '/purchase-orders?unknown=1',
      '/sales-orders?unknown=1',
    ])
      expect((await get(path)).status, path).toBe(422);
    // 用一个本用例自建商品验证「商品+仓库」精确过滤，避免依赖其它用例遗留的余额行。
    const filteredProduct = await newProduct('T-STOCK-FILTER');
    expect(
      (
        await post(
          '/stock-adjustments',
          {
            productId: filteredProduct.id,
            warehouseId: ids.warehouse,
            quantity: 3,
            reason: '过滤校验期初',
          },
          key('stock-filter'),
        )
      ).status,
    ).toBe(201);
    const filtered = bodyOf<ListRow<{ productId: string; warehouseId: string }>>(
      await get(
        `/stocks?productId=${filteredProduct.id}&warehouseId=${ids.warehouse}`,
      ),
    );
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]).toMatchObject({
      productId: filteredProduct.id,
      warehouseId: ids.warehouse,
    });
    // 同商品换到没有余额的仓库必须查不到，证明两个条件同时生效。
    expect(
      bodyOf<ListRow<unknown>>(
        await get(
          `/stocks?productId=${filteredProduct.id}&warehouseId=${ids.warehouse2}`,
        ),
      ).total,
    ).toBe(0);
    expect(
      bodyOf<ListRow<unknown>>(
        await get(`/stocks?warehouseId=${ids.warehouseOff}`),
      ).total,
    ).toBe(0);
  });
});

describe.sequential('权限、审计与认证边界', () => {
  it('仓库角色可过账/调整但不可审核/建单/查应付，采购与销售不可越权过账', async () => {
    const { roleDefinitions } = await import('@kingflow/shared');
    const clients: Record<
      string,
      { agent: ReturnType<TestServer['agent']>; csrf: string }
    > = {};
    for (const code of ['PURCHASE', 'SALES', 'WAREHOUSE', 'FINANCE', 'GUEST']) {
      const definition = roleDefinitions.find((role) => role.code === code)!;
      const role = await prisma.role.create({
        data: {
          code: `TRADE-${code}`,
          name: definition.name,
          permissions: JSON.stringify(definition.permissions),
        },
      });
      const username = `trade-${code.toLowerCase()}`;
      await prisma.user.create({
        data: {
          username,
          passwordHash: await hash('Test@12345', 4),
          displayName: definition.name,
          roleId: role.id,
        },
      });
      const client = server.agent();
      const login = await client
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ username, password: 'Test@12345' });
      clients[code] = {
        agent: client,
        csrf: bodyOf<{ csrfToken: string }>(login).csrfToken,
      };
    }
    const call = async (
      code: string,
      method: 'get' | 'post',
      path: string,
      payload: object = {},
      idempotencyKey?: string,
    ) => {
      const client = clients[code];
      if (method === 'get')
        return (await client.agent.get('/api/v1' + path).set('Origin', ORIGIN))
          .status;
      const request = client.agent
        .post('/api/v1' + path)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', client.csrf);
      if (idempotencyKey) request.set('Idempotency-Key', idempotencyKey);
      return (await request.send(payload)).status;
    };
    const product = await newProduct('T-PERM');
    const purchaseOrder = await approvedOrder('purchase', {
      items: [{ productId: product.id, quantity: 2, unitPrice: 100 }],
    });
    const pendingPurchase = await createOrder('purchase', {
      items: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
    });
    await post(`/purchase-orders/${pendingPurchase.id}/submit`, {});
    const salesOrder = await approvedOrder('sales', {
      items: [{ productId: ids.productA, quantity: 1, unitPrice: 100 }],
    });
    const pendingSales = await createOrder('sales', {
      items: [{ productId: ids.productA, quantity: 1, unitPrice: 100 }],
    });
    await post(`/sales-orders/${pendingSales.id}/submit`, {});

    // 仓库：过账与调整允许，审核/建单/财务拒绝
    expect(
      await call('WAREHOUSE', 'post', '/goods-receipts', {
        orderId: purchaseOrder.id,
        items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 2 }],
      }, key('perm-warehouse-receipt')),
    ).toBe(201);
    expect(
      await call('WAREHOUSE', 'post', '/stock-adjustments', {
        productId: product.id,
        warehouseId: ids.warehouse,
        quantity: 1,
        reason: '仓管盘点',
      }, key('perm-warehouse-adjust')),
    ).toBe(201);
    expect(
      await call('WAREHOUSE', 'post', `/purchase-orders/${pendingPurchase.id}/approve`),
    ).toBe(403);
    expect(await call('WAREHOUSE', 'post', '/purchase-orders', purchaseBody())).toBe(
      403,
    );
    expect(await call('WAREHOUSE', 'get', '/payables')).toBe(403);
    // 采购：不能过账、不能出库
    expect(
      await call('PURCHASE', 'post', '/goods-receipts', {
        orderId: purchaseOrder.id,
        items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 1 }],
      }, key('perm-purchase-receipt')),
    ).toBe(403);
    expect(
      await call('PURCHASE', 'post', '/sales-shipments', {
        orderId: salesOrder.id,
        items: [{ orderItemId: salesOrder.items[0].id, quantity: 1 }],
      }, key('perm-purchase-ship')),
    ).toBe(403);
    // 销售：不能出库、不能入库、不能看应付，可看库存
    expect(
      await call('SALES', 'post', '/sales-shipments', {
        orderId: salesOrder.id,
        items: [{ orderItemId: salesOrder.items[0].id, quantity: 1 }],
      }, key('perm-sales-ship')),
    ).toBe(403);
    expect(
      await call('SALES', 'post', '/goods-receipts', {
        orderId: purchaseOrder.id,
        items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 1 }],
      }, key('perm-sales-receipt')),
    ).toBe(403);
    expect(await call('SALES', 'get', '/payables')).toBe(403);
    expect(await call('SALES', 'get', '/stocks')).toBe(200);
    // 财务：可查入库/应付，不可查库存
    expect(await call('FINANCE', 'get', '/goods-receipts')).toBe(200);
    expect(await call('FINANCE', 'get', '/payables')).toBe(200);
    expect(await call('FINANCE', 'get', '/stocks')).toBe(403);
    // 访客：只读，不能调整
    expect(
      await call('GUEST', 'post', '/stock-adjustments', {
        productId: product.id,
        warehouseId: ids.warehouse,
        quantity: 1,
        reason: '访客调整',
      }, key('perm-guest-adjust')),
    ).toBe(403);
    expect(await call('GUEST', 'get', '/stocks')).toBe(200);
    expect(await call('GUEST', 'get', '/purchase-orders')).toBe(200);
    // 越权请求不产生业务副作用
    expect(
      await prisma.goodsReceipt.count({ where: { orderId: purchaseOrder.id } }),
    ).toBe(1);
    expect((await detail('purchase', pendingPurchase.id)).status).toBe('PENDING');
    expect((await detail('sales', salesOrder.id)).items[0].shippedQuantity).toBe(0);
  });

  it('审计：采购/销售订单 3 条（CREATE/SUBMIT/APPROVE）、过账各 1 条，且不含密码等敏感字段', async () => {
    const purchaseOrder = await approvedOrder('purchase', {
      items: [{ productId: ids.productA, quantity: 1, unitPrice: 100 }],
    });
    expect(
      (
        await prisma.auditLog.findMany({
          where: { resource: 'purchase-orders', resourceId: purchaseOrder.id },
          orderBy: { createdAt: 'asc' },
          select: { action: true, actorId: true },
        })
      ).map((row) => row.action),
    ).toEqual(['CREATE', 'SUBMIT', 'APPROVE']);
    const salesOrder = await approvedOrder('sales', {
      items: [{ productId: ids.productA, quantity: 1, unitPrice: 100 }],
    });
    expect(
      (
        await prisma.auditLog.findMany({
          where: { resource: 'sales-orders', resourceId: salesOrder.id },
          orderBy: { createdAt: 'asc' },
          select: { action: true },
        })
      ).map((row) => row.action),
    ).toEqual(['CREATE', 'SUBMIT', 'APPROVE']);
    const receipt = bodyOf<DocumentRow>(
      await post(
        '/goods-receipts',
        { orderId: purchaseOrder.id, items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 1 }] },
        key('audit-receipt'),
      ),
    );
    const shipment = bodyOf<DocumentRow>(
      await post(
        '/sales-shipments',
        { orderId: salesOrder.id, items: [{ orderItemId: salesOrder.items[0].id, quantity: 1 }] },
        key('audit-shipment'),
      ),
    );
    for (const [resource, resourceId] of [
      ['goods-receipts', receipt.id],
      ['sales-shipments', shipment.id],
    ] as const)
      expect(
        await prisma.auditLog.count({ where: { resource, resourceId } }),
      ).toBe(1);
    const logs = await prisma.auditLog.findMany();
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toMatch(/password|passwordHash|csrf|kf_session/i);
    for (const log of logs) {
      expect(Object.keys(log).sort()).toEqual([
        'action',
        'actorId',
        'createdAt',
        'id',
        'resource',
        'resourceId',
      ]);
    }
  });

  it('认证与来源边界：未登录 401、缺 CSRF 403、跨源 403，均不写入业务数据', async () => {
    const anonymous = server.agent();
    expect((await anonymous.get('/api/v1/purchase-orders').set('Origin', ORIGIN)).status).toBe(401);
    expect((await anonymous.get('/api/v1/stocks').set('Origin', ORIGIN)).status).toBe(401);
    expect((await anonymous.get('/api/v1/stock-alerts').set('Origin', ORIGIN)).status).toBe(401);
    const before = await prisma.purchaseOrder.count();
    expect(
      (
        await agent
          .post('/api/v1/purchase-orders')
          .set('Origin', ORIGIN)
          .send(purchaseBody())
      ).status,
    ).toBe(403);
    expect(
      (
        await agent
          .post('/api/v1/purchase-orders')
          .set('Origin', 'https://evil.example')
          .set('X-CSRF-Token', csrf)
          .send(purchaseBody())
      ).status,
    ).toBe(403);
    expect(
      (
        await agent
          .post('/api/v1/stock-adjustments')
          .set('Origin', ORIGIN)
          .send({
            productId: ids.productA,
            warehouseId: ids.warehouse,
            quantity: 1,
            reason: '无CSRF',
          })
      ).status,
    ).toBe(403);
    expect(await prisma.purchaseOrder.count()).toBe(before);
    expect(
      await prisma.stockAdjustment.count({ where: { reason: '无CSRF' } }),
    ).toBe(0);
  });
});
