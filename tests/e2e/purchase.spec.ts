import { test, expect } from '@playwright/test';
test('入库已提交但响应断开，刷新后仍使用原幂等键重试', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/me')).json();
  const headers = {
    Origin: 'http://localhost:5173',
    'X-CSRF-Token': auth.data.csrfToken,
  };
  const products = await (
    await page.request.get('/api/v1/products', { params: { q: 'KF-0001' } })
  ).json();
  const suppliers = await (await page.request.get('/api/v1/suppliers')).json();
  const warehouses = await (
    await page.request.get('/api/v1/warehouses')
  ).json();
  const created = await page.request.post('/api/v1/purchase-orders', {
    headers,
    data: {
      supplierId: suppliers.data.items[0].id,
      warehouseId: warehouses.data.items[0].id,
      orderDate: '2026-10-16',
      items: [
        { productId: products.data.items[0].id, quantity: 10, unitPrice: 8000 },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const order = (await created.json()).data;
  for (const action of ['submit', 'approve'])
    expect(
      (
        await page.request.post(
          `/api/v1/purchase-orders/${order.id}/${action}`,
          { headers, data: {} },
        )
      ).ok(),
    ).toBe(true);
  let dropped = false;
  await page.route('**/api/v1/goods-receipts', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true;
      const real = await route.fetch();
      expect(real.status()).toBe(201);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto(`/purchase-orders?view=${order.id}`);
  await page.getByRole('button', { name: '创建入库', exact: true }).click();
  const receipt = page.getByRole('dialog', {
    name: '创建采购入库',
    exact: true,
  });
  await receipt.getByRole('spinbutton', { name: '本次入库数量1' }).fill('2');
  await receipt.getByRole('button', { name: '确认入库', exact: true }).click();
  await expect(
    receipt.getByRole('button', { name: /重试原请求/ }),
  ).toBeVisible();
  const rotated = await page.request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://localhost:5173' },
    data: { username: 'admin', password: 'KingFlow@2026' },
  });
  expect(rotated.ok()).toBe(true);
  await receipt.getByRole('button', { name: /重试原请求/ }).click();
  await expect(
    receipt.getByText('安全令牌无效，请刷新页面后重试'),
  ).toBeVisible();
  await expect(
    receipt.getByRole('button', { name: /重试原请求/ }),
  ).toBeEnabled();
  await receipt.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await page
    .getByRole('button', { name: '重试未确认入库', exact: true })
    .click();
  await receipt.getByRole('button', { name: /重试原请求/ }).click();
  await expect(page.getByText('入库成功，库存与应付已同步')).toBeVisible();
  const records = await (
    await page.request.get('/api/v1/goods-receipts', {
      params: { orderId: order.id },
    })
  ).json();
  expect(records.data.total).toBe(1);
  expect(records.data.items[0].totalAmount).toBe(16000);
});
test('采购10件×80元，分批6+4入库后库存与应付一致', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('KingFlow@2026');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '经营概览' })).toBeVisible();
  const auth = await (await page.request.get('/api/v1/auth/me')).json();
  const headers = {
    Origin: 'http://localhost:5173',
    'X-CSRF-Token': auth.data.csrfToken,
  };
  const categories = await (
    await page.request.get('/api/v1/categories')
  ).json();
  const product = await page.request.post('/api/v1/products', {
    headers,
    data: {
      code: 'E2E-PO-A',
      name: '采购验收商品A',
      categoryId: categories.data.items[0].id,
      unit: '件',
      purchasePrice: 8000,
      salesPrice: 12000,
    },
  });
  expect(product.status()).toBe(201);
  await page.getByRole('menuitem', { name: '采购管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '采购订单', exact: true }).click();
  await page.getByRole('button', { name: '新建采购订单', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('供应商', { exact: true }).click();
  await page.getByText('优品办公供应链', { exact: true }).last().click();
  await drawer.getByLabel('入库仓库', { exact: true }).click();
  await page.getByText('上海中心仓', { exact: true }).last().click();
  await drawer.getByRole('combobox', { name: '明细商品1' }).fill('E2E-PO-A');
  await page.getByText('E2E-PO-A · 采购验收商品A', { exact: true }).click();
  await drawer.getByRole('spinbutton', { name: '明细数量1' }).fill('10');
  await drawer.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('采购订单已保存')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: '草稿' }).first();
  await row.getByRole('button', { name: '查看', exact: true }).click();
  const detail = page.getByRole('dialog', {
    name: '采购订单详情',
    exact: true,
  });
  const number = await detail.locator('[data-document-number]').innerText();
  await expect(
    detail.getByText('¥800.00', { exact: true }).first(),
  ).toBeVisible();
  await detail.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(detail.getByText('待审核', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '审核通过', exact: true }).click();
  await expect(detail.getByText('已审核', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '创建入库', exact: true }).click();
  const receipt = page.getByRole('dialog', {
    name: '创建采购入库',
    exact: true,
  });
  await receipt.getByRole('spinbutton', { name: '本次入库数量1' }).fill('6');
  await expect(
    receipt.getByText('¥480.00', { exact: true }).first(),
  ).toBeVisible();
  await receipt.getByRole('button', { name: '确认入库', exact: true }).click();
  await expect(page.getByText('入库成功，库存与应付已同步')).toBeVisible();
  await expect(detail.getByText('部分入库', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '创建入库', exact: true }).click();
  await receipt.getByRole('spinbutton', { name: '本次入库数量1' }).fill('4');
  await receipt.getByRole('button', { name: '确认入库', exact: true }).click();
  await expect(detail.locator('.document-heading .ant-tag')).toHaveText(
    '已入库',
  );
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('menuitem', { name: '库存管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '实时库存', exact: true }).click();
  await page.getByPlaceholder('搜索单号、名称或编码').fill('E2E-PO-A');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const stock = page.getByRole('row').filter({ hasText: 'E2E-PO-A' });
  await expect(
    stock.getByRole('cell', { name: '10', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'E2E-PO-A' })
      .getByRole('cell', { name: '10', exact: true }),
  ).toBeVisible();
  await page.getByRole('menuitem', { name: '财务管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '应付账款', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '应付账款', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: '财务关键词' })
    .fill('优品办公供应链');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  const order = await (
    await page.request.get('/api/v1/purchase-orders', { params: { q: number } })
  ).json();
  const receipts = await (
    await page.request.get('/api/v1/goods-receipts', {
      params: { orderId: order.data.items[0].id },
    })
  ).json();
  expect(
    receipts.data.items.reduce(
      (sum: number, r: { totalAmount: number }) => sum + r.totalAmount,
      0,
    ),
  ).toBe(80000);
  for (const r of receipts.data.items) {
    const payable = await (
      await page.request.get('/api/v1/payables', {
        params: { receiptId: r.id },
      })
    ).json();
    expect(payable.data.items[0].originalAmount).toBe(r.totalAmount);
    await expect(
      page.getByRole('row').filter({ hasText: r.number }),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath('purchase-payables.png'),
    fullPage: true,
  });
});
