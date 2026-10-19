import { z } from 'zod';
import { dateOnly, MAX_AMOUNT } from './purchase.js';
export const settlementSchema = z
  .object({
    sourceId: z.string().min(1),
    amount: z
      .number()
      .int('金额必须为整数分')
      .positive('金额必须大于0')
      .max(MAX_AMOUNT),
    date: dateOnly,
    method: z.enum(['银行转账', '现金', '其他']),
    remark: z.string().trim().max(500).default(''),
  })
  .strict();
export const financeQuerySchema = z
  .object({
    q: z.string().trim().max(100).default(''),
    status: z.enum(['UNSETTLED', 'PARTIAL', 'SETTLED']).optional(),
    type: z.enum(['RECEIPT', 'PAYMENT']).optional(),
    sourceId: z.string().optional(),
    receiptId: z.string().optional(),
    shipmentId: z.string().optional(),
    customerId: z.string().optional(),
    supplierId: z.string().optional(),
    dateFrom: dateOnly.optional(),
    dateTo: dateOnly.optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine(
    (v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo,
    '结束日期不能早于开始日期',
  );
export function settlementStatus(original: number, settled: number) {
  if (
    original < 0 ||
    settled < 0 ||
    settled > original ||
    !Number.isSafeInteger(original) ||
    !Number.isSafeInteger(settled)
  )
    throw new Error('结算金额不合法');
  return settled === original
    ? 'SETTLED'
    : settled > 0
      ? 'PARTIAL'
      : 'UNSETTLED';
}
export const financeStatusLabels: Record<string, string> = {
  UNSETTLED: '未结清',
  PARTIAL: '部分结清',
  SETTLED: '已结清',
};
export interface SettlementRecordData {
  id: string;
  number: string;
  type: 'RECEIPT' | 'PAYMENT';
  amount: number;
  date: string;
  method: string;
  remark: string;
  createdAt: string;
  receivableId: string | null;
  payableId: string | null;
  receivable: { id: string; number: string; customer: { name: string } } | null;
  payable: { id: string; number: string; supplier: { name: string } } | null;
  createdBy: { displayName: string };
}
export interface FinanceSource {
  id: string;
  number: string;
  originalAmount: number;
  paidAmount?: number;
  receivedAmount?: number;
  status: string;
  createdAt: string;
  supplier?: { name: string };
  customer?: { name: string };
  receipt?: { id: string; number: string; orderId: string };
  shipment?: { id: string; number: string; orderId: string };
  settlements?: SettlementRecordData[];
}
export interface FinanceSummary {
  receivableTotal: number;
  receivableRemaining: number;
  payableTotal: number;
  payableRemaining: number;
  receipts: number;
  payments: number;
}
