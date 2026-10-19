import { useState, useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  App,
  Drawer,
  Dropdown,
  Grid,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Input,
  Layout,
  List,
  Menu,
  Modal,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  Layers3,
  Menu as MenuIcon,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Bell,
  LogOut,
  ChevronRight,
  Command,
  UserRound,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MasterRecord, PageData } from '@kingflow/shared';
import { resources, labels, can } from '@kingflow/shared';
import { menuGroups, pageMeta } from '../routes/navigation';
import { useAuth } from '../stores/auth';
import { http, get, errorMessage } from '../services/client';
import type { Summary } from '../modules/dashboard/activity';
import { resourceNames, actionNames } from '../modules/dashboard/activity';
const { Header, Sider, Content } = Layout;

/**
 * 菜单项对应的后端权限。与路由 Access 守卫和 Service 层授权保持一致：
 * 没有权限的入口不展示，避免把只读访客引向必然 403 的页面。
 * 数组表示「任一权限即可」。
 */
const menuPermissions: Record<string, string[]> = {
  '/purchase-orders': ['purchase:read'],
  '/goods-receipts': ['receipts:read'],
  '/reports/purchases': ['purchase:read'],
  '/sales-orders': ['sales:read'],
  '/sales-shipments': ['shipments:read'],
  '/reports/sales': ['sales:read'],
  '/stocks': ['inventory:read'],
  '/stock-movements': ['inventory:read'],
  '/stock-adjustments': ['inventory:read'],
  '/stock-alerts': ['inventory:read'],
  '/reports/inventory': ['inventory:read'],
  '/receivables': ['receivables:read'],
  '/payables': ['payables:read'],
  '/receipts': ['finance:read'],
  '/payments': ['finance:read'],
  '/finance/summary': ['finance:read'],
  '/reports/finance': ['finance:read'],
  '/visualizations': [
    'sales:read',
    'purchase:read',
    'inventory:read',
    'finance:read',
  ],
  '/system/users': ['system:manage'],
  '/system/roles': ['system:manage'],
  '/system/audit-logs': ['system:manage'],
};
export function AppLayout() {
  const isMobile = !Grid.useBreakpoint().lg;
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const compact = !isMobile && collapsed;
  const [searchOpen, setSearchOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [logoutLoading, setLogoutLoading] = useState(false);
  const auth = useAuth((state) => state.auth);
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { message } = App.useApp();
  const meta = pageMeta(location.pathname);
  useEffect(() => {
    setMobileNavigation(false);
  }, [location.pathname, isMobile]);
  const search = useQuery({
    queryKey: ['global-search', searchTerm],
    queryFn: async () => {
      const lists = await Promise.all(
        resources.map(async (resource) => ({
          resource,
          ...(await get<PageData<MasterRecord>>(`/${resource}`, {
            q: searchTerm,
            pageSize: 5,
          })),
        })),
      );
      return lists.flatMap((list) =>
        list.items.map((item) => ({ ...item, resource: list.resource })),
      );
    },
    enabled: searchOpen && searchTerm.length > 0,
  });
  const activity = useQuery({
    queryKey: ['summary', auth?.user.id],
    queryFn: () => get<Summary>('/dashboard/summary'),
    enabled: noticeOpen,
  });
  async function logout() {
    setLogoutLoading(true);
    try {
      await http.post('/auth/logout');
      useAuth.getState().setAuth(null);
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      client.setQueryData(['session'], null);
      navigate('/login', { replace: true });
      void message.success('已退出登录');
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setLogoutLoading(false);
    }
  }
  const permissions = auth?.user.role.permissions ?? [];
  const allowed = (key: string) => {
    const required = menuPermissions[key];
    return (
      !required || required.some((permission) => can(permissions, permission))
    );
  };
  // 同一路径会出现在多个分组（例如销售统计/销售分析都指向 /reports/sales），
  // Ant Design Menu 要求 key 全局唯一，因此用「分组:路径」作为菜单 key 并映射回路由。
  const menuKey = (group: string, path: string) => `${group}:${path}`;
  const pathByKey = new Map(
    menuGroups.flatMap((group) =>
      group.children.map(
        (item) => [menuKey(group.key, item.key), item.key] as const,
      ),
    ),
  );
  const selectedKey = [...pathByKey.entries()]
    .filter(([, path]) => path === location.pathname)
    .map(([key]) => key)
    .slice(0, 1);
  // 空分组（例如访客的财务管理）整组隐藏，而不是留一个点开全 403 的菜单。
  const navItems = menuGroups
    .map((group) => ({
      ...group,
      children: group.children.filter((item) => allowed(item.key)),
    }))
    .filter((group) => group.children.length > 0)
    .map((group) => ({
      key: menuKey('group', group.key),
      icon: <group.icon size={18} />,
      label: group.label,
      children: group.children.map((item) => ({
        key: menuKey(group.key, item.key),
        label: item.label,
      })),
    }));
  const sidebar = (
    <>
      {' '}
      <Link
        to="/"
        className="sidebar-brand"
        onClick={() => setMobileNavigation(false)}
      >
        <div className="brand-mark">
          <Layers3 size={23} />
        </div>
        {!compact && (
          <strong>
            KingFlow<span> ERP</span>
          </strong>
        )}
      </Link>
      {!compact && (
        <div className="workspace-select">
          <div className="company-avatar">K</div>
          <div>
            <strong>KingFlow 演示企业</strong>
            <span>企业管理工作空间</span>
          </div>
          <Tag bordered={false}>DEMO</Tag>
        </div>
      )}
      <div className="sidebar-menu">
        <Menu
          mode="inline"
          selectedKeys={selectedKey}
          defaultOpenKeys={
            isMobile
              ? navItems
                  .filter((item) =>
                    item.children.some((child) =>
                      selectedKey.includes(child.key),
                    ),
                  )
                  .map((item) => item.key)
              : navItems.map((item) => item.key)
          }
          items={navItems}
          onClick={({ key }) => {
            const path = pathByKey.get(key);
            if (path) {
              navigate(path);
              setMobileNavigation(false);
            }
          }}
        />
      </div>
      {!compact && (
        <div className="sidebar-foot">
          <div>
            <span className="live-dot" /> 本地演示环境
          </div>
          <small>V1.0 · 企业资源管理</small>
        </div>
      )}
    </>
  );
  return (
    <Layout className="app-shell">
      {!isMobile && (
        <Sider
          className="app-sidebar"
          width={232}
          collapsedWidth={76}
          collapsed={collapsed}
          theme="light"
        >
          {sidebar}
        </Sider>
      )}
      {isMobile && (
        <Drawer
          title="全部功能"
          placement="left"
          rootClassName="mobile-navigation"
          width="min(300px, calc(100vw - 40px))"
          open={mobileNavigation}
          onClose={() => setMobileNavigation(false)}
          destroyOnHidden
          styles={{
            body: { padding: 0, display: 'flex', flexDirection: 'column' },
          }}
        >
          {sidebar}
        </Drawer>
      )}
      <Layout className="app-right">
        <Header className="app-header">
          <Space size={isMobile ? 4 : 18} className="header-leading">
            <Button
              type="text"
              aria-label={
                isMobile
                  ? '打开功能菜单'
                  : collapsed
                    ? '展开侧边栏'
                    : '折叠侧边栏'
              }
              icon={
                isMobile ? (
                  <MenuIcon size={21} />
                ) : collapsed ? (
                  <PanelLeftOpen size={19} />
                ) : (
                  <PanelLeftClose size={19} />
                )
              }
              onClick={() =>
                isMobile ? setMobileNavigation(true) : setCollapsed(!collapsed)
              }
            />
            {isMobile ? (
              <strong className="mobile-page-title">{meta.title}</strong>
            ) : (
              <Breadcrumb
                items={[{ title: meta.group }, { title: meta.title }]}
              />
            )}
          </Space>
          <Space size={14} className="header-actions">
            <Button
              aria-label="搜索资料"
              className="global-search-button"
              icon={<Search size={16} />}
              onClick={() => setSearchOpen(true)}
            >
              搜索资料{' '}
              <span className="search-key">
                <Command size={10} /> K
              </span>
            </Button>
            {!isMobile && (
              <>
                <Tooltip title="最近操作消息">
                  <Button
                    aria-label="最近操作消息"
                    type="text"
                    icon={
                      <Badge dot={false}>
                        <Bell size={19} />
                      </Badge>
                    }
                    onClick={() => setNoticeOpen(true)}
                  />
                </Tooltip>
                <div className="header-divider" />
                <Button
                  type="text"
                  className="user-button"
                  onClick={() => navigate('/profile')}
                >
                  <Avatar size={31} className="user-avatar">
                    {auth?.user.displayName.slice(0, 1)}
                  </Avatar>
                  <span className="user-name">
                    {auth?.user.displayName}
                    <small>{auth?.user.role.name}</small>
                  </span>
                </Button>
                <Tooltip title="退出登录">
                  <Button
                    type="text"
                    aria-label="退出登录"
                    loading={logoutLoading}
                    icon={<LogOut size={17} />}
                    onClick={() => void logout()}
                  />
                </Tooltip>
              </>
            )}
            {isMobile && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'profile',
                      label: '个人设置',
                      icon: <UserRound size={16} />,
                    },
                    {
                      key: 'logout',
                      label: logoutLoading ? '退出中…' : '退出登录',
                      disabled: logoutLoading,
                      icon: <LogOut size={16} />,
                    },
                  ],
                  onClick: ({ key }) =>
                    key === 'profile' ? navigate('/profile') : void logout(),
                }}
              >
                <Button
                  type="text"
                  className="user-button"
                  aria-label="用户菜单"
                >
                  <Avatar size={30} className="user-avatar">
                    {auth?.user.displayName.slice(0, 1)}
                  </Avatar>
                </Button>
              </Dropdown>
            )}
          </Space>
        </Header>
        <div className="context-strip">
          <Space size={7}>
            <span className="context-dot" />
            <span>KingFlow 企业工作空间</span>
            <ChevronRight size={12} />
            <strong>{meta.title}</strong>
          </Space>
          <span>
            {new Intl.DateTimeFormat('zh-CN', {
              timeZone: 'Asia/Shanghai',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            }).format(new Date())}
          </span>
        </div>
        <Content className="app-content">
          <Outlet />
        </Content>
        <footer className="app-footer">
          <span>KingFlow ERP · 让经营有序向前</span>
          <span>本地演示 · 人民币 CNY</span>
        </footer>
      </Layout>
      {isMobile && (
        <nav className="mobile-bottom-nav" aria-label="手机快捷导航">
          <Link
            to="/"
            aria-current={location.pathname === '/' ? 'page' : undefined}
          >
            <LayoutDashboard size={20} />
            <span>工作台</span>
          </Link>
          <button
            type="button"
            className={mobileNavigation ? 'active' : undefined}
            onClick={() => setMobileNavigation(true)}
          >
            <MenuIcon size={21} />
            <span>全部功能</span>
          </button>
          <button
            type="button"
            className={noticeOpen ? 'active' : undefined}
            onClick={() => setNoticeOpen(true)}
          >
            <Bell size={20} />
            <span>消息</span>
          </button>
          <Link
            to="/profile"
            aria-current={location.pathname === '/profile' ? 'page' : undefined}
          >
            <UserRound size={20} />
            <span>我的</span>
          </Link>
        </nav>
      )}
      <Modal
        title="全局资料搜索"
        open={searchOpen}
        onCancel={() => setSearchOpen(false)}
        footer={null}
        width={650}
        destroyOnHidden
      >
        <Input.Search
          autoFocus
          placeholder="搜索商品、分类、客户、供应商或仓库"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onSearch={(value) => setSearchTerm(value.trim())}
          enterButton="搜索"
          maxLength={100}
        />
        {search.isError ? (
          <Typography.Paragraph type="danger" style={{ marginTop: 20 }}>
            {errorMessage(search.error)}
          </Typography.Paragraph>
        ) : (
          <List
            className="search-results"
            loading={search.isFetching}
            dataSource={search.data ?? []}
            locale={{
              emptyText: searchTerm ? '没有找到匹配的资料' : '输入关键词后搜索',
            }}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    type="link"
                    onClick={() => {
                      setSearchOpen(false);
                      navigate(
                        `/master/${item.resource}?q=${encodeURIComponent(item.code)}`,
                      );
                    }}
                  >
                    打开
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag>{labels[item.resource]}</Tag>
                      {item.name}
                    </Space>
                  }
                  description={item.code}
                />
              </List.Item>
            )}
          />
        )}
      </Modal>
      <Modal
        title="最近操作消息"
        open={noticeOpen}
        onCancel={() => setNoticeOpen(false)}
        footer={<Button onClick={() => setNoticeOpen(false)}>关闭</Button>}
      >
        <Typography.Paragraph type="secondary">
          展示实际操作日志，当前没有独立消息推送服务。
        </Typography.Paragraph>
        {activity.isError ? (
          <Typography.Text type="danger">
            {errorMessage(activity.error)}
          </Typography.Text>
        ) : (
          <List
            loading={activity.isLoading}
            dataSource={activity.data?.recentLogs ?? []}
            locale={{ emptyText: '暂无操作消息' }}
            renderItem={(log) => (
              <List.Item>
                <List.Item.Meta
                  avatar={<Avatar icon={<UserRound size={16} />} />}
                  title={`${log.actor.displayName} ${actionNames[log.action] ?? log.action}了${resourceNames[log.resource] ?? log.resource}`}
                  description={new Date(log.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                />
              </List.Item>
            )}
          />
        )}
      </Modal>
    </Layout>
  );
}
