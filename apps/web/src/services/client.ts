import axios from 'axios';
import { useAuth } from '../stores/auth';
// Send only an invalidation signal; each tab verifies the HttpOnly session itself.
export const sessionChannel = new BroadcastChannel('kingflow-session');

/**
 * 每个请求都记录发起它时的会话标识（CSRF Token 与会话一一对应）。
 * 响应到达时若账号已经切换，这个旧请求的 401 不能用来判定「当前会话已失效」，
 * 否则用户切换账号后，切换前发出的迟到 401 会把新账号踢回登录页。
 */
export interface SessionScopedConfig {
  kfSessionToken?: string | null;
}

export const http = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  timeout: 15000,
});
http.interceptors.request.use((config) => {
  const auth = useAuth.getState().auth;
  const token = auth?.csrfToken;
  if (token) config.headers.set('X-CSRF-Token', token);
  (config as typeof config & SessionScopedConfig).kfSessionToken = token ?? null;
  return config;
});
http.interceptors.response.use((response) => {
  if (
    response.config.method === 'post' &&
    ['/auth/login', '/auth/logout', '/auth/password'].includes(
      response.config.url ?? '',
    )
  )
    sessionChannel.postMessage(null);
  return response;
});
/**
 * 401 是否属于「当前会话」。
 * 迟到请求携带的是旧会话标识时必须返回 false，调用方据此忽略该 401。
 */
export function isCurrentSessionFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 401) return false;
  const issuedWith = (error.config as SessionScopedConfig | undefined)
    ?.kfSessionToken;
  const current = useAuth.getState().auth?.csrfToken ?? null;
  if (!current) return true;
  // 未携带标识（例如登录前的匿名请求）无法证明属于当前会话，按当前会话处理。
  if (issuedWith === undefined) return true;
  return issuedWith === current;
}
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error))
    return (
      error.response?.data?.error?.message ??
      (error.code === 'ECONNABORTED'
        ? '请求超时，请重试'
        : '无法连接服务，请确认后端已启动')
    );
  return error instanceof Error ? error.message : '操作失败，请重试';
}
export async function get<T>(path: string, params?: object): Promise<T> {
  return (await http.get<{ data: T }>(path, { params })).data.data;
}
export function isUnauthorized(error: unknown) {
  return axios.isAxiosError(error) && error.response?.status === 401;
}
