import type { RequestHandler } from 'express';
import type { AuthData, Resource } from '@kingflow/shared';
import * as service from '../services/master-service.js';
export function controller(
  resource: Resource,
): Record<'list' | 'detail' | 'create' | 'update' | 'remove', RequestHandler> {
  return {
    list: async (req, res) => {
      res.json({
        data: await service.list(
          resource,
          req.query,
          (res.locals.auth as AuthData).user,
        ),
      });
    },
    detail: async (req, res) => {
      res.json({
        data: await service.detail(
          resource,
          String(req.params.id),
          (res.locals.auth as AuthData).user,
        ),
      });
    },
    create: async (req, res) => {
      res.status(201).json({
        data: await service.save(
          resource,
          req.body,
          (res.locals.auth as AuthData).user,
        ),
      });
    },
    update: async (req, res) => {
      res.json({
        data: await service.save(
          resource,
          req.body,
          (res.locals.auth as AuthData).user,
          String(req.params.id),
          req.get('If-Match'),
        ),
      });
    },
    remove: async (req, res) => {
      res.json({
        data: await service.remove(
          resource,
          String(req.params.id),
          (res.locals.auth as AuthData).user,
        ),
      });
    },
  };
}
