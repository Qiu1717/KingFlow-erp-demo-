import 'dotenv/config';
import { hash } from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { roleDefinitions, accountPasswordSchema } from '@kingflow/shared';

/**
 * 生产初始化：只补齐「缺失」的角色与账号，绝不改动已有数据。
 *
 * 幂等、非破坏性 —— 重复部署是常态，这个脚本必须做到：
 * - 角色：`roleDefinitions` 里缺失的才创建；已存在的**不覆盖** name / permissions，
 *   仅当发现权限与共享包定义不一致时打印告警，交由人工决策。
 * - 账号：缺失的才创建；已存在的**完全跳过** —— 不改密码、不改角色、
 *   不改显示名、不改启停状态，也不撤销会话。
 * - 不删除任何角色/账号，不创建演示用的业务账号，不跑 Seed。
 *
 * 因此在一个已经上线的库上反复执行它是安全的：输出会满屏「已存在，跳过」。
 *
 * 用法：
 *   ADMIN_PASSWORD=... DEMO_PASSWORD=... pnpm --filter @kingflow/api exec tsx scripts/provision-demo.ts
 * 密码仅在需要新建对应账号时才必填，且必须满足共享包的统一口令策略。
 */

const prisma = new PrismaClient();

/** 需要存在的两个账号；其余业务角色不建账号。 */
const accountSpecs = [
  { username: 'admin', roleCode: 'ADMIN', displayName: '演示管理员', env: 'ADMIN_PASSWORD' },
  { username: 'demo', roleCode: 'GUEST', displayName: '演示访客', env: 'DEMO_PASSWORD' },
] as const;

const roleOf = (code: string) => {
  const found = roleDefinitions.find((role) => role.code === code);
  if (!found) throw new Error(`共享包里找不到角色 ${code}`);
  return found;
};

async function main() {
  let created = 0;
  let skipped = 0;
  const warnings: string[] = [];

  // ---- 1. 角色：只补缺失，不覆盖 ----
  console.log('=== 角色同步（只创建缺失项，不覆盖已有权限）===');
  for (const definition of roleDefinitions) {
    const expected = JSON.stringify(definition.permissions);
    const existing = await prisma.role.findUnique({ where: { code: definition.code } });

    if (!existing) {
      await prisma.role.create({
        data: {
          code: definition.code,
          name: definition.name,
          permissions: expected,
        },
      });
      created += 1;
      console.log(`  + 创建角色 ${definition.code.padEnd(10)} ${definition.name}（${definition.permissions.length} 项权限）`);
      continue;
    }

    skipped += 1;
    if (existing.permissions === expected && existing.name === definition.name) {
      console.log(`  = 角色 ${definition.code.padEnd(10)} 已存在，跳过`);
    } else {
      // 只报告，不修改：已有角色的权限可能被管理员在界面上调整过，属于生产数据。
      warnings.push(`${definition.code} 的权限/名称与共享包定义不一致（保持原样未修改）`);
      console.log(`  ! 角色 ${definition.code.padEnd(10)} 已存在但内容与共享包不同 —— 保持原样，仅告警`);
    }
  }

  // ---- 2. 账号：只建缺失，已有账号完全不动 ----
  console.log('=== 账号初始化（已有账号保持原样）===');
  for (const spec of accountSpecs) {
    const existing = await prisma.user.findUnique({
      where: { username: spec.username },
      include: { role: true },
    });

    if (existing) {
      skipped += 1;
      console.log(
        `  = 账号 ${spec.username.padEnd(6)} 已存在（状态 ${existing.status}，角色 ${existing.role.code}），跳过：不改密码/角色/启停`,
      );
      continue;
    }

    const raw = process.env[spec.env];
    if (!raw) throw new Error(`账号 ${spec.username} 不存在，需要提供 ${spec.env} 才能创建`);
    const parsed = accountPasswordSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(`${spec.env} 不满足口令策略：${parsed.error.issues.map((i) => i.message).join('；')}`);

    const role = await prisma.role.findUnique({ where: { code: spec.roleCode } });
    if (!role) throw new Error(`角色 ${spec.roleCode} 不存在，请先完成角色同步`);

    await prisma.user.create({
      data: {
        username: spec.username,
        displayName: spec.displayName,
        passwordHash: await hash(parsed.data, 12),
        roleId: role.id,
        status: 'ACTIVE',
      },
    });
    created += 1;
    console.log(`  + 创建账号 ${spec.username.padEnd(6)} → 角色 ${spec.roleCode}`);
  }

  // ---- 3. 汇总（只读，不做任何写入）----
  const [roleCount, userCount, roles, users] = await Promise.all([
    prisma.role.count(),
    prisma.user.count(),
    prisma.role.findMany({ select: { code: true }, orderBy: { code: 'asc' } }),
    prisma.user.findMany({
      select: { username: true, status: true, role: { select: { code: true } } },
      orderBy: { username: 'asc' },
    }),
  ]);

  console.log('=== 汇总 ===');
  console.log(`  本次创建 ${created} 项，跳过 ${skipped} 项`);
  console.log(`  角色（${roleCount}）：${roles.map((role) => role.code).join(', ')}`);
  console.log(
    `  账号（${userCount}）：${users.map((user) => `${user.username}[${user.status}/${user.role.code}]`).join(', ')}`,
  );
  if (warnings.length) {
    console.log('  ⚠ 需人工确认：');
    for (const warning of warnings) console.log(`    - ${warning}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
