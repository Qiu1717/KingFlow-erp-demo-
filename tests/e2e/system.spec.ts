import { test, expect } from '@playwright/test';
// 该文件覆盖用户/角色/审计三段完整流程，且首次访问会触发 Vite 懒加载编译，
// 30 秒默认超时在全量串行运行时不足。
test.describe('系统管理', () => {
  test.setTimeout(120000);

  test('系统用户新增编辑启停、重置密码、角色权限与审计真实持久化', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByLabel('用户名')).toBeVisible();
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
    await page.getByRole('button', { name: '登录系统' }).click();
    await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
    await page.goto('/system/users');
    await page.getByRole('button', { name: '新增用户' }).click();
    const drawer = page.getByRole('dialog');
    const username = 'e2e_sys_' + Date.now();
    await drawer.getByLabel('登录账号').fill(username);
    await drawer.getByLabel('显示名称').fill('浏览器系统人员');
    await drawer.getByLabel('初始密码').fill('System@12345');
    await drawer.getByLabel('角色').click();
    await page.getByText('销售人员', { exact: true }).last().click();
    await drawer.getByRole('button', { name: '保存', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await page.getByPlaceholder('搜索账号或姓名').fill(username);
    await page.getByPlaceholder('搜索账号或姓名').press('Enter');
    const row = page.getByRole('row').filter({ hasText: username });
    await expect(row).toContainText('浏览器系统人员');
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await drawer.getByLabel('显示名称').fill('已编辑系统人员');
    await drawer.getByRole('button', { name: '保存', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await row.getByRole('button', { name: '停用', exact: true }).click();
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect(row).toContainText('已停用');
    await page.reload();
    await page.getByPlaceholder('搜索账号或姓名').fill(username);
    await page.getByPlaceholder('搜索账号或姓名').press('Enter');
    await expect(row).toContainText('已编辑系统人员');
    await row.getByRole('button', { name: '重置密码' }).click();
    await page.getByLabel('新密码', { exact: true }).fill('Reset@12345');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '确认重置' })
      .click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.goto('/system/roles');
    await expect(page.getByRole('heading', { name: '角色权限' })).toBeVisible();
    await page
      .getByRole('row')
      .filter({ hasText: 'SALES' })
      .getByRole('button', { name: '编辑权限' })
      .click();
    await expect(page.getByRole('dialog')).toContainText('销售人员');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存权限' })
      .click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.goto('/system/audit-logs');
    await expect(page.getByRole('heading', { name: '操作日志' })).toBeVisible();
    await page.getByPlaceholder('资源，如 users').fill('users');
    await page.getByPlaceholder('动作，如 UPDATE').fill('RESET_PASSWORD');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(
      page.getByRole('cell', { name: 'RESET_PASSWORD', exact: true }).first(),
    ).toBeVisible();
  });

  test('个人设置名称修改与改密退出、旧密码失效', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('用户名')).toBeVisible();
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
    await page.getByRole('button', { name: '登录系统' }).click();
    await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
    const auth = (await (await page.request.get('/api/v1/auth/me')).json()).data;
    const roles = (await (await page.request.get('/api/v1/system/roles')).json())
      .data;
    const username = 'profile_' + Date.now();
    expect(
      (
        await page.request.post('/api/v1/system/users', {
          headers: {
            Origin: 'http://localhost:5173',
            'X-CSRF-Token': auth.csrfToken,
          },
          data: {
            username,
            displayName: '个人设置验收',
            password: 'Profile@123',
            roleId: roles.find((r: { code: string }) => r.code === 'GUEST').id,
          },
        })
      ).status(),
    ).toBe(201);
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码', { exact: true }).fill('Profile@123');
    await page.getByRole('button', { name: '登录系统' }).click();
    await expect(page).not.toHaveURL(/\/login$/);
    await page.goto('/profile');
    await page.getByLabel('显示名称', { exact: true }).fill('个人修改成功');
    await page.getByRole('button', { name: '保存名称' }).click();
    await expect(page.getByText('个人修改成功').first()).toBeVisible();
    await page.getByLabel('当前密码').fill('Profile@123');
    await page.getByLabel('新密码', { exact: true }).fill('NewProfile@123');
    await page.getByLabel('确认新密码').fill('NewProfile@123');
    await page.getByRole('button', { name: '修改密码并退出' }).click();
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码', { exact: true }).fill('Profile@123');
    await page.getByRole('button', { name: '登录系统' }).click();
    await expect(page.getByText('用户名或密码错误')).toBeVisible();
    await page.getByLabel('密码', { exact: true }).fill('NewProfile@123');
    await page.getByRole('button', { name: '登录系统' }).click();
    await expect(page).not.toHaveURL(/\/login$/);
  });
});
