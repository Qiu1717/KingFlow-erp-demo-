import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hash, compare } from 'bcryptjs';
import { registrationSchema, type SessionUser } from '@kingflow/shared';
import { register } from '../src/services/registration-service.js';
import { login } from '../src/services/auth-service.js';
import {
  reviewRegistration,
  saveUser,
} from '../src/services/system-service.js';
import { prisma } from '../src/repositories/db.js';

let admin: SessionUser;
let businessRoleId: string;
let adminRoleId: string;
const password = 'Review!Secure2026';
const applicant = () => ({
  username: `reg_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
  displayName: '注册申请人',
  password,
});

beforeAll(async () => {
  if (
    process.env.NODE_ENV !== 'test' ||
    !process.env.DATABASE_URL?.includes('test')
  )
    throw new Error('注册回归只允许独立测试数据库');
  const role = await prisma.role.upsert({
    where: { code: 'ADMIN' },
    update: {},
    create: { code: 'ADMIN', name: '管理员', permissions: '["*"]' },
  });
  const guest = await prisma.role.upsert({
    where: { code: 'GUEST' },
    update: {},
    create: { code: 'GUEST', name: '访客', permissions: '["master:read"]' },
  });
  const user = await prisma.user.create({
    data: {
      username: `review_${randomUUID()}`,
      displayName: '审核管理员',
      passwordHash: await hash(password, 4),
      roleId: role.id,
    },
  });
  adminRoleId = role.id;
  businessRoleId = guest.id;
  admin = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: { code: role.code, name: role.name, permissions: ['*'] },
  };
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe.sequential('注册与管理员审核的真实数据库约束', () => {
  it('生产登录拒绝原演示口令', async () => {
    await expect(login({ username: 'admin', password: 'KingFlow@2026' }, undefined, true)).rejects.toMatchObject({ code: 'DEMO_CREDENTIALS_DISABLED' });
  });
  it('拒绝弱密码和注册时注入角色、状态', () => {
    expect(
      registrationSchema.safeParse({ ...applicant(), password: '12345678' })
        .success,
    ).toBe(false);
    expect(
      registrationSchema.safeParse({
        ...applicant(),
        roleId: adminRoleId,
        status: 'ACTIVE',
      }).success,
    ).toBe(false);
    expect(
      registrationSchema.safeParse({
        ...applicant(),
        password: '中'.repeat(23) + 'Aa1!',
      }).success,
    ).toBe(false);
  });
  it('注册持久保存哈希、待审核状态；待审不能取得会话', async () => {
    const input = applicant();
    expect(await register(input)).toEqual({
      username: input.username,
      status: 'PENDING',
    });
    const row = await prisma.user.findUniqueOrThrow({
      where: { username: input.username },
    });
    expect(row.status).toBe('PENDING');
    expect(row.passwordHash).not.toBe(password);
    expect(await compare(password, row.passwordHash)).toBe(true);
    await expect(
      login({ username: input.username, password }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PENDING' });
    expect(await prisma.session.count({ where: { userId: row.id } })).toBe(0);
  });
  it('普通用户不能审核，普通编辑不能跳过审核，管理员也不能在审核时授予管理员角色', async () => {
    const input = applicant();
    await register(input);
    const row = await prisma.user.findUniqueOrThrow({
      where: { username: input.username },
    });
    const guest: SessionUser = {
      ...admin,
      role: { code: 'GUEST', name: '访客', permissions: ['master:read'] },
    };
    await expect(
      reviewRegistration(
        row.id,
        { decision: 'APPROVE', roleId: businessRoleId },
        guest,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      saveUser({ status: 'ACTIVE' }, admin, row.id),
    ).rejects.toMatchObject({ code: 'REGISTRATION_REVIEW_REQUIRED' });
    await expect(
      reviewRegistration(
        row.id,
        { decision: 'APPROVE', roleId: adminRoleId },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('PENDING');
  });
  it('并发审核只成功一次，通过后能登录且只有一条通过日志', async () => {
    const input = applicant();
    await register(input);
    const row = await prisma.user.findUniqueOrThrow({
      where: { username: input.username },
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        reviewRegistration(
          row.id,
          { decision: 'APPROVE', roleId: businessRoleId },
          admin,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: row.id, action: 'APPROVE_REGISTRATION' },
      }),
    ).toBe(1);
    const session = await login({ username: input.username, password });
    expect(session.data.user.role.code).toBe('GUEST');
  });
  it('驳回后不能登录；重名注册不会生成额外账号', async () => {
    const input = applicant();
    await register(input);
    const row = await prisma.user.findUniqueOrThrow({
      where: { username: input.username },
    });
    await reviewRegistration(row.id, { decision: 'REJECT' }, admin);
    await expect(
      login({ username: input.username, password }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_REJECTED' });
    await expect(register(input)).rejects.toMatchObject({
      code: 'DUPLICATE_USERNAME',
    });
    expect(
      await prisma.user.count({ where: { username: input.username } }),
    ).toBe(1);
    expect(await prisma.session.count({ where: { userId: row.id } })).toBe(0);
  });
});
