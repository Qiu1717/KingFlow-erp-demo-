import type { ReactNode } from 'react';
import { Card, Col, Empty, Row, Typography } from 'antd';
import {
  ResponsiveContainer,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import type { AnalysisRow, Kind, Report } from './types';

const colors = [
  '#1677ff',
  '#36b8a2',
  '#faad14',
  '#8b72e8',
  '#f17d83',
  '#69b1ff',
];
const number = (v: unknown) =>
  Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

function ChartCard({
  title,
  label,
  empty,
  children,
}: {
  title: string;
  label: string;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <Card title={title}>
      <div
        role="img"
        aria-label={label}
        style={{ width: '100%', height: 280, minWidth: 0 }}
      >
        {empty ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前筛选范围暂无图表数据"
            style={{ paddingTop: 65 }}
          />
        ) : (
          children
        )}
      </div>
    </Card>
  );
}

export function ReportCharts({
  kind,
  analysis,
  metric,
}: {
  kind: Kind;
  analysis: Report['analysis'];
  metric: 'amount' | 'quantity';
}) {
  const money = metric === 'amount';
  const unit = money ? '元' : '基础单位';
  const valueName = money ? '金额（元）' : '数量（基础单位）';
  const rows = (data: AnalysisRow[]) =>
    data.map((r) => ({ ...r, value: money ? r.amount / 100 : r.quantity }));
  const ranking = (title: string, data: AnalysisRow[]) => (
    <ChartCard
      title={`${title} · 前10名（${unit}）`}
      label={`${title}图`}
      empty={!data.length}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows(data)}
          layout="vertical"
          margin={{ left: 0, right: 24 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            horizontal={false}
            stroke="#edf0f5"
          />
          <XAxis type="number" tickFormatter={number} />
          <YAxis
            type="category"
            dataKey="name"
            width={125}
            tick={{ fontSize: 12 }}
            tickFormatter={(v) =>
              String(v).length > 10 ? String(v).slice(0, 10) + '…' : String(v)
            }
          />
          <Tooltip formatter={(v) => `${number(v)} ${unit}`} />
          <Bar
            dataKey="value"
            name={valueName}
            fill="#1677ff"
            radius={[0, 4, 4, 0]}
            maxBarSize={22}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );

  return (
    <div style={{ marginBottom: 20 }}>
      {(kind === 'sales' || kind === 'purchases') && (
        <Row gutter={[20, 20]}>
          <Col span={24}>
            <ChartCard
              title={`${kind === 'sales' ? '销售' : '采购'}${money ? '金额' : '数量'}趋势（${unit}）`}
              label={`${kind === 'sales' ? '销售' : '采购'}趋势图`}
              empty={!analysis.trend.length}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={rows(analysis.trend)}
                  margin={{ left: 12, right: 24, top: 12 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#edf0f5" />
                  <XAxis
                    dataKey="name"
                    minTickGap={30}
                    tickFormatter={(v) => String(v).slice(5)}
                  />
                  <YAxis tickFormatter={number} width={80} />
                  <Tooltip formatter={(v) => `${number(v)} ${unit}`} />
                  <Area
                    type="linear"
                    name={valueName}
                    dataKey="value"
                    stroke="#1677ff"
                    fill="#e6f4ff"
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
              仅统计正式过账；无过账日期不绘制数据点。排行由全部筛选结果聚合后，按当前指标取前10名，与明细分页无关。
            </Typography.Paragraph>
          </Col>
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
      )}
      {kind === 'inventory' && (
        <Row gutter={[20, 20]}>
          <Col xs={24} xl={12}>
            <ChartCard
              title="仓库库存对比（数量）"
              label="仓库库存对比图"
              empty={!analysis.warehouseSummary.length}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={analysis.warehouseSummary}
                  margin={{ left: 12, right: 12, top: 12 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#edf0f5" />
                  <XAxis dataKey="name" />
                  <YAxis tickFormatter={number} />
                  <Tooltip formatter={(v) => `${number(v)}（按商品单位）`} />
                  <Bar
                    dataKey="quantity"
                    name="库存数量"
                    fill="#36b8a2"
                    radius={[5, 5, 0, 0]}
                    maxBarSize={64}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </Col>
          <Col xs={24} xl={12}>
            <ChartCard
              title="仓库库存占比（数量）"
              label="仓库库存占比图"
              empty={!analysis.warehouseSummary.some((r) => r.quantity > 0)}
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={analysis.warehouseSummary.filter(
                      (r) => r.quantity > 0,
                    )}
                    dataKey="quantity"
                    nameKey="name"
                    innerRadius={65}
                    outerRadius={95}
                    paddingAngle={3}
                    isAnimationActive={false}
                  >
                    {analysis.warehouseSummary
                      .filter((r) => r.quantity > 0)
                      .map((r, i) => (
                        <Cell key={r.name} fill={colors[i % colors.length]} />
                      ))}
                  </Pie>
                  <Tooltip formatter={(v) => `${number(v)} 件`} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>
          </Col>
          <Col span={24}>
            <Typography.Text type="secondary">
              未选择日期时展示实时余额；选择日期时展示截止日余额。下方预警始终按当前库存计算。数量按商品计量单位汇总，不代表库存价值或统一物理量。
            </Typography.Text>
          </Col>
        </Row>
      )}
      {kind === 'finance' && (
        <ChartCard
          title="应收应付结算结构（元）"
          label="应收应付结算对比图"
          empty={!analysis.financeSummary.some((r) => r.amount > 0)}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={analysis.financeSummary.map((r) => ({
                name: r.name,
                settled: r.settled / 100,
                balance: r.balance / 100,
              }))}
              margin={{ left: 12, right: 24, top: 12 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#edf0f5" />
              <XAxis dataKey="name" />
              <YAxis tickFormatter={number} width={80} />
              <Tooltip formatter={(v) => `¥${number(v)}`} />
              <Legend />
              <Bar
                name="已结金额"
                dataKey="settled"
                stackId="total"
                fill="#36b8a2"
                maxBarSize={90}
                isAnimationActive={false}
              />
              <Bar
                name="未结余额"
                dataKey="balance"
                stackId="total"
                fill="#faad14"
                radius={[5, 5, 0, 0]}
                maxBarSize={90}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
