import 'dotenv/config';
import { hash } from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { roleDefinitions } from '@kingflow/shared';

/**
 * 演示环境账号初始化：只建两个账号。
 *
 * - admin / ADMIN（全部权限）：演示完整功能
 * - demo  / GUEST（只读）：给他人试用，改不坏数据
 *
 * 与 prisma/seed.ts 的区别：seed 会按六个角色各建一个账号且共用密码，
 * 本脚本只建需要的两个角色与两个用户，可重复执行（upsert），会重置密码。
 *
 * 用法：
 *   ADMIN_PASSWORD=xxx DEMO_PASSWORD=yyy \
 *   pnpm --filter @kingflow/api exec tsx scripts/provision-demo.ts
 */

const prisma = new PrismaClient();

const roleOf = (code: string) => {
  const found = roleDefinitions.find((role) => role.code === code);
  if (!found) throw new Error(`共享包里找不到角色 ${code}`);
  return found;
};

async function main() {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const demoPassword = process.env.DEMO_PASSWORD;
  if (!adminPassword || !demoPassword)
    throw new Error('必须提供 ADMIN_PASSWORD 与 DEMO_PASSWORD');
  if (adminPassword.length < 10 || demoPassword.length < 10)
    throw new Error('两个密码都至少 10 位');
  if (adminPassword === demoPassword)
    throw new Error('admin 与 demo 不能使用相同密码');

  const specs = [
    { role: roleOf('ADMIN'), username: 'admin', displayName: '演示管理员', password: adminPassword },
    { role: roleOf('GUEST'), username: 'demo', displayName: '演示访客', password: demoPassword },
  ];

  for (const spec of specs) {
    const role = await prisma.role.upsert({
      where: { code: spec.role.code },
      update: { name: spec.role.name, permissions: JSON.stringify(spec.role.permissions) },
      create: {
        code: spec.role.code,
        name: spec.role.name,
        permissions: JSON.stringify(spec.role.permissions),
      },
    });
    const passwordHash = await hash(spec.password, 12);
    await prisma.user.upsert({
      where: { username: spec.username },
      update: { displayName: spec.displayName, roleId: role.id, passwordHash },
      create: {
        username: spec.username,
        displayName: spec.displayName,
        roleId: role.id,
        passwordHash,
      },
    });
    console.log(`已就绪账号 ${spec.username} → 角色 ${spec.role.code}`);
  }

  const users = await prisma.user.findMany({ select: { username: true }, orderBy: { username: 'asc' } });
  console.log(`当前用户：${users.map((user) => user.username).join(', ')}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
