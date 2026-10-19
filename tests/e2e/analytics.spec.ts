import { test, expect } from '@playwright/test';
async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
}
test('经营工作台、报表汇总与真实API一致，CSV可下载', async ({ page }) => {
  await login(page);
  const business = (
    await (await page.request.get('/api/v1/dashboard/business')).json()
  ).data;
  await expect(page.getByText('本月销售额', { exact: true })).toBeVisible();
  await expect(
    page.getByText('近30天销售趋势（元）', { exact: true }),
  ).toBeVisible();
  expect(business.trend).toHaveLength(30);
  await page.goto('/reports/sales');
  await expect(page.getByRole('heading', { name: '销售报表' })).toBeVisible();
  const report = (
    await (await page.request.get('/api/v1/reports/sales')).json()
  ).data;
  await expect(page.getByText('数量合计', { exact: true })).toBeVisible();
  await expect(
    page
      .locator('.ant-statistic')
      .filter({ hasText: '数量合计' })
      .locator('.ant-statistic-content'),
  ).toHaveText(report.totals.quantity.toLocaleString('en-US'));
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  expect((await downloaded).suggestedFilename()).toBe('kingflow-sales.csv');
  await expect(page.getByText('客户销售排行', { exact: true })).toBeVisible();
  for (const [kind, title, detail] of [
    ['purchases', '采购报表', '供应商采购排行'],
    ['inventory', '库存报表', '按仓库汇总'],
    ['finance', '往来报表', '原始金额'],
  ]) {
    await page.goto('/reports/' + kind);
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(detail, { exact: true }).first()).toBeVisible();
    const exported = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    expect((await exported).suggestedFilename()).toBe(`kingflow-${kind}.csv`);
  }
  await page.goto('/stock-alerts');
  await expect(page.getByRole('heading', { name: '库存预警' })).toBeVisible();
  await page.goto('/todos');
  await expect(page.getByRole('heading', { name: '业务待办' })).toBeVisible();
});
test('库存调整断开响应后刷新以原幂等键重试，只过账一次', async ({ page }) => {
  await login(page);
  const auth = (await (await page.request.get('/api/v1/auth/me')).json()).data;
  const headers = {
    Origin: 'http://localhost:5173',
    'X-CSRF-Token': auth.csrfToken,
  };
  const category = (await (await page.request.get('/api/v1/categories')).json())
    .data.items[0];
  const code = 'E2E-ADJ-' + Date.now();
  const created = await page.request.post('/api/v1/products', {
    headers,
    data: {
      code,
      name: '调整断网验收商品',
      categoryId: category.id,
      unit: '件',
      purchasePrice: 8000,
      salesPrice: 12000,
      minStock: 5,
    },
  });
  expect(created.status()).toBe(201);
  const product = (await created.json()).data;
  const warehouses = (
    await (await page.request.get('/api/v1/warehouses')).json()
  ).data.items;
  const warehouse = warehouses.find(
    (w: { status: string }) => w.status === 'ACTIVE',
  );
  let dropped = false;
  const keys: string[] = [];
  await page.route('**/api/v1/stock-adjustments', async (route) => {
    if (route.request().method() === 'POST') {
      keys.push(route.request().headers()['idempotency-key']);
      if (!dropped) {
        dropped = true;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  await page.goto('/stock-adjustments');
  await page.getByRole('button', { name: '新建库存调整', exact: true }).click();
  const drawer = page.getByRole('dialog', {
    name: '新建库存调整',
    exact: true,
  });
  await drawer.getByLabel('商品', { exact: true }).click();
  await drawer.getByRole('combobox').first().fill(code);
  await page.getByText(`${code} · 调整断网验收商品`, { exact: true }).click();
  await drawer.getByRole('combobox').nth(1).click();
  await page.getByText(warehouse.name, { exact: true }).last().click();
  await drawer.getByRole('spinbutton').fill('10');
  await drawer.getByRole('textbox').fill(code + '盘点');
  await drawer.getByRole('button', { name: '确认过账', exact: true }).click();
  await expect(
    drawer.getByRole('button', { name: '重试原请求', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '新建库存调整', exact: true }).click();
  await drawer.getByRole('button', { name: '重试原请求', exact: true }).click();
  await expect(page.getByText('库存调整已过账', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const adjustments = (
    await (
      await page.request.get('/api/v1/stock-adjustments', {
        params: { q: code },
      })
    ).json()
  ).data;
  expect(adjustments.total).toBe(1);
  const stock = (
    await (
      await page.request.get('/api/v1/stocks', {
        params: { productId: product.id, warehouseId: warehouse.id },
      })
    ).json()
  ).data;
  expect(stock.items[0].quantity).toBe(10);
});
