import { Router } from 'express';
import type { AuthData } from '@kingflow/shared';
import * as finance from '../services/finance-service.js';
export const financeRouter = Router();
for (const type of ['receivables', 'payables'] as const) {
  financeRouter.get('/' + type, async (req, res) =>
    res.json({
      data: await finance.sourceList(
        type,
        req.query,
        (res.locals.auth as AuthData).user,
      ),
    }),
  );
  financeRouter.get('/' + type + '/:id', async (req, res) =>
    res.json({
      data: await finance.sourceDetail(
        type,
        req.params.id as string,
        (res.locals.auth as AuthData).user,
      ),
    }),
  );
}
financeRouter.get('/settlements', async (req, res) =>
  res.json({
    data: await finance.records(req.query, (res.locals.auth as AuthData).user),
  }),
);
financeRouter.get('/finance/summary', async (req, res) =>
  res.json({
    data: await finance.summary(req.query, (res.locals.auth as AuthData).user),
  }),
);
for (const [path, type] of [
  ['receipts', 'RECEIPT'],
  ['payments', 'PAYMENT'],
] as const) {
  financeRouter.post('/settlements/' + path, async (req, res) => {
    const result = await finance.settle(
      type,
      req.body,
      req.get('Idempotency-Key'),
      (res.locals.auth as AuthData).user,
    );
    res.status(result.replayed ? 200 : 201).json({ data: result.record });
  });
}
