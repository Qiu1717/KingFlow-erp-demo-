export interface Summary {
  products: number;
  categories: number;
  customers: number;
  suppliers: number;
  warehouses: number;
  activeProducts: number;
  recentLogs: {
    id: string;
    action: string;
    resource: string;
    resourceId: string;
    createdAt: string;
    actor: { displayName: string };
  }[];
}
export const resourceNames: Record<string, string> = {
  'sales-orders': '销售订单',
  'sales-shipments': '销售出库',
  'stock-adjustments': '库存调整',
  settlements: '收付款',
  users: '用户',
  roles: '角色',
  'purchase-orders': '采购订单',
  'goods-receipts': '采购入库',
  products: '商品',
  categories: '分类',
  customers: '客户',
  suppliers: '供应商',
  warehouses: '仓库',
  auth: '账号',
};
export const actionNames: Record<string, string> = {
  SETTLE: '结算',
  RESET_PASSWORD: '重置密码',
  CHANGE_PASSWORD: '修改密码',
  SUBMIT: '提交',
  APPROVE: '审核',
  REJECT: '驳回',
  POST: '过账',
  CREATE: '新增',
  UPDATE: '更新',
  DELETE: '删除',
  LOGIN: '登录',
  LOGOUT: '退出',
};
