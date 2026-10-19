import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
export const userSelect = {
  id: true,
  username: true,
  displayName: true,
  status: true,
  roleId: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { id: true, code: true, name: true } },
} as const;
export async function lockSystem(tx: Prisma.TransactionClient) {
  // SQLite serializes writers; obtain its write lock before checking administrator invariants.
  await tx.$executeRaw`UPDATE "Role" SET "permissions" = "permissions" WHERE "code" = 'ADMIN'`;
}
export async function users(query: {
  q: string;
  status?: string;
  roleId?: string;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.UserWhereInput = {
    ...(query.q
      ? {
          OR: [
            { username: { contains: query.q } },
            { displayName: { contains: query.q } },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.roleId ? { roleId: query.roleId } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}
export async function logs(query: {
  actorId?: string;
  action?: string;
  resource?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.resource ? { resource: query.resource } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from
              ? { gte: new Date(query.from + 'T00:00:00+08:00') }
              : {}),
            ...(query.to
              ? {
                  lt: new Date(
                    new Date(query.to + 'T00:00:00+08:00').getTime() + 86400000,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { username: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}
