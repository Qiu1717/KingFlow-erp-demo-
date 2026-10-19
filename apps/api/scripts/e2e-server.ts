import { spawnSync } from 'node:child_process';
process.env.DATABASE_URL = 'file:./e2e.db';
process.env.NODE_ENV = 'test';
process.env.DEMO_PASSWORD = 'KingFlow@2026';
for (const args of [
  ['--import', 'tsx', 'scripts/migrate.ts'],
  [
    'node_modules/prisma/build/index.js',
    'migrate',
    'reset',
    '--force',
    '--skip-seed',
    '--skip-generate',
  ],
]) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const { seed } = await import('../prisma/seed.js');
await seed();
await import('../src/server.js');
