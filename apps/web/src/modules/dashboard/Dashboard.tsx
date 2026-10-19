import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  List,
  Tag,
  Typography,
  Timeline,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { get } from '../../services/client';
import {
  PageHeader,
  ErrorState,
  LoadingState,
  PermissionGuard,
  MoneyText,
} from '../../components/common';
import { useAuth } from '../../stores/auth';
import { type Summary, resourceNames, actionNames } from './activity';
interface Business {
  metrics: Record<string, number>;
  trend: { date: string; sales?: number; purchases?: number }[];
  topProducts?: { name: string; amount: number; quantity: number }[];
  orderStatuses?: { name: string; value: number }[];
  dateFrom: string;
  dateTo: string;
}
interface Todo {
  id: string;
  title: string;
  path: string;
  type: string;
}
const labels: Record<string, string> = {
  monthSales: '本月销售额',
  monthPurchases: '本月采购额',
  stockQuantity: '库存总数量',
  receivable: '待收款金额',
  payable: '待付款金额',
  pendingApprovals: '待审核单据',
  stockAlerts: '库存预警商品数',
};
const links: Record<string, string> = {
  monthSales: '/reports/sales',
  monthPurchases: '/reports/purchases',
  stockQuantity: '/stocks',
  receivable: '/receivables',
  payable: '/payables',
  pendingApprovals: '/todos',
  stockAlerts: '/stock-alerts',
};
const statusNames: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '待审核',
  APPROVED: '已审核',
  PARTIAL: '部分出库',
  SHIPPED: '已出库',
};
export function Dashboard({ todosOnly = false }: { todosOnly?: boolean }) {
  const auth = useAuth((s) => s.auth);
  const business = useQuery({
    queryKey: ['business', auth?.user.id],
    queryFn: () => get<Business>('/dashboard/business'),
  });
  const tasks = useQuery({
    queryKey: ['todos', auth?.user.id],
    queryFn: () => get<Todo[]>('/dashboard/todos'),
  });
  const summary = useQuery({
    queryKey: ['summary', auth?.user.id],
    queryFn: () => get<Summary>('/dashboard/summary'),
    enabled: !todosOnly,
  });
  if (business.isLoading || tasks.isLoading) return <LoadingState />;
  if (business.isError)
    return (
      <ErrorState
        error={business.error}
        retry={() => void business.refetch()}
      />
    );
  const data = business.data!;
  const todoCard = (
    <Card
      title="业务待办"
      extra={<Tag color="blue">{tasks.data?.length ?? 0} 项</Tag>}
    >
      {tasks.isError ? (
        <ErrorState error={tasks.error} retry={() => void tasks.refetch()} />
      ) : (
        <List
          dataSource={tasks.data}
          locale={{ emptyText: '暂无待办' }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Link key="open" to={item.path}>
                  去处理 →
                </Link>,
              ]}
            >
              <List.Item.Meta
                title={item.title}
                description={
                  item.type === 'inventory'
                    ? '按启用商品和仓库检查最低库存'
                    : '打开原始订单处理审核或出入库'
                }
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );
  if (todosOnly)
    return (
      <>
        <PageHeader
          title="业务待办"
          description="当前账号可处理的审核、出入库和库存预警。"
        />
        {todoCard}
      </>
    );
  const chart = (title: string, children: React.ReactNode) => (
    <Card title={title} styles={{ body: { height: 290 } }}>
      {children}
    </Card>
  );
  return (
    <>
      <PageHeader
        title="经营概览"
        description={`你好，${auth?.user.displayName}。经营数据来自正式过账，日期按上海时间统计。`}
        actions={
          <Button
            loading={business.isFetching || tasks.isFetching}
            onClick={() => {
              void business.refetch();
              void tasks.refetch();
              void summary.refetch();
            }}
          >
            刷新数据
          </Button>
        }
      />
      <Row gutter={[14, 14]}>
        {Object.entries(data.metrics).map(([key, value], index) => (
          <Col
            key={key}
            xs={12}
            md={8}
            xl={
              Object.keys(data.metrics).length === 7 ? (index < 4 ? 6 : 8) : 6
            }
          >
            <Link to={links[key]}>
              <Card size="small">
                <Statistic
                  title={labels[key]}
                  value={value}
                  formatter={(v) =>
                    [
                      'monthSales',
                      'monthPurchases',
                      'receivable',
                      'payable',
                    ].includes(key) ? (
                      <MoneyText cents={Number(v)} />
                    ) : (
                      Number(v).toLocaleString()
                    )
                  }
                />
                <Typography.Text type="secondary">
                  {key.startsWith('month')
                    ? '按正式出入库金额'
                    : '点击查看业务明细'}
                </Typography.Text>
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
      <Card size="small" style={{ margin: '16px 0' }}>
        <Space wrap>
          <strong>快捷操作</strong>
          <PermissionGuard permission="products:write">
            <Link to="/master/products?create=1">
              <Button>新建商品</Button>
            </Link>
          </PermissionGuard>
          <PermissionGuard permission="purchase:write">
            <Link to="/purchase-orders?new=1">
              <Button>新建采购订单</Button>
            </Link>
          </PermissionGuard>
          <PermissionGuard permission="sales:write">
            <Link to="/sales-orders?new=1">
              <Button type="primary">新建销售订单</Button>
            </Link>
          </PermissionGuard>
          <PermissionGuard permission="inventory:read">
            <Link to="/stocks">
              <Button>查询库存</Button>
            </Link>
          </PermissionGuard>
        </Space>
      </Card>
      <Row gutter={[16, 16]}>
        {data.topProducts !== undefined && (
          <Col xs={24} xl={12}>
            {chart(
              '近30天销售趋势（元）',
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={data.trend.map((r) => ({
                    ...r,
                    sales: (r.sales ?? 0) / 100,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v) => String(v).slice(5)}
                  />
                  <YAxis />
                  <Tooltip />
                  <Line
                    isAnimationActive={false}
                    name="销售额"
                    type="monotone"
                    dataKey="sales"
                    stroke="#1677ff"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>,
            )}
          </Col>
        )}
        {data.trend.some(
          (r) => r.sales !== undefined || r.purchases !== undefined,
        ) && (
          <Col xs={24} xl={12}>
            {chart(
              '近30天采购与销售（元）',
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.trend.map((r) => ({
                    ...r,
                    sales: r.sales === undefined ? undefined : r.sales / 100,
                    purchases:
                      r.purchases === undefined ? undefined : r.purchases / 100,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v) => String(v).slice(5)}
                  />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  {data.metrics.monthSales !== undefined && (
                    <Bar
                      isAnimationActive={false}
                      name="销售"
                      dataKey="sales"
                      fill="#1677ff"
                    />
                  )}
                  {data.metrics.monthPurchases !== undefined && (
                    <Bar
                      isAnimationActive={false}
                      name="采购"
                      dataKey="purchases"
                      fill="#93c5fd"
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>,
            )}
          </Col>
        )}
        {data.topProducts !== undefined && (
          <Col xs={24} xl={12}>
            {chart(
              '近30天商品销售排行（元）',
              data.topProducts.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.topProducts.map((r) => ({
                      ...r,
                      amount: r.amount / 100,
                    }))}
                    layout="vertical"
                  >
                    <XAxis type="number" />
                    <YAxis dataKey="name" type="category" width={100} />
                    <Tooltip />
                    <Bar
                      isAnimationActive={false}
                      name="销售额"
                      dataKey="amount"
                      fill="#1677ff"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Typography.Text type="secondary">
                  暂无销售出库记录
                </Typography.Text>
              ),
            )}
          </Col>
        )}
        {data.orderStatuses !== undefined && (
          <Col xs={24} xl={12}>
            {chart(
              '销售订单状态分布',
              data.orderStatuses.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      isAnimationActive={false}
                      data={data.orderStatuses.map((r) => ({
                        ...r,
                        name: statusNames[r.name] ?? r.name,
                      }))}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={65}
                      outerRadius={95}
                    >
                      {data.orderStatuses.map((r, i) => (
                        <Cell
                          key={r.name}
                          fill={
                            [
                              '#1677ff',
                              '#52c41a',
                              '#faad14',
                              '#94a3b8',
                              '#13c2c2',
                            ][i % 5]
                          }
                        />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <Typography.Text type="secondary">暂无销售订单</Typography.Text>
              ),
            )}
          </Col>
        )}
        <Col xs={24} xl={14}>
          {todoCard}
        </Col>
        <Col xs={24} xl={10}>
          <Card title="基础资料">
            <Space wrap>
              <Tag>商品 {summary.data?.products ?? 0}</Tag>
              <Tag>客户 {summary.data?.customers ?? 0}</Tag>
              <Tag>供应商 {summary.data?.suppliers ?? 0}</Tag>
              <Tag>仓库 {summary.data?.warehouses ?? 0}</Tag>
            </Space>
            <Timeline
              style={{ marginTop: 24 }}
              items={summary.data?.recentLogs.slice(0, 5).map((log) => ({
                children: (
                  <span>
                    {log.actor.displayName}{' '}
                    {actionNames[log.action] ?? log.action}{' '}
                    {resourceNames[log.resource] ?? log.resource}
                  </span>
                ),
              }))}
            />
          </Card>
        </Col>
      </Row>
      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
        趋势范围 {data.dateFrom} 至 {data.dateTo} · 金额按整数分汇总后显示人民币
        · 仅展示当前角色授权模块
      </Typography.Paragraph>
    </>
  );
}
