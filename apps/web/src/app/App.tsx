import { lazy, Suspense, useEffect, useLayoutEffect } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Result } from 'antd';
import type { AuthData } from '@kingflow/shared';
import { resources, can } from '@kingflow/shared';
import type { ReactNode } from 'react';
const OrderPage = lazy(() =>
  import('../modules/purchase/OrderPage').then((m) => ({
    default: m.OrderPage,
  })),
);
const ReadPages = lazy(() =>
  import('../modules/purchase/ReadPages').then((m) => ({
    default: m.ReadPages,
  })),
);
import { get, isUnauthorized, isCurrentSessionFailure } from '../services/client';
import { useAuth } from '../stores/auth';
import { http, sessionChannel } from '../services/client';
import { queryClient } from './query';
import { AppLayout } from '../layouts/AppLayout';
import { Login } from '../modules/system/Login';
const Profile = lazy(() =>
  import('../modules/system/Profile').then((m) => ({ default: m.Profile })),
);
const SalesOrderPage = lazy(() =>
  import('../modules/sales/OrderPage').then((m) => ({ default: m.OrderPage })),
);
const SalesReadPages = lazy(() =>
  import('../modules/sales/ReadPages').then((m) => ({ default: m.ReadPages })),
);
const FinancePage = lazy(() =>
  import('../modules/finance/FinancePage').then((m) => ({
    default: m.FinancePage,
  })),
);
const ReportPage = lazy(() =>
  import('../modules/reports/ReportPage').then((m) => ({
    default: m.ReportPage,
  })),
);
const Visualizations = lazy(() =>
  import('../modules/reports/Visualizations').then((m) => ({
    default: m.Visualizations,
  })),
);
const StockAlertsPage = lazy(() =>
  import('../modules/inventory/InventoryPages').then((m) => ({
    default: m.StockAlertsPage,
  })),
);
const StockAdjustmentsPage = lazy(() =>
  import('../modules/inventory/InventoryPages').then((m) => ({
    default: m.StockAdjustmentsPage,
  })),
);
const UsersPage = lazy(() =>
  import('../modules/system/Management').then((m) => ({
    default: m.UsersPage,
  })),
);
const RolesPage = lazy(() =>
  import('../modules/system/Management').then((m) => ({
    default: m.RolesPage,
  })),
);
const AuditLogsPage = lazy(() =>
  import('../modules/system/Management').then((m) => ({
    default: m.AuditLogsPage,
  })),
);
const Dashboard = lazy(() =>
  import('../modules/dashboard/Dashboard').then((m) => ({
    default: m.Dashboard,
  })),
);
const MasterPage = lazy(() =>
  import('../modules/master-data/pages/MasterPage').then((m) => ({
    default: m.MasterPage,
  })),
);
import { LoadingState, ErrorState } from '../components/common';
export function Application() {
  const location = useLocation();
  const auth = useAuth((state) => state.auth);
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await get<AuthData>('/auth/me');
      } catch (error) {
        // 会话查询自身返回 401 即代表当前没有有效会话；它总在最近一次登录之后发出。
        if (isUnauthorized(error)) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 60000,
  });
  useLayoutEffect(() => {
    if (useAuth.getState().auth?.csrfToken !== session.data?.csrfToken)
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
    useAuth.getState().setAuth(session.data ?? null);
  }, [session.data]);
  useEffect(() => {
    const changed = () => {
      useAuth.getState().setAuth(null);
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      void queryClient.resetQueries({ queryKey: ['session'], exact: true });
    };
    sessionChannel.addEventListener('message', changed);
    return () => sessionChannel.removeEventListener('message', changed);
  }, []);
  useEffect(() => {
    const interceptor = http.interceptors.response.use(
      (response) => response,
      (error) => {
        // 只有属于当前会话的 401 才清除登录态；切换账号前发出的迟到请求必须忽略，
        // 否则旧会话的 401 会把新登录的账号踢回登录页。
        if (
          isCurrentSessionFailure(error) &&
          !error.config?.url?.includes('/auth/login') &&
          !error.config?.url?.includes('/auth/me')
        ) {
          useAuth.getState().setAuth(null);
          queryClient.removeQueries({
            predicate: (query) => query.queryKey[0] !== 'session',
          });
          queryClient.setQueryData(['session'], null);
        }
        return Promise.reject(error);
      },
    );
    return () => http.interceptors.response.eject(interceptor);
  }, []);
  if (
    session.isPending ||
    (session.data && auth?.csrfToken !== session.data.csrfToken)
  )
    return <LoadingState />;
  if (session.isError)
    return (
      <ErrorState error={session.error} retry={() => void session.refetch()} />
    );
  if (!session.data)
    return ['/login', '/register'].includes(location.pathname) ? (
      <Login key={location.pathname} registering={location.pathname === '/register'} />
    ) : (
      <Navigate to="/login" replace />
    );
  return (
    <Suspense key={session.data.csrfToken} fallback={<LoadingState />}>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          {resources.map((resource) => (
            <Route
              key={resource}
              path={`/master/${resource}`}
              element={<MasterPage key={resource} resource={resource} />}
            />
          ))}
          <Route path="/profile" element={<Profile />} />
          <Route path="/visualizations" element={<Visualizations />} />
          <Route
            path="/purchase-orders"
            element={
              <Access permission="purchase:read">
                <OrderPage />
              </Access>
            }
          />
          <Route
            path="/goods-receipts"
            element={
              <Access permission="receipts:read">
                <ReadPages key="goods-receipts" kind="goods-receipts" />
              </Access>
            }
          />
          <Route
            path="/stocks"
            element={
              <Access permission="inventory:read">
                <ReadPages key="stocks" kind="stocks" />
              </Access>
            }
          />
          <Route
            path="/stock-movements"
            element={
              <Access permission="inventory:read">
                <ReadPages key="stock-movements" kind="stock-movements" />
              </Access>
            }
          />
          <Route
            path="/payables"
            element={
              <Access permission="payables:read">
                <FinancePage key="payables" kind="payables" />
              </Access>
            }
          />
          <Route
            path="/sales-orders"
            element={
              <Access permission="sales:read">
                <SalesOrderPage />
              </Access>
            }
          />
          <Route
            path="/sales-shipments"
            element={
              <Access permission="shipments:read">
                <SalesReadPages kind="sales-shipments" />
              </Access>
            }
          />
          {(['receivables', 'receipts', 'payments', 'overview'] as const).map(
            (kind) => (
              <Route
                key={kind}
                path={kind === 'overview' ? '/finance/summary' : '/' + kind}
                element={
                  <Access
                    permission={
                      kind === 'receivables'
                        ? 'receivables:read'
                        : 'finance:read'
                    }
                  >
                    <FinancePage key={kind} kind={kind} />
                  </Access>
                }
              />
            ),
          )}
          {(['sales', 'purchases', 'inventory', 'finance'] as const).map(
            (kind) => (
              <Route
                key={kind}
                path={'/reports/' + kind}
                element={
                  <Access
                    permission={
                      kind === 'sales'
                        ? 'sales:read'
                        : kind === 'purchases'
                          ? 'purchase:read'
                          : kind === 'inventory'
                            ? 'inventory:read'
                            : 'finance:read'
                    }
                  >
                    <ReportPage key={kind} kind={kind} />
                  </Access>
                }
              />
            ),
          )}
          <Route path="/todos" element={<Dashboard todosOnly />} />
          <Route
            path="/stock-alerts"
            element={
              <Access permission="inventory:read">
                <StockAlertsPage />
              </Access>
            }
          />
          <Route
            path="/stock-adjustments"
            element={
              <Access permission="inventory:read">
                <StockAdjustmentsPage />
              </Access>
            }
          />
          <Route
            path="/system/users"
            element={
              <Access permission="system:manage">
                <UsersPage />
              </Access>
            }
          />
          <Route
            path="/system/roles"
            element={
              <Access permission="system:manage">
                <RolesPage />
              </Access>
            }
          />
          <Route
            path="/system/audit-logs"
            element={
              <Access permission="system:manage">
                <AuditLogsPage />
              </Access>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
function Access({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const auth = useAuth((state) => state.auth);
  if (!auth) return <LoadingState />;
  return can(auth.user.role.permissions, permission) ? (
    children
  ) : (
    <Result
      status="403"
      title="无权访问"
      subTitle="当前角色未获得此业务页面的访问权限"
    />
  );
}
function NotFound() {
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="404"
      subTitle="页面不存在"
      extra={
        <Button type="primary" onClick={() => navigate('/')}>
          返回工作台
        </Button>
      }
    />
  );
}
