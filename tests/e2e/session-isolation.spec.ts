import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username = 'admin') {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.locator('.user-name')).toBeVisible();
}

test('另一标签退出后，当前标签立即清除受保护页面', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByText('个人设置', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/profile');
  await other.getByRole('button', { name: '退出登录' }).click();
  await expect(other.getByRole('button', { name: '登录系统' })).toBeVisible();
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '个人中心' })).toHaveCount(0);
});

test('重新验证发现账号切换时，清除旧账号页面草稿', async ({ page }) => {
  await login(page);
  await page.getByText('个人设置', { exact: true }).click();
  await page
    .getByLabel('显示名称', { exact: true })
    .fill('旧管理员尚未保存的姓名');
  const switched = await page.request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://localhost:5173' },
    data: { username: 'guest', password: 'KingFlow@2026' },
  });
  expect(switched.ok()).toBe(true);
  const next = await switched.json();
  await page.clock.setFixedTime(new Date(Date.now() + 61000));
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(page.locator('.user-name')).toContainText(
    next.data.user.displayName,
  );
  await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue(
    next.data.user.displayName,
  );
});

test('退出前发出的会话查询延迟返回时不能恢复已退出的身份', async ({ page }) => {
  await login(page);
  await page.getByText('个人设置', { exact: true }).click();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    captured();
    await hold;
    await route.fulfill({ response });
  });
  await page.clock.setFixedTime(new Date(Date.now() + 61000));
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await ready;
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
  const returned = page.waitForResponse('**/api/v1/auth/me');
  release();
  await returned;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(page.locator('.user-name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
});

test('旧会话业务请求延迟返回401时不能退出新账号', async ({ page, context }) => {
  await login(page);
  await page.getByText('个人设置', { exact: true }).click();
  const oldCookie = (await context.cookies()).find(
    (cookie) => cookie.name === 'kf_session',
  )!;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let first = true;
  await page.route('**/api/v1/products?**', async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    captured();
    await hold;
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        cookie: `kf_session=${oldCookie.value}`,
      },
    });
    expect(response.status()).toBe(401);
    await route.fulfill({ response });
  });
  await page.getByText('商品管理', { exact: true }).click();
  await ready;
  const switched = await page.request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://localhost:5173' },
    data: { username: 'guest', password: 'KingFlow@2026' },
  });
  expect(switched.ok()).toBe(true);
  await page.clock.setFixedTime(new Date(Date.now() + 61000));
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(page.locator('.user-name')).toContainText('只读访客');
  const returned = page.waitForResponse(
    (response) =>
      response.url().includes('/products?') && response.status() === 401,
  );
  release();
  await returned;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(page.locator('.user-name')).toContainText('只读访客');
  await expect(page.getByRole('heading', { name: '商品管理' })).toBeVisible();
});
