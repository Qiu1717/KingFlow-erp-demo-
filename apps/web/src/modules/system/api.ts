import { get, http } from '../../services/client';
export interface SystemRole {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  _count?: { users: number };
}
export interface SystemUser {
  id: string;
  username: string;
  displayName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'REJECTED';
  roleId: string;
  role: { id: string; code: string; name: string };
  createdAt: string;
}
export interface AuditLog {
  id: string;
  actorId: string;
  actor: { username: string; displayName: string };
  action: string;
  resource: string;
  resourceId: string;
  createdAt: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const systemApi = {
  reviewRegistration: (
    id: string,
    data: { decision: 'APPROVE'; roleId: string } | { decision: 'REJECT' },
  ) => http.post(`/system/users/${id}/review`, data),
  users: (params: object) => get<Page<SystemUser>>('/system/users', params),
  roles: () => get<SystemRole[]>('/system/roles'),
  permissions: () => get<string[]>('/system/permissions'),
  logs: (params: object) => get<Page<AuditLog>>('/system/audit-logs', params),
  saveUser: async (data: object, id?: string) =>
    (
      await (id
        ? http.patch('/system/users/' + id, data)
        : http.post('/system/users', data))
    ).data.data as SystemUser,
  resetPassword: (id: string, password: string) =>
    http.post(`/system/users/${id}/reset-password`, { password }),
  saveRole: (id: string, permissions: string[]) =>
    http.patch('/system/roles/' + id, { permissions }),
};
export const permissionLabels: Record<string, string> = {
  'master:read': '基础资料查询',
  'products:write': '商品维护',
  'categories:write': '分类维护',
  'customers:write': '客户维护',
  'suppliers:write': '供应商维护',
  'warehouses:write': '仓库维护',
  'purchase:read': '采购查询',
  'purchase:write': '采购维护',
  'purchase:approve': '采购审核',
  'receipts:read': '入库查询',
  'receipts:post': '采购入库',
  'sales:read': '销售查询',
  'sales:write': '销售维护',
  'sales:approve': '销售审核',
  'shipments:read': '出库查询',
  'shipments:post': '销售出库',
  'inventory:read': '库存查询',
  'inventory:adjust': '库存调整',
  'payables:read': '应付查询',
  'receivables:read': '应收查询',
  'finance:read': '财务概览',
  'settlements:write': '收款付款',
  '*': '全部系统权限',
  'system:manage': '系统管理',
};
