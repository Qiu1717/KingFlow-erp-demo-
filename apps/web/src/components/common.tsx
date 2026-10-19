import type { ReactNode } from 'react';
import {
  Button,
  Drawer,
  Empty,
  App,
  Result,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
  Grid,
} from 'antd';
import type { TableProps } from 'antd';
import { can } from '@kingflow/shared';
import { useAuth } from '../stores/auth';
import { errorMessage } from '../services/client';
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <Typography.Title level={2}>{title}</Typography.Title>
        <Typography.Text type="secondary">{description}</Typography.Text>
      </div>
      <Space wrap>{actions}</Space>
    </div>
  );
}
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}
export function DataTable<T extends object>(props: TableProps<T>) {
  const mobile = !Grid.useBreakpoint().lg;
  return (
    <>
      {mobile && (
        <div className="mobile-table-hint">左右滑动查看完整资料与操作</div>
      )}
      <Table<T>
        rowKey="id"
        size="middle"
        scroll={{ x: 900 }}
        locale={{ emptyText: <EmptyState /> }}
        {...props}
      />
    </>
  );
}
export function StatusTag({ status }: { status: string }) {
  return (
    <Tag color={status === 'ACTIVE' ? 'success' : 'default'} bordered={false}>
      <span className="status-dot" />
      {status === 'ACTIVE' ? '启用中' : '已停用'}
    </Tag>
  );
}
export function FormDrawer({
  title,
  open,
  onClose,
  children,
  footer,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Drawer
      title={title}
      open={open}
      onClose={onClose}
      width={540}
      // 抽屉最多占满视口高度，内容在 body 内独立滚动，底部操作区始终可见可点。
      height="100%"
      destroyOnHidden
      styles={{
        body: { overflowY: 'auto', paddingBottom: 8 },
        footer: { marginTop: 0 },
      }}
      footer={footer}
    >
      {children}
    </Drawer>
  );
}
export function ConfirmDialog({
  modal,
  title,
  content,
  onConfirm,
}: {
  modal: ReturnType<typeof App.useApp>['modal'];
  title: string;
  content: string;
  onConfirm: () => Promise<unknown>;
}) {
  modal.confirm({
    title,
    content,
    okText: '确定',
    cancelText: '取消',
    onOk: onConfirm,
  });
}
export function MoneyText({ cents }: { cents: number }) {
  return (
    <span className="money">
      {new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        minimumFractionDigits: 2,
      }).format(cents / 100)}
    </span>
  );
}
export function EmptyState() {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description="暂无资料，试试调整筛选条件或新增一条资料"
    />
  );
}
export function LoadingState() {
  return (
    <div className="loading-state">
      <Skeleton active paragraph={{ rows: 5 }} />
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <Result
      status="warning"
      title="暂时无法加载"
      subTitle={errorMessage(error)}
      extra={<Button onClick={retry}>重新加载</Button>}
    />
  );
}
export function PermissionGuard({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const auth = useAuth((state) => state.auth);
  return auth && can(auth.user.role.permissions, permission) ? children : null;
}
