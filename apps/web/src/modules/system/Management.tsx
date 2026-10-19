import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
} from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  PageHeader,
  DataTable,
  FilterBar,
  FormDrawer,
  StatusTag,
  ErrorState,
  LoadingState,
} from '../../components/common';
import { errorMessage } from '../../services/client';
import { useAuth } from '../../stores/auth';
import {
  systemApi,
  permissionLabels,
  type SystemUser,
  type SystemRole,
  type AuditLog,
} from './api';
const nameRules = [
  { required: true, message: '请输入显示名称' },
  { max: 60, message: '最多60个字符' },
];
const passwordRules = [
  { required: true, message: '请输入密码' },
  { min: 8, max: 72, message: '密码为8至72位' },
];
export function UsersPage() {
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const self = useAuth((state) => state.auth?.user.id);
  const [query, setQuery] = useState({
    q: '',
    status: undefined as string | undefined,
    roleId: undefined as string | undefined,
    page: 1,
    pageSize: 20,
  });
  const users = useQuery({
    queryKey: ['system', 'users', query],
    queryFn: () => systemApi.users(query),
  });
  const roles = useQuery({
    queryKey: ['system', 'roles'],
    queryFn: systemApi.roles,
  });
  const [editing, setEditing] = useState<SystemUser | null | undefined>();
  const [resetting, setResetting] = useState<SystemUser>();
  const [reviewing, setReviewing] = useState<SystemUser>();
  const [reviewForm] = Form.useForm<{ roleId: string }>();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const refresh = () => client.invalidateQueries({ queryKey: ['system'] });
  async function review(decision: 'APPROVE' | 'REJECT') {
    if (!reviewing) return;
    const values =
      decision === 'APPROVE'
        ? await reviewForm.validateFields().catch(() => null)
        : undefined;
    if (decision === 'APPROVE' && !values) return;
    setSaving(true);
    try {
      await systemApi.reviewRegistration(
        reviewing.id,
        decision === 'APPROVE'
          ? { decision, roleId: values!.roleId }
          : { decision },
      );
      await refresh();
      setReviewing(undefined);
      void message.success(
        decision === 'APPROVE'
          ? '审核通过，账号现在可以登录'
          : '注册申请已驳回',
      );
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function save(data: {
    username?: string;
    displayName: string;
    password?: string;
    roleId: string;
  }) {
    setSaving(true);
    try {
      await systemApi.saveUser(data, editing?.id);
      await refresh();
      setEditing(undefined);
      void message.success('用户已保存');
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  function toggle(row: SystemUser) {
    modal.confirm({
      title: `确定${row.status === 'ACTIVE' ? '停用' : '启用'}用户？`,
      content: '状态变更会使该用户现有登录失效。',
      okText: '确定',
      cancelText: '取消',
      onOk: async () => {
        try {
          await systemApi.saveUser(
            { status: row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
            row.id,
          );
          await refresh();
          void message.success('用户状态已更新');
        } catch (error) {
          void message.error(errorMessage(error));
          throw error;
        }
      },
    });
  }
  if (roles.isPending) return <LoadingState />;
  if (roles.isError)
    return (
      <ErrorState error={roles.error} retry={() => void roles.refetch()} />
    );
  return (
    <>
      <PageHeader
        title="用户管理"
        description="审核注册申请、分配业务角色与管理登录安全。停用保留业务历史。"
        actions={
          <Button
            type="primary"
            onClick={() => {
              form.resetFields();
              setEditing(null);
            }}
          >
            新增用户
          </Button>
        }
      />
      <Card>
        <FilterBar>
          <Input.Search
            placeholder="搜索账号或姓名"
            allowClear
            style={{ width: 240 }}
            onSearch={(q) => setQuery({ ...query, q, page: 1 })}
          />
          <Select
            aria-label="筛选用户状态"
            placeholder="全部状态"
            allowClear
            style={{ width: 140 }}
            options={[
              { label: '待审核', value: 'PENDING' },
              { label: '已驳回', value: 'REJECTED' },
              { label: '启用', value: 'ACTIVE' },
              { label: '停用', value: 'INACTIVE' },
            ]}
            onChange={(status) => setQuery({ ...query, status, page: 1 })}
          />
          <Select
            aria-label="筛选用户角色"
            placeholder="全部角色"
            allowClear
            style={{ width: 160 }}
            options={roles.data.map((r) => ({ label: r.name, value: r.id }))}
            onChange={(roleId) => setQuery({ ...query, roleId, page: 1 })}
          />
        </FilterBar>
        {users.isError ? (
          <ErrorState error={users.error} retry={() => void users.refetch()} />
        ) : (
          <DataTable<SystemUser>
            loading={users.isFetching}
            dataSource={users.data?.items}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total: users.data?.total,
              showSizeChanger: true,
              onChange: (page, pageSize) =>
                setQuery({ ...query, page, pageSize }),
            }}
            columns={[
              { title: '登录账号', dataIndex: 'username' },
              { title: '显示名称', dataIndex: 'displayName' },
              {
                title: '角色',
                render: (_, r) =>
                  ['PENDING', 'REJECTED'].includes(r.status)
                    ? '待分配'
                    : r.role.name,
              },
              {
                title: '状态',
                render: (_, r) =>
                  r.status === 'PENDING' ? (
                    <Tag color="processing">待审核</Tag>
                  ) : r.status === 'REJECTED' ? (
                    <Tag color="error">已驳回</Tag>
                  ) : (
                    <StatusTag status={r.status} />
                  ),
              },
              {
                title: '创建时间',
                render: (_, r) => dayjs(r.createdAt).format('YYYY-MM-DD HH:mm'),
              },
              {
                title: '操作',
                width: 230,
                render: (_, r) =>
                  r.status === 'PENDING' ? (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => {
                        reviewForm.resetFields();
                        setReviewing(r);
                      }}
                    >
                      审核注册
                    </Button>
                  ) : r.status === 'REJECTED' ? (
                    <span>申请已驳回</span>
                  ) : (
                    <Space>
                      <Button
                        type="link"
                        size="small"
                        onClick={() => {
                          form.setFieldsValue({
                            displayName: r.displayName,
                            roleId: r.roleId,
                          });
                          setEditing(r);
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        type="link"
                        size="small"
                        disabled={r.id === self}
                        onClick={() => toggle(r)}
                      >
                        {r.status === 'ACTIVE' ? '停用' : '启用'}
                      </Button>
                      <Button
                        type="link"
                        size="small"
                        disabled={r.id === self}
                        onClick={() => {
                          passwordForm.resetFields();
                          setResetting(r);
                        }}
                      >
                        重置密码
                      </Button>
                    </Space>
                  ),
              },
            ]}
          />
        )}
      </Card>
      <Modal
        title={`审核注册：${reviewing?.username ?? ''}`}
        open={!!reviewing}
        onCancel={() => {
          if (!saving) setReviewing(undefined);
        }}
        destroyOnHidden
        footer={
          <Space wrap>
            <Button disabled={saving} onClick={() => setReviewing(undefined)}>
              取消
            </Button>
            <Button
              danger
              loading={saving}
              onClick={() => void review('REJECT')}
            >
              驳回申请
            </Button>
            <Button
              type="primary"
              loading={saving}
              onClick={() => void review('APPROVE')}
            >
              审核通过
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          message="请先核实申请人身份，再分配最小必要权限。通过后账号可立即登录。"
          style={{ marginBottom: 20 }}
        />
        <p>申请人：{reviewing?.displayName}</p>
        <Form form={reviewForm} layout="vertical" preserve={false}>
          <Form.Item
            name="roleId"
            label="批准后分配的角色"
            rules={[{ required: true, message: '请选择业务角色' }]}
          >
            <Select
              options={roles.data
                .filter(
                  (r) =>
                    r.code !== 'ADMIN' &&
                    !r.permissions.some(
                      (p) => p === '*' || p === 'system:manage',
                    ),
                )
                .map((r) => ({ label: r.name, value: r.id }))}
              placeholder="请选择业务角色"
            />
          </Form.Item>
        </Form>
      </Modal>
      <FormDrawer
        title={editing ? '编辑用户' : '新增用户'}
        open={editing !== undefined}
        onClose={() => {
          if (!saving) setEditing(undefined);
        }}
        footer={
          <Button type="primary" loading={saving} onClick={() => form.submit()}>
            保存
          </Button>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={save}
          preserve={false}
          initialValues={
            editing
              ? { displayName: editing.displayName, roleId: editing.roleId }
              : undefined
          }
        >
          {!editing && (
            <>
              <Form.Item
                name="username"
                label="登录账号"
                rules={[
                  { required: true },
                  {
                    pattern: /^[A-Za-z0-9_-]{3,60}$/,
                    message: '3至60位字母、数字、下划线或短横线',
                  },
                ]}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item name="password" label="初始密码" rules={passwordRules}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          )}
          <Form.Item name="displayName" label="显示名称" rules={nameRules}>
            <Input />
          </Form.Item>
          <Form.Item
            name="roleId"
            label="角色"
            rules={[{ required: true, message: '请选择角色' }]}
          >
            <Select
              disabled={editing?.id === self}
              options={roles.data.map((r) => ({ label: r.name, value: r.id }))}
            />
          </Form.Item>
        </Form>
      </FormDrawer>
      <Modal
        title={`重置密码：${resetting?.username ?? ''}`}
        open={!!resetting}
        onCancel={() => {
          if (!saving) setResetting(undefined);
        }}
        onOk={() => passwordForm.submit()}
        okText="确认重置"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message="重置后该用户的全部登录会话失效。"
          style={{ marginBottom: 20 }}
        />
        <Form
          form={passwordForm}
          layout="vertical"
          preserve={false}
          onFinish={async ({ password }: { password: string }) => {
            if (!resetting) return;
            setSaving(true);
            try {
              await systemApi.resetPassword(resetting.id, password);
              setResetting(undefined);
              void message.success('密码已重置');
            } catch (error) {
              void message.error(errorMessage(error));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Form.Item name="password" label="新密码" rules={passwordRules}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
export function RolesPage() {
  const { message } = App.useApp();
  const client = useQueryClient();
  const roles = useQuery({
    queryKey: ['system', 'roles'],
    queryFn: systemApi.roles,
  });
  const permissions = useQuery({
    queryKey: ['system', 'permissions'],
    queryFn: systemApi.permissions,
  });
  const [editing, setEditing] = useState<SystemRole>();
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  if (roles.isPending || permissions.isPending) return <LoadingState />;
  if (roles.isError || permissions.isError)
    return (
      <ErrorState
        error={roles.error ?? permissions.error}
        retry={() => {
          void roles.refetch();
          void permissions.refetch();
        }}
      />
    );
  return (
    <>
      <PageHeader
        title="角色权限"
        description="管理员保留全部权限；访客只可授予查询权限。权限保存后关联账号需要重新登录。"
      />
      <Card>
        <DataTable<SystemRole>
          dataSource={roles.data}
          pagination={false}
          columns={[
            { title: '角色编码', dataIndex: 'code' },
            { title: '角色名称', dataIndex: 'name' },
            { title: '用户数', render: (_, r) => r._count?.users ?? 0 },
            {
              title: '权限',
              render: (_, r) => (
                <Space wrap>
                  {r.permissions.map((p) => (
                    <Tag key={p}>{permissionLabels[p] ?? p}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: '操作',
              width: 120,
              render: (_, r) => (
                <Button
                  type="link"
                  disabled={r.code === 'ADMIN'}
                  onClick={() => {
                    setEditing(r);
                    setSelected(r.permissions);
                  }}
                >
                  编辑权限
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <FormDrawer
        title={`编辑权限：${editing?.name ?? ''}`}
        open={!!editing}
        onClose={() => {
          if (!saving) setEditing(undefined);
        }}
        footer={
          <Button
            type="primary"
            loading={saving}
            onClick={async () => {
              if (!editing) return;
              setSaving(true);
              try {
                await systemApi.saveRole(editing.id, selected);
                await client.invalidateQueries({ queryKey: ['system'] });
                setEditing(undefined);
                void message.success('权限已保存，相关会话已撤销');
              } catch (error) {
                void message.error(errorMessage(error));
              } finally {
                setSaving(false);
              }
            }}
          >
            保存权限
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          message="保存会撤销此角色全部现有登录会话。"
          style={{ marginBottom: 20 }}
        />
        <Checkbox.Group
          value={selected}
          onChange={(values) => setSelected(values.map(String))}
        >
          <Space direction="vertical">
            {permissions.data
              .filter((p) => editing?.code !== 'GUEST' || p.endsWith(':read'))
              .map((p) => (
                <Checkbox key={p} value={p}>
                  {permissionLabels[p] ?? p}
                </Checkbox>
              ))}
          </Space>
        </Checkbox.Group>
      </FormDrawer>
    </>
  );
}
export function AuditLogsPage() {
  const [form] = Form.useForm();
  const [query, setQuery] = useState<{
    page: number;
    pageSize: number;
    resource?: string;
    action?: string;
    actorId?: string;
    from?: string;
    to?: string;
  }>({ page: 1, pageSize: 20 });
  const logs = useQuery({
    queryKey: ['system', 'logs', query],
    queryFn: () => systemApi.logs(query),
  });
  return (
    <>
      <PageHeader
        title="操作日志"
        description="查询真实操作记录，日期按上海时区且包含起止当天。日志不记录密码或会话内容。"
      />
      <Card>
        <Form
          form={form}
          layout="inline"
          style={{ marginBottom: 20, gap: 12 }}
          onFinish={(values: {
            resource?: string;
            action?: string;
            actorId?: string;
            dates?: [dayjs.Dayjs, dayjs.Dayjs];
          }) =>
            setQuery({
              ...query,
              page: 1,
              resource: values.resource?.trim() || undefined,
              action: values.action?.trim() || undefined,
              actorId: values.actorId?.trim() || undefined,
              from: values.dates?.[0].format('YYYY-MM-DD'),
              to: values.dates?.[1].format('YYYY-MM-DD'),
            })
          }
        >
          <Form.Item name="resource">
            <Input placeholder="资源，如 users" allowClear />
          </Form.Item>
          <Form.Item name="action">
            <Input placeholder="动作，如 UPDATE" allowClear />
          </Form.Item>
          <Form.Item name="actorId">
            <Input placeholder="操作者ID" allowClear />
          </Form.Item>
          <Form.Item name="dates">
            <DatePicker.RangePicker />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            查询
          </Button>
          <Button
            onClick={() => {
              form.resetFields();
              setQuery({ page: 1, pageSize: 20 });
            }}
          >
            重置
          </Button>
        </Form>
        {logs.isError ? (
          <ErrorState error={logs.error} retry={() => void logs.refetch()} />
        ) : (
          <DataTable<AuditLog>
            loading={logs.isFetching}
            dataSource={logs.data?.items}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total: logs.data?.total,
              showSizeChanger: true,
              onChange: (page, pageSize) =>
                setQuery({ ...query, page, pageSize }),
            }}
            columns={[
              {
                title: '时间',
                render: (_, r) =>
                  dayjs(r.createdAt).format('YYYY-MM-DD HH:mm:ss'),
                width: 180,
              },
              {
                title: '操作者',
                render: (_, r) =>
                  `${r.actor.displayName} (${r.actor.username})`,
              },
              { title: '操作者ID', dataIndex: 'actorId', ellipsis: true },
              { title: '动作', dataIndex: 'action' },
              { title: '资源', dataIndex: 'resource' },
              { title: '目标ID', dataIndex: 'resourceId', ellipsis: true },
            ]}
          />
        )}
      </Card>
    </>
  );
}
