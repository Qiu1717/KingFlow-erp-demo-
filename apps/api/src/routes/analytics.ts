import { Router } from 'express';
import * as c from '../controllers/analytics-controller.js';
export const analyticsRouter = Router();
analyticsRouter.get('/dashboard/business', c.business);
analyticsRouter.get('/dashboard/todos', c.todos);
for (const kind of ['sales', 'purchases', 'inventory', 'finance'] as const)
  analyticsRouter.get(`/reports/${kind}`, c.report(kind));
analyticsRouter.get('/stock-alerts', c.alerts);
analyticsRouter.get('/stock-adjustments', c.adjustments);
analyticsRouter.post('/stock-adjustments', c.postAdjustment);
