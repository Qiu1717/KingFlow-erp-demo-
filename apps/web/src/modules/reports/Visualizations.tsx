import { Result, Tabs } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { can } from '@kingflow/shared';
import { useAuth } from '../../stores/auth';
import { PageHeader } from '../../components/common';
import { ReportPage } from './ReportPage';

const views = [
  { key: 'sales', label: '销售分析', permission: 'sales:read' },
  { key: 'purchases', label: '采购分析', permission: 'purchase:read' },
  { key: 'inventory', label: '库存分析', permission: 'inventory:read' },
  { key: 'finance', label: '往来分析', permission: 'finance:read' },
] as const;

export function Visualizations() {
  const auth = useAuth((state) => state.auth);
  const [params, setParams] = useSearchParams();
  const allowed = views.filter(
    (view) => auth && can(auth.user.role.permissions, view.permission),
  );
  const active =
    allowed.find((view) => view.key === params.get('view'))?.key ??
    allowed[0]?.key;
  return (
    <>
      <PageHeader
        title="数据可视化"
        description="从真实业务单据洞察经营：切换分析主题，按日期、仓库筛选，悬停查看数值。"
      />
      {active ? (
        <Tabs
          activeKey={active}
          onChange={(view) => setParams({ view })}
          destroyOnHidden
          items={allowed.map((view) => ({
            key: view.key,
            label: view.label,
            children: <ReportPage key={view.key} kind={view.key} />,
          }))}
        />
      ) : (
        <Result
          status="403"
          title="无权访问"
          subTitle="当前角色未获得经营分析权限"
        />
      )}
    </>
  );
}
