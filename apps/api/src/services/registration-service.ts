import { hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { registrationSchema } from '@kingflow/shared';
import { prisma } from '../repositories/db.js';
import { lockSystem } from '../repositories/system-repository.js';
import { AppError } from '../utils/errors.js';

export async function register(input: unknown) {
  const data = registrationSchema.parse(input);
  const passwordHash = await hash(data.password, 12);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockSystem(tx);
        const role = await tx.role.findUnique({ where: { code: 'GUEST' } });
        if (
          !role ||
          !(await tx.user.count({
            where: { status: 'ACTIVE', role: { code: 'ADMIN' } },
          }))
        )
          throw new AppError(
            503,
            'REGISTRATION_UNAVAILABLE',
            '系统尚未完成初始化，请联系管理员',
          );
        const user = await tx.user.create({
          data: {
            username: data.username,
            displayName: data.displayName,
            passwordHash,
            roleId: role.id,
            status: 'PENDING',
          },
          select: { id: true, username: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'REGISTER',
            resource: 'users',
            resourceId: user.id,
          },
        });
        return { username: user.username, status: 'PENDING' as const };
      },
      { maxWait: 10000, timeout: 15000 },
    );
  } catch (error) {
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
