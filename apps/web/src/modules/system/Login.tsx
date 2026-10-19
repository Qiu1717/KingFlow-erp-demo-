import { useState } from 'react';
import { App, Alert, Button, Form, Input, Typography } from 'antd';
import {
  ArrowRight,
  Layers3,
  ShieldCheck,
  Database,
  Workflow,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { registrationSchema } from '@kingflow/shared';
import type { AuthData } from '@kingflow/shared';
import { http, get, errorMessage } from '../../services/client';
import { useAuth } from '../../stores/auth';
export function Login({ registering = false }: { registering?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [registered, setRegistered] = useState(false);
  const options = useQuery({
    queryKey: ['auth-options'],
    queryFn: () => get<{ registrationEnabled: boolean }>('/auth/options'),
    retry: false,
  });
  const client = useQueryClient();
  const { message } = App.useApp();
  async function submit(values: {
    username: string;
    password: string;
    displayName?: string;
    confirmPassword?: string;
  }) {
    setLoading(true);
    setError('');
    try {
      if (registering) {
        const parsed = registrationSchema.safeParse({
          username: values.username,
          password: values.password,
          displayName: values.displayName,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0].message);
          return;
        }
        await http.post('/auth/register', parsed.data);
        setRegistered(true);
        return;
      }
      const data = (await http.post<{ data: AuthData }>('/auth/login', values))
        .data.data;
      await client.cancelQueries();
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      useAuth.getState().setAuth(data);
      client.setQueryData(['session'], data);
      void message.success('登录成功');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand">
          <div className="brand-mark">
            <Layers3 size={26} />
          </div>
          <strong>
            KingFlow<span> ERP</span>
          </strong>
        </div>
        <div className="story-content">
          <div className="story-kicker">MAKE EVERY FLOW COUNT</div>
          <h1>
            企业经营，
            <br />
            有序向前。
          </h1>
          <p>
            连接资料、业务与决策，
            <br />
            让每一次协作都清晰高效。
          </p>
          <div className="story-visual">
            <div className="story-ring" />
            <div className="story-tile tile-one">
              <Database size={30} />
              <span>统一数据</span>
            </div>
            <div className="story-tile tile-two">
              <Workflow size={30} />
              <span>业务协同</span>
            </div>
            <div className="story-tile tile-three">
              <ShieldCheck size={30} />
              <span>安全可靠</span>
            </div>
          </div>
        </div>
        <div className="story-footer">KINGFLOW ERP · 企业资源管理系统</div>
      </section>
      <section className="login-form-side">
        <div className="login-form-wrap">
          <Tagline />
          <Typography.Title level={2}>
            {registering ? '注册账号' : '欢迎回来'}
          </Typography.Title>
          <p className="login-subtitle">
            {registering
              ? '提交注册申请，由管理员审核并分配业务角色。'
              : '登录 KingFlow，开启高效的一天。'}
          </p>
          {error && (
            <Alert
              type="error"
              showIcon
              message={error}
              style={{ marginBottom: 20 }}
            />
          )}
          {registering && options.isError && (
            <Alert
              type="error"
              showIcon
              message="无法确认注册状态，请稍后刷新重试"
            />
          )}
          {registering && options.data?.registrationEnabled === false && (
            <Alert
              type="warning"
              showIcon
              message="当前已关闭注册，请联系管理员"
            />
          )}
          {registered ? (
            <Alert
              type="success"
              showIcon
              message="注册申请已提交"
              description="请等待管理员审核。审核通过后，使用你设置的账号和密码登录。"
            />
          ) : (
            <Form
              layout="vertical"
              onFinish={submit}
              requiredMark={false}
              size="large"
              disabled={
                loading ||
                (registering && options.data?.registrationEnabled !== true)
              }
            >
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true, message: '请输入用户名' }]}
              >
                <Input
                  autoComplete="username"
                  placeholder="请输入用户名"
                  maxLength={60}
                />
              </Form.Item>
              {registering && (
                <Form.Item
                  name="displayName"
                  label="姓名"
                  rules={[
                    { required: true, whitespace: true, message: '请输入姓名' },
                    { max: 60 },
                  ]}
                >
                  <Input
                    autoComplete="name"
                    maxLength={60}
                    placeholder="请输入真实姓名，便于管理员审核"
                  />
                </Form.Item>
              )}
              <Form.Item
                name="password"
                label="密码"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password
                  autoComplete={
                    registering ? 'new-password' : 'current-password'
                  }
                  placeholder={
                    registering
                      ? '至少12位，包含大小写字母、数字和符号'
                      : '请输入密码'
                  }
                  maxLength={128}
                />
              </Form.Item>
              {registering && (
                <Form.Item
                  name="confirmPassword"
                  label="确认密码"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
                    ({ getFieldValue }) => ({
                      validator: (_, value: string) =>
                        !value || value === getFieldValue('password')
                          ? Promise.resolve()
                          : Promise.reject(new Error('两次输入的密码不一致')),
                    }),
                  ]}
                >
                  <Input.Password
                    autoComplete="new-password"
                    maxLength={72}
                    placeholder="请再次输入密码"
                  />
                </Form.Item>
              )}
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={loading}
                disabled={
                  registering && options.data?.registrationEnabled !== true
                }
              >
                {registering ? '提交注册申请' : '登录系统'}{' '}
                <ArrowRight size={17} />
              </Button>
            </Form>
          )}
          <p className="auth-switch">
            {registering ? (
              <Link to="/login">已有账号？返回登录</Link>
            ) : (
              options.data?.registrationEnabled && (
                <Link to="/register">没有账号？提交注册申请</Link>
              )
            )}
          </p>
          <div className="login-security">
            <ShieldCheck size={15} /> 安全会话认证 · 角色权限控制
          </div>
        </div>
        <footer>
          © {new Date().getFullYear()} KingFlow ERP · V1.0 企业资源管理
        </footer>
      </section>
    </div>
  );
}
function Tagline() {
  return <span className="login-tagline">企业资源管理工作空间</span>;
}
