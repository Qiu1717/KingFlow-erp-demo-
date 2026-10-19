import { accountPasswordSchema } from '@kingflow/shared';

/**
 * 账号口令的前端校验规则。
 *
 * 直接复用共享包的 `accountPasswordSchema`，与后端（注册 / 管理员建号 /
 * 管理员重置 / 个人改密）使用同一份策略，不再各写一套导致漂移：
 * ≥12 位、≤72 字节、需含大小写字母/数字/符号、不得包含系统名称。
 *
 * 只做体验层的提前提示，服务端仍然是唯一权威校验。
 */
export const PASSWORD_HINT = '至少12位，包含大小写字母、数字和符号';

export const accountPasswordRules = [
  { required: true, message: '请输入密码' },
  {
    validator: (_: unknown, value: string) => {
      if (!value) return Promise.resolve();
      const result = accountPasswordSchema.safeParse(value);
      return result.success
        ? Promise.resolve()
        : Promise.reject(new Error(result.error.issues[0]?.message ?? PASSWORD_HINT));
    },
  },
];
