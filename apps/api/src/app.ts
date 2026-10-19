import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { router } from './routes/index.js';
import { AppError } from './utils/errors.js';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { loadRuntimeConfig, type RuntimeConfig } from './config/runtime.js';
export function createApp(config: RuntimeConfig = loadRuntimeConfig()) {
const app = express();
app.disable('x-powered-by');
// 请求期中间件从 app.locals 读取配置，保证多个不同配置的 app 实例互不干扰。
app.locals.runtime = config;
app.set('trust proxy', config.trustProxy);
app.use(helmet());
app.use((req, res, next) => {
  res.set('X-Request-ID', randomUUID());
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  if (config.production && !req.secure && !['/api/v1/health', '/api/v1/ready'].includes(req.path)) return next(new AppError(426, 'HTTPS_REQUIRED', '生产环境必须通过HTTPS访问'));
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(
  '/api/v1',
  (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
  router,
);
if (config.production) {
  app.use(express.static(config.webDist, { index: false, dotfiles: 'deny', maxAge: '1y', immutable: true }));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/') || extname(req.path) || !req.accepts('html')) return next();
    res.set('Cache-Control', 'no-store').sendFile(join(config.webDist, 'index.html'));
  });
}
app.use((_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', '接口不存在'));
});
const errorHandler: express.ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  next,
) => {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '输入内容不符合要求',
        fields: error.flatten().fieldErrors,
      },
    });
    return;
  }
  if (error instanceof AppError) {
    res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const map: Record<string, [number, string, string]> = {
      P2002: [409, 'DUPLICATE_CODE', '编码已存在，请使用其他编码'],
      P2003: [409, 'REFERENCED', '资料已被引用，不能删除'],
      P2025: [404, 'NOT_FOUND', '资料不存在'],
      P2034: [409, 'WRITE_CONFLICT', '数据写入冲突，请重试'],
      P2028: [503, 'DATABASE_BUSY', '数据库繁忙，请稍后重试'],
      P1008: [503, 'DATABASE_BUSY', '数据库繁忙，请使用原幂等键稍后重试'],
      P2024: [503, 'DATABASE_BUSY', '数据库连接繁忙，请稍后重试'],
    };
    const mapped = map[error.code];
    if (mapped) {
      res
        .status(mapped[0])
        .json({ error: { code: mapped[1], message: mapped[2] } });
      return;
    }
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: '请求内容不是有效JSON' },
    });
    return;
  }
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 413
  ) {
    res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求内容过大' } });
    return;
  }
  console.error(
    'Unhandled API error',
    res.getHeader('X-Request-ID'),
    error instanceof Error ? error.name : 'UnknownError',
  );
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' },
  });
};
app.use(errorHandler);
return app;
}
export const app = createApp();
