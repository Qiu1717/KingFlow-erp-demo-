import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const database = process.env.DATABASE_URL ?? 'file:./dev.db';
if (
  process.env.NODE_ENV !== 'development' ||
  database !== 'file:./dev.db' ||
  !process.argv.includes('--confirm-local-dev')
) {
  throw new Error(
    '重置拒绝：需要NODE_ENV=development、DATABASE_URL=file:./dev.db和--confirm-local-dev，仅允许本项目本地开发库',
  );
}
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    resolve(dirname(require.resolve('prisma/package.json')), 'build/index.js'),
    'migrate',
    'reset',
    '--force',
    '--skip-seed',
  ],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: database } },
);
if (result.status !== 0) process.exit(result.status ?? 1);
await import('../prisma/seed.js').then((module) => module.seed());
await import('../src/repositories/db.js').then((module) =>
  module.prisma.$disconnect(),
);
