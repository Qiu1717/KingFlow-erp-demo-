import { it, expect } from 'vitest';
import {
  shippedStatus,
  salesRemainingQuantity,
  settlementStatus,
  settlementSchema,
} from '@kingflow/shared';
it('分批出库状态及剩余数量按所有行计算', () => {
  expect(shippedStatus([{ quantity: 3, shippedQuantity: 0 }])).toBe('APPROVED');
  expect(
    shippedStatus([
      { quantity: 3, shippedQuantity: 3 },
      { quantity: 2, shippedQuantity: 0 },
    ]),
  ).toBe('PARTIAL');
  expect(
    shippedStatus([
      { quantity: 3, shippedQuantity: 3 },
      { quantity: 2, shippedQuantity: 2 },
    ]),
  ).toBe('SHIPPED');
  expect(salesRemainingQuantity({ quantity: 10, shippedQuantity: 3 })).toBe(7);
});
it('应收应付部分结算、完全结算及零价来源状态一致，超额禁止', () => {
  expect(settlementStatus(36000, 0)).toBe('UNSETTLED');
  expect(settlementStatus(36000, 10000)).toBe('PARTIAL');
  expect(settlementStatus(36000, 36000)).toBe('SETTLED');
  expect(settlementStatus(80000, 30000)).toBe('PARTIAL');
  expect(settlementStatus(80000, 80000)).toBe('SETTLED');
  expect(settlementStatus(0, 0)).toBe('SETTLED');
  expect(() => settlementStatus(36000, 36001)).toThrow();
  expect(() => settlementStatus(36000, -1)).toThrow();
  expect(
    settlementSchema.safeParse({
      sourceId: 'x',
      amount: 0.1,
      date: '2026-10-16',
      method: '现金',
    }).success,
  ).toBe(false);
});
