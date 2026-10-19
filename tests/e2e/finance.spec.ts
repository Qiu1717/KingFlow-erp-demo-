import { test, expect } from '@playwright/test';
test('真实采购销售后，浏览器完成100+260收款及付款，响应丢失重试幂等', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
  const auth = (await (await page.request.get('/api/v1/auth/me')).json()).data;
  const headers = {
    Origin: 'http://localhost:5173',
    'X-CSRF-Token': auth.csrfToken,
  };
  const api = async (path: string, data: object, key?: string) => {
    const res = await page.request.post('/api/v1' + path, {
      headers: { ...headers, ...(key ? { 'Idempotency-Key': key } : {}) },
      data,
    });
    expect(res.ok()).toBe(true);
    return (await res.json()).data;
  };
  const data = async (path: string) =>
    (await (await page.request.get('/api/v1' + path)).json()).data;
  const product = (await data('/products?pageSize=100')).items[0];
  const supplier = (await data('/suppliers')).items[0];
  const customer = (await data('/customers')).items[0];
  const warehouse = (await data('/warehouses')).items[0];
  const po = await api('/purchase-orders', {
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    orderDate: '2026-10-16',
    items: [{ productId: product.id, quantity: 10, unitPrice: 8000 }],
  });
  for (const action of ['submit', 'approve'])
    await api(`/purchase-orders/${po.id}/${action}`, {});
  const gr = await api(
    '/goods-receipts',
    { orderId: po.id, items: [{ orderItemId: po.items[0].id, quantity: 10 }] },
    'e2e-finance-purchase',
  );
  const so = await api('/sales-orders', {
    customerId: customer.id,
    warehouseId: warehouse.id,
    orderDate: '2026-10-16',
    items: [{ productId: product.id, quantity: 3, unitPrice: 12000 }],
  });
  for (const action of ['submit', 'approve'])
    await api(`/sales-orders/${so.id}/${action}`, {});
  const shipment = await api(
    '/sales-shipments',
    { orderId: so.id, items: [{ orderItemId: so.items[0].id, quantity: 3 }] },
    'e2e-finance-shipment',
  );
  const ar = (await data('/receivables?shipmentId=' + shipment.id)).items[0];
  const ap = (await data('/payables?receiptId=' + gr.id)).items[0];
  await page.goto('/receivables?view=' + ar.id);
  const drawer = page.getByRole('dialog', { name: '收款单据详情' });
  await expect(
    drawer.getByText('¥360.00', { exact: true }).first(),
  ).toBeVisible();
  let aborted = false;
  await page.route('**/api/v1/settlements/receipts', async (route) => {
    if (!aborted) {
      aborted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort();
    } else await route.continue();
  });
  await drawer.getByLabel('收款金额（元）').fill('100');
  await drawer.getByRole('button', { name: '确认收款' }).click();
  await expect(
    drawer.getByRole('button', { name: /重试原结算请求/ }),
  ).toBeEnabled();
  await page.reload();
  await page
    .getByRole('dialog', { name: '收款单据详情' })
    .getByRole('button', { name: /重试原结算请求/ })
    .click();
  await expect(drawer.getByText('部分结清', { exact: true })).toBeVisible();
  await expect(drawer.getByText('¥260.00', { exact: true })).toBeVisible();
  await drawer.getByLabel('收款金额（元）').fill('260');
  await drawer.getByRole('button', { name: '确认收款' }).click();
  await expect(drawer.getByText('已结清', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: '确认收款' })).toHaveCount(0);
  expect((await data('/settlements?sourceId=' + ar.id)).total).toBe(2);
  await page.goto('/payables?view=' + ap.id);
  const payable = page.getByRole('dialog', { name: '付款单据详情' });
  await payable.getByLabel('付款金额（元）').fill('200');
  await payable.getByRole('button', { name: '确认付款' }).click();
  await expect(payable.getByText('部分结清', { exact: true })).toBeVisible();
  await payable.getByLabel('付款金额（元）').fill('600');
  await payable.getByRole('button', { name: '确认付款' }).click();
  await expect(payable.getByText('已结清', { exact: true })).toBeVisible();
  await page.goto('/finance/summary');
  await expect(page.getByText('未收余额', { exact: true })).toBeVisible();
  await page.goto('/receipts');
  await expect(page.getByRole('heading', { name: '收款记录' })).toBeVisible();
});
test('销售角色访问财务专用API和页面都被拒绝', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('sales');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
  expect((await page.request.get('/api/v1/payables')).status()).toBe(403);
  await page.goto('/payables');
  await expect(page.getByText('无权访问', { exact: true })).toBeVisible();
});
test('切换往来来源时，旧结算响应不会清除另一单的未确认请求', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
  const list = (
    await (
      await page.request.get('/api/v1/receivables', {
        params: { status: 'UNSETTLED', pageSize: 10 },
      })
    ).json()
  ).data.items;
  const [a, b] = list.filter(
    (row: { originalAmount: number; receivedAmount: number }) =>
      row.originalAmount - row.receivedAmount > 200,
  );
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dropped = false,
    aPosted = false;
  await page.route('**/api/v1/settlements/receipts', async (route) => {
    const body = route.request().postDataJSON();
    if (body.sourceId === b.id && !dropped) {
      dropped = true;
      expect((await route.fetch()).status()).toBe(201);
      await route.abort();
      return;
    }
    if (body.sourceId === a.id) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      aPosted = true;
      await held;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await page.goto('/receivables?status=UNSETTLED');
  await page.getByRole('button', { name: b.number, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '收款单据详情' });
  await drawer.getByLabel('收款金额（元）').fill('1');
  await drawer.getByRole('button', { name: '确认收款', exact: true }).click();
  await expect(
    drawer.getByRole('button', { name: /重试原结算请求/ }),
  ).toBeEnabled();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: a.number, exact: true }).click();
  await drawer.getByLabel('收款金额（元）').fill('1');
  await drawer.getByRole('button', { name: '确认收款', exact: true }).click();
  await expect.poll(() => aPosted).toBe(true);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: b.number, exact: true }).click();
  release();
  await expect(
    drawer.getByRole('button', { name: /重试原结算请求/ }),
  ).toBeEnabled();
  await drawer.getByRole('button', { name: /重试原结算请求/ }).click();
  await expect(
    drawer.getByRole('button', { name: '确认收款', exact: true }),
  ).toBeVisible();
  const records = (
    await (
      await page.request.get('/api/v1/settlements', {
        params: { sourceId: b.id },
      })
    ).json()
  ).data;
  expect(records.total).toBe(1);
  expect(records.items[0].amount).toBe(100);
});
