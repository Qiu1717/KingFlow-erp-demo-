import type { RequestHandler } from 'express';
import type { AuthData } from '@kingflow/shared';
import * as service from '../services/analytics-service.js';
export const business: RequestHandler = async (_req, res) => {
  res.json({
    data: await service.business((res.locals.auth as AuthData).user),
  });
};
export const todos: RequestHandler = async (_req, res) => {
  res.json({ data: await service.todos((res.locals.auth as AuthData).user) });
};
export const report =
  (kind: service.ReportKind): RequestHandler =>
  async (req, res) => {
    const result = await service.report(
      kind,
      req.query,
      (res.locals.auth as AuthData).user,
    );
    if (typeof result === 'string')
      res
        .type('text/csv; charset=utf-8')
        .attachment(`kingflow-${kind}.csv`)
        .send(result);
    else res.json({ data: result });
  };
export const alerts: RequestHandler = async (req, res) => {
  res.json({
    data: await service.stockAlerts(
      req.query,
      (res.locals.auth as AuthData).user,
    ),
  });
};
export const adjustments: RequestHandler = async (req, res) => {
  res.json({
    data: await service.adjustments(
      req.query,
      (res.locals.auth as AuthData).user,
    ),
  });
};
export const postAdjustment: RequestHandler = async (req, res) => {
  const result = await service.postAdjustment(
    req.body,
    req.get('Idempotency-Key'),
    (res.locals.auth as AuthData).user,
  );
  res.status(result.replayed ? 200 : 201).json({ data: result.adjustment });
};
