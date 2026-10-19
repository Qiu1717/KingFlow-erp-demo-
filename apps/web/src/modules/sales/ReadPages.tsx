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
import type { PageData, ShipmentRecord } from '@kingflow/shared';
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
type Kind = 'sales-shipments';
const titles = {
  'sales-shipments': [
    '销售出库',
    '正式出库记录与商品明细，库存和应收同时过账。',
  ],
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
    shipmentId: params.get('shipmentId') ?? undefined,
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
    queryKey: ['sales-warehouses'],
    queryFn: () => options('warehouses'),
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
            {
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
            }
            {
              <Form.Item name="range">
                <DateRangeFilter />
              </Form.Item>
            }
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
          <Typography.Text type="secondary">正式过账记录只读</Typography.Text>
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
      {kind === 'sales-shipments' && params.get('view') && (
        <ShipmentDetail
          id={params.get('view')!}
          onClose={() => update({ view: undefined })}
        />
      )}
    </>
  );
}
export function ReadPages({ kind }: { kind: Kind }) {
  const [, setParams] = useSearchParams();
  return (
    <RecordList<ShipmentRecord>
      kind={kind}
      columns={[
        {
          title: '出库单号',
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
          title: '来源销售订单',
          render: (_, r) => (
            <PermissionGuard permission="sales:read">
              <Link to={`/sales-orders?view=${r.orderId}`}>
                {r.order.number}
              </Link>
            </PermissionGuard>
          ),
        },
        { title: '客户', render: (_, r) => r.order.customer.name },
        { title: '仓库', render: (_, r) => r.warehouse.name },
        {
          title: '出库金额',
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
function ShipmentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['sales-shipments', 'detail', id],
    queryFn: () => get<ShipmentRecord>(`/sales-shipments/${id}`),
  });
  const shipment = detail.data;
  return (
    <Drawer
      title="销售出库详情"
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
        shipment && (
          <>
            <div className="document-heading">
              <Typography.Title level={4}>{shipment.number}</Typography.Title>
              <Tag color="green">已过账 · 只读</Tag>
            </div>
            <Descriptions
              bordered
              column={{ xs: 1, sm: 2 }}
              size="small"
              items={[
                {
                  key: 'order',
                  label: '来源销售单',
                  children: (
                    <PermissionGuard permission="sales:read">
                      <Link to={`/sales-orders?view=${shipment.orderId}`}>
                        {shipment.order.number}
                      </Link>
                    </PermissionGuard>
                  ),
                },
                {
                  key: 'customer',
                  label: '客户',
                  children: shipment.order.customer.name,
                },
                {
                  key: 'warehouse',
                  label: '仓库',
                  children: shipment.warehouse.name,
                },
                {
                  key: 'actor',
                  label: '操作人',
                  children: shipment.createdBy.displayName,
                },
                {
                  key: 'time',
                  label: '出库时间',
                  children: new Date(shipment.createdAt).toLocaleString(
                    'zh-CN',
                    { timeZone: 'Asia/Shanghai' },
                  ),
                },
                {
                  key: 'remark',
                  label: '备注',
                  children: shipment.remark || '—',
                },
              ]}
            />
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              style={{ marginTop: 22 }}
              dataSource={shipment.items}
              columns={[
                { title: '商品', dataIndex: 'productName' },
                { title: '商品编码', dataIndex: 'productCode' },
                { title: '出库数量', dataIndex: 'quantity' },
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
              出库合计{' '}
              <strong>
                <MoneyText cents={shipment.totalAmount} />
              </strong>
            </div>
            <Space>
              <PermissionGuard permission="receivables:read">
                <Link to={`/receivables?shipmentId=${shipment.id}`}>
                  <Button>查看本次应收</Button>
                </Link>
              </PermissionGuard>
              <PermissionGuard permission="inventory:read">
                <Link to={`/stock-movements?shipmentId=${shipment.id}`}>
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
