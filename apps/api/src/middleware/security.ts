import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { authenticate } from '../services/auth-service.js';
import { AppError } from '../utils/errors.js';
import { runtimeOf } from '../config/context.js';
import type { AuthData } from '@kingflow/shared';
export const originCheck: RequestHandler = (req, _res, next) => {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.get('Origin') !== runtimeOf(req).appOrigin
  )
    throw new AppError(403, 'INVALID_ORIGIN', '请求来源不受信任');
  next();
};
export const requireAuth: RequestHandler = async (req, res, next) => {
  res.locals.auth = await authenticate(req.cookies?.kf_session);
  next();
};
export const csrfCheck: RequestHandler = (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const expected = (res.locals.auth as AuthData).csrfToken;
    const token = req.get('X-CSRF-Token') ?? '';
    if (
      !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      throw new AppError(403, 'INVALID_CSRF', '安全令牌无效，请刷新页面后重试');
  }
  next();
};
