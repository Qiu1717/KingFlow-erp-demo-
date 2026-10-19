import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Space,
  Statistic,
  Select,
  Radio,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import { get, http, errorMessage } from '../../services/client';
import { DataTable } from '../../components/common';
import {
  PageHeader,
  FilterBar,
  ErrorState,
  MoneyText,
  LoadingState,
} from '../../components/common';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import type { Kind, Report, ReportRow, AnalysisRow } from './types';
import { ReportCharts } from './ReportCharts';
import { options } from '../purchase/api';
import { can } from '@kingflow/shared';
import { useAuth } from '../../stores/auth';
const names = {
  sales: '销售报表',
  purchases: '采购报表',
  inventory: '库存报表',
  finance: '往来报表',
};
export function ReportPage({ kind }: { kind: Kind }) {
  const [filters, setFilters] = useState<{
    q?: string;
    warehouseId?: string;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    pageSize: number;
  }>({ page: 1, pageSize: 20 });
  const [metric, setMetric] = useState<'amount' | 'quantity'>('amount');
  const [form] = Form.useForm();
  const auth = useAuth((state) => state.auth);
  const canChooseWarehouse =
    kind !== 'finance' &&
    !!auth &&
    can(auth.user.role.permissions, 'master:read');
  const warehouses = useQuery({
    queryKey: ['purchase-warehouses'],
    queryFn: () => options('warehouses'),
    enabled: canChooseWarehouse,
  });
  const applyFilters = () => {
    const v = form.getFieldsValue();
    setFilters({
      q: v.q,
      warehouseId: v.warehouseId,
      dateFrom: v.range?.[0],
      dateTo: v.range?.[1],
      page: 1,
      pageSize: filters.pageSize,
    });
  };
  const selectPeriod = (days?: number) => {
    const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
    const start = days
      ? new Date(
          new Date(today + 'T00:00:00+08:00').getTime() -
            (days - 1) * 86400000 +
            28800000,
        )
          .toISOString()
          .slice(0, 10)
      : undefined;
    form.setFieldValue('range', days ? [start, today] : undefined);
    applyFilters();
  };
  const { message } = App.useApp();
  const data = useQuery({
    queryKey: ['reports', kind, filters, metric],
    queryFn: () =>
      get<Report>(`/reports/${kind}`, { ...filters, rankBy: metric }),
  });
  const [exporting, setExporting] = useState(false);
  async function download() {
    setExporting(true);
    try {
      const response = await http.get(`/reports/${kind}`, {
        params: { ...filters, rankBy: metric, format: 'csv' },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kingflow-${kind}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <PageHeader
        title={names[kind]}
        description={
          kind === 'inventory'
            ? '实时库存；选择日期查看期初、期间增减及截止日库存，按上海时间核算。'
            : kind === 'finance'
              ? '按往来单据生成日期筛选；已结及未结为当前累计金额，单位人民币。'
              : '按正式过账记录统计，金额单位人民币；日期按上海时间包含首尾两日。'
        }
        actions={
          <Space>
            <Button
              onClick={() => void data.refetch()}
              loading={data.isFetching}
            >
              刷新数据
            </Button>
            <Button
              onClick={() => void download()}
              loading={exporting}
              disabled={data.isPending || data.isError}
            >
              导出 CSV
            </Button>
          </Space>
        }
      />
      <Card className="table-card" styles={{ body: { padding: 0 } }}>
        <FilterBar>
          <Space wrap style={{ marginBottom: 16 }}>
            <span>统计区间</span>
            {[7, 30, 90].map((days) => (
              <Button key={days} onClick={() => selectPeriod(days)}>
                近{days}天
              </Button>
            ))}
            <Button onClick={() => selectPeriod()}>全部日期</Button>
            {(kind === 'sales' || kind === 'purchases') && (
              <Radio.Group
                aria-label="图表指标"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                optionType="button"
                options={[
                  { label: '金额', value: 'amount' },
                  { label: '数量', value: 'quantity' },
                ]}
              />
            )}
          </Space>
          <Form form={form} layout="inline" onFinish={applyFilters}>
            <Form.Item name="q">
              <Input allowClear placeholder="搜索单号、商品或往来单位" />
            </Form.Item>
            {canChooseWarehouse && (
              <Form.Item name="warehouseId">
                <Select
                  aria-label="筛选仓库"
                  placeholder="全部仓库"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  style={{ width: 180 }}
                  loading={warehouses.isFetching}
                  options={warehouses.data?.map((w) => ({
                    value: w.id,
                    label: w.name,
                  }))}
                  notFoundContent={
                    warehouses.isError ? '仓库加载失败，请刷新页面' : undefined
                  }
                />
              </Form.Item>
            )}
            <Form.Item name="range">
              <DateRangeFilter />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit">
                查询
              </Button>
            </Form.Item>
          </Form>
        </FilterBar>
        {data.isError ? (
          <ErrorState error={data.error} retry={() => void data.refetch()} />
        ) : data.isPending ? (
          <LoadingState />
        ) : (
          <>
            <Row gutter={16} style={{ padding: '0 24px 18px' }}>
              {(kind === 'inventory'
                ? ['quantity']
                : kind === 'finance'
                  ? ['amount', 'settled', 'balance']
                  : ['quantity', 'amount']
              ).map((key) => (
                <Col key={key} xs={12} md={6}>
                  <Statistic
                    title={
                      {
                        quantity: '数量合计',
                        amount: '金额合计',
                        settled: '已结金额',
                        balance: '未结金额',
                      }[key]
                    }
                    value={
                      data.data?.totals[key as keyof Report['totals']] ?? 0
                    }
                    precision={key === 'quantity' ? 0 : 2}
                    formatter={(value) =>
                      key === 'quantity' ? (
                        value
                      ) : (
                        <MoneyText cents={Number(value)} />
                      )
                    }
                  />
                </Col>
              ))}
            </Row>
            <div className="report-analysis" style={{ padding: '0 24px' }}>
              <ReportCharts
                kind={kind}
                analysis={data.data.analysis}
                metric={metric}
              />
              <ReportAnalysis kind={kind} analysis={data.data.analysis} />
            </div>
            <DataTable<ReportRow>
              loading={data.isFetching}
              dataSource={data.data?.items}
              columns={[
                {
                  title: '单号 / 编码',
                  dataIndex: 'number',
                  render: (v, r) => <Link to={r.sourcePath}>{v}</Link>,
                },
                { title: '日期', dataIndex: 'date' },
                {
                  title: kind === 'finance' ? '类型' : '商品',
                  dataIndex: 'product',
                },
                { title: '往来单位', dataIndex: 'partner' },
                { title: '仓库', dataIndex: 'warehouse' },
                ...(kind === 'inventory' && (filters.dateFrom || filters.dateTo)
                  ? [
                      { title: '期初', dataIndex: 'openingQuantity' },
                      { title: '期间增加', dataIndex: 'inboundQuantity' },
                      { title: '期间减少', dataIndex: 'outboundQuantity' },
                    ]
                  : []),
                ...(kind === 'finance'
                  ? []
                  : [{ title: '数量', dataIndex: 'quantity' }]),
                ...(kind === 'inventory'
                  ? []
                  : [
                      {
                        title: '金额',
                        dataIndex: 'amount',
                        render: (v: number) => <MoneyText cents={v} />,
                      },
                    ]),
                ...(kind === 'finance'
                  ? [
                      {
                        title: '已结',
                        dataIndex: 'settled',
                        render: (v: number) => <MoneyText cents={v} />,
                      },
                      {
                        title: '未结',
                        dataIndex: 'balance',
                        render: (v: number) => <MoneyText cents={v} />,
                      },
                    ]
                  : []),
              ]}
              pagination={{
                current: filters.page,
                pageSize: filters.pageSize,
                total: data.data?.total,
                showSizeChanger: true,
                onChange: (page, pageSize) =>
                  setFilters({ ...filters, page, pageSize }),
              }}
            />
          </>
        )}
      </Card>
      <Space style={{ marginTop: 12 }}>
        数据来源：
        {kind === 'sales'
          ? '正式销售出库'
          : kind === 'purchases'
            ? '正式采购入库'
            : kind === 'inventory'
              ? '库存余额与正式库存流水'
              : '应收应付及实际结算'}{' '}
        · 单据链接可追溯业务来源
      </Space>
    </>
  );
}
function ReportAnalysis({
  kind,
  analysis,
}: {
  kind: Kind;
  analysis: Report['analysis'];
}) {
  const ranking = (title: string, rows: AnalysisRow[]) => (
    <Card title={title} size="small">
      <DataTable<AnalysisRow>
        rowKey="name"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 320 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '数量', dataIndex: 'quantity' },
          ...(kind === 'inventory'
            ? []
            : [
                {
                  title: '金额',
                  dataIndex: 'amount',
                  render: (value: number) => <MoneyText cents={value} />,
                },
              ]),
        ]}
      />
    </Card>
  );
  return (
    <div style={{ marginBottom: 20 }}>
      {(kind === 'sales' || kind === 'purchases') && (
        <>
          <Row gutter={[20, 20]}>
            <Col xs={24} xl={12}>
              {ranking(
                kind === 'sales' ? '客户销售排行' : '供应商采购排行',
                analysis.partnerRanking,
              )}
            </Col>
            <Col xs={24} xl={12}>
              {ranking('商品排行', analysis.productRanking)}
            </Col>
          </Row>
        </>
      )}
      {kind === 'finance' && (
        <Row gutter={[20, 20]}>
          {analysis.financeSummary.map((row) => (
            <Col xs={24} md={12} key={row.name}>
              <Card title={row.name}>
                <Space wrap>
                  <Statistic
                    title="原始金额"
                    value={row.amount / 100}
                    precision={2}
                    prefix="¥"
                  />
                  <Statistic
                    title="已结金额"
                    value={row.settled / 100}
                    precision={2}
                    prefix="¥"
                  />
                  <Statistic
                    title="未结余额"
                    value={row.balance / 100}
                    precision={2}
                    prefix="¥"
                  />
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
      {kind === 'inventory' && (
        <Row gutter={[20, 20]}>
          <Col xs={24} xl={12}>
            {ranking('按仓库汇总', analysis.warehouseSummary)}
          </Col>
          <Col xs={24} xl={12}>
            <Card title="库存预警与变动">
              <Statistic
                title="当前低库存商品仓库组合"
                value={analysis.stockAlerts?.total ?? 0}
              />
              <Space style={{ marginTop: 12 }}>
                <Link to="/stock-alerts">查看预警</Link>
                <Link to="/stock-movements">查看库存流水</Link>
              </Space>
              <DataTable
                pagination={false}
                dataSource={analysis.movements?.slice(0, 5)}
                scroll={{ x: 300 }}
                columns={[
                  { title: '最近流水', dataIndex: 'number', ellipsis: true },
                  { title: '变动数量', dataIndex: 'quantity' },
                ]}
              />
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
}
