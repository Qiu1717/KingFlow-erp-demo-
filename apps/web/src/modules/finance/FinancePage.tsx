import { createUuid } from '../../utils/uuid';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import {
  financeStatusLabels,
  type FinanceSource,
  type FinanceSummary,
  type PageData,
  type SettlementRecordData,
} from '@kingflow/shared';
import {
  PageHeader,
  FilterBar,
  DataTable,
  MoneyText,
  ErrorState,
  LoadingState,
  PermissionGuard,
} from '../../components/common';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import { priceInCents } from '../../components/DocumentItemsTable';
import { get, http, errorMessage } from '../../services/client';
import { useAuth } from '../../stores/auth';
type Kind = 'receivables' | 'payables' | 'receipts' | 'payments' | 'overview';
const names: Record<Kind, string> = {
  receivables: '应收账款',
  payables: '应付账款',
  receipts: '收款记录',
  payments: '付款记录',
  overview: '财务概览',
};
type Attempt = {
  key: string;
  storageKey: string;
  body: {
    sourceId: string;
    amount: number;
    date: string;
    method: string;
    remark: string;
  };
};
const statusTag = (value: string) => (
  <Tag
    color={
      value === 'SETTLED'
        ? 'success'
        : value === 'PARTIAL'
          ? 'processing'
          : 'warning'
    }
  >
    {financeStatusLabels[value]}
  </Tag>
);
const settledAmount = (row: FinanceSource) =>
  row.receivedAmount ?? row.paidAmount ?? 0;
export function FinancePage({ kind }: { kind: Kind }) {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm();
  const [source, setSource] = useState<string>();
  const [dates, setDates] = useState<[string, string]>();
  const q = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? undefined,
    receiptId: params.get('receiptId') ?? undefined,
    shipmentId: params.get('shipmentId') ?? undefined,
    page: Number(params.get('page') ?? 1),
    pageSize: 10,
    dateFrom: dates?.[0],
    dateTo: dates?.[1],
    ...(kind === 'receipts'
      ? { type: 'RECEIPT' }
      : kind === 'payments'
        ? { type: 'PAYMENT' }
        : {}),
  };
  const list = useQuery({
    queryKey: ['finance', kind, q],
    queryFn: () =>
      get<PageData<FinanceSource | SettlementRecordData>>(
        kind === 'receipts' || kind === 'payments'
          ? '/settlements'
          : '/' + kind,
        q,
      ),
    enabled: kind !== 'overview',
  });
  const summary = useQuery({
    queryKey: ['finance', 'summary', dates],
    queryFn: () =>
      get<FinanceSummary>('/finance/summary', {
        dateFrom: dates?.[0],
        dateTo: dates?.[1],
      }),
    enabled: kind === 'overview',
  });
  const isSource = kind === 'receivables' || kind === 'payables';
  const update = (values: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(values).forEach(([key, value]) =>
        value ? next.set(key, value) : next.delete(key),
      );
      next.delete('page');
      return next;
    });
  const recordsColumns = [
    { title: '收付款单号', dataIndex: 'number', width: 300 },
    {
      title: '往来单位',
      render: (_: unknown, row: SettlementRecordData) =>
        row.receivable?.customer.name ?? row.payable?.supplier.name,
    },
    {
      title: '来源单据',
      render: (_: unknown, row: SettlementRecordData) => (
        <Link
          to={`/${row.type === 'RECEIPT' ? 'receivables' : 'payables'}?view=${row.receivableId ?? row.payableId}`}
        >
          {row.receivable?.number ?? row.payable?.number}
        </Link>
      ),
    },
    {
      title: '金额',
      render: (_: unknown, row: SettlementRecordData) => (
        <MoneyText cents={row.amount} />
      ),
    },
    { title: '业务日期', dataIndex: 'date' },
    { title: '方式', dataIndex: 'method' },
    {
      title: '操作人',
      render: (_: unknown, row: SettlementRecordData) =>
        row.createdBy.displayName,
    },
    { title: '备注', dataIndex: 'remark' },
  ];
  return (
    <>
      <PageHeader
        title={names[kind]}
        description={
          isSource
            ? '按实际出入库生成往来，支持部分结算及来源追溯。'
            : kind === 'overview'
              ? '往来余额按全部有效单据统计，收付款按所选业务日期统计。'
              : '收付款为演示业务记录，过账后保留完整历史。'
        }
        actions={
          <Button
            loading={list.isFetching || summary.isFetching}
            onClick={() =>
              void (kind === 'overview' ? summary.refetch() : list.refetch())
            }
          >
            刷新
          </Button>
        }
      />
      {kind === 'overview' ? (
        <>
          <Card style={{ marginBottom: 20 }}>
            <Space wrap>
              <Typography.Text>收付日期</Typography.Text>
              <DateRangeFilter value={dates} onChange={setDates} />
            </Space>
          </Card>
          {summary.isPending ? (
            <LoadingState />
          ) : summary.isError ? (
            <ErrorState
              error={summary.error}
              retry={() => void summary.refetch()}
            />
          ) : (
            <Row gutter={[20, 20]}>
              {(
                [
                  ['应收原始总额', summary.data.receivableTotal],
                  ['未收余额', summary.data.receivableRemaining],
                  ['应付原始总额', summary.data.payableTotal],
                  ['未付余额', summary.data.payableRemaining],
                  ['所选期间收款', summary.data.receipts],
                  ['所选期间付款', summary.data.payments],
                ] as [string, number][]
              ).map(([title, value]) => (
                <Col key={title} xs={24} md={12} xl={8}>
                  <Card>
                    <Statistic
                      title={title}
                      value={value / 100}
                      prefix="¥"
                      precision={2}
                    />
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </>
      ) : (
        <Card className="table-card" styles={{ body: { padding: 0 } }}>
          <FilterBar>
            <Form
              form={form}
              layout="inline"
              initialValues={{ q: q.q, status: q.status }}
              onFinish={(values) => update(values)}
            >
              <Form.Item name="q">
                <Input
                  aria-label="财务关键词"
                  placeholder="单号 / 往来单位"
                  allowClear
                />
              </Form.Item>
              {isSource && (
                <Form.Item name="status">
                  <Select
                    aria-label="结算状态"
                    placeholder="全部结算状态"
                    allowClear
                    style={{ width: 150 }}
                    options={Object.entries(financeStatusLabels).map(
                      ([value, label]) => ({ value, label }),
                    )}
                  />
                </Form.Item>
              )}
              <Form.Item>
                <DateRangeFilter value={dates} onChange={setDates} />
              </Form.Item>
              <Button type="primary" htmlType="submit">
                查询
              </Button>
            </Form>
          </FilterBar>
          {list.isError ? (
            <ErrorState error={list.error} retry={() => void list.refetch()} />
          ) : isSource ? (
            <DataTable<FinanceSource>
              loading={list.isPending}
              dataSource={list.data?.items as FinanceSource[]}
              pagination={{
                current: q.page,
                pageSize: 10,
                total: list.data?.total,
                onChange: (page) =>
                  setParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('page', String(page));
                    return next;
                  }),
              }}
              columns={[
                {
                  title: '往来单号',
                  dataIndex: 'number',
                  width: 270,
                  render: (value: string, row) => (
                    <Button type="link" onClick={() => setSource(row.id)}>
                      {value}
                    </Button>
                  ),
                },
                {
                  title: '往来单位',
                  render: (_, row) => row.customer?.name ?? row.supplier?.name,
                },
                {
                  title: '来源单据',
                  render: (_, row) => (
                    <Link
                      to={
                        row.receipt
                          ? `/goods-receipts?view=${row.receipt.id}`
                          : `/sales-shipments?view=${row.shipment?.id}`
                      }
                    >
                      {row.receipt?.number ?? row.shipment?.number}
                    </Link>
                  ),
                },
                {
                  title: '原始金额',
                  render: (_, row) => <MoneyText cents={row.originalAmount} />,
                },
                {
                  title: kind === 'receivables' ? '已收金额' : '已付金额',
                  render: (_, row) => <MoneyText cents={settledAmount(row)} />,
                },
                {
                  title: '未结余额',
                  render: (_, row) => (
                    <MoneyText
                      cents={row.originalAmount - settledAmount(row)}
                    />
                  ),
                },
                { title: '状态', dataIndex: 'status', render: statusTag },
                {
                  title: '操作',
                  fixed: 'right',
                  render: (_, row) => (
                    <Button type="link" onClick={() => setSource(row.id)}>
                      查看 / {kind === 'receivables' ? '收款' : '付款'}
                    </Button>
                  ),
                },
              ]}
            />
          ) : (
            <DataTable<SettlementRecordData>
              loading={list.isPending}
              dataSource={list.data?.items as SettlementRecordData[]}
              columns={recordsColumns}
              pagination={{
                current: q.page,
                pageSize: 10,
                total: list.data?.total,
                onChange: (page) =>
                  setParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('page', String(page));
                    return next;
                  }),
              }}
            />
          )}
        </Card>
      )}
      {isSource && (
        <SourceDrawer
          kind={kind}
          id={source ?? params.get('view') ?? undefined}
          onClose={() => {
            setSource(undefined);
            setParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete('view');
              return next;
            });
          }}
        />
      )}
    </>
  );
}
function SourceDrawer({
  kind,
  id,
  onClose,
}: {
  kind: 'receivables' | 'payables';
  id?: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['finance', kind, id],
    queryFn: () => get<FinanceSource>(`/${kind}/${id}`),
    enabled: !!id,
  });
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const userId = useAuth((state) => state.auth?.user.id);
  const storageKey = `kf-settlement-${userId}-${kind}-${id}`;
  const label = kind === 'receivables' ? '收款' : '付款';
  useEffect(() => {
    form.resetFields();
    try {
      setAttempt(
        JSON.parse(
          sessionStorage.getItem(storageKey) ?? 'null',
        ) as Attempt | null,
      );
    } catch {
      setAttempt(null);
    }
  }, [storageKey, form]);
  const mutation = useMutation({
    mutationFn: async (request: Attempt) =>
      (
        await http.post(
          `/settlements/${kind === 'receivables' ? 'receipts' : 'payments'}`,
          request.body,
          { headers: { 'Idempotency-Key': request.key } },
        )
      ).data,
    onSuccess: async (_result, request) => {
      sessionStorage.removeItem(request.storageKey);
      if (request.body.sourceId === id) {
        setAttempt(null);
        form.resetFields();
      }
      void message.success(label + '已记录');
      await queryClient.invalidateQueries();
    },
    onError: (error: unknown, request) => {
      const code = (
        error as { response?: { data?: { error?: { code?: string } } } }
      ).response?.data?.error?.code;
      if (
        code &&
        ['VALIDATION_ERROR', 'EXCESS_SETTLEMENT', 'NOT_FOUND'].includes(code)
      ) {
        sessionStorage.removeItem(request.storageKey);
        if (request.body.sourceId === id) setAttempt(null);
      }
      void message.error(errorMessage(error));
    },
  });
  async function submit() {
    if (attempt) {
      mutation.mutate(attempt);
      return;
    }
    try {
      const values = await form.validateFields();
      const request: Attempt = {
        key: createUuid(),
        storageKey,
        body: {
          sourceId: id!,
          amount: priceInCents(String(values.amount)),
          date: values.date,
          method: values.method,
          remark: values.remark ?? '',
        },
      };
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      setAttempt(request);
      mutation.mutate(request);
    } catch (error) {
      if (error instanceof Error) void message.error(error.message);
    }
  }
  const row = detail.data;
  return (
    <Drawer
      title={label + '单据详情'}
      open={!!id}
      onClose={onClose}
      width={850}
      destroyOnHidden
    >
      {detail.isPending ? (
        <LoadingState />
      ) : detail.isError ? (
        <ErrorState error={detail.error} retry={() => void detail.refetch()} />
      ) : (
        row && (
          <>
            <Descriptions
              bordered
              size="small"
              column={{ xs: 1, sm: 2 }}
              items={[
                { key: 'number', label: '往来单号', children: row.number },
                {
                  key: 'partner',
                  label: '往来单位',
                  children: row.customer?.name ?? row.supplier?.name,
                },
                {
                  key: 'amount',
                  label: '原始金额',
                  children: <MoneyText cents={row.originalAmount} />,
                },
                {
                  key: 'settled',
                  label: '已结金额',
                  children: <MoneyText cents={settledAmount(row)} />,
                },
                {
                  key: 'remain',
                  label: '未结余额',
                  children: (
                    <MoneyText
                      cents={row.originalAmount - settledAmount(row)}
                    />
                  ),
                },
                {
                  key: 'status',
                  label: '状态',
                  children: statusTag(row.status),
                },
                {
                  key: 'source',
                  label: '来源单据',
                  span: 'filled',
                  children: (
                    <Link
                      to={
                        row.receipt
                          ? `/goods-receipts?view=${row.receipt.id}`
                          : `/sales-shipments?view=${row.shipment?.id}`
                      }
                    >
                      {row.receipt?.number ?? row.shipment?.number}
                    </Link>
                  ),
                },
              ]}
            />
            <PermissionGuard permission="settlements:write">
              {(row.status !== 'SETTLED' || attempt) && (
                <Card
                  title={'录入' + label}
                  size="small"
                  style={{ marginTop: 20 }}
                >
                  {attempt && (
                    <Alert
                      type="info"
                      showIcon
                      message="有待确认的结算请求；重试会查询并复用原记录。"
                      style={{ marginBottom: 16 }}
                    />
                  )}
                  <Form
                    form={form}
                    layout="vertical"
                    disabled={!!attempt || mutation.isPending}
                    initialValues={{
                      date: dayjs().format('YYYY-MM-DD'),
                      method: '银行转账',
                    }}
                  >
                    <Row gutter={16}>
                      <Col xs={24} sm={12}>
                        <Form.Item
                          label={label + '金额（元）'}
                          name="amount"
                          rules={[{ required: true, message: '请输入金额' }]}
                        >
                          <InputNumber
                            stringMode
                            min="0.01"
                            precision={2}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} sm={12}>
                        <Form.Item
                          label="业务日期"
                          name="date"
                          rules={[{ required: true }]}
                        >
                          <Input type="date" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item
                      label="收付方式"
                      name="method"
                      rules={[{ required: true }]}
                    >
                      <Select
                        options={['银行转账', '现金', '其他'].map((value) => ({
                          value,
                          label: value,
                        }))}
                      />
                    </Form.Item>
                    <Form.Item label="备注" name="remark">
                      <Input.TextArea maxLength={500} />
                    </Form.Item>
                  </Form>
                  <Button
                    type="primary"
                    loading={mutation.isPending}
                    onClick={() => void submit()}
                  >
                    {attempt ? '重试原结算请求' : '确认' + label}
                  </Button>
                </Card>
              )}
            </PermissionGuard>
            <Typography.Title level={5}>结算历史</Typography.Title>
            <Table<SettlementRecordData>
              size="small"
              rowKey="id"
              dataSource={row.settlements}
              pagination={false}
              scroll={{ x: 650 }}
              columns={[
                { title: '单号', dataIndex: 'number', ellipsis: true },
                {
                  title: '金额',
                  render: (_, item) => <MoneyText cents={item.amount} />,
                },
                { title: '日期', dataIndex: 'date' },
                { title: '方式', dataIndex: 'method' },
                {
                  title: '操作人',
                  render: (_, item) => item.createdBy.displayName,
                },
              ]}
            />
          </>
        )
      )}
    </Drawer>
  );
}
