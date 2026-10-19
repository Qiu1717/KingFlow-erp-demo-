import { useSearchParams, Link } from 'react-router-dom';
import {
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  PageData,
  ReceiptRecord,
  StockRecord,
  MovementRecord,
  PayableRecord,
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
import { get } from '../../services/client';
import { options } from './api';
type Kind = 'goods-receipts' | 'stocks' | 'stock-movements' | 'payables';
const titles: Record<Kind, [string, string]> = {
  'goods-receipts': [
    '采购入库',
    '正式入库记录与商品明细，库存和应付同时过账。',
  ],
  stocks: ['实时库存', '按商品与仓库分别核算，数量来自真实入库记录。'],
  'stock-movements': ['库存流水', '追溯每一次库存变化及来源入库单。'],
  payables: ['应付账款', '由正式采购入库生成；收付款操作将在 Phase 5 开放。'],
};
function RecordList<T extends { id: string }>({
  kind,
  columns,
}: {
  kind: Kind;
  columns: TableProps<T>['columns'];
}) {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm();
  const query = {
    q: params.get('q') ?? '',
    warehouseId: params.get('warehouseId') ?? undefined,
    receiptId: params.get('receiptId') ?? undefined,
    productId: params.get('productId') ?? undefined,
    shipmentId: params.get('shipmentId') ?? undefined,
    adjustmentId: params.get('adjustmentId') ?? undefined,
    orderId: params.get('orderId') ?? undefined,
    dateFrom: params.get('dateFrom') ?? undefined,
    dateTo: params.get('dateTo') ?? undefined,
    page: Number(params.get('page') ?? 1),
    pageSize: Number(params.get('pageSize') ?? 10),
  };
  const records = useQuery({
    queryKey: [kind, 'list', query],
    queryFn: () => get<PageData<T>>(`/${kind}`, query),
  });
  const warehouses = useQuery({
    queryKey: ['purchase-warehouses'],
    queryFn: () => options('warehouses'),
    enabled: kind !== 'payables',
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
        title={titles[kind][0]}
        description={titles[kind][1]}
        actions={
          <Button
            loading={records.isFetching}
            onClick={() => void records.refetch()}
          >
            刷新
          </Button>
        }
      />
      <Card className="table-card" styles={{ body: { padding: 0 } }}>
        <FilterBar>
          <Form
            name={`${kind}-filter`}
            form={form}
            layout="inline"
            initialValues={{
              q: query.q,
              warehouseId: query.warehouseId,
              range:
                query.dateFrom && query.dateTo
                  ? [query.dateFrom, query.dateTo]
                  : undefined,
            }}
            onFinish={(values) =>
              update({
                q: values.q,
                warehouseId: values.warehouseId,
                dateFrom: values.range?.[0],
                dateTo: values.range?.[1],
                page: 1,
              })
            }
          >
            <Form.Item name="q">
              <Input placeholder="搜索单号、名称或编码" allowClear />
            </Form.Item>
            {kind !== 'payables' && (
              <Form.Item name="warehouseId">
                <Select
                  placeholder="全部仓库"
                  allowClear
                  style={{ width: 160 }}
                  options={warehouses.data?.map((w) => ({
                    value: w.id,
                    label: w.name,
                  }))}
                />
              </Form.Item>
            )}
            {kind !== 'stocks' && (
              <Form.Item name="range">
                <DateRangeFilter />
              </Form.Item>
            )}
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
                      warehouseId: undefined,
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
          <span>
            {titles[kind][0]} <Tag>{records.data?.total ?? 0}</Tag>
          </span>
          <Typography.Text type="secondary">
            {kind === 'stocks' ? '库存按仓库独立记录' : '正式过账记录只读'}
          </Typography.Text>
        </div>
        {records.isError ? (
          <ErrorState
            error={records.error}
            retry={() => void records.refetch()}
          />
        ) : (
          <DataTable<T>
            loading={records.isFetching}
            dataSource={records.data?.items}
            columns={columns}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total: records.data?.total,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
              onChange: (page, pageSize) => update({ page, pageSize }),
            }}
          />
        )}
      </Card>
      {kind === 'goods-receipts' && params.get('view') && (
        <ReceiptDetail
          id={params.get('view')!}
          onClose={() => update({ view: undefined })}
        />
      )}
    </>
  );
}
export function ReadPages({ kind }: { kind: Kind }) {
  const [, setParams] = useSearchParams();
  if (kind === 'stocks')
    return (
      <RecordList<StockRecord>
        kind={kind}
        columns={[
          { title: '商品编码', render: (_, r) => r.product.code },
          { title: '商品名称', render: (_, r) => r.product.name },
          { title: '仓库', render: (_, r) => r.warehouse.name },
          { title: '当前库存', dataIndex: 'quantity' },
          { title: '单位', render: (_, r) => r.product.unit },
          { title: '预警数量', render: (_, r) => r.product.minStock },
          {
            title: '库存状态',
            render: (_, r) => (
              <Tag color={r.quantity < r.product.minStock ? 'orange' : 'green'}>
                {r.quantity < r.product.minStock ? '低于预警' : '正常'}
              </Tag>
            ),
          },
        ]}
      />
    );
  if (kind === 'stock-movements')
    return (
      <RecordList<MovementRecord>
        kind={kind}
        columns={[
          {
            title: '流水编号',
            dataIndex: 'number',
            width: 220,
            ellipsis: true,
          },
          {
            title: '商品',
            render: (_, r) => (
              <>
                {r.product.name}
                <div className="muted">{r.product.code}</div>
              </>
            ),
          },
          { title: '仓库', render: (_, r) => r.warehouse.name },
          {
            title: '类型',
            render: (_, r) => (
              <Tag color={r.quantity < 0 ? 'orange' : 'blue'}>
                {r.type === 'PURCHASE_RECEIPT'
                  ? '采购入库'
                  : r.type === 'SALES_SHIPMENT'
                    ? '销售出库'
                    : '库存调整'}
              </Tag>
            ),
          },
          {
            title: '变动数量',
            render: (_, r) => (
              <Typography.Text type={r.quantity < 0 ? 'warning' : 'success'}>
                {r.quantity > 0 ? '+' : ''}
                {r.quantity}
              </Typography.Text>
            ),
          },
          { title: '变动前', dataIndex: 'beforeQuantity' },
          { title: '变动后', dataIndex: 'afterQuantity' },
          {
            title: '来源单据',
            render: (_, r) =>
              r.receipt ? (
                <Link to={`/goods-receipts?view=${r.receipt.id}`}>
                  {r.receipt.number}
                </Link>
              ) : r.shipment ? (
                <Link to={`/sales-shipments?view=${r.shipment.id}`}>
                  {r.shipment.number}
                </Link>
              ) : r.adjustment ? (
                <Link to={`/stock-adjustments?q=${r.adjustment.number}`}>
                  {r.adjustment.number}
                </Link>
              ) : (
                '—'
              ),
          },
          {
            title: '操作人 / 时间',
            render: (_, r) => (
              <>
                {r.createdBy.displayName}
                <div className="muted">
                  {new Date(r.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                </div>
              </>
            ),
          },
        ]}
      />
    );
  if (kind === 'payables')
    return (
      <RecordList<PayableRecord>
        kind={kind}
        columns={[
          { title: '应付单号', dataIndex: 'number', width: 230 },
          { title: '供应商', render: (_, r) => r.supplier.name },
          {
            title: '来源入库',
            render: (_, r) => (
              <Link to={`/goods-receipts?view=${r.receipt.id}`}>
                {r.receipt.number}
              </Link>
            ),
          },
          {
            title: '原始应付',
            render: (_, r) => <MoneyText cents={r.originalAmount} />,
          },
          {
            title: '已付',
            render: (_, r) => <MoneyText cents={r.paidAmount} />,
          },
          {
            title: '未付',
            render: (_, r) => (
              <MoneyText cents={r.originalAmount - r.paidAmount} />
            ),
          },
          {
            title: '状态',
            render: (_, r) => (
              <Tag color={r.status === 'SETTLED' ? 'green' : 'orange'}>
                {r.status === 'SETTLED'
                  ? '已结清'
                  : r.status === 'PARTIAL'
                    ? '部分结清'
                    : '未结清'}
              </Tag>
            ),
          },
        ]}
      />
    );
  return (
    <RecordList<ReceiptRecord>
      kind={kind}
      columns={[
        {
          title: '入库单号',
          dataIndex: 'number',
          width: 240,
          render: (number: string, r) => (
            <Button
              type="link"
              onClick={() =>
                setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set('view', r.id);
                  return next;
                })
              }
            >
              {number}
            </Button>
          ),
        },
        {
          title: '来源采购订单',
          render: (_, r) => (
            <PermissionGuard permission="purchase:read">
              <Link to={`/purchase-orders?view=${r.orderId}`}>
                {r.order.number}
              </Link>
            </PermissionGuard>
          ),
        },
        { title: '供应商', render: (_, r) => r.order.supplier.name },
        { title: '仓库', render: (_, r) => r.warehouse.name },
        {
          title: '入库金额',
          render: (_, r) => <MoneyText cents={r.totalAmount} />,
        },
        {
          title: '过账时间',
          render: (_, r) =>
            new Date(r.createdAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            }),
        },
        { title: '状态', render: () => <Tag color="green">已过账</Tag> },
      ]}
    />
  );
}
function ReceiptDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['goods-receipts', 'detail', id],
    queryFn: () => get<ReceiptRecord>(`/goods-receipts/${id}`),
  });
  const receipt = detail.data;
  return (
    <Drawer
      title="采购入库详情"
      open
      onClose={onClose}
      width={900}
      destroyOnHidden
    >
      {detail.isLoading ? (
        <LoadingState />
      ) : detail.isError ? (
        <ErrorState error={detail.error} retry={() => void detail.refetch()} />
      ) : (
        receipt && (
          <>
            <div className="document-heading">
              <Typography.Title level={4}>{receipt.number}</Typography.Title>
              <Tag color="green">已过账 · 只读</Tag>
            </div>
            <Descriptions
              bordered
              column={{ xs: 1, sm: 2 }}
              size="small"
              items={[
                {
                  key: 'order',
                  label: '来源采购单',
                  children: (
                    <PermissionGuard permission="purchase:read">
                      <Link to={`/purchase-orders?view=${receipt.orderId}`}>
                        {receipt.order.number}
                      </Link>
                    </PermissionGuard>
                  ),
                },
                {
                  key: 'supplier',
                  label: '供应商',
                  children: receipt.order.supplier.name,
                },
                {
                  key: 'warehouse',
                  label: '仓库',
                  children: receipt.warehouse.name,
                },
                {
                  key: 'actor',
                  label: '操作人',
                  children: receipt.createdBy.displayName,
                },
                {
                  key: 'time',
                  label: '入库时间',
                  children: new Date(receipt.createdAt).toLocaleString(
                    'zh-CN',
                    { timeZone: 'Asia/Shanghai' },
                  ),
                },
                {
                  key: 'remark',
                  label: '备注',
                  children: receipt.remark || '—',
                },
              ]}
            />
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              style={{ marginTop: 22 }}
              dataSource={receipt.items}
              columns={[
                { title: '商品', dataIndex: 'productName' },
                { title: '商品编码', dataIndex: 'productCode' },
                { title: '入库数量', dataIndex: 'quantity' },
                {
                  title: '单价',
                  render: (_, r) => <MoneyText cents={r.unitPrice} />,
                },
                {
                  title: '金额',
                  render: (_, r) => <MoneyText cents={r.amount} />,
                },
              ]}
            />
            <div className="document-total">
              入库合计{' '}
              <strong>
                <MoneyText cents={receipt.totalAmount} />
              </strong>
            </div>
            <Space>
              <PermissionGuard permission="payables:read">
                <Link to={`/payables?receiptId=${receipt.id}`}>
                  <Button>查看本次应付</Button>
                </Link>
              </PermissionGuard>
              <PermissionGuard permission="inventory:read">
                <Link to={`/stock-movements?receiptId=${receipt.id}`}>
                  <Button>查看库存流水</Button>
                </Link>
              </PermissionGuard>
            </Space>
          </>
        )
      )}
    </Drawer>
  );
}
