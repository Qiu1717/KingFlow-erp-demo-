import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { hash } from 'bcryptjs';
import { roleDefinitions } from '@kingflow/shared';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, ORIGIN, type TestServer } from './server.js';

/**
 * 企业级认证 / 会话 / CSRF / 来源校验 / 限流 + 六角色权限矩阵。
 *
 * 断言全部落在真实 HTTP 响应与真实数据库：越权不仅要求 403，还要核对目标表计数
 * 未发生变化；403 响应体不得携带业务数据（金额、往来单位、密码、CSRF、会话）。
 */
const PASSWORD = 'Sec@Test123';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

const roleCodes = roleDefinitions.map((role) => role.code);
type RoleCode = (typeof roleCodes)[number];
type Client = {
  agent: ReturnType<TestServer['agent']>;
  csrf: string;
  userId: string;
  username: string;
};

let server: TestServer;
const clients = {} as Record<RoleCode, Client>;
const roleIds: Record<string, string> = {};
const userIds: Record<string, string> = {};
let categoryId = '';
let productId = '';
let supplierId = '';
let customerId = '';
let warehouseId = '';

function api(client: Client) {
  const get = (path: string, query?: object) => {
    let test = client.agent.get('/api/v1' + path).set('Origin', ORIGIN);
    if (query) test = test.query(query);
    return test;
  };
  const write = (
    method: 'post' | 'patch' | 'delete',
    path: string,
    body: object = {},
    headers: Record<string, string> = {},
  ) => {
    let test = client.agent[method]('/api/v1' + path)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', client.csrf);
    for (const [name, value] of Object.entries(headers)) test = test.set(name, value);
    return method === 'delete' ? test : test.send(body);
  };
  return {
    get,
    post: (path: string, body: object = {}, headers?: Record<string, string>) =>
      write('post', path, body, headers),
    patch: (path: string, body: object = {}, headers?: Record<string, string>) =>
      write('patch', path, body, headers),
    del: (path: string) => write('delete', path),
  };
}

async function signIn(username: string, password = PASSWORD) {
  const agent = server.agent();
  const response = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password });
  return { agent, response };
}

const SECRET_PATTERN =
  /passwordHash|password_hash|csrfToken|kf_session|Sec@Test123|Changed@123/i;
/** 登录/me 响应必须返回 csrfToken（前端需要），但不得回传密码摘要或会话令牌。 */
const CREDENTIAL_PATTERN =
  /passwordHash|password_hash|kf_session|Sec@Test123|Changed@123/i;
function expectNoSecret(body: unknown) {
  expect(JSON.stringify(body)).not.toMatch(SECRET_PATTERN);
}
function expectNoCredentials(body: unknown) {
  expect(JSON.stringify(body)).not.toMatch(CREDENTIAL_PATTERN);
}
function expectNoBusinessData(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(SECRET_PATTERN);
  expect(text).not.toContain('¥');
  expect(text).not.toContain('安全验收供应商');
  expect(text).not.toContain('安全验收客户');
  expect(text).not.toContain('安全验收商品');
}

/** 越权写请求：403、错误码、目标表计数不变、响应体不泄露业务数据。 */
async function expectForbiddenWrite(
  client: Client,
  method: 'post' | 'patch',
  path: string,
  body: object,
  counter: () => Promise<number>,
  headers?: Record<string, string>,
) {
  const before = await counter();
  const response = await api(client)[method](path, body, headers);
  expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403);
  expect(response.body.error.code).toBe('FORBIDDEN');
  expectNoBusinessData(response.body);
  expect(await counter()).toBe(before);
  return response;
}

async function expectAllowedWrite(
  client: Client,
  method: 'post' | 'patch',
  path: string,
  body: object,
  headers?: Record<string, string>,
) {
  const response = await api(client)[method](path, body, headers);
  expect(
    response.status,
    `${method.toUpperCase()} ${path} -> ${JSON.stringify(response.body)}`,
  ).toBeLessThan(300);
  return response;
}

async function loginRole(code: RoleCode) {
  const { agent, response } = await signIn(`sec_${code.toLowerCase()}`);
  expect(response.status).toBe(200);
  clients[code] = {
    agent,
    csrf: response.body.data.csrfToken,
    userId: userIds[code],
    username: `sec_${code.toLowerCase()}`,
  };
}

async function newPurchaseOrder(status: 'DRAFT' | 'PENDING' | 'APPROVED') {
  const created = await api(clients.ADMIN).post('/purchase-orders', {
    supplierId,
    warehouseId,
    orderDate: today(),
    items: [{ productId, quantity: 5, unitPrice: 8000 }],
  });
  expect(created.status).toBe(201);
  const order = created.body.data;
  if (status !== 'DRAFT') {
    expect(
      (await api(clients.ADMIN).post(`/purchase-orders/${order.id}/submit`, {})).status,
    ).toBe(200);
  }
  if (status === 'APPROVED') {
    expect(
      (await api(clients.ADMIN).post(`/purchase-orders/${order.id}/approve`, {})).status,
    ).toBe(200);
  }
  const detail = await api(clients.ADMIN).get(`/purchase-orders/${order.id}`);
  return detail.body.data;
}

async function newSalesOrder(status: 'DRAFT' | 'PENDING' | 'APPROVED') {
  const created = await api(clients.ADMIN).post('/sales-orders', {
    customerId,
    warehouseId,
    orderDate: today(),
    items: [{ productId, quantity: 4, unitPrice: 12000 }],
  });
  expect(created.status).toBe(201);
  const order = created.body.data;
  if (status !== 'DRAFT') {
    expect(
      (await api(clients.ADMIN).post(`/sales-orders/${order.id}/submit`, {})).status,
    ).toBe(200);
  }
  if (status === 'APPROVED') {
    expect(
      (await api(clients.ADMIN).post(`/sales-orders/${order.id}/approve`, {})).status,
    ).toBe(200);
  }
  const detail = await api(clients.ADMIN).get(`/sales-orders/${order.id}`);
  return detail.body.data;
}

async function stockUp(quantity: number) {
  const response = await api(clients.ADMIN).post(
    '/stock-adjustments',
    { productId, warehouseId, quantity, reason: '安全验收期初' },
    { 'Idempotency-Key': `sec-opening-${quantity}-${Math.random().toString(16).slice(2)}` },
  );
  expect(response.status).toBe(201);
}

beforeAll(async () => {
  server = await startTestServer();
  await cleanDatabase();
  for (const definition of roleDefinitions) {
    const role = await prisma.role.create({
      data: {
        code: definition.code,
        name: definition.name,
        permissions: JSON.stringify(definition.permissions),
      },
    });
    roleIds[definition.code] = role.id;
    const user = await prisma.user.create({
      data: {
        username: `sec_${definition.code.toLowerCase()}`,
        displayName: `安全${definition.name}`,
        roleId: role.id,
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    userIds[definition.code] = user.id;
    await loginRole(definition.code as RoleCode);
  }
  const category = await api(clients.ADMIN).post('/categories', {
    code: 'SEC-CAT',
    name: '安全验收分类',
  });
  expect(category.status).toBe(201);
  categoryId = category.body.data.id;
  const product = await api(clients.ADMIN).post('/products', {
    code: 'SEC-PROD',
    name: '安全验收商品',
    categoryId,
    unit: '件',
    purchasePrice: 8000,
    salesPrice: 12000,
    minStock: 0,
  });
  expect(product.status).toBe(201);
  productId = product.body.data.id;
  const supplier = await api(clients.ADMIN).post('/suppliers', {
    code: 'SEC-SUP',
    name: '安全验收供应商',
  });
  expect(supplier.status).toBe(201);
  supplierId = supplier.body.data.id;
  const customer = await api(clients.ADMIN).post('/customers', {
    code: 'SEC-CUS',
    name: '安全验收客户',
  });
  expect(customer.status).toBe(201);
  customerId = customer.body.data.id;
  const warehouse = await api(clients.ADMIN).post('/warehouses', {
    code: 'SEC-WH',
    name: '安全验收仓库',
  });
  expect(warehouse.status).toBe(201);
  warehouseId = warehouse.body.data.id;
  await stockUp(20);
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

describe.sequential('认证、会话、CSRF、来源校验与限流', { timeout: 120000 }, () => {
  it('未登录、错误密码、不存在用户、停用用户一律拒绝且不泄露账号是否存在', async () => {
    const anonymous = request(server.server);
    const products = await anonymous.get('/api/v1/products');
    expect(products.status).toBe(401);
    expect(products.body.error.code).toBe('UNAUTHENTICATED');
    expectNoSecret(products.body);
    expect((await anonymous.get('/api/v1/auth/me')).status).toBe(401);

    const wrong = await signIn(`sec_admin`, 'Definitely-Wrong@1');
    expect(wrong.response.status).toBe(401);
    expect(wrong.response.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await signIn('sec_does_not_exist', 'Definitely-Wrong@1');
    expect(unknown.response.status).toBe(401);
    expect(unknown.response.body.error.code).toBe('INVALID_CREDENTIALS');
    // 账号不存在与密码错误必须给出完全一致的响应，避免账号枚举。
    expect(unknown.response.body).toEqual(wrong.response.body);
    expectNoSecret(wrong.response.body);

    const disabled = await prisma.user.create({
      data: {
        username: 'sec_disabled',
        displayName: '停用账号',
        roleId: roleIds.GUEST,
        status: 'INACTIVE',
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    const disabledLogin = await signIn('sec_disabled');
    expect(disabledLogin.response.status).toBe(401);
    expect(disabledLogin.response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(
      await prisma.session.count({ where: { userId: disabled.id } }),
    ).toBe(0);

    // 公开健康检查不要求登录，其余接口不得匿名访问。
    expect((await anonymous.get('/api/v1/health')).status).toBe(200);
    expect((await anonymous.get('/api/v1/system/users')).status).toBe(401);
  });

  it('登录写入真实 Session：只存令牌摘要，Cookie HttpOnly/SameSite/Path 正确', async () => {
    const { response } = await signIn('sec_guest');
    expect(response.status).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const sessionCookie = cookies.find((value) => value.startsWith('kf_session='));
    expect(sessionCookie).toBeTruthy();
    const raw = sessionCookie!.split(';')[0].slice('kf_session='.length);
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\/api\/v1/i);
    expect(sessionCookie).toMatch(/Max-Age=28800/i);
    const stored = await prisma.session.findUnique({ where: { id: digest(raw) } });
    expect(stored).toBeTruthy();
    expect(stored!.id).not.toBe(raw);
    expect(stored!.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(stored!.csrfToken).not.toBe(raw);
    // 响应体不得回传会话令牌或密码摘要；csrfToken 必须返回给前端。
    expect(JSON.stringify(response.body)).not.toContain(raw);
    expectNoCredentials(response.body);
    expect(response.body.data.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.data.csrfToken).not.toBe(raw);
    // API 响应统一禁止缓存并带请求编号。
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CSRF 缺失/伪造/旧令牌与 Origin 缺失/跨源均拒绝，GET 不受影响', async () => {
    const admin = clients.ADMIN;
    expect((await api(admin).get('/products')).status).toBe(200);

    const missing = await admin.agent
      .post('/api/v1/categories')
      .set('Origin', ORIGIN)
      .send({ code: 'SEC-CSRF-1', name: '无CSRF' });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('INVALID_CSRF');

    const forged = await api(admin).post(
      '/categories',
      { code: 'SEC-CSRF-2', name: '伪造CSRF' },
      { 'X-CSRF-Token': 'a'.repeat(64) },
    );
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('INVALID_CSRF');

    const malformed = await api(admin).post(
      '/categories',
      { code: 'SEC-CSRF-3', name: '长度非法CSRF' },
      { 'X-CSRF-Token': 'abc' },
    );
    expect(malformed.status).toBe(403);
    expect(malformed.body.error.code).toBe('INVALID_CSRF');

    // 另一会话的 CSRF 令牌不得用于当前会话。
    const otherCsrf = clients.GUEST.csrf;
    const foreign = await api(admin).post(
      '/categories',
      { code: 'SEC-CSRF-4', name: '跨会话CSRF' },
      { 'X-CSRF-Token': otherCsrf },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('INVALID_CSRF');

    const noOrigin = await admin.agent
      .post('/api/v1/categories')
      .set('X-CSRF-Token', admin.csrf)
      .send({ code: 'SEC-CSRF-5', name: '无来源' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe('INVALID_ORIGIN');

    const crossOrigin = await admin.agent
      .post('/api/v1/categories')
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', admin.csrf)
      .send({ code: 'SEC-CSRF-6', name: '跨源' });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error.code).toBe('INVALID_ORIGIN');

    const crossOriginLogin = await request(server.server)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'sec_guest', password: PASSWORD });
    expect(crossOriginLogin.status).toBe(403);

    expect(await prisma.productCategory.count({ where: { code: { startsWith: 'SEC-CSRF' } } })).toBe(0);

    // 重新登录后旧会话的 CSRF 随会话一起失效。
    const oldCsrf = admin.csrf;
    const relogin = await signIn('sec_admin');
    expect(relogin.response.status).toBe(200);
    const rotated = await relogin.agent
      .post('/api/v1/categories')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', oldCsrf)
      .send({ code: 'SEC-CSRF-7', name: '旧会话令牌' });
    expect(rotated.status).toBe(403);
    expect(rotated.body.error.code).toBe('INVALID_CSRF');
    // 更新管理员会话，避免后续用例使用被撤销的旧会话。
    clients.ADMIN = {
      ...clients.ADMIN,
      agent: relogin.agent,
      csrf: relogin.response.body.data.csrfToken,
    };
  });

  it('退出撤销数据库会话，旧 Cookie 立即失效，缺少 CSRF 时不得退出', async () => {
    const guest = await signIn('sec_guest');
    const cookie = (guest.response.headers['set-cookie'] as unknown as string[])[0]
      .split(';')[0];
    const csrf = guest.response.body.data.csrfToken;
    const sessionCount = await prisma.session.count({ where: { userId: userIds.GUEST } });

    const withoutCsrf = await guest.agent
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN);
    expect(withoutCsrf.status).toBe(403);
    expect(await prisma.session.count({ where: { userId: userIds.GUEST } })).toBe(
      sessionCount,
    );

    const logout = await guest.agent
      .post('/api/v1/auth/logout')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf);
    expect(logout.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: userIds.GUEST } })).toBe(
      sessionCount - 1,
    );

    const replay = await request(server.server)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie);
    expect(replay.status).toBe(401);
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: userIds.GUEST, action: 'LOGOUT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
  });

  it('Session 过期后拒绝访问，重新登录恢复', async () => {
    const user = await prisma.user.create({
      data: {
        username: 'sec_expiry',
        displayName: '过期验收',
        roleId: roleIds.GUEST,
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    const { agent, response } = await signIn('sec_expiry');
    expect(response.status).toBe(200);
    const token = (response.headers['set-cookie'] as unknown as string[])[0]
      .split(';')[0]
      .slice('kf_session='.length);
    const sessionId = digest(token);
    expect(
      (await agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(200);
    await prisma.session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await agent.get('/api/v1/auth/me').set('Origin', ORIGIN);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SESSION_EXPIRED');
    expect(
      (await agent.get('/api/v1/products').set('Origin', ORIGIN)).status,
    ).toBe(401);
    const relogin = await signIn('sec_expiry');
    expect(relogin.response.status).toBe(200);
    expect(
      (await relogin.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(200);
    // 重新登录会清理过期会话，因此数据库只剩新会话。
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it('同账号并发登录多会话并存，重新登录替换旧 Cookie 并删除旧会话', async () => {
    const first = await signIn('sec_expiry');
    const second = await signIn('sec_expiry');
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(
      (await first.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(200);
    expect(
      (await second.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({
      where: { username: 'sec_expiry' },
    });
    const before = await prisma.session.count({ where: { userId: user.id } });
    expect(before).toBeGreaterThanOrEqual(2);

    const oldCookie = (second.response.headers['set-cookie'] as unknown as string[])[0]
      .split(';')[0];
    // 同一浏览器再次登录：携带旧 Cookie 时服务端删除旧会话并签发新 Cookie。
    const rotated = await second.agent
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'sec_expiry', password: PASSWORD });
    expect(rotated.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(before);
    const replay = await request(server.server)
      .get('/api/v1/auth/me')
      .set('Cookie', oldCookie);
    expect(replay.status).toBe(401);
    expect(
      (await second.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(200);

    const parallel = await Promise.all(
      Array.from({ length: 5 }, () => signIn('sec_expiry')),
    );
    expect(parallel.every((item) => item.response.status === 200)).toBe(true);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
      before + 5,
    );
  });

  it('账号停用后即使会话仍在数据库中也立即 401', async () => {
    const user = await prisma.user.create({
      data: {
        username: 'sec_locked',
        displayName: '停用会话验收',
        roleId: roleIds.GUEST,
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    const { agent, response } = await signIn('sec_locked');
    expect(response.status).toBe(200);
    expect(
      (await agent.get('/api/v1/products').set('Origin', ORIGIN)).status,
    ).toBe(200);
    // 直接改库模拟管理员停用，验证认证层读取实时账号状态而不是信任会话快照。
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'INACTIVE' },
    });
    const denied = await agent.get('/api/v1/products').set('Origin', ORIGIN);
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('SESSION_EXPIRED');
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe.sequential('六角色读权限矩阵（全部关键端点）', { timeout: 180000 }, () => {
  const matrix: { path: string; allow: RoleCode[] }[] = [
    { path: '/auth/me', allow: [...roleCodes] as RoleCode[] },
    { path: '/products', allow: [...roleCodes] as RoleCode[] },
    { path: '/categories', allow: [...roleCodes] as RoleCode[] },
    { path: '/customers', allow: [...roleCodes] as RoleCode[] },
    { path: '/suppliers', allow: [...roleCodes] as RoleCode[] },
    { path: '/warehouses', allow: [...roleCodes] as RoleCode[] },
    { path: '/dashboard/summary', allow: [...roleCodes] as RoleCode[] },
    { path: '/dashboard/business', allow: [...roleCodes] as RoleCode[] },
    { path: '/dashboard/todos', allow: [...roleCodes] as RoleCode[] },
    { path: '/system/reference', allow: [...roleCodes] as RoleCode[] },
    {
      path: '/purchase-orders',
      allow: ['ADMIN', 'PURCHASE', 'WAREHOUSE', 'GUEST'],
    },
    {
      path: '/goods-receipts',
      allow: ['ADMIN', 'PURCHASE', 'WAREHOUSE', 'FINANCE', 'GUEST'],
    },
    { path: '/stocks', allow: ['ADMIN', 'PURCHASE', 'SALES', 'WAREHOUSE', 'GUEST'] },
    {
      path: '/stock-movements',
      allow: ['ADMIN', 'PURCHASE', 'SALES', 'WAREHOUSE', 'GUEST'],
    },
    {
      path: '/stock-alerts',
      allow: ['ADMIN', 'PURCHASE', 'SALES', 'WAREHOUSE', 'GUEST'],
    },
    {
      path: '/stock-adjustments',
      allow: ['ADMIN', 'PURCHASE', 'SALES', 'WAREHOUSE', 'GUEST'],
    },
    { path: '/sales-orders', allow: ['ADMIN', 'SALES', 'WAREHOUSE', 'GUEST'] },
    {
      path: '/sales-shipments',
      allow: ['ADMIN', 'SALES', 'WAREHOUSE', 'FINANCE', 'GUEST'],
    },
    { path: '/receivables', allow: ['ADMIN', 'FINANCE'] },
    { path: '/payables', allow: ['ADMIN', 'FINANCE'] },
    { path: '/settlements', allow: ['ADMIN', 'FINANCE'] },
    { path: '/finance/summary', allow: ['ADMIN', 'FINANCE'] },
    { path: '/reports/sales', allow: ['ADMIN', 'SALES', 'WAREHOUSE', 'GUEST'] },
    { path: '/reports/purchases', allow: ['ADMIN', 'PURCHASE', 'WAREHOUSE', 'GUEST'] },
    {
      path: '/reports/inventory',
      allow: ['ADMIN', 'PURCHASE', 'SALES', 'WAREHOUSE', 'GUEST'],
    },
    { path: '/reports/finance', allow: ['ADMIN', 'FINANCE'] },
    { path: '/system/users', allow: ['ADMIN'] },
    { path: '/system/roles', allow: ['ADMIN'] },
    { path: '/system/permissions', allow: ['ADMIN'] },
    { path: '/system/audit-logs', allow: ['ADMIN'] },
  ];

  it('逐项断言六角色允许/拒绝，越权响应不泄露业务数据', async () => {
    const failures: string[] = [];
    for (const item of matrix) {
      for (const role of roleCodes as RoleCode[]) {
        const response = await api(clients[role]).get(item.path);
        const allowed = item.allow.includes(role);
        if (allowed && response.status !== 200) {
          failures.push(`${role} ${item.path} 期望200 实际${response.status}`);
          continue;
        }
        if (!allowed) {
          if (response.status !== 403) {
            failures.push(`${role} ${item.path} 期望403 实际${response.status}`);
            continue;
          }
          expectNoBusinessData(response.body);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('访客只读：可查基础资料与业务列表，但无任何维护入口权限', async () => {
    const guest = clients.GUEST;
    for (const path of ['/products', '/customers', '/stocks', '/sales-orders']) {
      expect((await api(guest).get(path)).status, path).toBe(200);
    }
    // 访客对每个写接口都必须是 403（管理员/其他角色的写矩阵另行逐项验证）。
    for (const [path, body] of [
      ['/products', { code: 'GUEST-W', name: '访客商品', categoryId, unit: '件', purchasePrice: 1, salesPrice: 1 }],
      ['/categories', { code: 'GUEST-CAT', name: '访客分类' }],
      ['/customers', { code: 'GUEST-CUS', name: '访客客户' }],
      ['/suppliers', { code: 'GUEST-SUP', name: '访客供应商' }],
      ['/warehouses', { code: 'GUEST-WH', name: '访客仓库' }],
      ['/purchase-orders', { supplierId, warehouseId, orderDate: today(), items: [{ productId, quantity: 1, unitPrice: 100 }] }],
      ['/sales-orders', { customerId, warehouseId, orderDate: today(), items: [{ productId, quantity: 1, unitPrice: 100 }] }],
      ['/stock-adjustments', { productId, warehouseId, quantity: 1, reason: '访客' }],
    ] as [string, object][]) {
      const response = await api(guest).post(path, body, {
        'Idempotency-Key': 'guest-write-attempt-' + path.slice(1),
      });
      expect(response.status, `GUEST POST ${path}`).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expectNoBusinessData(response.body);
    }
  });

  it('经营看板按权限裁剪指标：销售/采购/仓库/财务/访客互不越界', async () => {
    const keys = async (role: RoleCode) =>
      Object.keys((await api(clients[role]).get('/dashboard/business')).body.data.metrics);
    const admin = await keys('ADMIN');
    expect(admin).toEqual(
      expect.arrayContaining([
        'monthSales',
        'monthPurchases',
        'stockQuantity',
        'receivable',
        'payable',
        'pendingApprovals',
      ]),
    );
    const sales = await keys('SALES');
    expect(sales).toEqual(
      expect.arrayContaining(['monthSales', 'stockQuantity', 'pendingApprovals']),
    );
    expect(sales).not.toContain('monthPurchases');
    expect(sales).not.toContain('receivable');
    expect(sales).not.toContain('payable');
    const purchase = await keys('PURCHASE');
    expect(purchase).toEqual(
      expect.arrayContaining(['monthPurchases', 'stockQuantity', 'pendingApprovals']),
    );
    expect(purchase).not.toContain('monthSales');
    expect(purchase).not.toContain('receivable');
    expect(purchase).not.toContain('payable');
    const warehouse = await keys('WAREHOUSE');
    expect(warehouse).toEqual(
      expect.arrayContaining(['monthSales', 'monthPurchases', 'stockQuantity']),
    );
    expect(warehouse).not.toContain('receivable');
    expect(warehouse).not.toContain('payable');
    expect(warehouse).not.toContain('pendingApprovals');
    const finance = await keys('FINANCE');
    expect(finance).toEqual(expect.arrayContaining(['receivable', 'payable']));
    expect(finance).not.toContain('monthSales');
    expect(finance).not.toContain('monthPurchases');
    expect(finance).not.toContain('stockQuantity');
    expect(finance).not.toContain('pendingApprovals');
    const guest = await keys('GUEST');
    expect(guest).toEqual(expect.arrayContaining(['monthSales', 'monthPurchases', 'stockQuantity']));
    expect(guest).not.toContain('receivable');
    expect(guest).not.toContain('payable');
    // 趋势数组同样按权限裁剪字段。
    const salesTrend = (await api(clients.SALES).get('/dashboard/business')).body.data
      .trend[0];
    expect(salesTrend).toHaveProperty('sales');
    expect(salesTrend).not.toHaveProperty('purchases');
    const financeTrend = (await api(clients.FINANCE).get('/dashboard/business')).body
      .data.trend[0];
    expect(financeTrend).not.toHaveProperty('sales');
    expect(financeTrend).not.toHaveProperty('purchases');
    expect((await api(clients.FINANCE).get('/dashboard/business')).body.data.topProducts).toBeUndefined();
  });

  it('最近操作日志按操作者隔离，非管理员只能看到自己的审计记录', async () => {
    await api(clients.GUEST).patch('/auth/profile', { displayName: '只读访客' });
    const guestSummary = (await api(clients.GUEST).get('/dashboard/summary')).body.data;
    expect(guestSummary.recentLogs.length).toBeGreaterThan(0);
    expect(
      guestSummary.recentLogs.every(
        (log: { actorId: string }) => log.actorId === userIds.GUEST,
      ),
    ).toBe(true);
    const adminSummary = (await api(clients.ADMIN).get('/dashboard/summary')).body.data;
    expect(
      adminSummary.recentLogs.some(
        (log: { actorId: string }) => log.actorId !== userIds.ADMIN,
      ),
    ).toBe(true);
  });
});

describe.sequential('六角色写权限矩阵与越权零副作用', { timeout: 180000 }, () => {
  it('基础资料写权限：采购维护商品/分类/供应商，销售仅客户，仓库/财务/访客只读', async () => {
    const cases: {
      path: string;
      allow: RoleCode[];
      counter: () => Promise<number>;
      body: (role: RoleCode) => object;
    }[] = [
      {
        path: '/products',
        allow: ['ADMIN', 'PURCHASE'],
        counter: () => prisma.product.count(),
        body: (role) => ({
          code: `SEC-W-PROD-${role}`,
          name: `写权限商品${role}`,
          categoryId,
          unit: '件',
          purchasePrice: 100,
          salesPrice: 200,
        }),
      },
      {
        path: '/categories',
        allow: ['ADMIN', 'PURCHASE'],
        counter: () => prisma.productCategory.count(),
        body: (role) => ({ code: `SEC-W-CAT-${role}`, name: `写权限分类${role}` }),
      },
      {
        path: '/customers',
        allow: ['ADMIN', 'SALES'],
        counter: () => prisma.customer.count(),
        body: (role) => ({ code: `SEC-W-CUS-${role}`, name: `写权限客户${role}` }),
      },
      {
        path: '/suppliers',
        allow: ['ADMIN', 'PURCHASE'],
        counter: () => prisma.supplier.count(),
        body: (role) => ({ code: `SEC-W-SUP-${role}`, name: `写权限供应商${role}` }),
      },
      {
        path: '/warehouses',
        allow: ['ADMIN'],
        counter: () => prisma.warehouse.count(),
        body: (role) => ({ code: `SEC-W-WH-${role}`, name: `写权限仓库${role}` }),
      },
    ];
    for (const item of cases) {
      for (const role of roleCodes as RoleCode[]) {
        const body = item.body(role);
        if (item.allow.includes(role)) {
          const before = await item.counter();
          await expectAllowedWrite(clients[role], 'post', item.path, body);
          expect(await item.counter()).toBe(before + 1);
        } else {
          await expectForbiddenWrite(clients[role], 'post', item.path, body, item.counter);
        }
      }
    }
  });

  it('采购单：仅管理员/采购可建单提交审核，仓库/销售/财务/访客不能审核', async () => {
    const count = () => prisma.purchaseOrder.count();
    for (const role of roleCodes as RoleCode[]) {
      const body = {
        supplierId,
        warehouseId,
        orderDate: today(),
        items: [{ productId, quantity: 2, unitPrice: 1000 }],
      };
      if (role === 'ADMIN' || role === 'PURCHASE') {
        const created = await expectAllowedWrite(
          clients[role],
          'post',
          '/purchase-orders',
          body,
        );
        const id = created.body.data.id;
        await expectAllowedWrite(clients[role], 'post', `/purchase-orders/${id}/submit`, {});
      } else {
        await expectForbiddenWrite(clients[role], 'post', '/purchase-orders', body, count);
      }
    }
    // 审核与建单分离：为每个角色准备一张待审核单，只有管理员/采购可审核。
    for (const role of roleCodes as RoleCode[]) {
      const pending = await newPurchaseOrder('PENDING');
      if (role === 'ADMIN' || role === 'PURCHASE') {
        const approved = await expectAllowedWrite(
          clients[role],
          'post',
          `/purchase-orders/${pending.id}/approve`,
          {},
        );
        expect(approved.body.data.status).toBe('APPROVED');
      } else {
        const before = await prisma.auditLog.count({
          where: { resource: 'purchase-orders', resourceId: pending.id, action: 'APPROVE' },
        });
        await expectForbiddenWrite(
          clients[role],
          'post',
          `/purchase-orders/${pending.id}/approve`,
          {},
          () =>
            prisma.auditLog.count({
              where: {
                resource: 'purchase-orders',
                resourceId: pending.id,
                action: 'APPROVE',
              },
            }),
        );
        const after = await prisma.purchaseOrder.findUniqueOrThrow({
          where: { id: pending.id },
        });
        expect(after.status).toBe('PENDING');
        expect(before).toBe(0);
      }
    }
  });

  it('销售单：仅管理员/销售可建单审核，仓库不能审核销售单', async () => {
    for (const role of roleCodes as RoleCode[]) {
      const body = {
        customerId,
        warehouseId,
        orderDate: today(),
        items: [{ productId, quantity: 1, unitPrice: 2000 }],
      };
      if (role === 'ADMIN' || role === 'SALES') {
        const created = await expectAllowedWrite(clients[role], 'post', '/sales-orders', body);
        await expectAllowedWrite(
          clients[role],
          'post',
          `/sales-orders/${created.body.data.id}/submit`,
          {},
        );
      } else {
        await expectForbiddenWrite(
          clients[role],
          'post',
          '/sales-orders',
          body,
          () => prisma.salesOrder.count(),
        );
      }
    }
    for (const role of roleCodes as RoleCode[]) {
      const pending = await newSalesOrder('PENDING');
      if (role === 'ADMIN' || role === 'SALES') {
        const approved = await expectAllowedWrite(
          clients[role],
          'post',
          `/sales-orders/${pending.id}/approve`,
          {},
        );
        expect(approved.body.data.status).toBe('APPROVED');
      } else {
        await expectForbiddenWrite(
          clients[role],
          'post',
          `/sales-orders/${pending.id}/approve`,
          {},
          () =>
            prisma.auditLog.count({
              where: {
                resource: 'sales-orders',
                resourceId: pending.id,
                action: 'APPROVE',
              },
            }),
        );
        expect(
          (await prisma.salesOrder.findUniqueOrThrow({ where: { id: pending.id } })).status,
        ).toBe('PENDING');
      }
    }
  });

  it('入库过账仅仓库/管理员；销售、财务、采购、访客越权入库无库存与应付副作用', async () => {
    const receiptCount = () => prisma.goodsReceipt.count();
    const movementCount = () => prisma.stockMovement.count();
    const payableCount = () => prisma.payable.count();
    for (const role of roleCodes as RoleCode[]) {
      const order = await newPurchaseOrder('APPROVED');
      const body = {
        orderId: order.id,
        items: [{ orderItemId: order.items[0].id, quantity: 2 }],
      };
      const key = `sec-receipt-${role}-${Math.random().toString(16).slice(2)}`;
      if (role === 'ADMIN' || role === 'WAREHOUSE') {
        const receipts = await receiptCount();
        const movements = await movementCount();
        const payables = await payableCount();
        const response = await expectAllowedWrite(
          clients[role],
          'post',
          '/goods-receipts',
          body,
          { 'Idempotency-Key': key },
        );
        expect(response.status).toBe(201);
        expect(await receiptCount()).toBe(receipts + 1);
        expect(await movementCount()).toBe(movements + 1);
        expect(await payableCount()).toBe(payables + 1);
      } else {
        await expectForbiddenWrite(
          clients[role],
          'post',
          '/goods-receipts',
          body,
          async () =>
            (await receiptCount()) + (await movementCount()) + (await payableCount()),
          { 'Idempotency-Key': key },
        );
        expect(
          await prisma.goodsReceipt.count({ where: { orderId: order.id } }),
        ).toBe(0);
        expect(
          await prisma.payable.count({
            where: { receipt: { orderId: order.id } },
          }),
        ).toBe(0);
      }
    }
  });

  it('出库过账仅仓库/管理员；销售不能自行出库、财务/采购/访客越权无应收副作用', async () => {
    await stockUp(60);
    const shipmentCount = () => prisma.salesShipment.count();
    const receivableCount = () => prisma.receivable.count();
    for (const role of roleCodes as RoleCode[]) {
      const order = await newSalesOrder('APPROVED');
      const body = {
        orderId: order.id,
        items: [{ orderItemId: order.items[0].id, quantity: 1 }],
      };
      const key = `sec-ship-${role}-${Math.random().toString(16).slice(2)}`;
      if (role === 'ADMIN' || role === 'WAREHOUSE') {
        const shipments = await shipmentCount();
        const receivables = await receivableCount();
        const response = await expectAllowedWrite(
          clients[role],
          'post',
          '/sales-shipments',
          body,
          { 'Idempotency-Key': key },
        );
        expect(response.status).toBe(201);
        expect(await shipmentCount()).toBe(shipments + 1);
        expect(await receivableCount()).toBe(receivables + 1);
      } else {
        await expectForbiddenWrite(
          clients[role],
          'post',
          '/sales-shipments',
          body,
          async () => (await shipmentCount()) + (await receivableCount()),
          { 'Idempotency-Key': key },
        );
        expect(
          await prisma.salesShipment.count({ where: { orderId: order.id } }),
        ).toBe(0);
        expect(
          await prisma.receivable.count({
            where: { shipment: { orderId: order.id } },
          }),
        ).toBe(0);
      }
    }
  });

  it('库存调整仅仓库/管理员，其余角色越权不产生流水', async () => {
    for (const role of roleCodes as RoleCode[]) {
      const body = {
        productId,
        warehouseId,
        quantity: 1,
        reason: `权限矩阵调整${role}`,
      };
      const key = `sec-adjust-${role}-${Math.random().toString(16).slice(2)}`;
      if (role === 'ADMIN' || role === 'WAREHOUSE') {
        const before = await prisma.stockAdjustment.count();
        const movements = await prisma.stockMovement.count();
        await expectAllowedWrite(clients[role], 'post', '/stock-adjustments', body, {
          'Idempotency-Key': key,
        });
        expect(await prisma.stockAdjustment.count()).toBe(before + 1);
        expect(await prisma.stockMovement.count()).toBe(movements + 1);
      } else {
        await expectForbiddenWrite(
          clients[role],
          'post',
          '/stock-adjustments',
          body,
          async () =>
            (await prisma.stockAdjustment.count()) + (await prisma.stockMovement.count()),
          { 'Idempotency-Key': key },
        );
      }
    }
  });

  it('收付款仅财务/管理员，销售/采购/仓库/访客越权结算不改变往来余额', async () => {
    await stockUp(40);
    const settlementCount = () => prisma.settlementRecord.count();
    // 准备一笔应收与一笔应付。
    const salesOrder = await newSalesOrder('APPROVED');
    const shipment = await api(clients.ADMIN).post(
      '/sales-shipments',
      { orderId: salesOrder.id, items: [{ orderItemId: salesOrder.items[0].id, quantity: 1 }] },
      { 'Idempotency-Key': 'sec-settle-ar-shipment' },
    );
    expect(shipment.status).toBe(201);
    const receivable = await prisma.receivable.findUniqueOrThrow({
      where: { shipmentId: shipment.body.data.id },
    });
    const purchaseOrder = await newPurchaseOrder('APPROVED');
    const receipt = await api(clients.ADMIN).post(
      '/goods-receipts',
      { orderId: purchaseOrder.id, items: [{ orderItemId: purchaseOrder.items[0].id, quantity: 1 }] },
      { 'Idempotency-Key': 'sec-settle-ap-receipt' },
    );
    expect(receipt.status).toBe(201);
    const payable = await prisma.payable.findUniqueOrThrow({
      where: { receiptId: receipt.body.data.id },
    });

    for (const role of roleCodes as RoleCode[]) {
      for (const [path, sourceId, counter] of [
        ['/settlements/receipts', receivable.id, () => prisma.receivable.findUniqueOrThrow({ where: { id: receivable.id } })],
        ['/settlements/payments', payable.id, () => prisma.payable.findUniqueOrThrow({ where: { id: payable.id } })],
      ] as [string, string, () => Promise<{ receivedAmount?: number; paidAmount?: number }>][]) {
        const before = await counter();
        const settled = before.receivedAmount ?? before.paidAmount ?? 0;
        const body = {
          sourceId,
          amount: 100,
          date: today(),
          method: '银行转账',
        };
        const key = `sec-settle-${role}-${path.slice(-1)}-${Math.random().toString(16).slice(2)}`;
        if (role === 'ADMIN' || role === 'FINANCE') {
          const response = await expectAllowedWrite(clients[role], 'post', path, body, {
            'Idempotency-Key': key,
          });
          expect(response.status).toBe(201);
          const after = await counter();
          expect(after.receivedAmount ?? after.paidAmount).toBe(settled + 100);
        } else {
          await expectForbiddenWrite(clients[role], 'post', path, body, settlementCount, {
            'Idempotency-Key': key,
          });
          const after = await counter();
          expect(after.receivedAmount ?? after.paidAmount).toBe(settled);
        }
      }
    }
  });

  it('系统管理写接口仅管理员：用户、角色、重置密码均拒绝其他角色', async () => {
    const target = await prisma.user.create({
      data: {
        username: 'sec_target',
        displayName: '被管理账号',
        roleId: roleIds.GUEST,
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    const tempRole = await prisma.role.create({
      data: { code: 'SEC_TEMP', name: '临时角色', permissions: '["master:read"]' },
    });
    const userCount = () => prisma.user.count();
    for (const role of roleCodes as RoleCode[]) {
      if (role === 'ADMIN') {
        const created = await expectAllowedWrite(clients[role], 'post', '/system/users', {
          username: `sec_created_${Date.now()}`,
          displayName: '管理员创建账号',
          password: 'Created@12345',
          roleId: roleIds.GUEST,
        });
        expect(created.status).toBe(201);
        expect(await prisma.auditLog.count({ where: { action: 'CREATE', resource: 'users' } })).toBeGreaterThan(0);
        await expectAllowedWrite(clients[role], 'patch', `/system/users/${target.id}`, {
          displayName: '管理员改名',
        });
        await expectAllowedWrite(clients[role], 'post', `/system/users/${target.id}/reset-password`, {
          password: 'Reset@123456',
        });
        await expectAllowedWrite(clients[role], 'patch', `/system/roles/${tempRole.id}`, {
          permissions: ['master:read'],
        });
      } else {
        await expectForbiddenWrite(clients[role], 'post', '/system/users', {
          username: `sec_denied_${role}`,
          displayName: '越权创建',
          password: 'Created@12345',
          roleId: roleIds.GUEST,
        }, userCount);
        await expectForbiddenWrite(clients[role], 'patch', `/system/users/${target.id}`, {
          displayName: '越权改名',
        }, async () =>
          (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).displayName ===
          '被管理账号'
            ? 0
            : 1,
        );
        await expectForbiddenWrite(clients[role], 'post', `/system/users/${target.id}/reset-password`, {
          password: 'Reset@123456',
        }, async () =>
          (await prisma.session.count({ where: { userId: target.id } })) +
          (await prisma.auditLog.count({
            where: { resource: 'users', resourceId: target.id, action: 'RESET_PASSWORD' },
          })),
        );
        await expectForbiddenWrite(clients[role], 'patch', `/system/roles/${tempRole.id}`, {
          permissions: ['master:read', 'customers:write'],
        }, async () =>
          (await prisma.role.findUniqueOrThrow({ where: { id: tempRole.id } }))
            .permissions === '["master:read"]'
            ? 0
            : 1,
        );
      }
    }
    expect(
      (await prisma.role.findUniqueOrThrow({ where: { id: tempRole.id } })).permissions,
    ).toBe('["master:read"]');
  });

  it('拥有 * 权限但角色编码非 ADMIN 的自定义角色仍不能进入系统管理', async () => {
    const role = await prisma.role.create({
      data: { code: 'AUDITOR', name: '全权审计', permissions: '["*"]' },
    });
    const user = await prisma.user.create({
      data: {
        username: 'sec_auditor',
        displayName: '全权审计',
        roleId: role.id,
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    const { agent, response } = await signIn('sec_auditor');
    expect(response.status).toBe(200);
    const client: Client = {
      agent,
      csrf: response.body.data.csrfToken,
      userId: user.id,
      username: 'sec_auditor',
    };
    expect((await api(client).get('/system/users')).status).toBe(403);
    expect((await api(client).get('/system/audit-logs')).status).toBe(403);
    expect(
      (
        await api(client).post('/system/users', {
          username: 'sec_auditor_created',
          displayName: '越权',
          password: 'Created@12345',
          roleId: role.id,
        })
      ).status,
    ).toBe(403);
    // 业务接口按 * 正常放行，证明拦截来自系统管理的 ADMIN 校验而非整体失效。
    expect((await api(client).get('/products')).status).toBe(200);
  });

  it('所有角色均可修改自己的显示名称，越权字段被拒绝', async () => {
    for (const role of roleCodes as RoleCode[]) {
      const name = `安全改名${role}`;
      const response = await expectAllowedWrite(clients[role], 'patch', '/auth/profile', {
        displayName: name,
      });
      expect(response.body.data.displayName).toBe(name);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userIds[role] } })).displayName,
      ).toBe(name);
      const extra = await api(clients[role]).patch('/auth/profile', {
        displayName: name,
        roleId: roleIds.ADMIN,
      });
      expect(extra.status).toBe(422);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userIds[role] } })).roleId,
      ).toBe(roleIds[role]);
    }
  });
});

describe.sequential('登录限流（独立 IP 通道）', { timeout: 120000 }, () => {
  it('连续失败登录真实触发 429，且不产生会话或审计副作用', async () => {
    const role = await prisma.role.create({
      data: { code: 'SEC_LIMIT', name: '限流验收', permissions: '["master:read"]' },
    });
    const user = await prisma.user.create({
      data: {
        username: 'sec_limit',
        displayName: '限流验收',
        roleId: role.id,
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    const sessions = await prisma.session.count({ where: { userId: user.id } });
    const logs = await prisma.auditLog.count({ where: { actorId: user.id } });
    // 独立 agent + 独立来源 IP，避免与其他用例共用 express-rate-limit 的 IP 计数。
    const agent = server.agent();
    const attempt = async () => {
      const response = await agent
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ username: 'sec_limit', password: 'Wrong-Limit@1' });
      return response;
    };
    let limited: Awaited<ReturnType<typeof attempt>> | undefined;
    let attempts = 0;
    for (; attempts < 90 && !limited; attempts += 1) {
      const response = await attempt();
      if (response.status === 429) limited = response;
      else expect(response.status).toBe(401);
    }
    expect(attempts).toBeGreaterThan(0);
    expect(limited, '登录失败次数应触发 429 限流').toBeTruthy();
    expect(limited!.body.error.code).toBe('LOGIN_RATE_LIMIT');
    expect(limited!.body.error.message).toContain('登录尝试过多');
    expect(limited!.headers['ratelimit'] ?? limited!.headers['ratelimit-policy']).toBeTruthy();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(sessions);
    expect(await prisma.auditLog.count({ where: { actorId: user.id } })).toBe(logs);
    // 限流只影响登录入口，已认证的只读接口不受牵连。
    expect((await api(clients.GUEST).get('/products')).status).toBe(200);
  });
});
