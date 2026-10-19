import 'dotenv/config';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { prisma } from '../src/repositories/db.js';
import {
  backupDatabase,
  restoreDatabase,
  checkIntegrity,
  restoreDrill,
  databaseFile,
} from '../src/services/recovery-service.js';

/**
 * 运维命令：备份 / 恢复 / 完整性核对 / 恢复演练。
 *
 * 用法：
 *   tsx scripts/backup.ts backup   <目标文件>
 *   tsx scripts/backup.ts verify   [库路径]
 *   tsx scripts/backup.ts restore  <备份文件> <新库文件>
 *   tsx scripts/backup.ts drill    <目录>
 *
 * 安全约束：
 * - 备份/恢复都不覆盖任何已存在文件；恢复只写新库。
 * - 恢复后自动清除历史会话并做账实核对，核对不过即失败退出。
 * - 演练（drill）只读生产库、写独立目录，不动生产数据。
 */
const [command, ...rest] = process.argv.slice(2);

const usage = () => {
  console.error(
    [
      '用法：',
      '  tsx scripts/backup.ts backup  <目标文件>',
      '  tsx scripts/backup.ts verify  [库路径]',
      '  tsx scripts/backup.ts restore <备份文件> <新库文件>',
      '  tsx scripts/backup.ts drill   <目录>',
    ].join('\n'),
  );
  process.exitCode = 2;
};

const printIntegrity = (
  report: Awaited<ReturnType<typeof checkIntegrity>>,
  label: string,
) => {
  console.log(`${label}：${report.ok ? '通过' : '未通过'}`);
  for (const check of report.checks)
    console.log(
      `  ${check.violations === 0 ? '✓' : '✗'} ${check.label}${
        check.violations === 0 ? '' : ` — ${check.violations} 处不一致`
      }${check.sample ? `（示例：${check.sample}）` : ''}`,
    );
};

async function main() {
  if (!command) return usage();

  if (command === 'backup') {
    const target = rest[0];
    if (!target) return usage();
    const result = await backupDatabase(resolve(target));
    console.log(`备份完成：${result.path}`);
    console.log(`大小：${result.bytes} 字节`);
    console.log(`SHA256：${result.sha256}`);
    console.log(`时间：${result.createdAt}`);
    return;
  }

  if (command === 'verify') {
    const file = rest[0] ? resolve(rest[0]) : await databaseFile();
    console.log(`核对数据库：${file}`);
    const report = await checkIntegrity();
    printIntegrity(report, '账实一致性核对');
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === 'restore') {
    const [backup, target] = rest;
    if (!backup || !target) return usage();
    const result = await restoreDatabase(resolve(backup), resolve(target));
    console.log(`恢复完成：${result.target}`);
    console.log(`来源：${result.source}`);
    console.log(`已清除历史会话：${result.sessionsCleared}`);
    printIntegrity(result.integrity, '恢复后账实一致性核对');
    if (!result.integrity.ok) process.exitCode = 1;
    return;
  }

  if (command === 'drill') {
    const directory = rest[0];
    if (!directory) return usage();
    await mkdir(resolve(directory), { recursive: true });
    const result = await restoreDrill(resolve(directory));
    console.log(`备份文件：${result.backup.path}（${result.backup.bytes} 字节）`);
    console.log(`恢复库：${result.restore.target}`);
    printIntegrity(result.before, '演练前生产库核对');
    printIntegrity(result.after, '演练后恢复库核对');
    if (!result.before.ok || !result.after.ok) process.exitCode = 1;
    return;
  }

  return usage();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
