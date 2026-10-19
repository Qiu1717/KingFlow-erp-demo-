import type { RequestHandler } from 'express';
import type { AuthData } from '@kingflow/shared';
import * as service from '../services/purchase-service.js';
export const listOrders: RequestHandler = async (req, res) => {
  res.json({
    data: await service.orderList(
      req.query,
      (res.locals.auth as AuthData).user,
    ),
  });
};
export const getOrder: RequestHandler = async (req, res) => {
  res.json({
    data: await service.orderDetail(
      String(req.params.id),
      (res.locals.auth as AuthData).user,
    ),
  });
};
export const saveOrder: RequestHandler = async (req, res) => {
  res.status(req.params.id ? 200 : 201).json({
    data: await service.saveOrder(
      req.body,
      (res.locals.auth as AuthData).user,
      req.params.id ? String(req.params.id) : undefined,
    ),
  });
};
export const transition =
  (action: 'submit' | 'approve' | 'reject'): RequestHandler =>
  async (req, res) => {
    res.json({
      data: await service.transition(
        String(req.params.id),
        action,
        req.body,
        (res.locals.auth as AuthData).user,
      ),
    });
  };
export const postReceipt: RequestHandler = async (req, res) => {
  const result = await service.postReceipt(
    req.body,
    req.get('Idempotency-Key'),
    (res.locals.auth as AuthData).user,
  );
  res.status(result.replayed ? 200 : 201).json({ data: result.receipt });
};
export const getReceipt: RequestHandler = async (req, res) => {
  res.json({
    data: await service.receiptDetail(
      String(req.params.id),
      (res.locals.auth as AuthData).user,
    ),
  });
};
export const read =
  (kind: 'receiptList' | 'stocks' | 'movements' | 'payables'): RequestHandler =>
  async (req, res) => {
    res.json({
      data: await service[kind](req.query, (res.locals.auth as AuthData).user),
    });
  };
