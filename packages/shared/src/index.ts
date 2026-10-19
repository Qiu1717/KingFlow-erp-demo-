import { z } from 'zod';
export * from './purchase.js';
export * from './sales.js';
export * from './finance.js';
export * from './registration.js';

export const resources = [
  'products',
  'categories',
  'customers',
  'suppliers',
  'warehouses',
] as const;
export type Resource = (typeof resources)[number];
export type Permission =
  | 'master:read'
  | `${Resource}:write`
  | 'sales:read'
  | 'sales:write'
  | 'sales:approve'
  | 'shipments:read'
  | 'shipments:post'
  | 'purchase:read'
  | 'purchase:write'
  | 'purchase:approve'
  | 'receipts:read'
  | 'receipts:post'
  | 'inventory:read'
  | 'payables:read'
  | 'receivables:read'
  | 'finance:read'
  | 'settlements:write'
  | 'inventory:adjust'
  | 'system:manage'
  | '*';
export const roleDefinitions = [
  { code: 'ADMIN', name: '系统管理员', username: 'admin', permissions: ['*'] },
  {
    code: 'PURCHASE',
    name: '采购人员',
    username: 'purchase',
    permissions: [
      'master:read',
      'products:write',
      'categories:write',
      'suppliers:write',
      'purchase:read',
      'purchase:write',
      'purchase:approve',
      'receipts:read',
      'inventory:read',
    ],
  },
  {
    code: 'SALES',
    name: '销售人员',
    username: 'sales',
    permissions: [
      'master:read',
      'customers:write',
      'inventory:read',
      'sales:read',
      'sales:write',
      'sales:approve',
      'shipments:read',
    ],
  },
  {
    code: 'WAREHOUSE',
    name: '仓库人员',
    username: 'warehouse',
    permissions: [
      'master:read',
      'purchase:read',
      'receipts:read',
      'receipts:post',
      'sales:read',
      'shipments:read',
      'shipments:post',
      'inventory:read',
      'inventory:adjust',
    ],
  },
  {
    code: 'FINANCE',
    name: '财务人员',
    username: 'finance',
    permissions: [
      'master:read',
      'shipments:read',
      'receipts:read',
      'payables:read',
      'receivables:read',
      'finance:read',
      'settlements:write',
    ],
  },
  {
    code: 'GUEST',
    name: '只读访客',
    username: 'guest',
    permissions: [
      'master:read',
      'purchase:read',
      'receipts:read',
      'sales:read',
      'shipments:read',
      'inventory:read',
    ],
  },
] as const;
export function can(
  permissions: readonly string[],
  permission: string,
): boolean {
  return permissions.includes('*') || permissions.includes(permission);
}
const text = (max: number) => z.string().trim().max(max, `最多${max}个字符`);
const base = {
  code: text(40)
    .min(1, '请输入编码')
    .regex(/^[A-Za-z0-9_-]+$/, '编码仅允许字母、数字、下划线和短横线'),
  name: text(100).min(1, '请输入名称'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
};
const partner = {
  ...base,
  contact: text(60).default(''),
  phone: text(30).default(''),
  email: z
    .union([z.literal(''), z.string().trim().email('邮箱格式不正确').max(120)])
    .default(''),
  address: text(250).default(''),
  remark: text(500).default(''),
};
export const schemas = {
  products: z
    .object({
      ...base,
      categoryId: z.string().min(1, '请选择分类'),
      specification: text(100).default(''),
      unit: text(20).min(1, '请输入单位'),
      purchasePrice: z
        .number()
        .int('金额必须为整数分')
        .min(0)
        .max(1_000_000_000),
      salesPrice: z.number().int('金额必须为整数分').min(0).max(1_000_000_000),
      minStock: z.number().int().min(0).max(1_000_000_000).default(0),
    })
    .strict(),
  categories: z.object(base).strict(),
  customers: z.object(partner).strict(),
  suppliers: z.object(partner).strict(),
  warehouses: z
    .object({
      ...base,
      location: text(250).default(''),
      manager: text(60).default(''),
    })
    .strict(),
};
export const listSchema = z
  .object({
    q: text(100).default(''),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    categoryId: z.string().optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z
      .enum(['code', 'name', 'createdAt', 'updatedAt'])
      .default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type ListQuery = z.infer<typeof listSchema>;
export type MasterInput = z.infer<(typeof schemas)[Resource]>;
export interface MasterRecord {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
  categoryId?: string;
  category?: { id: string; name: string };
  specification?: string;
  unit?: string;
  purchasePrice?: number;
  salesPrice?: number;
  minStock?: number;
  contact?: string;
  phone?: string;
  email?: string;
  address?: string;
  remark?: string;
  location?: string;
  manager?: string;
}
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: { code: string; name: string; permissions: string[] };
}
export interface AuthData {
  user: SessionUser;
  csrfToken: string;
}
export interface PageData<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const labels: Record<Resource, string> = {
  products: '商品管理',
  categories: '商品分类',
  customers: '客户管理',
  suppliers: '供应商管理',
  warehouses: '仓库管理',
};
export const singular: Record<Resource, string> = {
  products: '商品',
  categories: '分类',
  customers: '客户',
  suppliers: '供应商',
  warehouses: '仓库',
};
export interface FieldDefinition {
  key: string;
  label: string;
  kind?: 'money' | 'number' | 'category' | 'textarea';
  required?: boolean;
}
const partnerFields: FieldDefinition[] = [
  { key: 'contact', label: '联系人' },
  { key: 'phone', label: '电话' },
  { key: 'email', label: '邮箱' },
  { key: 'address', label: '地址' },
  { key: 'remark', label: '备注', kind: 'textarea' },
];
export const fields: Record<Resource, FieldDefinition[]> = {
  products: [
    { key: 'categoryId', label: '商品分类', kind: 'category', required: true },
    { key: 'specification', label: '规格型号' },
    { key: 'unit', label: '计量单位', required: true },
    {
      key: 'purchasePrice',
      label: '参考采购价（元）',
      kind: 'money',
      required: true,
    },
    {
      key: 'salesPrice',
      label: '参考销售价（元）',
      kind: 'money',
      required: true,
    },
    { key: 'minStock', label: '最低库存预警', kind: 'number' },
  ],
  categories: [],
  customers: partnerFields,
  suppliers: partnerFields,
  warehouses: [
    { key: 'location', label: '所在位置' },
    { key: 'manager', label: '负责人' },
  ],
};
