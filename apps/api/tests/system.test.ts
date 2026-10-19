import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { hash, compare } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { startTestServer, type TestServer } from './server.js';
let server: TestServer;
let admin: ReturnType<TestServer['agent']>;
let csrf = '',
  adminId = '',
  roleId = '',
  guestId = '',
  userId = '';
const write = (method: 'post' | 'patch', path: string, body: object) =>
  admin[method]('/api/v1' + path)
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', csrf)
    .send(body);
beforeAll(async () => {
  server = await startTestServer();
  admin = server.agent();
  const role = await prisma.role.upsert({
    where: { code: 'ADMIN' },
    create: { code: 'ADMIN', name: '管理员', permissions: '["*"]' },
    update: { permissions: '["*"]' },
  });
  const guest = await prisma.role.upsert({
    where: { code: 'GUEST' },
    create: { code: 'GUEST', name: '访客', permissions: '["master:read"]' },
    update: { permissions: '["master:read"]' },
  });
  guestId = guest.id;
  const sales = await prisma.role.upsert({
    where: { code: 'SALES' },
    create: { code: 'SALES', name: '销售', permissions: '["master:read"]' },
    update: {},
  });
  roleId = sales.id;
  const user = await prisma.user.upsert({
    where: { username: 'system_test_admin' },
    create: {
      username: 'system_test_admin',
      displayName: '系统验收管理员',
      roleId: role.id,
      passwordHash: await hash('Test@12345', 4),
    },
    update: {
      status: 'ACTIVE',
      roleId: role.id,
      passwordHash: await hash('Test@12345', 4),
    },
  });
  adminId = user.id;
  await prisma.user.deleteMany({ where: { username: 'system_test_user' } });
  const login = await write('post', '/auth/login', {
    username: 'system_test_admin',
    password: 'Test@12345',
  });
  csrf = login.body.data.csrfToken;
});
afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});
describe.sequential('系统管理真实API安全闭环', () => {
  it('未登录及普通角色拒绝系统数据', async () => {
    expect(
      (await request(server.server).get('/api/v1/system/users')).status,
    ).toBe(401);
    const guest = server.agent();
    await prisma.user.upsert({
      where: { username: 'system_test_guest' },
      create: {
        username: 'system_test_guest',
        displayName: '访客',
        roleId: guestId,
        passwordHash: await hash('Test@12345', 4),
      },
      update: { roleId: guestId },
    });
    await guest
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ username: 'system_test_guest', password: 'Test@12345' });
    for (const path of ['users', 'roles', 'audit-logs'])
      expect((await guest.get('/api/v1/system/' + path)).status).toBe(403);
  });
  it('登录校验期间密码发生改变时拒绝签发旧凭据会话', async () => {
    const raceUser = await prisma.user.upsert({
      where: { username: 'system_login_race' },
      create: {
        username: 'system_login_race',
        displayName: '登录并发验收',
        roleId: guestId,
        passwordHash: await hash('RaceOld@123', 4),
      },
      update: { passwordHash: await hash('RaceOld@123', 4) },
    });
    await prisma.session.deleteMany({ where: { userId: raceUser.id } });
    const nextHash = await hash('RaceNew@123', 4);
    const read = prisma.user.findUnique.bind(prisma.user);
    let changed = false;
    // Coordinate a real database change after the credential snapshot, without faking any result.
    const spy = vi
      .spyOn(
        prisma.user as unknown as {
          findUnique: (
            args: Parameters<typeof read>[0],
          ) => Promise<Awaited<ReturnType<typeof read>>>;
        },
        'findUnique',
      )
      .mockImplementation(async (args) => {
        const result = await read(args);
        if (!changed && args.where.username === 'system_login_race') {
          changed = true;
          await prisma.user.update({
            where: { id: raceUser.id },
            data: { passwordHash: nextHash },
          });
        }
        return result;
      });
    try {
      const result = await request(server.server)
        .post('/api/v1/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'system_login_race', password: 'RaceOld@123' });
      expect(result.status).toBe(401);
      expect(
        await prisma.session.count({ where: { userId: raceUser.id } }),
      ).toBe(0);
    } finally {
      spy.mockRestore();
      prisma.user.findUnique = read;
    }
  });
  it('新增、分页筛选、编辑用户，密码哈希不出接口', async () => {
    const created = await write('post', '/system/users', {
      username: 'system_test_user',
      displayName: '系统测试人员',
      password: 'Test@12345',
      roleId,
    });
    expect(created.status).toBe(201);
    userId = created.body.data.id;
    expect(JSON.stringify(created.body)).not.toMatch(/password|session|csrf/i);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(await compare('Test@12345', stored.passwordHash)).toBe(true);
    expect(
      (
        await write('patch', '/system/users/' + userId, {
          displayName: '编辑人员',
        })
      ).status,
    ).toBe(200);
    const rows = await admin.get(
      '/api/v1/system/users?q=system_test_user&pageSize=1',
    );
    expect(rows.body.data.total).toBe(1);
    expect(rows.body.data.items[0].displayName).toBe('编辑人员');
    expect(JSON.stringify(rows.body)).not.toMatch(/passwordHash|csrfToken/);
    expect(
      (
        await write('post', '/system/users', {
          username: 'system_test_user',
          displayName: '重复',
          password: 'Test@12345',
          roleId,
        })
      ).status,
    ).toBe(409);
  });
  it('拒绝额外字段、短密码、自停用及自改角色', async () => {
    expect(
      (await write('patch', '/system/users/' + userId, { passwordHash: 'x' }))
        .status,
    ).toBe(422);
    expect(
      (
        await write('post', `/system/users/${userId}/reset-password`, {
          password: '123',
        })
      ).status,
    ).toBe(422);
    expect(
      (await write('patch', '/system/users/' + adminId, { status: 'INACTIVE' }))
        .status,
    ).toBe(409);
    expect(
      (await write('patch', '/system/users/' + adminId, { roleId })).status,
    ).toBe(409);
  });
  it('停用、重置密码、改角色撤销既有Session', async () => {
    for (const update of [{ status: 'INACTIVE' }, { roleId: guestId }]) {
      await prisma.session.create({
        data: {
          id: 'sys-session-' + Object.keys(update)[0],
          csrfToken: 'x',
          userId,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      expect(
        (await write('patch', '/system/users/' + userId, update)).status,
      ).toBe(200);
      expect(await prisma.session.count({ where: { userId } })).toBe(0);
    }
    await prisma.session.create({
      data: {
        id: 'sys-session-password',
        csrfToken: 'x',
        userId,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    expect(
      (
        await write('post', `/system/users/${userId}/reset-password`, {
          password: 'Changed@12345',
        })
      ).status,
    ).toBe(200);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(
      await compare(
        'Changed@12345',
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
          .passwordHash,
      ),
    ).toBe(true);
  });
  it('ADMIN权限固定，GUEST只读，普通角色禁止提权，权限修改撤销会话', async () => {
    const roles = (await admin.get('/api/v1/system/roles')).body.data;
    expect(Array.isArray(roles)).toBe(true);
    const id = roles.find((r: { code: string }) => r.code === 'ADMIN').id;
    expect(
      (
        await write('patch', '/system/roles/' + id, {
          permissions: ['master:read'],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await write('patch', '/system/roles/' + guestId, {
          permissions: ['products:write'],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await write('patch', '/system/roles/' + roleId, {
          permissions: ['system:manage'],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await write('patch', '/system/roles/' + roleId, {
          permissions: ['unknown:read'],
        })
      ).status,
    ).toBe(422);
    await prisma.user.update({ where: { id: userId }, data: { roleId } });
    await prisma.session.create({
      data: {
        id: 'sys-role-session',
        csrfToken: 'x',
        userId,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    expect(
      (
        await write('patch', '/system/roles/' + roleId, {
          permissions: ['master:read', 'customers:write'],
        })
      ).status,
    ).toBe(200);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
  });
  it('日志按资源动作操作者筛选分页，敏感密码不进入审计', async () => {
    const logs = await admin.get('/api/v1/system/audit-logs').query({
      resource: 'users',
      action: 'RESET_PASSWORD',
      actorId: adminId,
      pageSize: 1,
    });
    expect(logs.status).toBe(200);
    expect(logs.body.data.items).toHaveLength(1);
    expect(logs.body.data.items[0].resourceId).toBe(userId);
    expect(JSON.stringify(logs.body)).not.toMatch(
      /Changed@123|Test@12345|passwordHash|csrfToken/,
    );
  });
  it('个人名称持久化，旧密码错误不变更，成功改密撤销全部会话', async () => {
    expect(
      (await write('patch', '/auth/profile', { displayName: '新的管理员' }))
        .status,
    ).toBe(200);
    expect(
      (await admin.get('/api/v1/auth/me')).body.data.user.displayName,
    ).toBe('新的管理员');
    expect(
      (
        await write('post', '/auth/password', {
          currentPassword: 'wrong',
          newPassword: 'Final@12345',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await write('post', '/auth/password', {
          currentPassword: 'Test@12345',
          newPassword: 'Final@12345',
        })
      ).status,
    ).toBe(200);
    expect((await admin.get('/api/v1/auth/me')).status).toBe(401);
  });
  it('并发管理员互相停用始终保留启用管理员，撤销败方会话', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });
    const second = await prisma.user.upsert({
      where: { username: 'system_test_admin2' },
      create: {
        username: 'system_test_admin2',
        displayName: '第二管理员',
        roleId: adminRole.id,
        passwordHash: await hash('Test@12345', 4),
      },
      update: { status: 'ACTIVE', roleId: adminRole.id },
    });
    const others = await prisma.user.findMany({
      where: { roleId: adminRole.id, id: { notIn: [adminId, second.id] } },
      select: { id: true, status: true },
    });
    await prisma.user.updateMany({
      where: { id: { in: others.map((u) => u.id) } },
      data: { status: 'INACTIVE' },
    });
    const rival = server.agent();
    try {
      const login = await write('post', '/auth/login', {
        username: 'system_test_admin',
        password: 'Final@12345',
      });
      csrf = login.body.data.csrfToken;
      const otherLogin = await rival
        .post('/api/v1/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'system_test_admin2', password: 'Test@12345' });
      const results = await Promise.all([
        write('patch', '/system/users/' + second.id, { status: 'INACTIVE' }),
        rival
          .patch('/api/v1/system/users/' + adminId)
          .set('Origin', 'http://localhost:5173')
          .set('X-CSRF-Token', otherLogin.body.data.csrfToken)
          .send({ status: 'INACTIVE' }),
      ]);
      expect(results.some((r) => r.status === 200)).toBe(true);
      expect(
        results.every((r) => [200, 401, 403, 409, 503].includes(r.status)),
      ).toBe(true);
      expect(
        await prisma.user.count({
          where: { roleId: adminRole.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      const loser = await prisma.user.findFirstOrThrow({
        where: { id: { in: [adminId, second.id] }, status: 'INACTIVE' },
      });
      expect(await prisma.session.count({ where: { userId: loser.id } })).toBe(
        0,
      );
    } finally {
      for (const user of others)
        await prisma.user.update({
          where: { id: user.id },
          data: { status: user.status },
        });
      await prisma.user.updateMany({
        where: { id: { in: [adminId, second.id] } },
        data: { status: 'ACTIVE' },
      });
    }
  });
});
