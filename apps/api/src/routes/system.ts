import { Router } from 'express';
import * as c from '../controllers/system-controller.js';
export const systemRouter = Router();
systemRouter.post('/system/users/:id/review', c.reviewRegistration);
for (const prefix of ['', '/system']) {
  systemRouter.get(prefix + '/users', c.users);
  systemRouter.post(prefix + '/users', c.create);
  systemRouter.patch(prefix + '/users/:id', c.update);
  systemRouter.post(prefix + '/users/:id/reset-password', c.resetPassword);
  systemRouter.get(prefix + '/roles', c.roles);
  systemRouter.patch(prefix + '/roles/:id', c.updateRole);
  systemRouter.get(prefix + '/permissions', c.permissions);
  systemRouter.get(prefix + '/audit-logs', c.logs);
}
systemRouter.patch('/auth/profile', c.profile);
systemRouter.post('/auth/password', c.password);
