import { spawnSync } from 'node:child_process';
process.env.DATABASE_URL = 'file:./test.db';
process.env.NODE_ENV = 'test';
function run(args: string[]) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['--import', 'tsx', 'scripts/migrate.ts']);
run(['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1']);
