import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { compare, hash } from 'bcryptjs';
import { prisma } from '../src/repositories/db.js';
import { cleanDatabase } from './helpers.js';
import { startTestServer, ORIGIN, type TestServer } from './server.js';

/**
 * 系统管理企业场景：用户 CRUD、角色权限、最后管理员保护、审计查询与脱敏、个人设置。
 * 全部断言落在真实 HTTP 与真实数据库（bcrypt 哈希、Session 行、AuditLog 行）。
 */
const PASSWORD = 'Sys@Test123';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const yesterday = () =>
  new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);

type Agent = ReturnType<TestServer['agent']>;
interface Client {
  agent: Agent;
  csrf: string;
  userId: string;
}
let server: TestServer;
let admin: Client;
let adminId = '';
const roleIds: Record<string, string> = {};

async function signIn(username: string, password = PASSWORD) {
  const agent = server.agent();
  const response = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password });
  return { agent, response };
}

function api(client: Client) {
  return {
    get: (path: string, query?: object) => {
      let test = client.agent.get('/api/v1' + path).set('Origin', ORIGIN);
      if (query) test = test.query(query);
      return test;
    },
    post: (
      path: string,
      body: object = {},
      headers: Record<string, string> = {},
    ) => {
      let test = client.agent
        .post('/api/v1' + path)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', client.csrf);
      for (const [name, value] of Object.entries(headers)) test = test.set(name, value);
      return test.send(body);
    },
    patch: (path: string, body: object = {}) =>
      client.agent
        .patch('/api/v1' + path)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', client.csrf)
        .send(body),
    del: (path: string) =>
      client.agent
        .delete('/api/v1' + path)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', client.csrf),
  };
}

const SECRET_PATTERN = /passwordHash|password_hash|csrfToken|kf_session|Sys@Test123/i;
/** 登录/me 必须返回 csrfToken，但绝不能回传密码摘要或会话令牌明文。 */
const CREDENTIAL_PATTERN = /passwordHash|password_hash|kf_session|Sys@Test123/i;
function expectNoSecret(body: unknown) {
  expect(JSON.stringify(body)).not.toMatch(SECRET_PATTERN);
}
function expectNoCredentials(body: unknown) {
  expect(JSON.stringify(body)).not.toMatch(CREDENTIAL_PATTERN);
}

async function createUser(
  username: string,
  roleCode = 'GUEST',
  password = PASSWORD,
) {
  const response = await api(admin).post('/system/users', {
    username,
    displayName: `系统${username}`,
    password,
    roleId: roleIds[roleCode],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; username: string };
}

beforeAll(async () => {
  server = await startTestServer();
  await cleanDatabase();
  const definitions = [
    ['ADMIN', '系统管理员', ['*']],
    ['PURCHASE', '采购人员', ['master:read', 'purchase:read']],
    ['SALES', '销售人员', ['master:read', 'sales:read']],
    ['WAREHOUSE', '仓库人员', ['master:read', 'inventory:read']],
    ['FINANCE', '财务人员', ['master:read', 'finance:read']],
    ['GUEST', '只读访客', ['master:read']],
  ] as const;
  for (const [code, name, permissions] of definitions) {
    const role = await prisma.role.create({
      data: { code, name, permissions: JSON.stringify(permissions) },
    });
    roleIds[code] = role.id;
  }
  const adminUser = await prisma.user.create({
    data: {
      username: 'sys_admin',
      displayName: '系统验收管理员',
      roleId: roleIds.ADMIN,
      passwordHash: await hash(PASSWORD, 4),
    },
  });
  adminId = adminUser.id;
  const login = await signIn('sys_admin');
  expect(login.response.status).toBe(200);
  admin = {
    agent: login.agent,
    csrf: login.response.body.data.csrfToken,
    userId: adminId,
  };
});

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
});

describe.sequential('用户管理：校验、持久化与不可越权字段', { timeout: 120000 }, () => {
  it('新增用户拒绝非法账号、弱密码、超72字节密码、额外字段与不存在角色，且不落库', async () => {
    const userCount = () => prisma.user.count();
    const before = await userCount();
    const invalid: [string, object][] = [
      ['缺字段', { username: 'sys_missing' }],
      ['账号过短', { username: 'ab', displayName: '短账号', password: PASSWORD, roleId: roleIds.GUEST }],
      ['账号含非法字符', { username: 'sys bad name', displayName: '非法账号', password: PASSWORD, roleId: roleIds.GUEST }],
      ['账号过长', { username: 'a'.repeat(61), displayName: '超长账号', password: PASSWORD, roleId: roleIds.GUEST }],
      ['显示名为空', { username: 'sys_blank', displayName: '   ', password: PASSWORD, roleId: roleIds.GUEST }],
      ['密码过短', { username: 'sys_weak', displayName: '弱密码', password: '1234567', roleId: roleIds.GUEST }],
      ['密码超过72字节', { username: 'sys_bytes', displayName: '长密码', password: '密'.repeat(25), roleId: roleIds.GUEST }],
      ['注入passwordHash', { username: 'sys_hash', displayName: '越权字段', password: PASSWORD, roleId: roleIds.GUEST, passwordHash: 'x' }],
      ['注入status非法值', { username: 'sys_status', displayName: '非法状态', password: PASSWORD, roleId: roleIds.GUEST, status: 'DELETED' }],
      ['角色不存在', { username: 'sys_role', displayName: '角色不存在', password: PASSWORD, roleId: 'not-a-role' }],
      ['角色为空', { username: 'sys_role2', displayName: '角色为空', password: PASSWORD, roleId: '' }],
    ];
    for (const [label, body] of invalid) {
      const response = await api(admin).post('/system/users', body);
      expect(response.status, `${label} -> ${JSON.stringify(response.body)}`).toBe(422);
      expectNoSecret(response.body);
    }
    expect(await userCount()).toBe(before);
    expect(
      await prisma.auditLog.count({ where: { action: 'CREATE', resource: 'users' } }),
    ).toBe(0);
  });

  it('72字节边界密码可创建并可登录，密码以 bcrypt 哈希落库且接口不回传', async () => {
    const exact = '密'.repeat(24); // 24 个汉字 = 72 字节，正好等于 bcrypt 上限
    expect(Buffer.byteLength(exact, 'utf8')).toBe(72);
    const response = await api(admin).post('/system/users', {
      username: 'sys_72bytes',
      displayName: '边界密码',
      password: exact,
      roleId: roleIds.GUEST,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expectNoCredentials(response.body);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { username: 'sys_72bytes' },
    });
    expect(stored.passwordHash).not.toBe(exact);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await compare(exact, stored.passwordHash)).toBe(true);
    const login = await signIn('sys_72bytes', exact);
    expect(login.response.status).toBe(200);
    expectNoCredentials(login.response.body);
    expect(login.response.body.data.csrfToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('用户名重复返回可读的 409（不是基础资料的「编码」提示）且不产生第二个用户', async () => {
    await createUser('sys_dup');
    const before = await prisma.user.count({ where: { username: 'sys_dup' } });
    const duplicate = await api(admin).post('/system/users', {
      username: 'sys_dup',
      displayName: '重复账号',
      password: PASSWORD,
      roleId: roleIds.SALES,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toMatch(/DUPLICATE|USERNAME/);
    expect(duplicate.body.error.message).toContain('登录账号');
    expect(duplicate.body.error.message).not.toContain('编码');
    expect(await prisma.user.count({ where: { username: 'sys_dup' } })).toBe(before);
  });

  it('编辑仅接受显示名称/角色/状态，用户名与密码字段被拒绝，未知用户 404', async () => {
    const user = await createUser('sys_edit');
    const target = () =>
      prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    for (const [label, body] of [
      ['改用户名', { username: 'sys_edit2' }],
      ['改密码', { password: 'Another@12345' }],
      ['写哈希', { passwordHash: 'x' }],
      ['空变更', {}],
    ] as [string, object][]) {
      const response = await api(admin).patch(`/system/users/${user.id}`, body);
      expect(response.status, `${label} -> ${JSON.stringify(response.body)}`).toBe(422);
    }
    expect((await target()).username).toBe('sys_edit');
    const missing = await api(admin).patch('/system/users/not-exist', {
      displayName: '不存在',
    });
    expect(missing.status).toBe(404);
    // 管理员不能通过 API 删除用户，避免破坏审计与业务外键。
    const removed = await api(admin).del(`/system/users/${user.id}`);
    expect(removed.status).toBe(404);
    expect(await target()).toBeTruthy();
  });

  it('列表按账号/名称/状态/角色筛选并分页，响应不含密码摘要', async () => {
    await createUser('sys_filter_a', 'SALES');
    await createUser('sys_filter_b', 'SALES');
    const byKeyword = await api(admin).get('/system/users', {
      q: 'sys_filter',
      pageSize: 1,
    });
    expect(byKeyword.status).toBe(200);
    expect(byKeyword.body.data.total).toBe(2);
    expect(byKeyword.body.data.items).toHaveLength(1);
    expect(byKeyword.body.data.pageSize).toBe(1);
    const second = await api(admin).get('/system/users', {
      q: 'sys_filter',
      pageSize: 1,
      page: 2,
    });
    expect(second.body.data.items[0].id).not.toBe(byKeyword.body.data.items[0].id);
    const byRole = await api(admin).get('/system/users', {
      roleId: roleIds.SALES,
      pageSize: 100,
    });
    expect(byRole.body.data.items.length).toBeGreaterThanOrEqual(2);
    expect(
      byRole.body.data.items.every(
        (row: { roleId: string }) => row.roleId === roleIds.SALES,
      ),
    ).toBe(true);
    const byStatus = await api(admin).get('/system/users', {
      status: 'INACTIVE',
      pageSize: 100,
    });
    expect(
      byStatus.body.data.items.every(
        (row: { status: string }) => row.status === 'INACTIVE',
      ),
    ).toBe(true);
    expectNoSecret(byKeyword.body);
    expectNoSecret(byRole.body);
    for (const query of [{ page: 0 }, { pageSize: 101 }, { status: 'DELETED' }]) {
      expect((await api(admin).get('/system/users', query)).status, JSON.stringify(query)).toBe(422);
    }
  });

  it('停用与改角色立即撤销目标账号全部会话，用户请求返回 401', async () => {
    const user = await createUser('sys_revoke', 'SALES');
    const first = await signIn('sys_revoke');
    const second = await signIn('sys_revoke');
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(
      (await first.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(200);
    expect(
      (
        await api(admin).patch(`/system/users/${user.id}`, { status: 'INACTIVE' })
      ).status,
    ).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    for (const client of [first, second]) {
      const denied = await client.agent
        .get('/api/v1/auth/me')
        .set('Origin', ORIGIN);
      expect(denied.status).toBe(401);
    }
    // 启用后重新登录，改角色同样撤销会话。
    expect(
      (
        await api(admin).patch(`/system/users/${user.id}`, { status: 'ACTIVE' })
      ).status,
    ).toBe(200);
    const relogin = await signIn('sys_revoke');
    expect(relogin.response.status).toBe(200);
    expect(
      (
        await api(admin).patch(`/system/users/${user.id}`, {
          roleId: roleIds.WAREHOUSE,
        })
      ).status,
    ).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(
      (await relogin.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(401);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId,
    ).toBe(roleIds.WAREHOUSE);
    // 角色变更后的新权限真实生效。
    const next = await signIn('sys_revoke');
    expect(
      (await next.agent.get('/api/v1/stocks').set('Origin', ORIGIN)).status,
    ).toBe(200);
    expect(
      (await next.agent.get('/api/v1/sales-orders').set('Origin', ORIGIN)).status,
    ).toBe(403);
  });

  it('管理员重置密码撤销目标会话，旧密码失效、新密码可登录；重置自己与不存在用户被拒', async () => {
    const user = await createUser('sys_reset');
    const victim = await signIn('sys_reset');
    expect(victim.response.status).toBe(200);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const self = await api(admin).post(`/system/users/${adminId}/reset-password`, {
      password: 'Another@12345',
    });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_PASSWORD');
    const missing = await api(admin).post(
      '/system/users/not-exist/reset-password',
      { password: 'Another@12345' },
    );
    expect(missing.status).toBe(404);
    const weak = await api(admin).post(`/system/users/${user.id}/reset-password`, {
      password: '123',
    });
    expect(weak.status).toBe(422);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
    ).toBe(before.passwordHash);

    const reset = await api(admin).post(`/system/users/${user.id}/reset-password`, {
      password: 'Reset@123456',
    });
    expect(reset.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(
      (await victim.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(401);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(await compare('Reset@123456', after.passwordHash)).toBe(true);
    expect(await compare(PASSWORD, after.passwordHash)).toBe(false);
    expect((await signIn('sys_reset', PASSWORD)).response.status).toBe(401);
    expect((await signIn('sys_reset', 'Reset@123456')).response.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'RESET_PASSWORD', resource: 'users', resourceId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
  });
});

describe.sequential('自身与最后管理员保护', { timeout: 120000 }, () => {
  it('管理员不能停用自己或修改自己的角色，只能改自己的显示名称', async () => {
    const disable = await api(admin).patch(`/system/users/${adminId}`, {
      status: 'INACTIVE',
    });
    expect(disable.status).toBe(409);
    expect(disable.body.error.code).toBe('SELF_LOCKOUT');
    const role = await api(admin).patch(`/system/users/${adminId}`, {
      roleId: roleIds.GUEST,
    });
    expect(role.status).toBe(409);
    expect(role.body.error.code).toBe('SELF_LOCKOUT');
    const stillAdmin = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(stillAdmin.status).toBe('ACTIVE');
    expect(stillAdmin.roleId).toBe(roleIds.ADMIN);
    expect(
      (await api(admin).patch(`/system/users/${adminId}`, { displayName: '系统验收管理员2' }))
        .status,
    ).toBe(200);
    expect(
      (await api(admin).patch(`/system/users/${adminId}`, { roleId: roleIds.ADMIN }))
        .status,
    ).toBe(200);
  });

  it('最后一名启用管理员不可被消除：并发互停后仍恰好一名启用管理员', async () => {
    const second = await prisma.user.create({
      data: {
        username: 'sys_admin2',
        displayName: '第二管理员',
        roleId: roleIds.ADMIN,
        passwordHash: await hash(PASSWORD, 4),
      },
    });
    // 其余管理员（如其他测试残留）先停用，确保场景只有两名启用管理员。
    await prisma.user.updateMany({
      where: {
        roleId: roleIds.ADMIN,
        id: { notIn: [adminId, second.id] },
        status: 'ACTIVE',
      },
      data: { status: 'INACTIVE' },
    });
    const rival = await signIn('sys_admin2');
    expect(rival.response.status).toBe(200);
    const rivalClient: Client = {
      agent: rival.agent,
      csrf: rival.response.body.data.csrfToken,
      userId: second.id,
    };
    const results = await Promise.all([
      api(admin).patch(`/system/users/${second.id}`, { status: 'INACTIVE' }),
      api(rivalClient).patch(`/system/users/${adminId}`, { status: 'INACTIVE' }),
    ]);
    expect(results.map((response) => response.status)).toContain(200);
    expect(
      await prisma.user.count({ where: { roleId: roleIds.ADMIN, status: 'ACTIVE' } }),
    ).toBe(1);
    const survivor = await prisma.user.findFirstOrThrow({
      where: { roleId: roleIds.ADMIN, status: 'ACTIVE' },
    });
    const loser = await prisma.user.findFirstOrThrow({
      where: { id: { in: [adminId, second.id] }, status: 'INACTIVE' },
    });
    expect(await prisma.session.count({ where: { userId: loser.id } })).toBe(0);
    // 幸存管理员仍然可用，且再次尝试自停用被拒。
    const survivorLogin = await signIn(survivor.username);
    expect(survivorLogin.response.status).toBe(200);
    const survivorClient: Client = {
      agent: survivorLogin.agent,
      csrf: survivorLogin.response.body.data.csrfToken,
      userId: survivor.id,
    };
    const selfDisable = await api(survivorClient).patch(
      `/system/users/${survivor.id}`,
      { status: 'INACTIVE' },
    );
    expect(selfDisable.status).toBe(409);
    expect(
      await prisma.user.count({ where: { roleId: roleIds.ADMIN, status: 'ACTIVE' } }),
    ).toBe(1);
    // 恢复主管理员并重新登录，供后续用例使用。
    await prisma.user.update({
      where: { id: adminId },
      data: { status: 'ACTIVE' },
    });
    await prisma.user.update({
      where: { id: second.id },
      data: { status: 'INACTIVE' },
    });
    const restored = await signIn('sys_admin');
    expect(restored.response.status).toBe(200);
    admin = {
      agent: restored.agent,
      csrf: restored.response.body.data.csrfToken,
      userId: adminId,
    };
  });
});

describe.sequential('角色权限编辑', { timeout: 120000 }, () => {
  it('管理员角色必须保留 *，非管理员不能获得 * 或 system:manage，访客只能只读', async () => {
    const roles = (await api(admin).get('/system/roles')).body.data as {
      id: string;
      code: string;
      permissions: string[];
    }[];
    const adminRole = roles.find((role) => role.code === 'ADMIN')!;
    const guestRole = roles.find((role) => role.code === 'GUEST')!;
    const salesRole = roles.find((role) => role.code === 'SALES')!;
    for (const permissions of [[], ['master:read'], ['*', 'master:read']]) {
      const response = await api(admin).patch(`/system/roles/${adminRole.id}`, {
        permissions,
      });
      expect(response.status, JSON.stringify(permissions)).toBe(409);
      expect(response.body.error.code).toBe('ADMIN_PROTECTED');
    }
    expect(
      (await prisma.role.findUniqueOrThrow({ where: { id: adminRole.id } })).permissions,
    ).toBe('["*"]');
    for (const permissions of [
      ['*'],
      ['master:read', 'system:manage'],
      ['products:write'],
      ['master:read', 'products:write'],
    ]) {
      const response = await api(admin).patch(`/system/roles/${guestRole.id}`, {
        permissions,
      });
      expect(response.status, JSON.stringify(permissions)).toBe(422);
      expect(response.body.error.code).toBe('INVALID_PERMISSION');
    }
    for (const permissions of [
      ['*'],
      ['master:read', 'unknown:read'],
      ['master:read', 123],
    ]) {
      const response = await api(admin).patch(`/system/roles/${salesRole.id}`, {
        permissions,
      });
      expect(response.status, JSON.stringify(permissions)).toBe(422);
    }
    const missing = await api(admin).patch('/system/roles/not-exist', {
      permissions: ['master:read'],
    });
    expect(missing.status).toBe(404);
    expect(
      (await prisma.role.findUniqueOrThrow({ where: { id: guestRole.id } })).permissions,
    ).toBe('["master:read"]');
  });

  it('权限未变化时保存不撤销会话；真实变更会撤销该角色全部会话并写审计', async () => {
    const user = await createUser('sys_roleuser', 'WAREHOUSE');
    const session = await signIn('sys_roleuser');
    expect(session.response.status).toBe(200);
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'WAREHOUSE' },
    });
    const unchanged = await api(admin).patch(`/system/roles/${role.id}`, {
      permissions: JSON.parse(role.permissions),
    });
    expect(unchanged.status).toBe(200);
    expect(
      await prisma.session.count({ where: { userId: user.id } }),
      '权限未变更时不应撤销会话',
    ).toBe(1);
    expect(
      (await session.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(200);

    const changed = await api(admin).patch(`/system/roles/${role.id}`, {
      permissions: ['master:read', 'inventory:read', 'inventory:adjust'],
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data.permissions).toEqual([
      'master:read',
      'inventory:read',
      'inventory:adjust',
    ]);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(
      (await session.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
    ).toBe(401);
    expect(
      (
        await prisma.role.findUniqueOrThrow({ where: { id: role.id } })
      ).permissions,
    ).toBe('["master:read","inventory:read","inventory:adjust"]');
    expect(
      await prisma.auditLog.count({
        where: { action: 'UPDATE_PERMISSIONS', resource: 'roles', resourceId: role.id },
      }),
    ).toBe(1);
    // 新权限真实生效：库存调整放开、采购查询被收回。
    const relogin = await signIn('sys_roleuser');
    expect(
      (await relogin.agent.get('/api/v1/stocks').set('Origin', ORIGIN)).status,
    ).toBe(200);
    expect(
      (await relogin.agent.get('/api/v1/purchase-orders').set('Origin', ORIGIN)).status,
    ).toBe(403);
    // 恢复仓库角色默认权限，避免影响其他用例。
    await api(admin).patch(`/system/roles/${role.id}`, {
      permissions: [
        'master:read',
        'purchase:read',
        'receipts:read',
        'receipts:post',
        'sales:read',
        'shipments:read',
        'shipments:post',
        'inventory:read',
        'inventory:adjust',
      ],
    });
  });

  it('保存管理员角色自身未变更权限时，不会踢掉当前管理员会话', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });
    const before = await prisma.session.count({ where: { userId: adminId } });
    const response = await api(admin).patch(`/system/roles/${adminRole.id}`, {
      permissions: ['*'],
    });
    expect(response.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: adminId } })).toBe(before);
    expect(
      (await api(admin).get('/auth/me')).status,
      '保存未变更的管理员权限不应让操作者掉线',
    ).toBe(200);
  });
});

describe.sequential('审计日志：过滤、分页、日期与脱敏', { timeout: 120000 }, () => {
  it('按资源/动作/操作者过滤并分页，页间不重复', async () => {
    const filter = { resource: 'users', action: 'RESET_PASSWORD', actorId: adminId };
    const all = await api(admin).get('/system/audit-logs', {
      ...filter,
      pageSize: 100,
    });
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBeGreaterThanOrEqual(1);
    expect(
      all.body.data.items.every(
        (row: { resource: string; action: string; actorId: string }) =>
          row.resource === 'users' &&
          row.action === 'RESET_PASSWORD' &&
          row.actorId === adminId,
      ),
    ).toBe(true);
    const firstPage = await api(admin).get('/system/audit-logs', {
      ...filter,
      pageSize: 1,
      page: 1,
    });
    const secondPage = await api(admin).get('/system/audit-logs', {
      ...filter,
      pageSize: 1,
      page: 2,
    });
    expect(firstPage.body.data.items).toHaveLength(1);
    if (all.body.data.total > 1) {
      expect(secondPage.body.data.items[0].id).not.toBe(
        firstPage.body.data.items[0].id,
      );
    }
    const unknownActor = await api(admin).get('/system/audit-logs', {
      actorId: 'not-exist',
    });
    expect(unknownActor.body.data.total).toBe(0);
    expect(unknownActor.body.data.items).toEqual([]);
    // 审计响应含操作者名称但不含任何凭据。
    expect(all.body.data.items[0].actor.username).toBe('sys_admin');
    expectNoSecret(all.body);
  });

  it('日期筛选按上海自然日包含首尾两天，非法日期与倒置区间返回 422', async () => {
    const created = await createUser('sys_audit_day');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { resource: 'users', resourceId: created.id, action: 'CREATE' },
    });
    // 构造昨天与明天的审计记录，验证半开区间边界。
    const yesterdayRow = await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: 'AUDIT_BOUNDARY',
        resource: 'users',
        resourceId: 'boundary-yesterday',
        createdAt: new Date(`${yesterday()}T23:59:59+08:00`),
      },
    });
    const tomorrowRow = await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: 'AUDIT_BOUNDARY',
        resource: 'users',
        resourceId: 'boundary-tomorrow',
        createdAt: new Date(`${today()}T23:59:59+08:00`),
      },
    });
    const onlyToday = await api(admin).get('/system/audit-logs', {
      action: 'AUDIT_BOUNDARY',
      from: today(),
      to: today(),
      pageSize: 100,
    });
    expect(onlyToday.status).toBe(200);
    expect(onlyToday.body.data.items.map((row: { id: string }) => row.id)).toEqual([
      tomorrowRow.id,
    ]);
    const onlyYesterday = await api(admin).get('/system/audit-logs', {
      action: 'AUDIT_BOUNDARY',
      from: yesterday(),
      to: yesterday(),
      pageSize: 100,
    });
    expect(
      onlyYesterday.body.data.items.map((row: { id: string }) => row.id),
    ).toEqual([yesterdayRow.id]);
    // 无日期条件时两条边界记录都返回，证明筛选而非数据缺失。
    const all = await api(admin).get('/system/audit-logs', {
      action: 'AUDIT_BOUNDARY',
      pageSize: 100,
    });
    expect(all.body.data.total).toBe(2);
    expect(audit.resourceId).toBe(created.id);
    // 日期筛选不得改变总数口径以外的记录（昨天不在今天范围内）。
    expect(onlyToday.body.data.total).toBe(1);
    expect(onlyYesterday.body.data.total).toBe(1);
    for (const query of [
      { from: '2026-02-30' },
      { from: '2026-13-01' },
      { from: '2026-1-1' },
      { from: today(), to: yesterday() },
      { page: 0 },
      { pageSize: 101 },
    ]) {
      const response = await api(admin).get('/system/audit-logs', query);
      expect(response.status, JSON.stringify(query)).toBe(422);
    }
  });

  it('审计只记录动作与目标，不保存密码、哈希、CSRF 或会话令牌', async () => {
    const rows = await prisma.auditLog.findMany();
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(SECRET_PATTERN);
    expect(text).not.toContain('Reset@123456');
    expect(text).not.toContain('Another@12345');
    // 审计接口同样不得回传上述内容。
    const response = await api(admin).get('/system/audit-logs', { pageSize: 100 });
    expect(response.status).toBe(200);
    expectNoSecret(response.body);
    expect(JSON.stringify(response.body)).not.toContain('Reset@123456');
    // 会话表只保存令牌摘要（64位十六进制），绝不保存明文令牌。
    const sessions = await prisma.session.findMany();
    for (const session of sessions) {
      expect(session.id).toMatch(/^[a-f0-9]{64}$/);
      expect(session.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe.sequential('个人设置：显示名称与改密', { timeout: 120000 }, () => {
  it('显示名称持久化到数据库并写入审计，非法值被拒绝', async () => {
    const user = await createUser('sys_profile');
    const login = await signIn('sys_profile');
    const client: Client = {
      agent: login.agent,
      csrf: login.response.body.data.csrfToken,
      userId: user.id,
    };
    const saved = await api(client).patch('/auth/profile', { displayName: '个人设置新名称' });
    expect(saved.status).toBe(200);
    expect(saved.body.data.displayName).toBe('个人设置新名称');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).displayName,
    ).toBe('个人设置新名称');
    expect((await api(client).get('/auth/me')).body.data.user.displayName).toBe(
      '个人设置新名称',
    );
    expect(
      await prisma.auditLog.count({
        where: { action: 'UPDATE_PROFILE', resource: 'users', resourceId: user.id },
      }),
    ).toBe(1);
    for (const body of [
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(61) },
      { displayName: '合法', status: 'INACTIVE' },
      { displayName: '合法', roleId: roleIds.ADMIN },
    ]) {
      const response = await api(client).patch('/auth/profile', body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).displayName,
    ).toBe('个人设置新名称');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roleId,
    ).toBe(roleIds.GUEST);
  });

  it('改密必须验证旧密码：错误旧密码不改库、不撤销会话，正确后撤销全部会话并失效旧密码', async () => {
    const user = await createUser('sys_password');
    const first = await signIn('sys_password');
    const second = await signIn('sys_password');
    const client: Client = {
      agent: first.agent,
      csrf: first.response.body.data.csrfToken,
      userId: user.id,
    };
    const original = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);

    for (const body of [
      { currentPassword: 'Wrong-Old@1', newPassword: 'Changed@12345' },
      { currentPassword: PASSWORD, newPassword: '123' },
      { currentPassword: PASSWORD, newPassword: '密'.repeat(25) },
      { currentPassword: PASSWORD },
      { currentPassword: PASSWORD, newPassword: 'Changed@12345', extra: 1 },
    ]) {
      const response = await api(client).post('/auth/password', body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
      ).toBe(original.passwordHash);
    }
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);
    expect((await api(client).get('/auth/me')).status).toBe(200);

    const changed = await api(client).post('/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'Changed@12345',
    });
    expect(changed.status).toBe(200);
    const cleared = changed.headers['set-cookie'] as unknown as string[];
    expect(cleared.join(';')).toMatch(/kf_session=;/);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.passwordHash).not.toBe(original.passwordHash);
    expect(await compare('Changed@12345', updated.passwordHash)).toBe(true);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    for (const session of [first, second]) {
      expect(
        (await session.agent.get('/api/v1/auth/me').set('Origin', ORIGIN)).status,
      ).toBe(401);
    }
    expect((await signIn('sys_password', PASSWORD)).response.status).toBe(401);
    expect((await signIn('sys_password', 'Changed@12345')).response.status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { action: 'CHANGE_PASSWORD', resource: 'users', resourceId: user.id },
      }),
    ).toBe(1);
  });
});

describe.sequential('系统管理接口一致性与别名', { timeout: 120000 }, () => {
  it('/users 与 /system/users 别名行为一致，且系统接口只读清单不含敏感字段', async () => {
    const short = await api(admin).get('/users', { pageSize: 5 });
    const prefixed = await api(admin).get('/system/users', { pageSize: 5 });
    expect(short.status).toBe(200);
    expect(prefixed.status).toBe(200);
    expect(short.body.data.total).toBe(prefixed.body.data.total);
    expect(short.body.data.items.map((row: { id: string }) => row.id)).toEqual(
      prefixed.body.data.items.map((row: { id: string }) => row.id),
    );
    const roles = await api(admin).get('/roles');
    expect(roles.status).toBe(200);
    expect(Array.isArray(roles.body.data)).toBe(true);
    expect(roles.body.data.map((role: { code: string }) => role.code)).toEqual(
      expect.arrayContaining(['ADMIN', 'GUEST']),
    );
    const permissions = await api(admin).get('/permissions');
    expect(permissions.status).toBe(200);
    expect(permissions.body.data).toContain('master:read');
    expect(permissions.body.data).not.toContain('*');
    expect(permissions.body.data).not.toContain('system:manage');
    expectNoSecret(short.body);
    expectNoSecret(roles.body);
  });
});
