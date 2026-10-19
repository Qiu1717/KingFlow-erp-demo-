import { z } from 'zod';
export const MAX_AMOUNT = 2_000_000_000;
export const purchaseStatuses = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'PARTIAL',
  'RECEIVED',
] as const;
export type PurchaseStatus = (typeof purchaseStatuses)[number];
export const purchaseStatusLabels: Record<PurchaseStatus, string> = {
  DRAFT: '草稿',
  PENDING: '待审核',
  APPROVED: '已审核',
  PARTIAL: '部分入库',
  RECEIVED: '已入库',
};
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(value + 'T00:00:00Z');
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, '日期不存在');
export function calculateAmount(
  items: { quantity: number; unitPrice: number }[],
): number {
  let total = 0;
  for (const item of items) {
    const amount = item.quantity * item.unitPrice;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT)
      throw new Error('明细金额超出范围');
    total += amount;
  }
  if (!Number.isSafeInteger(total) || total > MAX_AMOUNT)
    throw new Error('订单金额超出范围');
  return total;
}
export function receivedStatus(
  items: { quantity: number; receivedQuantity: number }[],
): PurchaseStatus {
  if (items.every((item) => item.receivedQuantity === item.quantity))
    return 'RECEIVED';
  return items.some((item) => item.receivedQuantity > 0)
    ? 'PARTIAL'
    : 'APPROVED';
}
export const remainingQuantity = (item: {
  quantity: number;
  receivedQuantity: number;
}) => item.quantity - item.receivedQuantity;
export const purchaseSchema = z
  .object({
    supplierId: z.string().min(1, '请选择供应商'),
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
        message: '预计到货不能早于订单日期',
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
export const receiptSchema = z
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
    { path: ['items'], message: '入库明细不能重复' },
  );
export const documentQuerySchema = z
  .object({
    q: z.string().trim().max(100).default(''),
    status: z.enum(purchaseStatuses).optional(),
    supplierId: z.string().optional(),
    warehouseId: z.string().optional(),
    productId: z.string().optional(),
    orderId: z.string().optional(),
    receiptId: z.string().optional(),
    shipmentId: z.string().optional(),
    adjustmentId: z.string().optional(),
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
export type DocumentQuery = z.infer<typeof documentQuerySchema>;
export type PurchaseInput = z.infer<typeof purchaseSchema>;
export type ReceiptInput = z.infer<typeof receiptSchema>;
export interface PurchaseItem {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  specification: string;
  unit: string;
  quantity: number;
  receivedQuantity: number;
  unitPrice: number;
  amount: number;
}
export interface PurchaseOrderRecord {
  rejectionReason: string;
  id: string;
  number: string;
  supplierId: string;
  warehouseId: string;
  supplier: { name: string };
  warehouse: { name: string };
  orderDate: string;
  expectedDate: string | null;
  remark: string;
  status: PurchaseStatus;
  totalAmount: number;
  version: number;
  createdAt: string;
  createdBy: { displayName: string };
  items: PurchaseItem[];
  receipts?: ReceiptRecord[];
}
export interface ReceiptRecord {
  id: string;
  number: string;
  orderId: string;
  order: { number: string; supplier: { name: string } };
  warehouse: { name: string };
  totalAmount: number;
  remark: string;
  createdAt: string;
  createdBy: { displayName: string };
  items: Omit<PurchaseItem, 'receivedQuantity'>[];
  payable?: {
    id: string;
    number: string;
    originalAmount: number;
    paidAmount: number;
    status: string;
  };
}
export interface StockRecord {
  id: string;
  productId: string;
  warehouseId: string;
  product: { code: string; name: string; unit: string; minStock: number };
  warehouse: { name: string };
  quantity: number;
  updatedAt: string;
}
export interface MovementRecord {
  id: string;
  number: string;
  product: { code: string; name: string };
  warehouse: { name: string };
  type: string;
  quantity: number;
  beforeQuantity: number;
  afterQuantity: number;
  receipt?: { id: string; number: string } | null;
  shipment?: { id: string; number: string } | null;
  adjustment?: { id: string; number: string } | null;
  createdBy: { displayName: string };
  createdAt: string;
}
export interface PayableRecord {
  id: string;
  number: string;
  supplier: { name: string };
  receipt: { id: string; number: string; orderId: string };
  originalAmount: number;
  paidAmount: number;
  status: string;
  createdAt: string;
}
