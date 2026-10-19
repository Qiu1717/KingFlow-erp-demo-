import type { RequestHandler } from 'express';
import type { AuthData } from '@kingflow/shared';
import * as service from '../services/system-service.js';
import { runtimeOf, sessionCookie } from '../config/context.js';
const user = (res: Parameters<RequestHandler>[1]) =>
  (res.locals.auth as AuthData).user;
export const users: RequestHandler = async (req, res) => {
  res.json({ data: await service.listUsers(req.query, user(res)) });
};
export const reviewRegistration: RequestHandler = async (req, res) => {
  res.json({ data: await service.reviewRegistration(String(req.params.id), req.body, user(res)) });
};
export const roles: RequestHandler = async (_req, res) => {
  res.json({ data: await service.listRoles(user(res)) });
};
export const permissions: RequestHandler = async (_req, res) => {
  await service.listRoles(user(res));
  res.json({ data: service.permissionOptions });
};
export const logs: RequestHandler = async (req, res) => {
  res.json({ data: await service.listLogs(req.query, user(res)) });
};
export const create: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await service.saveUser(req.body, user(res)) });
};
export const update: RequestHandler = async (req, res) => {
  res.json({
    data: await service.saveUser(req.body, user(res), String(req.params.id)),
  });
};
export const resetPassword: RequestHandler = async (req, res) => {
  res.json({
    data: await service.resetPassword(
      String(req.params.id),
      req.body,
      user(res),
    ),
  });
};
export const updateRole: RequestHandler = async (req, res) => {
  res.json({
    data: await service.saveRole(String(req.params.id), req.body, user(res)),
  });
};
export const profile: RequestHandler = async (req, res) => {
  res.json({ data: await service.profile(req.body, user(res)) });
};
export const password: RequestHandler = async (req, res) => {
  const data = await service.changePassword(req.body, user(res));
  res.clearCookie('kf_session', sessionCookie(runtimeOf(req))).json({ data });
};
