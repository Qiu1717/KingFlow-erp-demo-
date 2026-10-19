import { Router } from 'express';
import * as c from '../controllers/purchase-controller.js';
import { AppError } from '../utils/errors.js';
export const purchaseRouter = Router();
purchaseRouter.get('/purchase-orders', c.listOrders);
purchaseRouter.post('/purchase-orders', c.saveOrder);
purchaseRouter.get('/purchase-orders/:id', c.getOrder);
purchaseRouter.patch('/purchase-orders/:id', c.saveOrder);
for (const action of ['submit', 'approve', 'reject'] as const)
  purchaseRouter.post(`/purchase-orders/:id/${action}`, c.transition(action));
purchaseRouter.get('/goods-receipts', c.read('receiptList'));
purchaseRouter.post('/goods-receipts', c.postReceipt);
purchaseRouter.get('/goods-receipts/:id', c.getReceipt);
purchaseRouter.all('/goods-receipts/:id', () => {
  throw new AppError(405, 'IMMUTABLE_DOCUMENT', '正式入库单不可修改或删除');
});
purchaseRouter.get('/stocks', c.read('stocks'));
purchaseRouter.get('/stock-movements', c.read('movements'));
purchaseRouter.get('/payables', c.read('payables'));
