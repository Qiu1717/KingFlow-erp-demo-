import 'dotenv/config';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * 定位前端生产构建目录。
 *
 * 不能用固定的相对路径：同一份代码在两种上下文里运行，模块所在层级不同。
 * - 源码：apps/api/src/config/ → ../../../web/dist → apps/web/dist ✓
 * - 编译产物：apps/api/dist/apps/api/src/config/ → ../../../web/dist → apps/api/dist/apps/web/dist ✗
 *
 * 因此从模块目录逐级向上寻找工作区根（含 pnpm-workspace.yaml），再取 apps/web/dist。
 * 找不到就回退到源码相对路径，由 server.ts 的启动检查给出明确错误。
 */
function resolveWebDist(): string {
  let directory = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml')))
      return join(directory, 'apps/web/dist');
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  return fileURLToPath(new URL('../../../web/dist/', import.meta.url));
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = z.enum(['development', 'test', 'production']).default('development').parse(env.NODE_ENV);
  const production = mode === 'production';
  const appOrigin = z.string().url().parse(env.APP_ORIGIN ?? (production ? undefined : 'http://localhost:5173'));
  const origin = new URL(appOrigin);
  if (origin.origin !== appOrigin || !['http:', 'https:'].includes(origin.protocol) || (production && origin.protocol !== 'https:')) throw new Error('APP_ORIGIN必须为完整来源，生产环境必须使用HTTPS且不带路径');
  const databaseUrl = env.DATABASE_URL ?? (production ? '' : 'file:./dev.db');
  if (!databaseUrl.startsWith('file:') || (production && !isAbsolute(databaseUrl.slice(5)))) throw new Error('生产DATABASE_URL必须显式指定本机绝对SQLite路径');
  const trustProxy = z.enum(['false', 'loopback']).default('false').parse(env.TRUST_PROXY);
  return {
    mode, production, appOrigin, databaseUrl,
    registrationEnabled: z.enum(['true', 'false']).default('true').parse(env.REGISTRATION_ENABLED) === 'true',
    host: env.HOST ?? '127.0.0.1',
    port: z.coerce.number().int().min(0).max(65535).default(3001).parse(env.PORT),
    trustProxy: trustProxy === 'loopback' ? 'loopback' as const : false as const,
    webDist: env.WEB_DIST ?? resolveWebDist(),
  };
}
export type RuntimeConfig = ReturnType<typeof loadRuntimeConfig>;
