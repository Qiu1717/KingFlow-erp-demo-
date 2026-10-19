import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, ORIGIN, type TestServer } from './server.js';

const origin = ORIGIN;
let server: TestServer;
let admin: ReturnType<TestServer['agent']>;
let csrf = '';
let categoryId = '';
let productId = '';
const match = async (path: string) =>
  '"' +
  ((await admin.get(path)).body.data?.updatedAt ?? '1970-01-01T00:00:00.000Z') +
  '"';
beforeAll(async () => {
  server = await startTestServer();
  admin = server.agent();
  await cleanDatabase();
  const role = await prisma.role.create({
    data: { code: 'ADMIN', name: '管理员', permissions: '["*"]' },
  });
  await prisma.user.create({
    data: {
      username: 'admin',
      passwordHash: await hash('Test@12345', 4),
      displayName: '测试管理',
      roleId: role.id,
    },
  });
  const sales = await prisma.role.create({
    data: {
      code: 'SALES',
      name: '销售',
      permissions: '["master:read","customers:write"]',
    },
  });
  await prisma.user.create({
    data: {
      username: 'sales',
      passwordHash: await hash('Test@12345', 4),
      displayName: '销售',
      roleId: sales.id,
    },
  });
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});
describe.sequential('真实数据库认证与基础资料', () => {
  it('未登录拒绝访问', async () => {
    expect((await server.agent().get('/api/v1/products')).status).toBe(401);
  });
  it('拒绝跨源登录和错误密码', async () => {
    expect(
      (
        await server
          .agent()
          .post('/api/v1/auth/login')
          .set('Origin', 'https://evil.example')
          .send({ username: 'admin', password: 'Test@12345' })
      ).status,
    ).toBe(403);
    expect(
      (
        await server
          .agent()
          .post('/api/v1/auth/login')
          .set('Origin', origin)
          .send({ username: 'admin', password: 'wrong' })
      ).status,
    ).toBe(401);
  });
  it('登录持久化Session，me不暴露密码', async () => {
    const res = await admin
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: 'admin', password: 'Test@12345' });
    expect(res.status).toBe(200);
    csrf = res.body.data.csrfToken;
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect((await admin.get('/api/v1/auth/me')).body.data.user.username).toBe(
      'admin',
    );
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(await prisma.session.count()).toBe(1);
  });
  it('无CSRF或跨源变更拒绝', async () => {
    expect(
      (
        await admin
          .post('/api/v1/categories')
          .set('Origin', origin)
          .send({ code: 'C', name: '分类' })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin
          .post('/api/v1/categories')
          .set('Origin', 'https://evil.example')
          .set('X-CSRF-Token', csrf)
          .send({ code: 'C', name: '分类' })
      ).status,
    ).toBe(403);
  });
  it('分类新增并拒绝重复编码', async () => {
    const res = await admin
      .post('/api/v1/categories')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send({ code: 'C01', name: '测试分类' });
    expect(res.status).toBe(201);
    categoryId = res.body.data.id;
    expect(
      (
        await admin
          .post('/api/v1/categories')
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({ code: 'C01', name: '重复' })
      ).status,
    ).toBe(409);
  });
  it('非法输入、浮点分值和越界金额被拒绝', async () => {
    for (const purchasePrice of [-1, 1.5, 1000000001]) {
      expect(
        (
          await admin
            .post('/api/v1/products')
            .set('Origin', origin)
            .set('X-CSRF-Token', csrf)
            .send({
              code: 'P',
              name: '商品',
              categoryId,
              unit: '件',
              purchasePrice,
              salesPrice: 12000,
            })
        ).status,
      ).toBe(422);
    }
    expect(
      (
        await admin
          .post('/api/v1/customers')
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({ code: 'X', name: '', email: 'bad' })
      ).status,
    ).toBe(422);
  });
  it('商品创建、查询、修改、停用持久化', async () => {
    const res = await admin
      .post('/api/v1/products')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send({
        code: 'P01',
        name: '商品A',
        categoryId,
        unit: '件',
        purchasePrice: 8000,
        salesPrice: 12000,
      });
    expect(res.status).toBe(201);
    productId = res.body.data.id;
    const update = await admin
      .patch(`/api/v1/products/${productId}`)
      .set('If-Match', await match(`/api/v1/products/${productId}`))
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send({ name: '修改商品', salesPrice: 12345, status: 'INACTIVE' });
    expect(update.status).toBe(200);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .salesPrice,
    ).toBe(12345);
    const list = await admin.get(
      '/api/v1/products?q=修改&status=INACTIVE&pageSize=1&sortBy=code&sortOrder=asc',
    );
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0].id).toBe(productId);
    expect(
      (await admin.get(`/api/v1/products/${productId}`)).body.data.name,
    ).toBe('修改商品');
  });
  it('分类引用保护且不存在资源404', async () => {
    expect(
      (
        await admin
          .delete(`/api/v1/categories/${categoryId}`)
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
      ).status,
    ).toBe(409);
    expect(
      (
        await admin
          .patch('/api/v1/products/missing')
          .set('If-Match', await match('/api/v1/products/missing'))
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({ name: 'x' })
      ).status,
    ).toBe(404);
  });
  it.each(['customers', 'suppliers', 'warehouses'])(
    '%s CRUD与持久化',
    async (resource) => {
      const res = await admin
        .post(`/api/v1/${resource}`)
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf)
        .send({ code: 'TEST01', name: '测试对象' });
      expect(res.status).toBe(201);
      const id = res.body.data.id;
      expect(
        (
          await admin
            .patch(`/api/v1/${resource}/${id}`)
            .set('If-Match', await match(`/api/v1/${resource}/${id}`))
            .set('Origin', origin)
            .set('X-CSRF-Token', csrf)
            .send({ name: '更新对象', status: 'INACTIVE' })
        ).status,
      ).toBe(200);
      expect(
        (await admin.get(`/api/v1/${resource}/${id}`)).body.data.status,
      ).toBe('INACTIVE');
      expect(
        (
          await admin
            .delete(`/api/v1/${resource}/${id}`)
            .set('Origin', origin)
            .set('X-CSRF-Token', csrf)
        ).status,
      ).toBe(200);
    },
  );
  it('CSV含BOM与公式防护', async () => {
    await admin
      .patch(`/api/v1/products/${productId}`)
      .set('If-Match', await match(`/api/v1/products/${productId}`))
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send({ name: '=HYPERLINK("bad")' });
    const res = await admin.get('/api/v1/products/export.csv');
    expect(res.status).toBe(200);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain("'=HYPERLINK");
  });
  it('销售不能维护商品、可维护客户，越权无写入', async () => {
    const agent = server.agent();
    const login = await agent
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: 'sales', password: 'Test@12345' });
    const token = login.body.data.csrfToken;
    expect(
      (
        await agent
          .post('/api/v1/products')
          .set('Origin', origin)
          .set('X-CSRF-Token', token)
          .send({})
      ).status,
    ).toBe(403);
    expect((await agent.get('/api/v1/products')).status).toBe(200);
    expect(
      (
        await agent
          .post('/api/v1/customers')
          .set('Origin', origin)
          .set('X-CSRF-Token', token)
          .send({ code: 'SALESC', name: '客户' })
      ).status,
    ).toBe(201);
    await prisma.user.update({
      where: { username: 'sales' },
      data: { status: 'INACTIVE' },
    });
    expect((await agent.get('/api/v1/products')).status).toBe(401);
  });
  it('主数据统计真实，审计不含敏感信息', async () => {
    expect(
      (await admin.get('/api/v1/dashboard/summary')).body.data.products,
    ).toBe(await prisma.product.count());
    expect(await prisma.auditLog.count()).toBeGreaterThan(5);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(
      'Test@12345',
    );
  });
  it('列表拒绝越界分页、任意排序和额外查询参数', async () => {
    for (const query of [
      'page=0',
      'pageSize=1000',
      'sortBy=passwordHash',
      'status=APPROVED',
      'unknown=x',
    ])
      expect((await admin.get(`/api/v1/products?${query}`)).status).toBe(422);
    const res = await admin.get('/api/v1/products?q=不存在的商品&pageSize=1');
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });
  it('商品重复编码冲突，未引用商品及分类允许删除', async () => {
    const input = {
      code: 'TMP-P',
      name: '临时商品',
      categoryId,
      unit: '件',
      purchasePrice: 1,
      salesPrice: 2,
    };
    const res = await admin
      .post('/api/v1/products')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send(input);
    expect(res.status).toBe(201);
    expect(
      (
        await admin
          .post('/api/v1/products')
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send(input)
      ).status,
    ).toBe(409);
    expect(
      (
        await admin
          .delete(`/api/v1/products/${res.body.data.id}`)
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
      ).status,
    ).toBe(200);
    const cat = await admin
      .post('/api/v1/categories')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send({ code: 'TMP-CAT', name: '临时分类' });
    expect(
      (
        await admin
          .patch(`/api/v1/categories/${cat.body.data.id}`)
          .set(
            'If-Match',
            await match(`/api/v1/categories/${cat.body.data.id}`),
          )
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({ name: '新名称' })
      ).body.data.name,
    ).toBe('新名称');
    expect(
      (
        await admin
          .delete(`/api/v1/categories/${cat.body.data.id}`)
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
      ).status,
    ).toBe(200);
  });
  it('停用分类不能新建商品，已有商品可以保留分类编辑', async () => {
    await admin
      .patch(`/api/v1/categories/${categoryId}`)
      .set('If-Match', await match(`/api/v1/categories/${categoryId}`))
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'INACTIVE' });
    expect(
      (
        await admin
          .post('/api/v1/products')
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({
            code: 'BAD-CAT-P',
            name: '禁用分类商品',
            categoryId,
            unit: '件',
            purchasePrice: 1,
            salesPrice: 2,
          })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin
          .patch(`/api/v1/products/${productId}`)
          .set('If-Match', await match(`/api/v1/products/${productId}`))
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({ categoryId, name: '保留分类编辑' })
      ).status,
    ).toBe(200);
  });
  it('错误安全令牌、缺少来源被拒绝且无写入', async () => {
    const before = await prisma.customer.count();
    expect(
      (
        await admin
          .post('/api/v1/customers')
          .set('Origin', origin)
          .set('X-CSRF-Token', 'f'.repeat(64))
          .send({ code: 'FORGED', name: '失败' })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin
          .post('/api/v1/customers')
          .set('X-CSRF-Token', csrf)
          .send({ code: 'FORGED', name: '失败' })
      ).status,
    ).toBe(403);
    expect(await prisma.customer.count()).toBe(before);
  });
  it('退出撤销会话', async () => {
    expect(
      (
        await admin
          .post('/api/v1/auth/logout')
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
      ).status,
    ).toBe(200);
    expect((await admin.get('/api/v1/auth/me')).status).toBe(401);
  });
  it('登录接口实施限流并返回中文错误', async () => {
    let status = 0;
    let message = '';
    for (let i = 0; i < 61; i++) {
      const res = await server
        .agent()
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send({ username: 'admin', password: 'wrong' });
      status = res.status;
      message = res.body.error.message;
    }
    expect(status).toBe(429);
    expect(message).toContain('登录尝试过多');
  });
});
