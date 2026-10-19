import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, username = 'admin') {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
}

test('数据可视化四类图表、数量排行及仓库日期筛选使用真实API', async ({
  page,
}) => {
  await login(page);
  await page.goto('/visualizations');
  await expect(
    page.getByRole('heading', { name: '数据可视化', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('销售趋势图')).toBeVisible();
  const note = await page.getByText(/^仅统计正式过账；/).boundingBox();
  const ranking = await page
    .getByLabel('客户销售排行图')
    .locator('..')
    .locator('..')
    .boundingBox();
  expect(note).not.toBeNull();
  expect(ranking).not.toBeNull();
  expect(ranking!.y).toBeGreaterThanOrEqual(note!.y + note!.height);
  const quantity = page.waitForResponse(
    (r) =>
      r.url().includes('/reports/sales?') &&
      r.url().includes('rankBy=quantity'),
  );
  await page.getByLabel('图表指标').getByText('数量', { exact: true }).click();
  await expect(
    page.getByRole('radio', { name: '数量', exact: true }),
  ).toBeChecked();
  expect((await quantity).ok()).toBe(true);
  await expect(page.getByLabel('客户销售排行图')).toBeVisible();
  const period = page.waitForResponse(
    (r) => r.url().includes('/reports/sales?') && r.url().includes('dateFrom='),
  );
  await page.getByRole('button', { name: '近30天', exact: true }).click();
  expect((await period).ok()).toBe(true);
  const warehouses = (
    await (await page.request.get('/api/v1/warehouses')).json()
  ).data.items;
  await page.getByRole('combobox', { name: '筛选仓库' }).click();
  await page.getByTitle(warehouses[0].name, { exact: true }).click();
  const filtered = page.waitForResponse(
    (r) =>
      r.url().includes('/reports/sales?') &&
      r.url().includes(`warehouseId=${warehouses[0].id}`),
  );
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const result = (await (await filtered).json()).data;
  await expect(
    page
      .locator('.ant-statistic')
      .filter({ hasText: '数量合计' })
      .locator('.ant-statistic-content'),
  ).toHaveText(result.totals.quantity.toLocaleString('en-US'));
  await page.getByRole('tab', { name: '采购分析', exact: true }).click();
  await expect(page.getByLabel('采购趋势图')).toBeVisible();
  await page.getByRole('tab', { name: '库存分析', exact: true }).click();
  await expect(page.getByLabel('仓库库存对比图')).toBeVisible();
  await expect(page.getByLabel('仓库库存占比图')).toBeVisible();
  await page.getByRole('tab', { name: '往来分析', exact: true }).click();
  await expect(page.getByLabel('应收应付结算对比图')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('kingflow-finance.csv');
});

test('图表空态及请求失败有明确反馈，刷新可恢复', async ({ page }) => {
  await login(page);
  await page.goto('/visualizations');
  await page
    .getByPlaceholder('搜索单号、商品或往来单位')
    .fill('NO-DATA-VISUALIZATION-TEST');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(
    page.getByLabel('销售趋势图').getByText('当前筛选范围暂无图表数据'),
  ).toBeVisible();
  await page.route('**/api/v1/reports/sales?*', (route) => route.abort());
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.getByText('暂时无法加载', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByLabel('销售趋势图')).toHaveCount(0);
  await page.unroute('**/api/v1/reports/sales?*');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByLabel('销售趋势图')).toBeVisible();
});

test('销售角色只显示获授权的可视化页签', async ({ page }) => {
  await login(page, 'sales');
  await page.goto('/visualizations');
  await expect(
    page.getByRole('tab', { name: '销售分析', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: '库存分析', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: '采购分析', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('tab', { name: '往来分析', exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await page.request.get('/api/v1/reports/finance?rankBy=quantity')
    ).status(),
  ).toBe(403);
});
