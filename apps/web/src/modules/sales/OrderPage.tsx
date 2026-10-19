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
  salesStatuses,
  salesStatusLabels,
  type SalesStatus,
  type SalesOrderRecord,
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
import { ShipmentForm } from './ShipmentForm';
import { useAuth } from '../../stores/auth';
export function SalesStatusTag({ status }: { status: SalesStatus }) {
  const colors = {
    DRAFT: 'default',
    PENDING: 'orange',
    APPROVED: 'blue',
    PARTIAL: 'cyan',
    SHIPPED: 'green',
  };
  return (
    <Tag color={colors[status]} bordered={false}>
      {salesStatusLabels[status]}
    </Tag>
  );
}
export function OrderPage() {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<SalesOrderRecord | true | null>(
    params.get('new') === '1' ? true : null,
  );
  const query = {
    q: params.get('q') ?? '',
    customerId: params.get('customerId') ?? undefined,
    status: params.get('status') ?? undefined,
    dateFrom: params.get('dateFrom') ?? undefined,
    dateTo: params.get('dateTo') ?? undefined,
    page: Number(params.get('page') ?? 1),
    pageSize: Number(params.get('pageSize') ?? 10),
    sortBy: params.get('sortBy') ?? 'createdAt',
    sortOrder: params.get('sortOrder') ?? 'desc',
  };
  const orders = useQuery({
    queryKey: ['sales-orders', 'list', query],
    queryFn: () => get<PageData<SalesOrderRecord>>('/sales-orders', query),
  });
  const customers = useQuery({
    queryKey: ['sales-customers'],
    queryFn: () => options('customers'),
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
        title="销售订单"
        description="从销售计划到分批出库，全程留痕、账实同步。"
        actions={
          <>
            <Button
              icon={<RefreshCw size={15} />}
              loading={orders.isFetching}
              onClick={() => void orders.refetch()}
            >
              刷新
            </Button>
            <PermissionGuard permission="sales:write">
              <Button
                type="primary"
                icon={<Plus size={16} />}
                onClick={() => setEditing(true)}
              >
                新建销售订单
              </Button>
            </PermissionGuard>
          </>
        }
      />
      <div className="resource-banner">
        <div className="banner-icon">采</div>
        <div>
          <span className="banner-label">销售单据</span>
          <strong>{orders.data?.total ?? '—'}</strong>
          <span className="muted"> 条符合筛选的订单</span>
        </div>
        <div className="banner-tip">
          草稿 → 待审核 → 已审核 → 部分出库 → 已出库
        </div>
      </div>
      <Card className="table-card" styles={{ body: { padding: 0 } }}>
        <FilterBar>
          <Form
            name="sales-filter"
            form={form}
            layout="inline"
            initialValues={{
              q: query.q,
              customerId: query.customerId,
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
                customerId: values.customerId,
                dateFrom: values.range?.[0],
                dateTo: values.range?.[1],
                page: 1,
              })
            }
          >
            <Form.Item name="q">
              <Input
                prefix={<Search size={15} />}
                placeholder="搜索订单编号或客户"
                allowClear
              />
            </Form.Item>
            <Form.Item name="customerId">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="全部客户"
                style={{ width: 175 }}
                options={customers.data?.map((s) => ({
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
                options={salesStatuses.map((status) => ({
                  value: status,
                  label: salesStatusLabels[status],
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
                      customerId: undefined,
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
          销售订单列表{' '}
          <span className="muted">金额单位：人民币元 · 单价保存为成交快照</span>
        </div>
        {orders.isError ? (
          <ErrorState
            error={orders.error}
            retry={() => void orders.refetch()}
          />
        ) : (
          <DataTable<SalesOrderRecord>
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
                title: '客户',
                render: (_, row) => row.customer.name,
                width: 190,
              },
              {
                title: '出库仓库',
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
                render: (_, row) => <SalesStatusTag status={row.status} />,
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
                      <PermissionGuard permission="sales:write">
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
  onEdit: (order: SalesOrderRecord) => void;
}) {
  const query = useQuery({
    queryKey: ['sales-orders', 'detail', id],
    queryFn: () => orderDetail(id),
  });
  const client = useQueryClient();
  const { message } = App.useApp();
  const [shipmentOpen, setShipmentOpen] = useState(false);
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
      void client.invalidateQueries({ queryKey: ['sales-orders'] });
      void client.invalidateQueries({ queryKey: ['summary'] });
      void client.invalidateQueries({ queryKey: ['business'] });
      void client.invalidateQueries({ queryKey: ['todos'] });
    },
    onError: (error) => void message.error(errorMessage(error)),
  });
  const order = query.data;
  const hasPending = !!sessionStorage.getItem(
    `kf-shipment-${auth?.user.id}-${id}`,
  );
  return (
    <Drawer
      title="销售订单详情"
      open
      onClose={() => {
        if (!mutation.isPending && !shipmentOpen) onClose();
      }}
      width={980}
      destroyOnHidden
      footer={
        <div className="drawer-footer">
          <Space wrap>
            {order && (
              <>
                {order.status === 'DRAFT' && (
                  <PermissionGuard permission="sales:write">
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
                  <PermissionGuard permission="sales:approve">
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
                  <PermissionGuard permission="shipments:post">
                    <Button
                      type="primary"
                      onClick={() => setShipmentOpen(true)}
                    >
                      {hasPending ? '重试未确认出库' : '创建出库'}
                    </Button>
                  </PermissionGuard>
                )}
              </>
            )}
            <Button
              onClick={onClose}
              disabled={mutation.isPending || shipmentOpen}
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
              <SalesStatusTag status={order.status} />
            </div>
            <Descriptions
              bordered
              size="small"
              column={{ xs: 1, sm: 2 }}
              items={[
                {
                  key: 'customer',
                  label: '客户',
                  children: order.customer.name,
                },
                {
                  key: 'warehouse',
                  label: '出库仓库',
                  children: order.warehouse.name,
                },
                { key: 'date', label: '订单日期', children: order.orderDate },
                {
                  key: 'expected',
                  label: '预计交货',
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
              商品明细与出库进度
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
                { title: '销售数量', dataIndex: 'quantity' },
                { title: '已出库', dataIndex: 'shippedQuantity' },
                {
                  title: '剩余',
                  render: (_, item) => item.quantity - item.shippedQuantity,
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
            <div className="form-section-title">出库记录</div>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={order.shipments ?? []}
              locale={{ emptyText: '尚无正式出库记录' }}
              columns={[
                {
                  title: '出库单号',
                  render: (_, shipment) => (
                    <Link to={`/sales-shipments?view=${shipment.id}`}>
                      {shipment.number}
                    </Link>
                  ),
                },
                {
                  title: '出库金额',
                  render: (_, shipment) => (
                    <MoneyText cents={shipment.totalAmount} />
                  ),
                },
                {
                  title: '出库时间',
                  render: (_, shipment) =>
                    new Date(shipment.createdAt).toLocaleString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                    }),
                },
                {
                  title: '来源追溯',
                  render: (_, shipment) => (
                    <PermissionGuard permission="receivables:read">
                      <Link to={`/receivables?shipmentId=${shipment.id}`}>
                        查看应收
                      </Link>
                    </PermissionGuard>
                  ),
                },
              ]}
            />
            <ShipmentForm
              order={order}
              open={shipmentOpen}
              onClose={() => setShipmentOpen(false)}
            />
          </>
        )
      )}
      <Modal
        title="驳回销售订单"
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
