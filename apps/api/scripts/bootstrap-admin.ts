import 'dotenv/config';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import {
  accountNameSchema,
  accountPasswordSchema,
  roleDefinitions,
} from '@kingflow/shared';
import { loadRuntimeConfig } from '../src/config/runtime.js';

async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error('请显式指定目标 DATABASE_URL，禁止默认写入演示数据库');
  loadRuntimeConfig();
  const username = accountNameSchema.parse(process.env.ADMIN_USERNAME);
  const displayName = z
    .string()
    .trim()
    .min(1)
    .max(60)
    .parse(process.env.ADMIN_DISPLAY_NAME);
  const password = accountPasswordSchema.parse(process.env.ADMIN_PASSWORD);
  delete process.env.ADMIN_PASSWORD;
  const { prisma } = await import('../src/repositories/db.js');
  try {
    const passwordHash = await hash(password, 12);
    await prisma.$transaction(
      async (tx) => {
        for (const role of roleDefinitions) {
          await tx.role.upsert({
            where: { code: role.code },
            update: {},
            create: {
              code: role.code,
              name: role.name,
              permissions: JSON.stringify(role.permissions),
            },
          });
        }
        // 角色写入先取得 SQLite 写锁，避免并发初始化出两个首任管理员。
        if (await tx.user.count({ where: { role: { code: 'ADMIN' } } }))
          throw new Error(
            '已存在管理员，拒绝重复初始化或覆盖密码；请通过现有管理员管理账号',
          );
        const role = await tx.role.findUniqueOrThrow({
          where: { code: 'ADMIN' },
        });
        if (role.permissions !== '["*"]')
          throw new Error('管理员角色配置异常，请先核对角色权限');
        const user = await tx.user.create({
          data: {
            username,
            displayName,
            passwordHash,
            roleId: role.id,
            status: 'ACTIVE',
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'BOOTSTRAP_ADMIN',
            resource: 'users',
            resourceId: user.id,
          },
        });
      },
      { maxWait: 10000, timeout: 15000 },
    );
    console.log('管理员初始化完成。密码不会显示，请使用部署时设置的凭据登录。');
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof z.ZodError
      ? '管理员参数不符合要求：请检查账号、姓名和密码规则'
      : error instanceof Error && !error.name.startsWith('Prisma')
        ? error.message
        : '初始化失败，请检查数据库迁移、连接与账号唯一性',
  );
  process.exitCode = 1;
});
