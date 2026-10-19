import { test, expect } from '@playwright/test';
test('出库已提交但响应断开，刷新后仍使用原幂等键重试', async ({ page }) => {
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
  const customers = await (await page.request.get('/api/v1/customers')).json();
  const warehouses = await (
    await page.request.get('/api/v1/warehouses')
  ).json();
  const supply = (await (await page.request.get('/api/v1/suppliers')).json())
    .data.items[0];
  const purchase = await page.request.post('/api/v1/purchase-orders', {
    headers,
    data: {
      supplierId: supply.id,
      warehouseId: warehouses.data.items[0].id,
      orderDate: '2026-10-16',
      items: [
        { productId: products.data.items[0].id, quantity: 10, unitPrice: 8000 },
      ],
    },
  });
  const po = (await purchase.json()).data;
  for (const action of ['submit', 'approve'])
    await page.request.post(`/api/v1/purchase-orders/${po.id}/${action}`, {
      headers,
      data: {},
    });
  expect(
    (
      await page.request.post('/api/v1/goods-receipts', {
        headers: { ...headers, 'Idempotency-Key': 'e2e-sales-opening' },
        data: {
          orderId: po.id,
          items: [{ orderItemId: po.items[0].id, quantity: 10 }],
        },
      })
    ).status(),
  ).toBe(201);
  const created = await page.request.post('/api/v1/sales-orders', {
    headers,
    data: {
      customerId: customers.data.items[0].id,
      warehouseId: warehouses.data.items[0].id,
      orderDate: '2026-10-16',
      items: [
        {
          productId: products.data.items[0].id,
          quantity: 10,
          unitPrice: 12000,
        },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const order = (await created.json()).data;
  for (const action of ['submit', 'approve'])
    expect(
      (
        await page.request.post(`/api/v1/sales-orders/${order.id}/${action}`, {
          headers,
          data: {},
        })
      ).ok(),
    ).toBe(true);
  let dropped = false;
  await page.route('**/api/v1/sales-shipments', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true;
      const real = await route.fetch();
      expect(real.status()).toBe(201);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto(`/sales-orders?view=${order.id}`);
  await page.getByRole('button', { name: '创建出库', exact: true }).click();
  const shipment = page.getByRole('dialog', {
    name: '创建销售出库',
    exact: true,
  });
  await shipment.getByRole('spinbutton', { name: '本次出库数量1' }).fill('2');
  await shipment.getByRole('button', { name: '确认出库', exact: true }).click();
  await expect(
    shipment.getByRole('button', { name: /重试原请求/ }),
  ).toBeVisible();
  const rotated = await page.request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://localhost:5173' },
    data: { username: 'admin', password: 'KingFlow@2026' },
  });
  expect(rotated.ok()).toBe(true);
  await shipment.getByRole('button', { name: /重试原请求/ }).click();
  await expect(
    shipment.getByText('安全令牌无效，请刷新页面后重试'),
  ).toBeVisible();
  await expect(
    shipment.getByRole('button', { name: /重试原请求/ }),
  ).toBeEnabled();
  await shipment.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await page
    .getByRole('button', { name: '重试未确认出库', exact: true })
    .click();
  await shipment.getByRole('button', { name: /重试原请求/ }).click();
  await expect(page.getByText('出库成功，库存与应收已同步')).toBeVisible();
  const records = await (
    await page.request.get('/api/v1/sales-shipments', {
      params: { orderId: order.id },
    })
  ).json();
  expect(records.data.total).toBe(1);
  expect(records.data.items[0].totalAmount).toBe(24000);
});

test('销售界面建单审核出3件后库存7、应收360且刷新持久化', async ({ page }) => {
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
  const category = (await (await page.request.get('/api/v1/categories')).json())
    .data.items[0];
  const product = await page.request.post('/api/v1/products', {
    headers,
    data: {
      code: 'E2E-SO-A',
      name: '销售验收商品A',
      categoryId: category.id,
      unit: '件',
      purchasePrice: 8000,
      salesPrice: 12000,
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).data.id;
  const supplier = (await (await page.request.get('/api/v1/suppliers')).json())
    .data.items[0];
  const warehouse = (
    await (await page.request.get('/api/v1/warehouses')).json()
  ).data.items.find((w: { name: string }) => w.name === '上海中心仓');
  const po = (
    await (
      await page.request.post('/api/v1/purchase-orders', {
        headers,
        data: {
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          orderDate: '2026-10-16',
          items: [{ productId, quantity: 10, unitPrice: 8000 }],
        },
      })
    ).json()
  ).data;
  for (const action of ['submit', 'approve'])
    await page.request.post(`/api/v1/purchase-orders/${po.id}/${action}`, {
      headers,
      data: {},
    });
  expect(
    (
      await page.request.post('/api/v1/goods-receipts', {
        headers: { ...headers, 'Idempotency-Key': 'e2e-sales-core-opening' },
        data: {
          orderId: po.id,
          items: [{ orderItemId: po.items[0].id, quantity: 10 }],
        },
      })
    ).status(),
  ).toBe(201);
  await page.goto('/sales-orders?new=1');
  const form = page.getByRole('dialog', { name: '新建销售订单', exact: true });
  await form.getByLabel('客户', { exact: true }).click();
  await page.getByText('远山科技有限公司', { exact: true }).last().click();
  await form.getByLabel('出库仓库', { exact: true }).click();
  await page.getByText('上海中心仓', { exact: true }).last().click();
  await form.getByRole('combobox', { name: '明细商品1' }).fill('E2E-SO-A');
  await page.getByText('E2E-SO-A · 销售验收商品A', { exact: true }).click();
  await form.getByRole('spinbutton', { name: '明细数量1' }).fill('3');
  await form.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('销售订单已保存')).toBeVisible();
  const order = (
    await (
      await page.request.get('/api/v1/sales-orders', {
        params: { q: '远山' },
      })
    ).json()
  ).data.items.find((o: { totalAmount: number }) => o.totalAmount === 36000);
  expect(order).toBeTruthy();
  await page.goto(`/sales-orders?view=${order.id}`);
  const detail = page.getByRole('dialog', {
    name: '销售订单详情',
    exact: true,
  });
  await detail.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(detail.locator('.document-heading .ant-tag')).toHaveText(
    '待审核',
  );
  await detail.getByRole('button', { name: '审核通过', exact: true }).click();
  await expect(detail.locator('.document-heading .ant-tag')).toHaveText(
    '已审核',
  );
  await detail.getByRole('button', { name: '创建出库', exact: true }).click();
  const shipment = page.getByRole('dialog', {
    name: '创建销售出库',
    exact: true,
  });
  await shipment.getByRole('button', { name: '确认出库', exact: true }).click();
  await expect(page.getByText('出库成功，库存与应收已同步')).toBeVisible();
  await expect(detail.locator('.document-heading .ant-tag')).toHaveText(
    '已出库',
  );
  await page.goto(`/stocks?q=E2E-SO-A`);
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'E2E-SO-A' })
      .getByRole('cell', { name: '7', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'E2E-SO-A' })
      .getByRole('cell', { name: '7', exact: true }),
  ).toBeVisible();
  const shipments = (
    await (
      await page.request.get('/api/v1/sales-shipments', {
        params: { orderId: order.id },
      })
    ).json()
  ).data;
  expect(shipments.total).toBe(1);
  const ar = (
    await (
      await page.request.get('/api/v1/receivables', {
        params: { shipmentId: shipments.items[0].id },
      })
    ).json()
  ).data;
  expect(ar.items[0].originalAmount).toBe(36000);
  await page.goto(`/receivables?shipmentId=${shipments.items[0].id}`);
  await expect(
    page.getByText(shipments.items[0].number, { exact: true }).first(),
  ).toBeVisible();
});
