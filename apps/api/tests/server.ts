import type { Server } from 'node:http';
import { createServer } from 'node:http';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/repositories/db.js';

/**
 * 测试用真实 HTTP 服务器。
 *
 * 不要直接用 `request(app)` / `request.agent(app)`：supertest 7 会为 Express 应用
 * 惰性创建一个共享 server，并在「最后一个请求结束」时关闭它。若前一个请求还在
 * 构造/等待（例如 `.set('If-Match', await match(...))` 先发了一次 GET），
 * 后一个请求结束时就会把 server 关掉，前一个请求 dispatch 时 `server.address()`
 * 已为 null，抛出 `Cannot read properties of null (reading 'address')`。
 *
 * 这里显式 listen 一个真实端口，让 supertest 使用调用方持有的 server，
 * 生命周期由测试文件自己控制（beforeAll 启动、afterAll 关闭）。
 */
export interface TestServer {
  server: Server;
  agent: () => ReturnType<typeof request.agent>;
  base: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('测试服务器未获得有效端口');
  return {
    server,
    agent: () => request.agent(server),
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export const ORIGIN = 'http://localhost:5173';

export async function stopDatabase() {
  await prisma.$disconnect();
}
