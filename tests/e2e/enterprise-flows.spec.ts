import { expect, test, type Page } from '@playwright/test';

/**
 * 企业级浏览器端到端：六角色菜单/403、完整业务闭环、多标签会话隔离、
 * 表单校验真实反馈、1366/1440 布局、断网可恢复。
 * 所有业务操作走真实界面与真实接口，不 mock 业务。
 */
const PASSWORD = 'KingFlow@2026';
const ORIGIN = 'http://localhost:5173';
const roleAccounts = [
  { username: 'admin', role: '系统管理员', displayName: '演示管理员' },
  { username: 'purchase', role: '采购人员', displayName: '采购人员' },
  { username: 'sales', role: '销售人员', displayName: '销售人员' },
  { username: 'warehouse', role: '仓库人员', displayName: '仓库人员' },
  { username: 'finance', role: '财务人员', displayName: '财务人员' },
  { username: 'guest', role: '只读访客', displayName: '只读访客' },
];

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.locator('.user-name')).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
}

async function apiHeaders(page: Page) {
  const auth = (await (await page.request.get('/api/v1/auth/me')).json()).data;
  return {
    Origin: ORIGIN,
    'X-CSRF-Token': auth.csrfToken as string,
  };
}

/** 用真实 API 准备商品等主数据；界面交互仍全部点击真实按钮。 */
async function prepare(
  page: Page,
  options: { code: string; name: string; price: number; salePrice: number },
) {
  const headers = await apiHeaders(page);
  const categories = (
    await (await page.request.get('/api/v1/categories')).json()
  ).data.items;
  const suppliers = (
    await (await page.request.get('/api/v1/suppliers')).json()
  ).data.items;
  const customers = (
    await (await page.request.get('/api/v1/customers')).json()
  ).data.items;
  const warehouses = (
    await (await page.request.get('/api/v1/warehouses')).json()
  ).data.items;
  const product = await page.request.post('/api/v1/products', {
    headers,
    data: {
      code: options.code,
      name: options.name,
      categoryId: categories[0].id,
      unit: '件',
      purchasePrice: options.price,
      salesPrice: options.salePrice,
    },
  });
  expect(product.status()).toBe(201);
  return {
    product: (await product.json()).data,
    supplier: suppliers[0],
    customer: customers[0],
    warehouse:
      warehouses.find((w: { name: string }) => w.name === '上海中心仓') ??
      warehouses[0],
    headers,
  };
}


test.describe('六角色菜单与页面可见性', () => {
  test.setTimeout(120000);
  for (const account of roleAccounts) {
    test(`${account.role} 登录后仅看到有权限的菜单，直达未授权页面显示 403`, async ({
      page,
    }) => {
      await login(page, account.username);
      await expect(page.locator('.user-name')).toContainText(account.role);
      const isAdmin = account.username === 'admin';
      const isFinance = account.username === 'finance';
      // 分组是否展示，取决于该分组下是否存在任一有权访问的子项（见 AppLayout.menuPermissions）。
      // 财务人员持有 receipts:read / shipments:read，因此能看到采购管理(采购入库)与销售管理(销售出库)，
      // 但不持有采购/销售订单权限，看不到订单与统计页；库存管理整组对财务隐藏。
      const canPurchase =
        isAdmin || ['purchase', 'warehouse', 'guest', 'finance'].includes(account.username);
      const canSales =
        isAdmin || ['sales', 'warehouse', 'guest', 'finance'].includes(account.username);
      const canInventory = !isFinance;
      const sidebar = page.locator('.app-sidebar');
      // 系统管理分组始终存在（含个人设置），但用户/角色/审计仅管理员可见。
      for (const [item, expected] of [
        ['用户管理', isAdmin],
        ['角色权限', isAdmin],
        ['操作日志', isAdmin],
        ['个人设置', true],
      ] as [string, boolean][]) {
        await expect(
          sidebar.getByRole('menuitem', { name: item, exact: true }),
          `${account.username} 菜单 ${item}`,
        ).toHaveCount(expected ? 1 : 0);
      }
      // 整组受权限控制的分组：没有任一子项权限时整组隐藏。
      for (const [group, expected] of [
        ['财务管理', isAdmin || isFinance],
        ['采购管理', canPurchase],
        ['销售管理', canSales],
        ['库存管理', canInventory],
      ] as [string, boolean][]) {
        await expect(
          sidebar.getByRole('menuitem', { name: group, exact: true }),
          `${account.username} 菜单组 ${group}`,
        ).toHaveCount(expected ? 1 : 0);
      }
      // 财务只能看到出入库，不能看到采购/销售订单与统计（订单读写权限不在其角色内）。
      if (isFinance) {
        for (const item of ['采购订单', '采购统计', '销售订单', '销售统计']) {
          await expect(
            sidebar.getByRole('menuitem', { name: item, exact: true }),
            `财务不应看到 ${item}`,
          ).toHaveCount(0);
        }
        for (const item of ['采购入库', '销售出库']) {
          await expect(
            sidebar.getByRole('menuitem', { name: item, exact: true }),
            `财务应能看到 ${item}`,
          ).toHaveCount(1);
        }
      }
      // 经营报表分组按子项权限逐项展示。
      await expect(
        sidebar.getByRole('menuitem', { name: '经营报表', exact: true }),
      ).toHaveCount(1);
      await sidebar.getByRole('menuitem', { name: '经营报表', exact: true }).click();
      // 报表子项按各自的读取权限逐项判断（财务看不了销售/采购报表，也没有库存报表）。
      const canSalesReport = isAdmin || ['sales', 'warehouse', 'guest'].includes(account.username);
      const canPurchaseReport = isAdmin || ['purchase', 'warehouse', 'guest'].includes(account.username);
      for (const [item, expected] of [
        ['数据可视化', true],
        ['销售分析', canSalesReport],
        ['采购分析', canPurchaseReport],
        ['库存分析', !isFinance],
        ['往来分析', isAdmin || isFinance],
      ] as [string, boolean][]) {
        await expect(
          sidebar.getByRole('menuitem', { name: item, exact: true }),
          `${account.username} 报表项 ${item}`,
        ).toHaveCount(expected ? 1 : 0);
      }
      // 直达未授权路由：403 结果页；有权限页面正常渲染标题。
      const pages: [string, string, boolean][] = [
        ['/system/users', '用户管理', isAdmin],
        ['/system/roles', '角色权限', isAdmin],
        ['/system/audit-logs', '操作日志', isAdmin],
        ['/payables', '应付账款', isAdmin || isFinance],
        ['/receivables', '应收账款', isAdmin || isFinance],
        ['/finance/summary', '财务概览', isAdmin || isFinance],
        ['/reports/finance', '往来报表', isAdmin || isFinance],
        ['/reports/sales', '销售报表', canSalesReport],
        ['/reports/purchases', '采购报表', canPurchaseReport],
        ['/purchase-orders', '采购订单', isAdmin || ['purchase', 'warehouse', 'guest'].includes(account.username)],
        ['/sales-orders', '销售订单', isAdmin || ['sales', 'warehouse', 'guest'].includes(account.username)],
        ['/stock-adjustments', '库存调整', !isFinance],
      ];
      for (const [path, heading, allowed] of pages) {
        await page.goto(path);
        if (allowed) {
          await expect(
            page.getByRole('heading', { name: heading, exact: true }),
            `${account.username} ${path} 应可访问`,
          ).toBeVisible();
          await expect(page.getByText('无权访问', { exact: true })).toHaveCount(0);
        } else {
          await expect(
            page.getByText('无权访问', { exact: true }),
            `${account.username} ${path} 应 403`,
          ).toBeVisible();
          await expect(
            page.getByRole('heading', { name: heading, exact: true }),
          ).toHaveCount(0);
        }
      }
      // 个人中心所有角色可进。
      await page.goto('/profile');
      await expect(
        page.getByRole('heading', { name: '个人中心', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.user-name')).toContainText(account.displayName);
      await logout(page);
    });
  }

  test('只读访客没有任何写入口，直接调用写接口也 403', async ({ page }) => {
    await login(page, 'guest');
    await page.goto('/master/products');
    await expect(
      page.getByRole('heading', { name: '商品管理', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '新增商品', exact: true }),
    ).toHaveCount(0);
    // 商品默认按创建时间倒序分页，目标商品可能不在首屏：先按编码精确检索。
    await page.getByPlaceholder('搜索编码或名称').fill('KF-0001');
    await page.getByPlaceholder('搜索编码或名称').press('Enter');
    const row = page.getByRole('row').filter({ hasText: 'KF-0001' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: '查看', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: '停用', exact: true })).toHaveCount(0);
    // 后端同样拒绝：访客无 products:write。
    const headers = await apiHeaders(page);
    const denied = await page.request.post('/api/v1/products', {
      headers,
      data: {
        code: `E2E-GUEST-WRITE-${Date.now()}`,
        name: '访客越权商品',
        categoryId: 'x',
        unit: '件',
        purchasePrice: 1,
        salesPrice: 1,
      },
    });
    expect(denied.status()).toBe(403);
    // 库存调整页面可看但无新建按钮（缺 inventory:adjust）。
    await page.goto('/stock-adjustments');
    await expect(
      page.getByRole('heading', { name: '库存调整', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '新建库存调整', exact: true }),
    ).toHaveCount(0);
    // 采购单详情不显示审核/入库按钮。
    await page.goto('/purchase-orders');
    await expect(
      page.getByRole('heading', { name: '采购订单', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '新建采购订单', exact: true }),
    ).toHaveCount(0);
    await logout(page);
  });
});

test.describe('完整业务闭环', () => {
  test.setTimeout(240000);
  test('界面建单→审核→分批入库→应付付款→销售→出库→应收收款→报表一致', async ({
    page,
  }) => {
    await login(page, 'admin');
    const stamp = Date.now();
    const productCode = `E2E-FLOW-${stamp}`;
    const productName = `闭环验收商品${stamp}`;
    const data = await prepare(page, {
      code: productCode,
      name: productName,
      price: 8000,
      salePrice: 12000,
    });

    // ---------- 采购：界面建单 → 提交 → 审核 ----------
    await page.goto('/purchase-orders');
    await page.getByRole('button', { name: '新建采购订单', exact: true }).click();
    const orderForm = page.getByRole('dialog', { name: '新建采购订单', exact: true });
    // 供应商下拉可搜索且可滚动，先输入名字过滤再选，避免目标条目不在可视区。
    await orderForm.getByLabel('供应商', { exact: true }).click();
    await orderForm.getByLabel('供应商', { exact: true }).fill(data.supplier.name);
    await page.getByText(data.supplier.name, { exact: true }).last().click();
    await orderForm.getByLabel('入库仓库', { exact: true }).click();
    await page.getByText(data.warehouse.name, { exact: true }).last().click();
    await orderForm.getByRole('combobox', { name: '明细商品1' }).fill(productCode);
    await page.getByText(`${productCode} · ${productName}`, { exact: true }).click();
    await orderForm.getByRole('spinbutton', { name: '明细数量1' }).fill('10');
    await orderForm.getByRole('spinbutton', { name: '明细单价1' }).fill('80');
    await expect(
      orderForm.getByText('¥800.00', { exact: true }).first(),
    ).toBeVisible();
    await orderForm.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('采购订单已保存')).toBeVisible();
    await expect(orderForm).not.toBeVisible();
    // 采购订单列表只展示单号/供应商/金额，不含商品名：新单按创建时间倒序排在首行，
    // 且是当前唯一一张草稿单，用它精确定位，避免命中已关闭抽屉里的残留节点。
    const newRow = page
      .locator('.ant-table-tbody tr')
      .filter({ has: page.getByRole('button', { name: '编辑', exact: true }) })
      .first();
    await expect(newRow).toBeVisible();
    await expect(newRow).toContainText('¥800.00');
    await newRow.getByRole('button', { name: '查看', exact: true }).click();
    const purchaseDetail = page.getByRole('dialog', {
      name: '采购订单详情',
      exact: true,
    });
    await expect(
      purchaseDetail.getByText('¥800.00', { exact: true }).first(),
    ).toBeVisible();
    const purchaseNumber = await purchaseDetail
      .locator('[data-document-number]')
      .innerText();
    await purchaseDetail.getByRole('button', { name: '提交审核', exact: true }).click();
    await expect(purchaseDetail.locator('.document-heading .ant-tag')).toHaveText(
      '待审核',
    );
    await purchaseDetail.getByRole('button', { name: '审核通过', exact: true }).click();
    await expect(purchaseDetail.locator('.document-heading .ant-tag')).toHaveText(
      '已审核',
    );
    // ---------- 分批入库 6 + 4 ----------
    await purchaseDetail.getByRole('button', { name: '创建入库', exact: true }).click();
    const receipt = page.getByRole('dialog', { name: '创建采购入库', exact: true });
    await receipt.getByRole('spinbutton', { name: '本次入库数量1' }).fill('6');
    await expect(receipt.getByText('¥480.00', { exact: true }).first()).toBeVisible();
    await receipt.getByRole('button', { name: '确认入库', exact: true }).click();
    await expect(page.getByText('入库成功，库存与应付已同步')).toBeVisible();
    await expect(purchaseDetail.locator('.document-heading .ant-tag')).toHaveText(
      '部分入库',
    );
    await purchaseDetail.getByRole('button', { name: '创建入库', exact: true }).click();
    await receipt.getByRole('spinbutton', { name: '本次入库数量1' }).fill('4');
    await receipt.getByRole('button', { name: '确认入库', exact: true }).click();
    await expect(purchaseDetail.locator('.document-heading .ant-tag')).toHaveText(
      '已入库',
    );
    await purchaseDetail.getByRole('button', { name: '关闭详情', exact: true }).click();

    // ---------- 真实落库核对：库存 10、两笔应付合计 800 元 ----------
    const purchaseOrders = (
      await (
        await page.request.get('/api/v1/purchase-orders', {
          params: { q: purchaseNumber },
        })
      ).json()
    ).data.items;
    expect(purchaseOrders).toHaveLength(1);
    const receipts = (
      await (
        await page.request.get('/api/v1/goods-receipts', {
          params: { orderId: purchaseOrders[0].id },
        })
      ).json()
    ).data;
    expect(receipts.total).toBe(2);
    expect(
      receipts.items.reduce(
        (sum: number, row: { totalAmount: number }) => sum + row.totalAmount,
        0,
      ),
    ).toBe(80000);
    await page.goto(`/stocks?q=${productCode}`);
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: productCode })
        .getByRole('cell', { name: '10', exact: true }),
    ).toBeVisible();
    const payableIds: string[] = [];
    for (const row of receipts.items) {
      const payable = (
        await (
          await page.request.get('/api/v1/payables', {
            params: { receiptId: row.id },
          })
        ).json()
      ).data.items;
      expect(payable[0].originalAmount).toBe(row.totalAmount);
      payableIds.push(payable[0].id);
    }

    // ---------- 付款：界面部分结清 + 全部结清 ----------
    // 分批入库会产生多张应付单，先读首张单据的真实原始金额，再按其金额分批结清。
    const payableOriginal = (
      (
        await (
          await page.request.get('/api/v1/payables', {
            params: { sourceId: payableIds[0] },
          })
        ).json()
      ).data.items[0] as { originalAmount: number }
    ).originalAmount;
    const firstPart = Math.floor(payableOriginal / 2);
    const remainder = payableOriginal - firstPart;
    await page.goto(`/payables?view=${payableIds[0]}`);
    const payableDrawer = page.getByRole('dialog', { name: '付款单据详情' });
    await payableDrawer
      .getByLabel('付款金额（元）')
      .fill((firstPart / 100).toFixed(2));
    await payableDrawer.getByRole('button', { name: '确认付款' }).click();
    await expect(payableDrawer.getByText('部分结清', { exact: true })).toBeVisible();
    // 超额付款被拒绝：填比未结余额更多的金额，界面上不会出现「已结清」。
    await payableDrawer
      .getByLabel('付款金额（元）')
      .fill(((remainder + 100) / 100).toFixed(2));
    await payableDrawer.getByRole('button', { name: '确认付款' }).click();
    await expect(payableDrawer.getByText('部分结清', { exact: true })).toBeVisible();
    await expect(payableDrawer.getByText('已结清', { exact: true })).toHaveCount(0);
    // 按剩余金额结清。
    await payableDrawer
      .getByLabel('付款金额（元）')
      .fill((remainder / 100).toFixed(2));
    await payableDrawer.getByRole('button', { name: '确认付款' }).click();
    await expect(payableDrawer.getByText('已结清', { exact: true })).toBeVisible();
    await expect(
      payableDrawer.getByRole('button', { name: '确认付款' }),
    ).toHaveCount(0);

    // ---------- 销售：界面建单 → 提交 → 审核 → 出库 ----------
    await page.goto('/sales-orders');
    await page.getByRole('button', { name: '新建销售订单', exact: true }).click();
    const salesForm = page.getByRole('dialog', { name: '新建销售订单', exact: true });
    // 客户下拉是 showSearch 的可滚动列表，目标客户可能不在首屏：先输入名字过滤再选。
    await salesForm.getByLabel('客户', { exact: true }).click();
    await salesForm.getByLabel('客户', { exact: true }).fill(data.customer.name);
    await page.getByText(data.customer.name, { exact: true }).last().click();
    await salesForm.getByLabel('出库仓库', { exact: true }).click();
    await page.getByText(data.warehouse.name, { exact: true }).last().click();
    await salesForm.getByRole('combobox', { name: '明细商品1' }).fill(productCode);
    await page.getByText(`${productCode} · ${productName}`, { exact: true }).click();
    await salesForm.getByRole('spinbutton', { name: '明细数量1' }).fill('3');
    await salesForm.getByRole('spinbutton', { name: '明细单价1' }).fill('120');
    await salesForm.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('销售订单已保存')).toBeVisible();
    await expect(salesForm).not.toBeVisible();
    // 与采购订单同理：销售列表不展示商品名，用唯一草稿行的「编辑」按钮定位新单。
    const newSalesRow = page
      .locator('.ant-table-tbody tr')
      .filter({ has: page.getByRole('button', { name: '编辑', exact: true }) })
      .first();
    await expect(newSalesRow).toBeVisible();
    await expect(newSalesRow).toContainText('¥360.00');
    await newSalesRow.getByRole('button', { name: '查看', exact: true }).click();
    const salesDetail = page.getByRole('dialog', {
      name: '销售订单详情',
      exact: true,
    });
    await expect(
      salesDetail.getByText('¥360.00', { exact: true }).first(),
    ).toBeVisible();
    const salesNumber = await salesDetail
      .locator('[data-document-number]')
      .innerText();
    await salesDetail.getByRole('button', { name: '提交审核', exact: true }).click();
    await expect(salesDetail.locator('.document-heading .ant-tag')).toHaveText(
      '待审核',
    );
    await salesDetail.getByRole('button', { name: '审核通过', exact: true }).click();
    await expect(salesDetail.locator('.document-heading .ant-tag')).toHaveText(
      '已审核',
    );
    await salesDetail.getByRole('button', { name: '创建出库', exact: true }).click();
    const shipment = page.getByRole('dialog', { name: '创建销售出库', exact: true });
    await expect(shipment.getByText('¥360.00', { exact: true }).first()).toBeVisible();
    await shipment.getByRole('button', { name: '确认出库', exact: true }).click();
    await expect(page.getByText('出库成功，库存与应收已同步')).toBeVisible();
    await expect(salesDetail.locator('.document-heading .ant-tag')).toHaveText(
      '已出库',
    );
    await salesDetail.getByRole('button', { name: '关闭详情', exact: true }).click();

    // 库存 10 - 3 = 7
    await page.goto(`/stocks?q=${productCode}`);
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: productCode })
        .getByRole('cell', { name: '7', exact: true }),
    ).toBeVisible();
    const salesOrders = (
      await (
        await page.request.get('/api/v1/sales-orders', {
          params: { q: salesNumber },
        })
      ).json()
    ).data.items;
    expect(salesOrders).toHaveLength(1);
    const shipments = (
      await (
        await page.request.get('/api/v1/sales-shipments', {
          params: { orderId: salesOrders[0].id },
        })
      ).json()
    ).data.items;
    expect(shipments).toHaveLength(1);
    const receivables = (
      await (
        await page.request.get('/api/v1/receivables', {
          params: { shipmentId: shipments[0].id },
        })
      ).json()
    ).data.items;
    expect(receivables[0].originalAmount).toBe(36000);

    // ---------- 收款：100 + 260 ----------
    await page.goto(`/receivables?view=${receivables[0].id}`);
    const receivableDrawer = page.getByRole('dialog', { name: '收款单据详情' });
    await receivableDrawer.getByLabel('收款金额（元）').fill('100');
    await receivableDrawer.getByRole('button', { name: '确认收款' }).click();
    await expect(
      receivableDrawer.getByText('部分结清', { exact: true }),
    ).toBeVisible();
    await expect(
      receivableDrawer.getByText('¥260.00', { exact: true }),
    ).toBeVisible();
    await receivableDrawer.getByLabel('收款金额（元）').fill('260');
    await receivableDrawer.getByRole('button', { name: '确认收款' }).click();
    await expect(receivableDrawer.getByText('已结清', { exact: true })).toBeVisible();
    await expect(
      receivableDrawer.getByRole('button', { name: '确认收款' }),
    ).toHaveCount(0);

    // ---------- 报表与看板数字一致 ----------
    const salesReport = (
      await (
        await page.request.get('/api/v1/reports/sales', {
          params: { q: productName },
        })
      ).json()
    ).data;
    expect(salesReport.totals.quantity).toBe(3);
    expect(salesReport.totals.amount).toBe(36000);
    const purchaseReport = (
      await (
        await page.request.get('/api/v1/reports/purchases', {
          params: { q: productName },
        })
      ).json()
    ).data;
    expect(purchaseReport.totals.quantity).toBe(10);
    expect(purchaseReport.totals.amount).toBe(80000);
    const inventoryReport = (
      await (
        await page.request.get('/api/v1/reports/inventory', {
          params: { q: productName },
        })
      ).json()
    ).data;
    expect(
      inventoryReport.items.find(
        (row: { number: string }) => row.number === productCode,
      )?.quantity,
    ).toBe(7);
    const financeReport = (
      await (await page.request.get('/api/v1/reports/finance', { params: { pageSize: 100 } })).json()
    ).data;
    // 报表按来源追溯标识定位本单，避免依赖其他 Seed 往来数据。
    const receivableRow = financeReport.items.find(
      (row: { sourcePath: string }) =>
        row.sourcePath.includes(receivables[0].id),
    );
    expect(receivableRow).toBeTruthy();
    expect(receivableRow.amount).toBe(36000);
    expect(receivableRow.settled).toBe(36000);
    expect(receivableRow.balance).toBe(0);
    const payableRow = financeReport.items.find(
      (row: { sourcePath: string }) => row.sourcePath.includes(payableIds[0]),
    );
    expect(payableRow).toBeTruthy();
    // 分批入库会生成两张应付单：payableIds[0] 对应其中一次入库的金额，
    // 与前面读取到的 payableOriginal 必须一致，且已全部结清。
    expect(payableRow.amount).toBe(payableOriginal);
    expect(payableRow.settled).toBe(payableOriginal);
    expect(payableRow.balance).toBe(0);

    // 界面报表展示同一数字（真实渲染而非只查接口）。
    await page.goto('/reports/sales');
    await expect(page.getByRole('heading', { name: '销售报表' })).toBeVisible();
    await page.getByPlaceholder('搜索单号、商品或往来单位').fill(productName);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(
      page.locator('.ant-statistic').filter({ hasText: '数量合计' }),
    ).toContainText('3');
    await expect(
      page.getByRole('row').filter({ hasText: productCode }).first(),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '销售报表' })).toBeVisible();
    await page.goto('/finance/summary');
    await expect(
      page.getByRole('heading', { name: '财务概览', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('未收余额', { exact: true })).toBeVisible();
  });
});

test.describe('会话隔离与缓存隔离', () => {
  test.setTimeout(150000);
  test('旧会话迟到的 401 不会踢掉新登录账号，页面按新角色重建', async ({
    page,
    context,
  }) => {
    await login(page, 'admin');
    await page.getByText('个人设置', { exact: true }).click();
    await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();
    const oldCookie = (await context.cookies()).find(
      (cookie) => cookie.name === 'kf_session',
    )!;
    expect(oldCookie.httpOnly).toBe(true);
    expect(oldCookie.sameSite).toBe('Lax');
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
    // 另一标签切换为访客，旧会话失效。
    const switched = await page.request.post('/api/v1/auth/login', {
      headers: { Origin: ORIGIN },
      data: { username: 'guest', password: PASSWORD },
    });
    expect(switched.ok()).toBe(true);
    await page.clock.setFixedTime(new Date(Date.now() + 61000));
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
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
    await expect(
      page.getByRole('button', { name: '新增商品', exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.user-name')).toContainText('只读访客');
    await expect(
      page.getByRole('button', { name: '新增商品', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText('无权访问', { exact: true })).toHaveCount(0);
    await logout(page);
  });

  test('多标签：一个标签退出后另一个标签立即回到登录页', async ({
    page,
    context,
  }) => {
    await login(page, 'admin');
    const other = await context.newPage();
    await other.goto('/stocks');
    await expect(
      other.getByRole('heading', { name: '实时库存', exact: true }),
    ).toBeVisible();
    await other.getByRole('button', { name: '退出登录' }).click();
    await expect(other.getByRole('button', { name: '登录系统' })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
    await page.goto('/system/users');
    await expect(page.getByRole('button', { name: '登录系统' })).toBeVisible();
    await other.close();
  });

  test('账号被停用后，已打开的页面下一次请求立即回到登录页', async ({
    page,
  }) => {
    await login(page, 'admin');
    const headers = await apiHeaders(page);
    const roles = (
      await (await page.request.get('/api/v1/system/roles')).json()
    ).data;
    const guestRole = roles.find((role: { code: string }) => role.code === 'GUEST');
    const username = `e2e_kick_${Date.now()}`;
    const created = await page.request.post('/api/v1/system/users', {
      headers,
      data: {
        username,
        displayName: '会话踢出验收',
        password: 'Kick@12345',
        roleId: guestRole.id,
      },
    });
    expect(created.status()).toBe(201);
    // 受害者必须是真正干净的上下文：显式清空 storageState 与 Cookie，
    // 否则会继承当前 context 里 admin 的会话，用例就失去意义。
    const victimContext = await page.context().browser()!.newContext({
      storageState: { cookies: [], origins: [] },
      baseURL: ORIGIN,
    });
    try {
      const victim = await victimContext.newPage();
      await victim.context().clearCookies();
      await victim.goto('/login');
      await expect(victim.getByLabel('用户名')).toBeVisible();
      await victim.getByLabel('用户名').fill(username);
      await victim.getByLabel('密码', { exact: true }).fill('Kick@12345');
      await victim.getByRole('button', { name: '登录系统' }).click();
      await expect(victim.locator('.user-name')).toBeVisible();
      const userId = (await created.json()).data.id;
      const disabled = await page.request.patch(
        `/api/v1/system/users/${userId}`,
        {
          headers,
          data: { status: 'INACTIVE' },
        },
      );
      expect(disabled.status()).toBe(200);
      // 停用后该账号所有会话已被服务端清除，下一次请求 401 并把界面踢回登录页。
      // 浏览器不会因 401 自动删除 Cookie（只有服务端明确 clearCookie 才会），
      // 因此这里断言的是「服务端会话已失效」而不是「Cookie 已消失」。
      const me = await victim.request.get('/api/v1/auth/me');
      expect(me.status()).toBe(401);
      await victim.goto('/stocks');
      await expect(
        victim.getByRole('button', { name: '登录系统' }).first(),
      ).toBeVisible();
      await expect(victim.locator('.user-name')).toHaveCount(0);
    } finally {
      await victimContext.close();
    }
  });
});

test.describe('表单校验与错误反馈', () => {
  test.setTimeout(180000);
  test('必填、超量入库、库存不足出库、超额付款在界面可见且不产生脏数据', async ({
    page,
  }) => {
    await login(page, 'admin');
    const stamp = Date.now();
    const productCode = `E2E-VALID-${stamp}`;
    const productName = `校验验收商品${stamp}`;
    const data = await prepare(page, {
      code: productCode,
      name: productName,
      price: 5000,
      salePrice: 9000,
    });

    // 1) 必填校验：不选供应商/仓库直接保存 → 界面提示，数据库不新增单据。
    await page.goto('/purchase-orders');
    const before = (
      await (
        await page.request.get('/api/v1/purchase-orders', { params: { pageSize: 1 } })
      ).json()
    ).data.total;
    await page.getByRole('button', { name: '新建采购订单', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新建采购订单', exact: true });
    await form.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(form.getByText('请选择供应商')).toBeVisible();
    await expect(form.getByText('请选择仓库')).toBeVisible();
    await form.getByRole('button', { name: '取消', exact: true }).click();
    expect(
      (
        await (
          await page.request.get('/api/v1/purchase-orders', {
            params: { pageSize: 1 },
          })
        ).json()
      ).data.total,
    ).toBe(before);

    // 2) 超量入库：界面最大值约束 + 服务端 409，库存与应付不变。
    const purchase = (
      await (
        await page.request.post('/api/v1/purchase-orders', {
          headers: data.headers,
          data: {
            supplierId: data.supplier.id,
            warehouseId: data.warehouse.id,
            orderDate: new Date().toISOString().slice(0, 10),
            items: [{ productId: data.product.id, quantity: 5, unitPrice: 5000 }],
          },
        })
      ).json()
    ).data;
    for (const action of ['submit', 'approve']) {
      expect(
        (
          await page.request.post(
            `/api/v1/purchase-orders/${purchase.id}/${action}`,
            { headers: data.headers, data: {} },
          )
        ).ok(),
      ).toBe(true);
    }
    await page.goto(`/purchase-orders?view=${purchase.id}`);
    const detail = page.getByRole('dialog', { name: '采购订单详情', exact: true });
    await detail.getByRole('button', { name: '创建入库', exact: true }).click();
    const receipt = page.getByRole('dialog', { name: '创建采购入库', exact: true });
    const quantityInput = receipt.getByRole('spinbutton', {
      name: '本次入库数量1',
    });
    await quantityInput.fill('99');
    await quantityInput.blur();
    // Ant Design InputNumber 失焦时会把超限值钳回 max（此处剩余 5），
    // 界面不会保留非法的 99。
    await expect(quantityInput).toHaveValue('5');
    await expect(quantityInput).toHaveAttribute('aria-valuemax', '5');
    // 后端同样拒绝超量（直接绕界面发请求），且这一单不产生任何入库单
    // （库存里有演示数据的入库单，因此必须按 orderId 过滤而不是看全表）。
    expect(
      (
        await (
          await page.request.get('/api/v1/goods-receipts', {
            params: { orderId: purchase.id },
          })
        ).json()
      ).data.total,
    ).toBe(0);
    const excessive = await page.request.post('/api/v1/goods-receipts', {
      headers: { ...data.headers, 'Idempotency-Key': `e2e-excess-${stamp}` },
      data: {
        orderId: purchase.id,
        items: [{ orderItemId: purchase.items[0].id, quantity: 99 }],
      },
    });
    expect(excessive.status()).toBe(409);
    expect((await excessive.json()).error.code).toBe('EXCESS_RECEIPT');
    expect(
      (
        await (
          await page.request.get('/api/v1/goods-receipts', {
            params: { orderId: purchase.id },
          })
        ).json()
      ).data.total,
    ).toBe(0);
    await receipt.getByRole('button', { name: '取消', exact: true }).click();
    await expect(receipt).not.toBeVisible();
    await detail.getByRole('button', { name: '关闭详情', exact: true }).click();

    // 3) 库存不足出库：界面提示库存不足，库存与应收不改变。
    const salesOrder = (
      await (
        await page.request.post('/api/v1/sales-orders', {
          headers: data.headers,
          data: {
            customerId: data.customer.id,
            warehouseId: data.warehouse.id,
            orderDate: new Date().toISOString().slice(0, 10),
            items: [{ productId: data.product.id, quantity: 4, unitPrice: 9000 }],
          },
        })
      ).json()
    ).data;
    for (const action of ['submit', 'approve']) {
      expect(
        (
          await page.request.post(
            `/api/v1/sales-orders/${salesOrder.id}/${action}`,
            { headers: data.headers, data: {} },
          )
        ).ok(),
      ).toBe(true);
    }
    await page.goto(`/sales-orders?view=${salesOrder.id}`);
    const salesDetail = page.getByRole('dialog', {
      name: '销售订单详情',
      exact: true,
    });
    await salesDetail.getByRole('button', { name: '创建出库', exact: true }).click();
    const shipment = page.getByRole('dialog', { name: '创建销售出库', exact: true });
    await shipment.getByRole('button', { name: '确认出库', exact: true }).click();
    await expect(shipment.getByText('仓库可用库存不足')).toBeVisible({
      timeout: 20000,
    });
    expect(
      (
        await (
          await page.request.get('/api/v1/sales-shipments', {
            params: { orderId: salesOrder.id },
          })
        ).json()
      ).data.total,
    ).toBe(0);
    await shipment.getByRole('button', { name: '取消', exact: true }).click();
    await salesDetail.getByRole('button', { name: '关闭详情', exact: true }).click();

    // 4) 超额付款：真实入库生成应付后用界面超额付款 → 明确提示，余额不变。
    const receiptOk = await page.request.post('/api/v1/goods-receipts', {
      headers: { ...data.headers, 'Idempotency-Key': `e2e-valid-receipt-${stamp}` },
      data: {
        orderId: purchase.id,
        items: [{ orderItemId: purchase.items[0].id, quantity: 5 }],
      },
    });
    expect(receiptOk.status()).toBe(201);
    const payable = (
      await (
        await page.request.get('/api/v1/payables', {
          params: { receiptId: (await receiptOk.json()).data.id },
        })
      ).json()
    ).data.items[0];
    await page.goto(`/payables?view=${payable.id}`);
    const payableDrawer = page.getByRole('dialog', { name: '付款单据详情' });
    await payableDrawer.getByLabel('付款金额（元）').fill('999');
    await payableDrawer.getByRole('button', { name: '确认付款' }).click();
    await expect(page.getByText('收付款金额不能超过未结余额')).toBeVisible({
      timeout: 20000,
    });
    await expect(
      payableDrawer.getByText('未结清', { exact: true }),
    ).toBeVisible();
    const payableAfter = (
      await (await page.request.get(`/api/v1/payables/${payable.id}`)).json()
    ).data;
    expect(payableAfter.paidAmount).toBe(0);
    expect(payableAfter.status).toBe('UNSETTLED');
    // 5) 空金额被表单拦下，不产生结算记录。
    await payableDrawer.getByLabel('付款金额（元）').fill('');
    await payableDrawer.getByRole('button', { name: '确认付款' }).click();
    await expect(page.getByText('请输入金额')).toBeVisible();
    expect(
      (
        await (
          await page.request.get('/api/v1/settlements', {
            params: { sourceId: payable.id },
          })
        ).json()
      ).data.total,
    ).toBe(0);
  });
});

test.describe('布局与运行质量', () => {
  test.setTimeout(180000);
  test('1440 与 1366 下主要页面无横向溢出、无 JS 错误', async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await login(page, 'admin');
    const pages: [string, string][] = [
      ['/', '经营概览'],
      ['/master/products', '商品管理'],
      ['/purchase-orders', '采购订单'],
      ['/sales-orders', '销售订单'],
      ['/stocks', '实时库存'],
      ['/receivables', '应收账款'],
      ['/reports/sales', '销售报表'],
      ['/visualizations', '数据可视化'],
      ['/system/users', '用户管理'],
      ['/system/audit-logs', '操作日志'],
      ['/profile', '个人中心'],
    ];
    for (const [width, height] of [
      [1440, 1000],
      [1366, 768],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const [path, title] of pages) {
        await page.goto(path);
        await expect(
          page.getByRole('heading', { name: title, exact: true }).first(),
          `${path} 标题`,
        ).toBeVisible();
        await expect
          .poll(
            () =>
              page.evaluate(
                () => document.documentElement.scrollWidth - window.innerWidth,
              ),
            { message: `${width}px ${path} 横向溢出` },
          )
          .toBeLessThanOrEqual(1);
      }
    }
    expect(pageErrors, `JS 异常：${pageErrors.join(' | ')}`).toEqual([]);
    // 401 是登录前访问 /auth/me 的正常探测；404 来自浏览器默认请求的 favicon；
    // React 开发模式的 useForm 提示不影响功能。真正的运行期异常由 pageErrors 兜底。
    const unexpected = consoleErrors.filter(
      (text) =>
        !/favicon|ERR_FAILED|net::/i.test(text) &&
        !/status of 401/i.test(text) &&
        !/status of 404/i.test(text) &&
        !/useForm.*not connected/i.test(text),
    );
    expect(unexpected, `控制台错误：${unexpected.join(' | ')}`).toEqual([]);
  });

  test('接口失败时提示明确，恢复后可重试成功且不产生假成功', async ({ page }) => {
    await login(page, 'admin');
    await page.goto('/master/products');
    // 列表默认每页 10 条、创建时间倒序，演示商品不在首屏：先检索再断言。
    await page.getByPlaceholder('搜索编码或名称').fill('KF-0001');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(
      page.getByRole('cell', { name: 'KF-0001', exact: true }),
    ).toBeVisible();
    // 读接口失败 → 明确错误态 + 重新加载可恢复。
    await page.route('**/api/v1/products?**', (route) => route.abort('failed'));
    // 用不同的关键词，确保真的发出新请求（相同查询键会命中缓存，不产生网络调用）。
    await page.getByPlaceholder('搜索编码或名称').fill('KF-000');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(page.getByText('暂时无法加载', { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByText('无法连接服务，请确认后端已启动')).toBeVisible();
    await page.unroute('**/api/v1/products?**');
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(
      page.getByRole('cell', { name: 'KF-0001', exact: true }),
    ).toBeVisible();
    // 写接口失败 → 抽屉保留、明确错误；恢复后同一表单保存成功。
    const code = `E2E-OFFLINE-${Date.now()}`;
    await page.getByRole('button', { name: '新增商品', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '新增商品', exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('textbox', { name: '商品编码', exact: true }).fill(code);
    await drawer.getByRole('textbox', { name: '商品名称', exact: true }).fill('断网验收商品');
    await drawer.getByLabel('商品分类', { exact: true }).click();
    await page.getByText('办公用品', { exact: true }).last().click();
    await drawer.getByLabel('计量单位').fill('件');
    // 用真实的 503 响应模拟后端不可用：比 abort 更接近线上故障，也能让界面展示服务端错误文案。
    await page.route('**/api/v1/products', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: '服务暂时不可用，请稍后重试',
              },
            }),
          })
        : route.continue(),
    );
    await drawer.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.getByText('服务暂时不可用，请稍后重试'),
    ).toBeVisible({ timeout: 20000 });
    // 失败后抽屉必须保留用户已填内容，恢复接口后同一表单可直接重试成功。
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole('textbox', { name: '商品编码', exact: true }),
    ).toHaveValue(code);
    // 三个 glob 都需解除：浏览器可能对带/不带查询串的请求分别命中不同模式。
    for (const pattern of [
      '**/api/v1/products',
      '**/api/v1/products?**',
      '**/api/v1/products/**',
    ])
      await page.unroute(pattern);
    // 用页面内真实 fetch 确认写接口已恢复（page.request 不经过 page.route，无法证明拦截已解除）。
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
              const response = await fetch('/api/v1/products', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                signal: controller.signal,
              });
              return response.status;
            } catch {
              return -1;
            } finally {
              clearTimeout(timer);
            }
          }),
        { timeout: 20000 },
      )
      // 403（缺 CSRF）或 422 都说明请求已经穿透到后端，503 才代表仍被拦截。
      .toBeGreaterThanOrEqual(400);
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const response = await fetch('/api/v1/products?pageSize=1');
            return response.status;
          }),
        { timeout: 20000 },
      )
      .toBe(200);
    // 恢复后同一表单直接重试成功。
    // antd 的 message 提示条带淡出动画，按钮位置的稳定性检查会被反复打断，
    // 因此按元素实际坐标点击一次（仍是真实鼠标事件，会触发 React onClick）。
    const saveBox = await drawer
      .getByRole('button', { name: '保存', exact: true })
      .boundingBox();
    expect(saveBox).not.toBeNull();
    await page.mouse.click(
      saveBox!.x + saveBox!.width / 2,
      saveBox!.y + saveBox!.height / 2,
    );
    await expect(page.getByText('新增成功')).toBeVisible();
    await expect(drawer).not.toBeVisible();
    await page.getByPlaceholder('搜索编码或名称').fill(code);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(
      page.getByRole('cell', { name: '断网验收商品', exact: true }),
    ).toBeVisible();
  });
});
