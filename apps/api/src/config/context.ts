import type { Request } from 'express';
import type { RuntimeConfig } from '../config/runtime.js';

/**
 * 运行时配置统一入口。
 *
 * 应用配置由 `createApp(config)` 注入到 `app.locals`，请求期从这里读取，
 * 不再直接读 `process.env`。这样测试可以用不同的来源/生产配置构造独立 app，
 * 而不会因为模块加载时的 `process.env` 快照而互相污染。
 */
export const runtimeOf = (req: Request): RuntimeConfig =>
  req.app.locals.runtime as RuntimeConfig;

/** 会话 Cookie 属性：生产强制 Secure，开发/test 允许 HTTP 本地调试。 */
export const sessionCookie = (config: RuntimeConfig) => ({
  httpOnly: true as const,
  sameSite: 'lax' as const,
  secure: config.production,
  path: '/api/v1',
});
