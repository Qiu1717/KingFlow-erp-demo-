import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
});
test('登录、导航、个人中心和退出', async ({ page }) => {
  await page.getByText('个人设置', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
  await page.goto('/master/products');
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
});
test('商品新增、查询、详情、修改、刷新持久化、停用和启用', async ({ page }) => {
  await page.getByText('商品管理', { exact: true }).click();
  await page.getByRole('button', { name: '新增商品', exact: true }).click();
  await page
    .getByRole('textbox', { name: '商品编码', exact: true })
    .fill('E2E-P01');
  await page
    .getByRole('textbox', { name: '商品名称', exact: true })
    .fill('浏览器验收商品');
  await page.getByLabel('商品分类', { exact: true }).click();
  await page.getByText('办公用品', { exact: true }).last().click();
  await page.getByLabel('计量单位').fill('件');
  await page.getByLabel('参考采购价（元）').fill('80.01');
  await page.getByLabel('参考销售价（元）').fill('120.50');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('新增成功')).toBeVisible();
  await page.getByPlaceholder('搜索编码或名称').fill('E2E-P01');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: '浏览器验收商品', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('row')
    .filter({ hasText: 'E2E-P01' })
    .getByRole('button', { name: '查看', exact: true })
    .click();
  await expect(page.getByText('商品详情', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'E2E-P01' })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '商品名称', exact: true })
    .fill('持久化验收商品');
  await page.getByLabel('参考销售价（元）').fill('128.88');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('保存成功')).toBeVisible();
  await page.reload();
  await page.getByPlaceholder('搜索编码或名称').fill('E2E-P01');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: '持久化验收商品', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('¥128.88', { exact: true })).toBeVisible();
  await page
    .getByRole('row')
    .filter({ hasText: 'E2E-P01' })
    .getByRole('button', { name: '停用', exact: true })
    .click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(
    page.getByRole('row').filter({ hasText: 'E2E-P01' }).getByText('已停用'),
  ).toBeVisible();
  await page
    .getByRole('row')
    .filter({ hasText: 'E2E-P01' })
    .getByRole('button', { name: '启用', exact: true })
    .click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(
    page.getByRole('row').filter({ hasText: 'E2E-P01' }).getByText('启用中'),
  ).toBeVisible();
});
for (const [menu, entity, code] of [
  ['客户管理', '客户', 'E2E-C'],
  ['供应商管理', '供应商', 'E2E-S'],
  ['仓库管理', '仓库', 'E2E-W'],
  ['商品分类', '分类', 'E2E-CAT'],
]) {
  test(`${entity}新增并刷新持久化`, async ({ page }) => {
    await page.getByText(menu, { exact: true }).click();
    await page
      .getByRole('button', { name: `新增${entity}`, exact: true })
      .click();
    await page
      .getByRole('textbox', { name: `${entity}编码`, exact: true })
      .fill(code);
    await page
      .getByRole('textbox', { name: `${entity}名称`, exact: true })
      .fill(`验收${entity}`);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('新增成功')).toBeVisible();
    await page.reload();
    await page.getByPlaceholder('搜索编码或名称').fill(code);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(
      page.getByRole('cell', { name: `验收${entity}`, exact: true }),
    ).toBeVisible();
  });
}
test('采购统计进入真实报表、未知路由404', async ({ page }) => {
  await page.getByRole('menuitem', { name: '采购管理', exact: true }).click();
  await page.getByText('采购统计', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '采购报表', exact: true })).toBeVisible();
  await page.goto('/unknown');
  await expect(page.getByRole('main').getByText('页面不存在')).toBeVisible();
});
test('全局搜索与CSV导出使用真实资料', async ({ page }) => {
  await page.getByRole('button', { name: '搜索资料 K' }).click();
  await page
    .getByPlaceholder('搜索商品、分类、客户、供应商或仓库')
    .fill('KF-0001');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: 'KF-0001', exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  expect((await download).suggestedFilename()).toContain('商品资料.csv');
  await page.getByRole('button', { name: '最近操作消息' }).click();
  await expect(
    page.getByText('展示实际操作日志，当前没有独立消息推送服务。'),
  ).toBeVisible();
});
test('销售角色仅可维护客户，商品API拒绝越权', async ({ page }) => {
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByLabel('用户名').fill('sales');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await page.getByText('商品管理', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '商品管理' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '新增商品', exact: true }),
  ).toHaveCount(0);
  const session = await (await page.request.get('/api/v1/auth/me')).json();
  const denied = await page.request.post('/api/v1/products', {
    headers: {
      Origin: 'http://localhost:5173',
      'X-CSRF-Token': session.data.csrfToken,
    },
    data: {},
  });
  expect(denied.status()).toBe(403);
  await page.getByText('客户管理', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: '新增客户', exact: true }),
  ).toBeVisible();
});
test('1440与1366布局验收截图', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByText('库存总数量', { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('dashboard-1440.png'),
    fullPage: true,
  });
  await page.getByText('商品管理', { exact: true }).click();
  await expect(
    page.getByRole('cell', { name: 'KF-0030', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('products-1440.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('products-1366.png'),
    fullPage: true,
  });
});
test('账号切换不展示前一账号缓存的日志', async ({ page }) => {
  await expect(page.getByText('库存总数量', { exact: true })).toBeVisible();
  await page.getByText('个人设置', { exact: true }).click();
  const session = await (await page.request.get('/api/v1/auth/me')).json();
  const logout = await page.request.post('/api/v1/auth/logout', {
    headers: {
      Origin: 'http://localhost:5173',
      'X-CSRF-Token': session.data.csrfToken,
    },
  });
  expect(logout.ok()).toBe(true);
  await page.clock.setFixedTime(new Date(Date.now() + 61000));
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/dashboard/summary', async (route) => {
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await page.getByLabel('用户名').fill('guest');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.locator('.user-name')).toContainText('只读访客');
  try {
    await expect(
      page.getByRole('main').getByText('演示管理员', { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByText('库存总数量', { exact: true })).toBeVisible();
});
test('服务端撤销会话后，业务请求401立即返回登录', async ({ page }) => {
  const session = await (await page.request.get('/api/v1/auth/me')).json();
  await page.request.post('/api/v1/auth/logout', {
    headers: {
      Origin: 'http://localhost:5173',
      'X-CSRF-Token': session.data.csrfToken,
    },
  });
  await page.getByText('商品管理', { exact: true }).click();
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '商品管理' })).toHaveCount(0);
});
test('其他标签切换账号后，操作消息按新身份加载', async ({ page }) => {
  await expect(page.getByText('库存总数量', { exact: true })).toBeVisible();
  await page.getByText('个人设置', { exact: true }).click();
  const login = await page.request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://localhost:5173' },
    data: { username: 'guest', password: 'KingFlow@2026' },
  });
  expect(login.ok()).toBe(true);
  await page.clock.setFixedTime(new Date(Date.now() + 61000));
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(page.locator('.user-name')).toContainText('只读访客');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/dashboard/summary', async (route) => {
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '最近操作消息' }).click();
  try {
    await expect(
      page
        .getByRole('dialog')
        .getByText('演示管理员 登录了账号', { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    page
      .getByRole('dialog')
      .getByText('只读访客 登录了账号', { exact: true })
      .first(),
  ).toBeVisible();
});
