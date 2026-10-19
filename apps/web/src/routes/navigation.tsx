import {
  LayoutDashboard,
  Database,
  ShoppingCart,
  ShoppingBag,
  Boxes,
  Wallet,
  ChartNoAxesCombined,
  Settings,
} from 'lucide-react';
export const menuGroups = [
  {
    key: 'work',
    label: '工作台',
    icon: LayoutDashboard,
    children: [
      { key: '/', label: '经营概览' },
      { key: '/todos', label: '我的待办' },
    ],
  },
  {
    key: 'master',
    label: '基础资料',
    icon: Database,
    children: [
      { key: '/master/products', label: '商品管理' },
      { key: '/master/categories', label: '商品分类' },
      { key: '/master/customers', label: '客户管理' },
      { key: '/master/suppliers', label: '供应商管理' },
      { key: '/master/warehouses', label: '仓库管理' },
    ],
  },
  {
    key: 'purchase',
    label: '采购管理',
    icon: ShoppingCart,
    children: [
      { key: '/purchase-orders', label: '采购订单' },
      { key: '/goods-receipts', label: '采购入库' },
      { key: '/reports/purchases', label: '采购统计' },
    ],
  },
  {
    key: 'sales',
    label: '销售管理',
    icon: ShoppingBag,
    children: [
      { key: '/sales-orders', label: '销售订单' },
      { key: '/sales-shipments', label: '销售出库' },
      { key: '/reports/sales', label: '销售统计' },
    ],
  },
  {
    key: 'inventory',
    label: '库存管理',
    icon: Boxes,
    children: [
      { key: '/stocks', label: '实时库存' },
      { key: '/stock-movements', label: '库存流水' },
      { key: '/stock-adjustments', label: '库存调整' },
      { key: '/stock-alerts', label: '库存预警' },
    ],
  },
  {
    key: 'finance',
    label: '财务管理',
    icon: Wallet,
    children: [
      { key: '/receivables', label: '应收账款' },
      { key: '/payables', label: '应付账款' },
      { key: '/receipts', label: '收款记录' },
      { key: '/payments', label: '付款记录' },
      { key: '/finance/summary', label: '财务概览' },
    ],
  },
  {
    key: 'reports',
    label: '经营报表',
    icon: ChartNoAxesCombined,
    children: [
      { key: '/visualizations', label: '数据可视化' },
      { key: '/reports/sales', label: '销售分析' },
      { key: '/reports/purchases', label: '采购分析' },
      { key: '/reports/inventory', label: '库存分析' },
      { key: '/reports/finance', label: '往来分析' },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    icon: Settings,
    children: [
      { key: '/system/users', label: '用户管理' },
      { key: '/system/roles', label: '角色权限' },
      { key: '/system/audit-logs', label: '操作日志' },
      { key: '/profile', label: '个人设置' },
    ],
  },
];
export function pageMeta(path: string) {
  for (const group of menuGroups) {
    const item = group.children.find((item) => item.key === path);
    if (item) return { group: group.label, title: item.label };
  }
  return { group: 'KingFlow ERP', title: '页面不存在' };
}
