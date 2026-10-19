import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL ??= 'file:./dev.db';

/**
 * SQLite 单写者约束与 Prisma 连接池的交互。
 *
 * Prisma 默认按 CPU 数量打开多个 SQLite 连接。多个连接同时尝试写同一库时，
 * SQLite 只允许一个写者，其余连接会在驱动层等待并最终抛 P1008（socket timeout），
 * 表现为并发过账偶发 503 —— 这不是业务规则错误，而是连接池与存储引擎不匹配。
 *
 * 把连接数固定为 1 后，写入在客户端即被串行化，与 SQLite 的单写者模型一致：
 * 并发请求排队执行而不是互相抢锁，账实一致且不再出现 P1008。
 * 只读请求同样走这一条连接，对当前单实例部署规模足够；水平扩展需要更换存储引擎。
 */
function sqliteUrl(raw: string): string {
  if (!raw.startsWith('file:')) return raw;
  // 不能用 new URL()：它会把相对路径 file:./dev.db 规范成 file:///dev.db 而指向错误位置。
  const [base, existing = ''] = raw.split('?');
  const params = new URLSearchParams(existing);
  if (!params.has('connection_limit')) params.set('connection_limit', '1');
  // 长事务下放宽驱动层等待，避免把正常的排队误判为超时。
  if (!params.has('socket_timeout')) params.set('socket_timeout', '30');
  return `${base}?${params.toString()}`;
}

export const databaseUrl = sqliteUrl(process.env.DATABASE_URL);

const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

/** 可安全重试的瞬时写入冲突：事务已回滚，重试不会产生重复过账。 */
const TRANSIENT = new Set(['P1008', 'P2028', 'P2034', 'P2024']);
const MAX_ATTEMPTS = 5;

const isTransient = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  TRANSIENT.has(String((error as { code: unknown }).code));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 指数退避 + 抖动，避免多个请求在同一时刻再次碰撞。 */
async function withWriteRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (!isTransient(error) || attempt >= MAX_ATTEMPTS) throw error;
      const backoff = Math.min(1000, 25 * 2 ** attempt);
      await wait(backoff + Math.random() * backoff);
    }
  }
}

const runInteractive = client.$transaction.bind(client);

/**
 * 只重试交互式事务（回调形式）。数组形式传入的是已经在执行的 Promise，
 * 重试会重复提交，因此原样执行。
 */
function transactionWithRetry(...args: unknown[]) {
  const [first, second] = args;
  if (typeof first === 'function')
    return withWriteRetry(() =>
      (runInteractive as (...inner: unknown[]) => Promise<unknown>)(first, second),
    );
  return (runInteractive as (...inner: unknown[]) => Promise<unknown>)(...args);
}

Object.assign(client, { $transaction: transactionWithRetry });

export const prisma = client;
