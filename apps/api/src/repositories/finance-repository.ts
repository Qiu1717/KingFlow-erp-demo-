import type { Prisma } from '@prisma/client';
export const settlementInclude = {
  receivable: {
    select: { id: true, number: true, customer: { select: { name: true } } },
  },
  payable: {
    select: { id: true, number: true, supplier: { select: { name: true } } },
  },
  createdBy: { select: { displayName: true } },
} satisfies Prisma.SettlementRecordInclude;
export const payableInclude = {
  supplier: { select: { name: true } },
  receipt: { select: { id: true, number: true, orderId: true } },
};
export const receivableInclude = {
  customer: { select: { name: true } },
  shipment: { select: { id: true, number: true, orderId: true } },
};
