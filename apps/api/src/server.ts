import { app } from './app.js';
import { prisma } from './repositories/db.js';
import { loadRuntimeConfig } from './config/runtime.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const config = loadRuntimeConfig();
if (config.production && !existsSync(join(config.webDist, 'index.html'))) throw new Error('缺少前端生产构建，请先执行pnpm build');
const server = app.listen(config.port, config.host, () =>
  console.log(`KingFlow API http://${config.host}:${config.port}`),
);
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
  });
