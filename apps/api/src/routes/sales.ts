import { Router } from 'express';
import * as c from '../controllers/sales-controller.js';
import { AppError } from '../utils/errors.js';
export const salesRouter = Router();
salesRouter.get('/sales-orders', c.listOrders);
salesRouter.post('/sales-orders', c.saveOrder);
salesRouter.get('/sales-orders/:id', c.getOrder);
salesRouter.patch('/sales-orders/:id', c.saveOrder);
for (const action of ['submit', 'approve', 'reject'] as const)
  salesRouter.post(`/sales-orders/:id/${action}`, c.transition(action));
salesRouter.get('/sales-shipments', c.read('shipmentList'));
salesRouter.post('/sales-shipments', c.postShipment);
salesRouter.get('/sales-shipments/:id', c.getShipment);
salesRouter.all('/sales-shipments/:id', () => {
  throw new AppError(405, 'IMMUTABLE_DOCUMENT', '正式出库单不可修改或删除');
});
