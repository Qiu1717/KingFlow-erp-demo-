import { randomBytes, createHash } from 'node:crypto';
import { compare } from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../repositories/db.js';
import { AppError } from '../utils/errors.js';
import type { AuthData } from '@kingflow/shared';
export const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(60),
    password: z.string().min(1).max(128),
  })
  .strict();
export async function login(input: unknown, oldToken?: string, production = false) {
  const { username, password } = loginSchema.parse(input);
  if (production && password === 'KingFlow@2026')
    throw new AppError(403, 'DEMO_CREDENTIALS_DISABLED', '生产环境禁止使用演示密码，请联系管理员重置');
  const user = await prisma.user.findUnique({
    where: { username },
    include: { role: true },
  });
  // Equal hashing work for unknown usernames reduces timing-based account enumeration.
  const valid = await compare(
    password,
    user?.passwordHash ??
      '$2b$12$C6UzMDM.H6dfI/f/IKcEe.8h8dJcFQ9n0mNQ2NtfW2AqZ7bP0ZMyi',
  );
  if (!user || !valid)
    throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
  if (user.status === 'PENDING')
    throw new AppError(403, 'ACCOUNT_PENDING', '账号正在等待管理员审核，审核通过后方可登录');
  if (user.status === 'REJECTED')
    throw new AppError(403, 'ACCOUNT_REJECTED', '注册申请未通过，请联系管理员');
  if (user.status !== 'ACTIVE')
    throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await prisma.$transaction(async (tx) => {
    // Serialize session creation with password, status and role changes.
    await tx.$executeRaw`UPDATE "User" SET "displayName" = "displayName" WHERE "id" = ${user.id}`;
    const current = await tx.user.findUnique({
      where: { id: user.id },
      include: { role: true },
    });
    if (
      !current ||
      current.status !== 'ACTIVE' ||
      current.passwordHash !== user.passwordHash ||
      current.roleId !== user.roleId ||
      current.role.permissions !== user.role.permissions
    )
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        '账号信息已变更，请重新登录',
      );
    if (oldToken)
      await tx.session.deleteMany({ where: { id: digest(oldToken) } });
    await tx.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await tx.session.create({
      data: {
        id: digest(token),
        userId: user.id,
        csrfToken,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'LOGIN',
        resource: 'auth',
        resourceId: user.id,
      },
    });
  });
  return { token, data: { user: publicUser(user), csrfToken } };
}
function publicUser(user: {
  id: string;
  username: string;
  displayName: string;
  role: { code: string; name: string; permissions: string };
}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: {
      code: user.role.code,
      name: user.role.name,
      permissions: z.array(z.string()).parse(JSON.parse(user.role.permissions)),
    },
  };
}
export async function authenticate(token?: string): Promise<AuthData> {
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  const session = await prisma.session.findUnique({
    where: { id: digest(token) },
    include: { user: { include: { role: true } } },
  });
  if (
    !session ||
    session.expiresAt <= new Date() ||
    session.user.status !== 'ACTIVE'
  )
    throw new AppError(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
  return { user: publicUser(session.user), csrfToken: session.csrfToken };
}
export async function logout(token: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { id: digest(token) } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'LOGOUT',
        resource: 'auth',
        resourceId: actorId,
      },
    });
  });
}
