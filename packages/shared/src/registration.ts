import { z } from 'zod';

export const accountNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{3,60}$/, '账号为3至60位字母、数字、下划线或短横线');
export const accountPasswordSchema = z
  .string()
  .min(12, '密码至少12位')
  .max(72)
  .refine(
    (value) => new TextEncoder().encode(value).length <= 72,
    '密码最多72字节',
  )
  .refine(
    (value) =>
      /[a-z]/.test(value) &&
      /[A-Z]/.test(value) &&
      /[0-9]/.test(value) &&
      /[^A-Za-z0-9\s]/.test(value),
    '密码需包含大写字母、小写字母、数字和符号',
  )
  .refine((value) => !/kingflow/i.test(value), '请勿使用系统名称或演示密码');
export const registrationSchema = z
  .object({
    username: accountNameSchema,
    displayName: z.string().trim().min(1, '请输入姓名').max(60),
    password: accountPasswordSchema,
  })
  .strict();
export type RegistrationInput = z.infer<typeof registrationSchema>;
