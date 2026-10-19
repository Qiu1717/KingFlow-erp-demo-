import { isAbsolute, resolve } from 'node:path';

/**
 * 运维命令（备份 / 恢复 / 核对 / 演练）的启动前环境校验。
 *
 * 必须在任何会建立数据库连接的模块之前 import —— `src/repositories/db.ts`
 * 在缺少 DATABASE_URL 时会回退到 `file:./dev.db`。运维命令一旦踩到这条回退，
 * 就会对着一个空库（或另一个 cwd 下的库）执行备份：账实核对会报「表不存在」，
 * 更糟的情况是核对通过，产出一个看起来成功、实际毫无用途的备份文件。
 *
 * 因此这里把「缺少 DATABASE_URL」变成硬失败，而不是让它悄悄回退。
 */
const raw = process.env.DATABASE_URL?.trim();

if (!raw) {
  console.error('[环境校验] 缺少 DATABASE_URL，运维命令已中止（不会回退到 dev.db）。');
  console.error('[环境校验] 请显式指定源库，例如：');
  console.error('  DATABASE_URL=file:/var/lib/kingflow/erp.db pnpm db:backup /backup/erp.db');
  console.error('[环境校验] 或先加载生产环境变量：set -a; . /etc/kingflow/erp.env; set +a');
  process.exit(1);
}

if (!raw.startsWith('file:')) {
  console.error(`[环境校验] DATABASE_URL 不是 SQLite 文件地址：${raw}`);
  process.exit(1);
}

const filePart = raw.slice('file:'.length).split('?')[0];

if (!isAbsolute(filePart)) {
  // 相对路径会随工作目录变化而指向不同文件，这里不直接拒绝（本地开发仍在用），
  // 但必须显式告警，并让后续输出打印 PRAGMA 解析出的真实绝对路径。
  console.warn('[环境校验] 警告：DATABASE_URL 使用相对路径，实际源库将以运行时解析结果为准。');
  console.warn(`[环境校验] 配置值 = ${raw}`);
  console.warn(`[环境校验] 按当前工作目录解析 = ${resolve(filePart)}`);
}

export {};
