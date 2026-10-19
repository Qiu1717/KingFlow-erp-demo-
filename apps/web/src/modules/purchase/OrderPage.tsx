import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  App,
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { Plus, Search, RefreshCw } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  purchaseStatuses,
  purchaseStatusLabels,
  type PurchaseStatus,
  type PurchaseOrderRecord,
  type PageData,
} from '@kingflow/shared';
import {
  PageHeader,
  FilterBar,
  DataTable,
  MoneyText,
  PermissionGuard,
  ErrorState,
  LoadingState,
} from '../../components/common';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import { get, errorMessage } from '../../services/client';
import { orderAction, orderDetail, options } from './api';
import { OrderForm } from './OrderForm';
import { ReceiptForm } from './ReceiptForm';
import { useAuth } from '../../stores/auth';
export function PurchaseStatusTag({ status }: { status: PurchaseStatus }) {
  const colors = {
    DRAFT: 'default',
    PENDING: 'orange',
    APPROVED: 'blue',
    PARTIAL: 'cyan',
    RECEIVED: 'green',
  };
  return (
    <Tag color={colors[status]} bordered={false}>
      {purchaseStatusLabels[status]}
    </Tag>
  );
}
export function OrderPage() {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<PurchaseOrderRecord | true | null>(
    params.get('new') === '1' ? true : null,
  );
  const query = {
    q: params.get('q') ?? '',
    supplierId: params.get('supplierId') ?? undefined,
    status: params.get('status') ?? undefined,
    dateFrom: params.get('dateFrom') ?? undefined,
    dateTo: params.get('dateTo') ?? undefined,
    page: Number(params.get('page') ?? 1),
    pageSize: Number(params.get('pageSize') ?? 10),
    sortBy: params.get('sortBy') ?? 'createdAt',
    sortOrder: params.get('sortOrder') ?? 'desc',
  };
  const orders = useQuery({
    queryKey: ['purchase-orders', 'list', query],
    queryFn: () =>
      get<PageData<PurchaseOrderRecord>>('/purchase-orders', query),
  });
  const suppliers = useQuery({
    queryKey: ['purchase-suppliers'],
    queryFn: () => options('suppliers'),
  });
  function update(changes: Record<string, string | number | undefined>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      return next;
    });
  }
  return (
    <>
      <PageHeader
        title="采购订单"
        description="从采购计划到分批入库，全程留痕、账实同步。"
        actions={
          <>
            <Button
              icon={<RefreshCw size={15} />}
              loading={orders.isFetching}
              onClick={() => void orders.refetch()}
            >
              刷新
            </Button>
            <PermissionGuard permission="purchase:write">
              <Button
                type="primary"
                icon={<Plus size={16} />}
                onClick={() => setEditing(true)}
              >
                新建采购订单
              </Button>
            </PermissionGuard>
          </>
        }
      />
      <div className="resource-banner">
        <div className="banner-icon">采</div>
        <div>
          <span className="banner-label">采购单据</span>
          <strong>{orders.data?.total ?? '—'}</strong>
          <span className="muted"> 条符合筛选的订单</span>
        </div>
        <div className="banner-tip">
          草稿 → 待审核 → 已审核 → 部分入库 → 已入库
        </div>
      </div>
      <Card className="table-card" styles={{ body: { padding: 0 } }}>
        <FilterBar>
          <Form
            name="purchase-filter"
            form={form}
            layout="inline"
            initialValues={{
              q: query.q,
              supplierId: query.supplierId,
              status: query.status,
              range:
                query.dateFrom && query.dateTo
                  ? [query.dateFrom, query.dateTo]
                  : undefined,
            }}
            onFinish={(values) =>
              update({
                q: values.q,
                status: values.status,
                supplierId: values.supplierId,
                dateFrom: values.range?.[0],
                dateTo: values.range?.[1],
                page: 1,
              })
            }
          >
            <Form.Item name="q">
              <Input
                prefix={<Search size={15} />}
                placeholder="搜索订单编号或供应商"
                allowClear
              />
            </Form.Item>
            <Form.Item name="supplierId">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="全部供应商"
                style={{ width: 175 }}
                options={suppliers.data?.map((s) => ({
                  value: s.id,
                  label: s.name,
                }))}
              />
            </Form.Item>
            <Form.Item name="status">
              <Select
                allowClear
                placeholder="全部状态"
                style={{ width: 125 }}
                options={purchaseStatuses.map((status) => ({
                  value: status,
                  label: purchaseStatusLabels[status],
                }))}
              />
            </Form.Item>
            <Form.Item name="range">
              <DateRangeFilter />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit">
                  查询
                </Button>
                <Button
                  onClick={() => {
                    form.resetFields();
                    form.setFieldsValue({
                      q: '',
                      status: undefined,
                      supplierId: undefined,
                      range: undefined,
                    });
                    setParams({});
                  }}
                >
                  重置
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </FilterBar>
        <div className="table-title">
          采购订单列表{' '}
          <span className="muted">金额单位：人民币元 · 单价保存为成交快照</span>
        </div>
        {orders.isError ? (
          <ErrorState
            error={orders.error}
            retry={() => void orders.refetch()}
          />
        ) : (
          <DataTable<PurchaseOrderRecord>
            loading={orders.isFetching}
            dataSource={orders.data?.items}
            columns={[
              {
                title: '订单编号',
                dataIndex: 'number',
                width: 240,
                sorter: true,
                render: (value: string, row) => (
                  <Button type="link" onClick={() => update({ view: row.id })}>
                    {value}
                  </Button>
                ),
              },
              {
                title: '供应商',
                render: (_, row) => row.supplier.name,
                width: 190,
              },
              {
                title: '入库仓库',
                render: (_, row) => row.warehouse.name,
                width: 130,
              },
              {
                title: '订单日期',
                dataIndex: 'orderDate',
                width: 115,
                sorter: true,
              },
              {
                title: '订单金额',
                dataIndex: 'totalAmount',
                width: 125,
                sorter: true,
                render: (amount: number) => <MoneyText cents={amount} />,
              },
              {
                title: '状态',
                width: 105,
                render: (_, row) => <PurchaseStatusTag status={row.status} />,
              },
              {
                title: '操作',
                width: 120,
                fixed: 'right',
                render: (_, row) => (
                  <Space size={0}>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => update({ view: row.id })}
                    >
                      查看
                    </Button>
                    {row.status === 'DRAFT' && (
                      <PermissionGuard permission="purchase:write">
                        <Button
                          type="link"
                          size="small"
                          onClick={() => setEditing(row)}
                        >
                          编辑
                        </Button>
                      </PermissionGuard>
                    )}
                  </Space>
                ),
              },
            ]}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total: orders.data?.total,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
              onChange: (page, pageSize) => update({ page, pageSize }),
            }}
            onChange={(_p, _f, sorter) => {
              if (!Array.isArray(sorter) && sorter.field)
                update({
                  sortBy: String(sorter.field),
                  sortOrder: sorter.order === 'ascend' ? 'asc' : 'desc',
                  page: 1,
                });
            }}
          />
        )}
      </Card>
      <OrderForm
        open={!!editing}
        order={editing && editing !== true ? editing : undefined}
        onClose={() => setEditing(null)}
      />
      {params.get('view') && (
        <OrderDetail
          id={params.get('view')!}
          onClose={() => update({ view: undefined })}
          onEdit={(order) => {
            update({ view: undefined });
            setEditing(order);
          }}
        />
      )}
    </>
  );
}
function OrderDetail({
  id,
  onClose,
  onEdit,
}: {
  id: string;
  onClose: () => void;
  onEdit: (order: PurchaseOrderRecord) => void;
}) {
  const query = useQuery({
    queryKey: ['purchase-orders', 'detail', id],
    queryFn: () => orderDetail(id),
  });
  const client = useQueryClient();
  const { message } = App.useApp();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const auth = useAuth((state) => state.auth);
  const mutation = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: object }) =>
      orderAction(id, action, body),
    onSuccess: () => {
      void message.success('订单状态已更新');
      setRejectOpen(false);
      setReason('');
      void client.invalidateQueries({ queryKey: ['purchase-orders'] });
      void client.invalidateQueries({ queryKey: ['summary'] });
      void client.invalidateQueries({ queryKey: ['business'] });
      void client.invalidateQueries({ queryKey: ['todos'] });
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const order = query.data;
  const hasPending = !!sessionStorage.getItem(
    `kf-receipt-${auth?.user.id}-${id}`,
  );
  return (
    <Drawer
      title="采购订单详情"
      open
      onClose={() => {
        if (!mutation.isPending && !receiptOpen) onClose();
      }}
      width={980}
      destroyOnHidden
      footer={
        <div className="drawer-footer">
          <Space wrap>
            {order && (
              <>
                {order.status === 'DRAFT' && (
                  <PermissionGuard permission="purchase:write">
                    <Button
                      disabled={mutation.isPending}
                      onClick={() => onEdit(order)}
                    >
                      编辑草稿
                    </Button>
                    <Button
                      type="primary"
                      loading={mutation.isPending}
                      onClick={() => mutation.mutate({ action: 'submit' })}
                    >
                      提交审核
                    </Button>
                  </PermissionGuard>
                )}
                {order.status === 'PENDING' && (
                  <PermissionGuard permission="purchase:approve">
                    <Button
                      disabled={mutation.isPending}
                      onClick={() => setRejectOpen(true)}
                    >
                      驳回
                    </Button>
                    <Button
                      type="primary"
                      loading={mutation.isPending}
                      onClick={() => mutation.mutate({ action: 'approve' })}
                    >
                      审核通过
                    </Button>
                  </PermissionGuard>
                )}
                {(['APPROVED', 'PARTIAL'].includes(order.status) ||
                  hasPending) && (
                  <PermissionGuard permission="receipts:post">
                    <Button type="primary" onClick={() => setReceiptOpen(true)}>
                      {hasPending ? '重试未确认入库' : '创建入库'}
                    </Button>
                  </PermissionGuard>
                )}
              </>
            )}
            <Button
              onClick={onClose}
              disabled={mutation.isPending || receiptOpen}
            >
              关闭详情
            </Button>
          </Space>
        </div>
      }
    >
      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        order && (
          <>
            <div className="document-heading">
              <div>
                <Typography.Title level={4} data-document-number>
                  {order.number}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {order.createdBy.displayName} 创建 ·{' '}
                  {new Date(order.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                </Typography.Text>
              </div>
              <PurchaseStatusTag status={order.status} />
            </div>
            <Descriptions
              bordered
              size="small"
              column={{ xs: 1, sm: 2 }}
              items={[
                {
                  key: 'supplier',
                  label: '供应商',
                  children: order.supplier.name,
                },
                {
                  key: 'warehouse',
                  label: '入库仓库',
                  children: order.warehouse.name,
                },
                { key: 'date', label: '订单日期', children: order.orderDate },
                {
                  key: 'expected',
                  label: '预计到货',
                  children: order.expectedDate ?? '—',
                },
                {
                  key: 'remark',
                  label: '备注',
                  children: order.remark || '—',
                  span: 'filled',
                },
              ]}
            />
            {order.rejectionReason && (
              <Alert
                type="warning"
                showIcon
                message="最近驳回原因"
                description={order.rejectionReason}
                style={{ marginTop: 16 }}
              />
            )}
            <div className="form-section-title" style={{ marginTop: 26 }}>
              商品明细与入库进度
            </div>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              scroll={{ x: 780 }}
              dataSource={order.items}
              columns={[
                {
                  title: '商品',
                  render: (_, item) => (
                    <>
                      {item.productName}
                      <div className="muted">
                        {item.productCode} · {item.specification || '—'} ·{' '}
                        {item.unit}
                      </div>
                    </>
                  ),
                },
                { title: '采购数量', dataIndex: 'quantity' },
                { title: '已入库', dataIndex: 'receivedQuantity' },
                {
                  title: '剩余',
                  render: (_, item) => item.quantity - item.receivedQuantity,
                },
                {
                  title: '单价',
                  render: (_, item) => <MoneyText cents={item.unitPrice} />,
                },
                {
                  title: '金额',
                  render: (_, item) => <MoneyText cents={item.amount} />,
                },
              ]}
            />
            <div className="document-total">
              订单合计{' '}
              <strong>
                <MoneyText cents={order.totalAmount} />
              </strong>
            </div>
            <div className="form-section-title">入库记录</div>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={order.receipts ?? []}
              locale={{ emptyText: '尚无正式入库记录' }}
              columns={[
                {
                  title: '入库单号',
                  render: (_, receipt) => (
                    <Link to={`/goods-receipts?view=${receipt.id}`}>
                      {receipt.number}
                    </Link>
                  ),
                },
                {
                  title: '入库金额',
                  render: (_, receipt) => (
                    <MoneyText cents={receipt.totalAmount} />
                  ),
                },
                {
                  title: '入库时间',
                  render: (_, receipt) =>
                    new Date(receipt.createdAt).toLocaleString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                    }),
                },
                {
                  title: '来源追溯',
                  render: (_, receipt) => (
                    <PermissionGuard permission="payables:read">
                      <Link to={`/payables?receiptId=${receipt.id}`}>
                        查看应付
                      </Link>
                    </PermissionGuard>
                  ),
                },
              ]}
            />
            <ReceiptForm
              order={order}
              open={receiptOpen}
              onClose={() => setReceiptOpen(false)}
            />
          </>
        )
      )}
      <Modal
        title="驳回采购订单"
        open={rejectOpen}
        confirmLoading={mutation.isPending}
        okText="确认驳回"
        cancelText="取消"
        onCancel={() => setRejectOpen(false)}
        onOk={() => {
          if (!reason.trim()) {
            void message.warning('请填写驳回原因');
            return;
          }
          mutation.mutate({ action: 'reject', body: { reason } });
        }}
      >
        <Alert
          type="info"
          message="驳回后订单返回草稿，可修改并重新提交。"
          style={{ marginBottom: 15 }}
        />
        <Input.TextArea
          aria-label="驳回原因"
          placeholder="请输入驳回原因"
          value={reason}
          maxLength={500}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal>
    </Drawer>
  );
}
