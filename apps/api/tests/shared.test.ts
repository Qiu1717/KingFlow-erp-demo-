import { describe, it, expect } from 'vitest';
import { can, roleDefinitions, schemas } from '@kingflow/shared';
describe('权限边界与输入约束', () => {
  it('管理员全权、销售仅客户维护、访客只读', () => {
    expect(can(roleDefinitions[0].permissions, 'warehouses:write')).toBe(true);
    expect(can(roleDefinitions[2].permissions, 'products:write')).toBe(false);
    expect(can(roleDefinitions[2].permissions, 'customers:write')).toBe(true);
    expect(can(roleDefinitions[5].permissions, 'master:read')).toBe(true);
    expect(can(roleDefinitions[5].permissions, 'customers:write')).toBe(false);
  });
  it('禁止额外字段与任意状态，编码不接收公式', () => {
    expect(
      schemas.categories.safeParse({
        code: 'X',
        name: '分类',
        status: 'APPROVED',
      }).success,
    ).toBe(false);
    expect(
      schemas.categories.safeParse({
        code: 'X',
        name: '分类',
        createdById: 'fake',
      }).success,
    ).toBe(false);
    expect(
      schemas.categories.safeParse({ code: '=SUM(1)', name: '分类' }).success,
    ).toBe(false);
  });
});
