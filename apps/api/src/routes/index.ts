import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { resources, roleDefinitions, type AuthData } from '@kingflow/shared';
import { originCheck, requireAuth, csrfCheck } from '../middleware/security.js';
import { runtimeOf, sessionCookie } from '../config/context.js';
import * as auth from '../services/auth-service.js';
import { register } from '../services/registration-service.js';
import { AppError } from '../utils/errors.js';
import * as master from '../services/master-service.js';
import { controller } from '../controllers/master-controller.js';
import { salesRouter } from './sales.js';
import { purchaseRouter } from './purchase.js';
import { financeRouter } from './finance.js';
import { systemRouter } from './system.js';
import { analyticsRouter } from './analytics.js';
import { prisma } from '../repositories/db.js';
export const router = Router();
router.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok' } });
});
router.get('/ready', async (_req, res) => {
  try {
    await prisma.$transaction([prisma.user.count(), prisma.stockBalance.count(), prisma.receivable.count(), prisma.payable.count()]);
    res.json({ data: { status: 'ready' } });
  } catch {
    res.status(503).json({ error: { code: 'DATABASE_NOT_READY', message: '数据库暂未就绪' } });
  }
});
router.use(originCheck);
router.get('/auth/options', (req, res) => {
  res.json({ data: { registrationEnabled: runtimeOf(req).registrationEnabled, registrationMode: 'approval' } });
});
router.post('/auth/register', rateLimit({
  windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ error: { code: 'REGISTER_RATE_LIMIT', message: '注册尝试过多，请一小时后重试' } }); },
}), async (req, res) => {
  if (!runtimeOf(req).registrationEnabled) throw new AppError(403, 'REGISTRATION_DISABLED', '注册功能已关闭，请联系管理员');
  res.status(201).json({ data: await register(req.body) });
});
router.post(
  '/auth/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'LOGIN_RATE_LIMIT',
          message: '登录尝试过多，请稍后再试',
        },
      });
    },
  }),
  async (req, res) => {
    const result = await auth.login(req.body, req.cookies?.kf_session, runtimeOf(req).production);
    res.cookie('kf_session', result.token, {
      ...sessionCookie(runtimeOf(req)),
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ data: result.data });
  },
);
router.use(requireAuth, csrfCheck);
router.use(financeRouter);
router.use(systemRouter);
router.use(analyticsRouter);
router.use(purchaseRouter);
router.use(salesRouter);
router.get('/auth/me', (_req, res) => {
  res.json({ data: res.locals.auth });
});
router.post('/auth/logout', async (req, res) => {
  await auth.logout(
    req.cookies.kf_session,
    (res.locals.auth as AuthData).user.id,
  );
  res
    .clearCookie('kf_session', sessionCookie(runtimeOf(req)))
    .json({ data: { success: true } });
});
router.get('/dashboard/summary', async (_req, res) => {
  res.json({ data: await master.summary((res.locals.auth as AuthData).user) });
});
router.get('/system/reference', (_req, res) => {
  res.json({
    data: roleDefinitions.map(({ code, name, permissions }) => ({
      code,
      name,
      permissions,
    })),
  });
});
router.get('/products/export.csv', async (req, res) => {
  const output = await master.exportProducts(
    req.query,
    (res.locals.auth as AuthData).user,
  );
  res
    .type('text/csv; charset=utf-8')
    .attachment('kingflow-products.csv')
    .send(output);
});
for (const resource of resources) {
  const c = controller(resource);
  router.get(`/${resource}`, c.list);
  router.post(`/${resource}`, c.create);
  router.get(`/${resource}/:id`, c.detail);
  router.patch(`/${resource}/:id`, c.update);
  router.delete(`/${resource}/:id`, c.remove);
}
