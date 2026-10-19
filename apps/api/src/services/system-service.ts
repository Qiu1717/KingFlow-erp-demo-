import { z } from 'zod';
import { compare, hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@kingflow/shared';
import { prisma } from '../repositories/db.js';
import * as repository from '../repositories/system-repository.js';
import { authorize } from './master-service.js';
import { AppError } from '../utils/errors.js';
export const permissionOptions = [
  'master:read',
  'products:write',
  'categories:write',
  'customers:write',
  'suppliers:write',
  'warehouses:write',
  'purchase:read',
  'purchase:write',
  'purchase:approve',
  'receipts:read',
  'receipts:post',
  'sales:read',
  'sales:write',
  'sales:approve',
  'shipments:read',
  'shipments:post',
  'inventory:read',
  'inventory:adjust',
  'payables:read',
  'receivables:read',
  'finance:read',
  'settlements:write',
] as const;
const password = z
  .string()
  .min(8, '密码至少8位')
  .max(72)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, '密码最多72字节');
const displayName = z.string().trim().min(1).max(60);
const id = z.string().min(1).max(100);
const pagination = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const userQuery = z
  .object({
    ...pagination,
    q: z.string().trim().max(100).default(''),
    status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING', 'REJECTED']).optional(),
    roleId: id.optional(),
  })
  .strict();
const createSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(60)
      .regex(/^[A-Za-z0-9_-]+$/),
    displayName,
    roleId: id,
    status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
    password,
  })
  .strict();
const editSchema = createSchema
  .omit({ password: true, username: true })
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, '至少修改一个字段');
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    '日期无效',
  );
const logQuery = z
  .object({
    ...pagination,
    actorId: id.optional(),
    action: z.string().trim().min(1).max(60).optional(),
    resource: z.string().trim().min(1).max(60).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || v.from <= v.to,
    '开始日期不能晚于结束日期',
  );
const options = { maxWait: 10000, timeout: 15000 };
function manage(user: SessionUser) {
  authorize(user, 'system:manage');
  if (user.role.code !== 'ADMIN')
    throw new AppError(403, 'FORBIDDEN', '仅管理员可以管理系统');
}
async function lockedActor(tx: Prisma.TransactionClient, user: SessionUser) {
  await repository.lockSystem(tx);
  const actor = await tx.user.findUnique({
    where: { id: user.id },
    include: { role: true },
  });
  if (
    !actor ||
    actor.status !== 'ACTIVE' ||
    actor.role.code !== 'ADMIN' ||
    !JSON.parse(actor.role.permissions).includes('*')
  )
    throw new AppError(403, 'FORBIDDEN', '管理员权限已变更，请重新登录');
}
const audit = (
  tx: Prisma.TransactionClient,
  actorId: string,
  action: string,
  resource: string,
  resourceId: string,
) => tx.auditLog.create({ data: { actorId, action, resource, resourceId } });
export async function listUsers(input: unknown, user: SessionUser) {
  manage(user);
  return repository.users(userQuery.parse(input));
}
export async function listRoles(user: SessionUser) {
  manage(user);
  const rows = await prisma.role.findMany({
    orderBy: { code: 'asc' },
    include: { _count: { select: { users: true } } },
  });
  return rows.map((row) => ({
    ...row,
    permissions: z.array(z.string()).parse(JSON.parse(row.permissions)),
  }));
}
export async function listLogs(input: unknown, user: SessionUser) {
  manage(user);
  return repository.logs(logQuery.parse(input));
}
export async function reviewRegistration(userId: string, input: unknown, user: SessionUser) {
  manage(user);
  const data = z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('APPROVE'), roleId: id }).strict(),
    z.object({ decision: z.literal('REJECT') }).strict(),
  ]).parse(input);
  return prisma.$transaction(async (tx) => {
    await lockedActor(tx, user);
    const applicant = await tx.user.findUnique({ where: { id: userId } });
    if (!applicant || applicant.status !== 'PENDING')
      throw new AppError(409, 'REGISTRATION_NOT_PENDING', '该账号不在待审核状态，请刷新列表');
    if (data.decision === 'APPROVE') {
      const role = await tx.role.findUnique({ where: { id: data.roleId } });
      if (!role || role.code === 'ADMIN' || JSON.parse(role.permissions).some((p: string) => p === '*' || p === 'system:manage'))
        throw new AppError(422, 'INVALID_ROLE', '请选择普通业务角色，注册审核不能直接授予管理员权限');
    }
    const row = await tx.user.update({
      where: { id: userId },
      data: data.decision === 'APPROVE' ? { status: 'ACTIVE', roleId: data.roleId } : { status: 'REJECTED' },
      select: repository.userSelect,
    });
    await tx.session.deleteMany({ where: { userId } });
    await audit(tx, user.id, data.decision === 'APPROVE' ? 'APPROVE_REGISTRATION' : 'REJECT_REGISTRATION', 'users', userId);
    return row;
  }, options);
}
export async function saveUser(
  input: unknown,
  user: SessionUser,
  userId?: string,
) {
  manage(user);
  const creating = userId ? undefined : createSchema.parse(input);
  const data = creating ?? editSchema.parse(input);
  const passwordHash = creating ? await hash(creating.password, 12) : undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      await lockedActor(tx, user);
      const existing = userId
        ? await tx.user.findUnique({
            where: { id: userId },
            include: { role: true },
          })
        : null;
      if (userId && !existing)
        throw new AppError(404, 'NOT_FOUND', '用户不存在');
      if (existing && ['PENDING', 'REJECTED'].includes(existing.status))
        throw new AppError(409, 'REGISTRATION_REVIEW_REQUIRED', '注册申请须通过审核操作处理；已驳回申请不能直接启用');
      if (
        userId === user.id &&
        (data.status === 'INACTIVE' ||
          (data.roleId && data.roleId !== existing?.roleId))
      )
        throw new AppError(409, 'SELF_LOCKOUT', '不能停用自己或更改自己的角色');
      const role = data.roleId
        ? await tx.role.findUnique({ where: { id: data.roleId } })
        : null;
      if (data.roleId && !role)
        throw new AppError(422, 'INVALID_ROLE', '请选择有效角色');
      if (
        existing?.status === 'ACTIVE' &&
        existing.role.code === 'ADMIN' &&
        (data.status === 'INACTIVE' || (role && role.code !== 'ADMIN'))
      ) {
        const admins = await tx.user.count({
          where: { status: 'ACTIVE', role: { code: 'ADMIN' } },
        });
        if (admins <= 1)
          throw new AppError(409, 'LAST_ADMIN', '必须保留至少一名启用的管理员');
      }
      const safe = {
        displayName: data.displayName,
        status: data.status,
        roleId: data.roleId,
      };
      const row = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: safe,
            select: repository.userSelect,
          })
        : await tx.user.create({
            data: {
              username: creating!.username,
              displayName: creating!.displayName,
              roleId: creating!.roleId,
              status: creating!.status,
              passwordHash: passwordHash!,
            },
            select: repository.userSelect,
          });
      if (
        existing &&
        ((data.status && data.status !== existing.status) ||
          (data.roleId && data.roleId !== existing.roleId))
      )
        await tx.session.deleteMany({ where: { userId: existing.id } });
      await audit(tx, user.id, existing ? 'UPDATE' : 'CREATE', 'users', row.id);
      return row;
    }, options);
  } catch (error) {
    // 用户名唯一冲突要给账号语义，而不是复用基础资料的「编码已存在」提示。
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      throw new AppError(
        409,
        'DUPLICATE_USERNAME',
        '登录账号已存在，请使用其他账号',
      );
    throw error;
  }
}
export async function resetPassword(
  userId: string,
  input: unknown,
  user: SessionUser,
) {
  manage(user);
  const data = z.object({ password }).strict().parse(input);
  const passwordHash = await hash(data.password, 12);
  return prisma.$transaction(async (tx) => {
    await lockedActor(tx, user);
    if (userId === user.id)
      throw new AppError(
        409,
        'SELF_PASSWORD',
        '请通过个人设置验证旧密码后修改',
      );
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId } });
    await audit(tx, user.id, 'RESET_PASSWORD', 'users', userId);
    return { success: true };
  }, options);
}
export async function saveRole(
  roleId: string,
  input: unknown,
  user: SessionUser,
) {
  manage(user);
  const data = z
    .object({ permissions: z.array(z.string()).max(50) })
    .strict()
    .parse(input);
  return prisma.$transaction(async (tx) => {
    await lockedActor(tx, user);
    const role = await tx.role.findUnique({ where: { id: roleId } });
    if (!role) throw new AppError(404, 'NOT_FOUND', '角色不存在');
    if (role.code === 'ADMIN') {
      if (data.permissions.length !== 1 || data.permissions[0] !== '*')
        throw new AppError(
          409,
          'ADMIN_PROTECTED',
          '管理员必须保留全部系统权限',
        );
    } else if (
      data.permissions.some(
        (p) =>
          !permissionOptions.some((option) => option === p) ||
          (role.code === 'GUEST' && !p.endsWith(':read')),
      )
    )
      throw new AppError(
        422,
        'INVALID_PERMISSION',
        '包含无效权限或违反访客只读约束',
      );
    const permissions = [...new Set(data.permissions)];
    const current = z
      .array(z.string())
      .safeParse(JSON.parse(role.permissions));
    // 权限未实际变化时不撤销会话：管理员保存管理员角色（只能保存为 *）会
    // 把操作者自己的会话删掉，导致保存成功却立刻掉线；其他角色同理。
    const changed =
      !current.success ||
      current.data.length !== permissions.length ||
      [...current.data].sort().join('\u0000') !==
        [...permissions].sort().join('\u0000');
    await tx.role.update({
      where: { id: roleId },
      data: { permissions: JSON.stringify(permissions) },
    });
    if (changed) {
      await tx.session.deleteMany({ where: { user: { roleId } } });
      await audit(tx, user.id, 'UPDATE_PERMISSIONS', 'roles', roleId);
    }
    return { id: role.id, code: role.code, name: role.name, permissions };
  }, options);
}
export async function profile(input: unknown, user: SessionUser) {
  const data = z.object({ displayName }).strict().parse(input);
  return prisma.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id: user.id },
      data,
      select: repository.userSelect,
    });
    await audit(tx, user.id, 'UPDATE_PROFILE', 'users', user.id);
    return row;
  });
}
export async function changePassword(input: unknown, user: SessionUser) {
  const data = z
    .object({
      currentPassword: z.string().min(1).max(128),
      newPassword: password,
    })
    .strict()
    .parse(input);
  const passwordHash = await hash(data.newPassword, 12);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "User" SET "displayName" = "displayName" WHERE "id" = ${user.id}`;
    const existing = await tx.user.findUnique({ where: { id: user.id } });
    if (
      !existing ||
      existing.status !== 'ACTIVE' ||
      !(await compare(data.currentPassword, existing.passwordHash))
    )
      throw new AppError(422, 'INVALID_PASSWORD', '当前密码不正确');
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(tx, user.id, 'CHANGE_PASSWORD', 'users', user.id);
    return { success: true };
  }, options);
}
