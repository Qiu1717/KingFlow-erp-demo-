import 'dotenv/config';
import { existsSync, closeSync, openSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
process.env.DATABASE_URL ??= 'file:./dev.db';
const require = createRequire(import.meta.url);
const file = resolve('prisma', process.env.DATABASE_URL.replace(/^file:/, ''));
mkdirSync(dirname(file), { recursive: true });
// Windows Prisma 6 schema engine cannot create a missing SQLite file reliably.
if (!existsSync(file)) closeSync(openSync(file, 'ax'));
const cli = resolve(
  dirname(require.resolve('prisma/package.json')),
  'build/index.js',
);
for (const args of [['migrate', 'deploy'], ['generate']]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
