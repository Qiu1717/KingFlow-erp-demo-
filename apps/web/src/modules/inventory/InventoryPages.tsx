import { createUuid } from '../../utils/uuid';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';

import type { PageData } from '@kingflow/shared';
import {
  DataTable,
  ErrorState,
  FilterBar,
  PageHeader,
  PermissionGuard,
} from '../../components/common';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import { get, http, errorMessage } from '../../services/client';
import { options } from '../purchase/api';
import { useAuth } from '../../stores/auth';
interface Row {
  id: string;
  number: string;
  quantity: number;
  shortage: number;
  reason: string;
  createdAt: string;
  product: {
    id?: string;
    code: string;
    name: string;
    unit?: string;
    minStock?: number;
  };
  warehouse: { id?: string; name: string };
  productId: string;
  warehouseId: string;
  createdBy?: { displayName: string };
}
interface Body {
  productId: string;
  warehouseId: string;
  quantity: number;
  reason: string;
}
function validBody(value: unknown): value is Body {
  if (!value || typeof value !== 'object') return false;
  const v = value as Body;
  return (
    typeof v.productId === 'string' &&
    v.productId.length > 0 &&
    typeof v.warehouseId === 'string' &&
    v.warehouseId.length > 0 &&
    Number.isInteger(v.quantity) &&
    v.quantity !== 0 &&
    Math.abs(v.quantity) <= 2000000000 &&
    typeof v.reason === 'string' &&
    v.reason.trim().length > 0 &&
    v.reason.length <= 500
  );
}
export function StockAlertsPage() {
  return <InventoryPage alerts />;
}
export function StockAdjustmentsPage() {
  return <InventoryPage />;
}
function InventoryPage({ alerts = false }: { alerts?: boolean }) {
  const [filters, setFilters] = useState({
    q: '',
    warehouseId: undefined as string | undefined,
    dateFrom: undefined as string | undefined,
    dateTo: undefined as string | undefined,
    page: 1,
    pageSize: 20,
  });
  const [open, setOpen] = useState(false),
    [form] = Form.useForm();
  const endpoint = alerts ? 'stock-alerts' : 'stock-adjustments';
  const records = useQuery({
    queryKey: [endpoint, filters],
    queryFn: () => get<PageData<Row>>('/' + endpoint, filters),
  });
  const warehouses = useQuery({
    queryKey: ['purchase-warehouses'],
    queryFn: () => options('warehouses'),
  });
  return (
    <>
      <PageHeader
        title={alerts ? '库存预警' : '库存调整'}
        description={
          alerts
            ? '启用商品 × 启用仓库，未建立余额的组合按零库存计算。'
            : '盘点盈亏以带符号的整数数量调整，正式记录不可修改；原因、操作者和流水完整留存。'
        }
        actions={
          <Space>
            <Button onClick={() => void records.refetch()}>刷新</Button>
            <PermissionGuard permission="inventory:adjust">
              <Button type="primary" onClick={() => setOpen(true)}>
                新建库存调整
              </Button>
            </PermissionGuard>
          </Space>
        }
      />
      <Card className="table-card" styles={{ body: { padding: 0 } }}>
        <FilterBar>
          <Form
            form={form}
            layout="inline"
            onFinish={(v) =>
              setFilters({
                ...filters,
                q: v.q ?? '',
                warehouseId: v.warehouseId,
                dateFrom: v.range?.[0],
                dateTo: v.range?.[1],
                page: 1,
              })
            }
          >
            <Form.Item name="q">
              <Input allowClear placeholder="搜索商品、单号或原因" />
            </Form.Item>
            <Form.Item name="warehouseId">
              <Select
                allowClear
                placeholder="全部仓库"
                style={{ width: 170 }}
                options={warehouses.data?.map((r) => ({
                  value: r.id,
                  label: r.name,
                }))}
              />
            </Form.Item>
            {!alerts && (
              <Form.Item name="range">
                <DateRangeFilter />
              </Form.Item>
            )}
            <Form.Item>
              <Button type="primary" htmlType="submit">
                查询
              </Button>
            </Form.Item>
          </Form>
        </FilterBar>
        {records.isError ? (
          <ErrorState
            error={records.error}
            retry={() => void records.refetch()}
          />
        ) : (
          <DataTable<Row>
            loading={records.isFetching}
            dataSource={records.data?.items}
            columns={[
              ...(!alerts ? [{ title: '调整单号', dataIndex: 'number' }] : []),
              { title: '商品编码', render: (_, r) => r.product.code },
              { title: '商品名称', render: (_, r) => r.product.name },
              { title: '仓库', render: (_, r) => r.warehouse.name },
              {
                title: alerts ? '当前库存' : '调整数量',
                dataIndex: 'quantity',
                render: (n: number) => (
                  <Tag color={n < 0 ? 'orange' : alerts ? 'red' : 'blue'}>
                    {n > 0 && !alerts ? '+' : ''}
                    {n}
                  </Tag>
                ),
              },
              ...(alerts
                ? [
                    {
                      title: '预警线',
                      render: (_: unknown, r: Row) => r.product.minStock,
                    },
                    { title: '缺口', dataIndex: 'shortage' },
                  ]
                : [
                    { title: '调整原因', dataIndex: 'reason' },
                    {
                      title: '操作者',
                      render: (_: unknown, r: Row) => r.createdBy?.displayName,
                    },
                    {
                      title: '时间',
                      dataIndex: 'createdAt',
                      render: (v: string) =>
                        new Date(v).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                        }),
                    },
                  ]),
              {
                title: '追溯',
                render: (_, r) => (
                  <Link
                    to={`/stock-movements?productId=${r.productId}&warehouseId=${r.warehouseId}`}
                  >
                    库存流水
                  </Link>
                ),
              },
            ]}
            pagination={{
              current: filters.page,
              pageSize: filters.pageSize,
              total: records.data?.total,
              showSizeChanger: true,
              onChange: (page, pageSize) =>
                setFilters({ ...filters, page, pageSize }),
            }}
          />
        )}
      </Card>
      {open && <AdjustmentForm onClose={() => setOpen(false)} />}
    </>
  );
}
function AdjustmentForm({ onClose }: { onClose: () => void }) {
  const userId = useAuth((s) => s.auth?.user.id),
    storageKey = `kf-adjustment-${userId}`;
  const [form] = Form.useForm<Body>();
  const { message } = App.useApp();
  const client = useQueryClient();
  const [attempt, setAttempt] = useState<{ key: string; body: Body } | null>(
    () => {
      try {
        const data = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
        return data && typeof data.key === 'string' && validBody(data.body)
          ? data
          : null;
      } catch {
        return null;
      }
    },
  );
  const [error, setError] = useState('');
  const products = useQuery({
    queryKey: ['inventory-products'],
    queryFn: () => options('products'),
  });
  const warehouses = useQuery({
    queryKey: ['purchase-warehouses'],
    queryFn: () => options('warehouses'),
  });
  const mutation = useMutation({
    mutationFn: (a: { key: string; body: Body }) =>
      http.post('/stock-adjustments', a.body, {
        headers: { 'Idempotency-Key': a.key },
      }),
    onSuccess: () => {
      sessionStorage.removeItem(storageKey);
      for (const key of [
        'stocks',
        'stock-movements',
        'stock-adjustments',
        'stock-alerts',
        'business',
        'todos',
      ])
        void client.invalidateQueries({ queryKey: [key] });
      void message.success('库存调整已过账');
      onClose();
    },
    onError: (e) => {
      setError(errorMessage(e));
      if (
        axios.isAxiosError(e) &&
        [
          'VALIDATION_ERROR',
          'INVALID_PRODUCT',
          'INVALID_WAREHOUSE',
          'INVALID_QUANTITY',
          'INSUFFICIENT_STOCK',
          'STOCK_OVERFLOW',
        ].includes(e.response?.data?.error?.code)
      ) {
        sessionStorage.removeItem(storageKey);
        setAttempt(null);
      }
    },
  });
  function submit(body: Body) {
    const next = attempt ?? { key: createUuid(), body };
    if (!validBody(next.body)) {
      setError('请选择商品和仓库，数量为非零整数，原因不能为空');
      return;
    }
    sessionStorage.setItem(storageKey, JSON.stringify(next));
    setAttempt(next);
    setError('');
    mutation.mutate(next);
  }
  return (
    <Drawer
      open
      title="新建库存调整"
      width={520}
      onClose={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={mutation.isPending}
            onClick={() => (attempt ? submit(attempt.body) : form.submit())}
          >
            {attempt ? '重试原请求' : '确认过账'}
          </Button>
        </Space>
      }
    >
      {attempt && (
        <Alert
          type="warning"
          showIcon
          message="存在结果未确认的请求，重试会使用原始内容及幂等键。"
          style={{ marginBottom: 16 }}
        />
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 16 }}
        />
      )}
      <Form
        name="stock-adjustment-form"
        form={form}
        layout="vertical"
        initialValues={attempt?.body}
        disabled={!!attempt || mutation.isPending}
        onFinish={submit}
      >
        <Form.Item
          label="商品"
          name="productId"
          rules={[{ required: true, message: '请选择商品' }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={products.data?.map((p) => ({
              value: p.id,
              label: `${p.code} · ${p.name}`,
            }))}
          />
        </Form.Item>
        <Form.Item
          label="仓库"
          name="warehouseId"
          rules={[{ required: true, message: '请选择仓库' }]}
        >
          <Select
            options={warehouses.data?.map((w) => ({
              value: w.id,
              label: w.name,
            }))}
          />
        </Form.Item>
        <Form.Item
          label="调整数量"
          name="quantity"
          extra="盘盈填正数，盘亏填负数。"
          rules={[
            { required: true, message: '请输入调整数量' },
            {
              validator: (_, v) =>
                Number.isInteger(v) && v !== 0
                  ? Promise.resolve()
                  : Promise.reject(new Error('必须为非零整数')),
            },
          ]}
        >
          <InputNumber
            min={-2000000000}
            max={2000000000}
            precision={0}
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item
          label="调整原因"
          name="reason"
          rules={[
            { required: true, whitespace: true, message: '请填写调整原因' },
          ]}
        >
          <Input.TextArea rows={4} maxLength={500} showCount />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
