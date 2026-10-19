import { z } from 'zod';
import { dateOnly, calculateAmount } from './purchase.js';
export const salesStatuses = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'PARTIAL',
  'SHIPPED',
] as const;
export type SalesStatus = (typeof salesStatuses)[number];
export const salesStatusLabels: Record<SalesStatus, string> = {
  DRAFT: '草稿',
  PENDING: '待审核',
  APPROVED: '已审核',
  PARTIAL: '部分出库',
  SHIPPED: '已出库',
};
export function shippedStatus(
  items: { quantity: number; shippedQuantity: number }[],
): SalesStatus {
  if (items.every((item) => item.shippedQuantity === item.quantity))
    return 'SHIPPED';
  return items.some((item) => item.shippedQuantity > 0)
    ? 'PARTIAL'
    : 'APPROVED';
}
export const salesRemainingQuantity = (item: {
  quantity: number;
  shippedQuantity: number;
}) => item.quantity - item.shippedQuantity;
export const salesSchema = z
  .object({
    customerId: z.string().min(1, '请选择客户'),
    warehouseId: z.string().min(1, '请选择仓库'),
    orderDate: dateOnly,
    version: z.number().int().nonnegative().optional(),
    expectedDate: dateOnly.nullable().optional(),
    remark: z.string().trim().max(500).default(''),
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1),
            quantity: z.number().int().min(1).max(1000000),
            unitPrice: z.number().int().min(0).max(1000000000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.expectedDate && data.expectedDate < data.orderDate)
      ctx.addIssue({
        code: 'custom',
        path: ['expectedDate'],
        message: '预计交货不能早于订单日期',
      });
    if (
      new Set(data.items.map((item) => item.productId)).size !==
      data.items.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: '商品不能重复，请合并数量',
      });
    try {
      calculateAmount(data.items);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: (error as Error).message,
      });
    }
  });
export const shipmentSchema = z
  .object({
    orderId: z.string().min(1),
    remark: z.string().trim().max(500).default(''),
    items: z
      .array(
        z
          .object({
            orderItemId: z.string().min(1),
            quantity: z.number().int().min(1).max(1000000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (data) =>
      new Set(data.items.map((item) => item.orderItemId)).size ===
      data.items.length,
    { path: ['items'], message: '出库明细不能重复' },
  );
export const salesQuerySchema = z
  .object({
    q: z.string().trim().max(100).default(''),
    status: z.enum(salesStatuses).optional(),
    customerId: z.string().optional(),
    warehouseId: z.string().optional(),
    productId: z.string().optional(),
    orderId: z.string().optional(),
    shipmentId: z.string().optional(),
    dateFrom: dateOnly.optional(),
    dateTo: dateOnly.optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z
      .enum(['createdAt', 'orderDate', 'number', 'totalAmount'])
      .default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine(
    (data) => !data.dateFrom || !data.dateTo || data.dateFrom <= data.dateTo,
    { path: ['dateTo'], message: '结束日期不能早于开始日期' },
  );
export type SalesQuery = z.infer<typeof salesQuerySchema>;
export type SalesInput = z.infer<typeof salesSchema>;
export type ShipmentInput = z.infer<typeof shipmentSchema>;
export interface SalesItem {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  specification: string;
  unit: string;
  quantity: number;
  shippedQuantity: number;
  unitPrice: number;
  amount: number;
}
export interface SalesOrderRecord {
  rejectionReason: string;
  id: string;
  number: string;
  customerId: string;
  warehouseId: string;
  customer: { name: string };
  warehouse: { name: string };
  orderDate: string;
  expectedDate: string | null;
  remark: string;
  status: SalesStatus;
  totalAmount: number;
  version: number;
  createdAt: string;
  createdBy: { displayName: string };
  items: SalesItem[];
  shipments?: ShipmentRecord[];
}
export interface ShipmentRecord {
  id: string;
  number: string;
  orderId: string;
  order: { number: string; customer: { name: string } };
  warehouse: { name: string };
  totalAmount: number;
  remark: string;
  createdAt: string;
  createdBy: { displayName: string };
  items: Omit<SalesItem, 'shippedQuantity'>[];
  receivable?: {
    id: string;
    number: string;
    originalAmount: number;
    receivedAmount: number;
    status: string;
  };
}
