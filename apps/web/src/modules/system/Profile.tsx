import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Space,
  Tag,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthData } from '@kingflow/shared';
import { useAuth } from '../../stores/auth';
import { PageHeader } from '../../components/common';
import { errorMessage, get, http } from '../../services/client';
import { permissionLabels } from './api';
export function Profile() {
  const auth = useAuth((state) => state.auth);
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [savingName, setSavingName] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordForm] = Form.useForm();
  return (
    <>
      <PageHeader
        title="个人中心"
        description="维护显示名称与账号密码，修改密码后需要重新登录。"
      />
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card title="账号信息">
          <Descriptions
            column={1}
            items={[
              {
                key: 'username',
                label: '登录账号',
                children: auth?.user.username,
              },
              { key: 'role', label: '角色', children: auth?.user.role.name },
              {
                key: 'permissions',
                label: '当前权限',
                children: (
                  <Space wrap>
                    {auth?.user.role.permissions.map((p) => (
                      <Tag key={p}>{permissionLabels[p] ?? p}</Tag>
                    ))}
                  </Space>
                ),
              },
              {
                key: 'timezone',
                label: '时区 / 币种',
                children: 'Asia/Shanghai / 人民币 CNY',
              },
            ]}
          />
        </Card>
        <Card title="个人设置">
          <Form
            layout="vertical"
            initialValues={{ displayName: auth?.user.displayName }}
            onFinish={async (data: { displayName: string }) => {
              setSavingName(true);
              try {
                await http.patch('/auth/profile', data);
                const updated = await get<AuthData>('/auth/me');
                client.setQueryData(['session'], updated);
                useAuth.getState().setAuth(updated);
                void message.success('显示名称已保存');
              } catch (error) {
                void message.error(errorMessage(error));
              } finally {
                setSavingName(false);
              }
            }}
            style={{ maxWidth: 440 }}
          >
            <Form.Item
              name="displayName"
              label="显示名称"
              rules={[
                { required: true, whitespace: true, message: '请输入显示名称' },
                { max: 60, message: '最多60个字符' },
              ]}
            >
              <Input />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={savingName}>
              保存名称
            </Button>
          </Form>
        </Card>
        <Card title="修改密码">
          <Alert
            showIcon
            type="warning"
            message="修改成功后，此账号的全部登录会话立即失效。"
            style={{ marginBottom: 20 }}
          />
          <Form
            form={passwordForm}
            layout="vertical"
            style={{ maxWidth: 440 }}
            onFinish={(data: {
              currentPassword: string;
              newPassword: string;
              confirmPassword: string;
            }) => {
              modal.confirm({
                title: '确定修改密码并退出？',
                content: '请使用新密码重新登录。',
                okText: '确定',
                cancelText: '取消',
                onOk: async () => {
                  setSavingPassword(true);
                  try {
                    await http.post('/auth/password', {
                      currentPassword: data.currentPassword,
                      newPassword: data.newPassword,
                    });
                    useAuth.getState().setAuth(null);
                    client.clear();
                    client.setQueryData(['session'], null);
                    passwordForm.resetFields();
                    navigate('/login', { replace: true });
                    void message.success('密码已修改，请重新登录');
                  } catch (error) {
                    void message.error(errorMessage(error));
                    throw error;
                  } finally {
                    setSavingPassword(false);
                  }
                },
              });
            }}
          >
            <Form.Item
              name="currentPassword"
              label="当前密码"
              rules={[{ required: true, message: '请输入当前密码' }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="新密码"
              rules={[
                { required: true, message: '请输入新密码' },
                { min: 8, max: 72, message: '密码为8至72位' },
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="确认新密码"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: '请再次输入新密码' },
                ({ getFieldValue }) => ({
                  validator: (_, value: string) =>
                    value === getFieldValue('newPassword')
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次密码不一致')),
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Button htmlType="submit" loading={savingPassword}>
              修改密码并退出
            </Button>
          </Form>
        </Card>
      </Space>
    </>
  );
}
