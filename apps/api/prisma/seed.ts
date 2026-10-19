import { seedSales } from './seed-sales.js';
import { seedFinance } from './seed-finance.js';
import { hash } from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { roleDefinitions } from '@kingflow/shared';
import { prisma } from '../src/repositories/db.js';
import { seedPurchases } from './seed-purchase.js';

export async function seed() {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? 'development'))
    throw new Error('Seed仅允许开发或独立测试环境');
  const password = process.env.DEMO_PASSWORD ?? 'KingFlow@2026';
  if (password.length < 10 || password.length > 128)
    throw new Error('演示密码长度必须10–128位');
  const passwordHash = await hash(password, 12);
  await prisma.$transaction(
    async (tx) => {
      for (const role of roleDefinitions) {
        const record = await tx.role.upsert({
          where: { code: role.code },
          update: {},
          create: {
            code: role.code,
            name: role.name,
            permissions: JSON.stringify(role.permissions),
          },
        });
        await tx.user.upsert({
          where: { username: role.username },
          update: {},
          create: {
            username: role.username,
            displayName: role.code === 'ADMIN' ? '演示管理员' : role.name,
            roleId: record.id,
            passwordHash,
          },
        });
      }
      const admin = await tx.user.findUniqueOrThrow({
        where: { username: 'admin' },
      });
      const createdById = admin.id;
      const categoryNames = [
        '办公用品',
        '数码设备',
        '办公家具',
        '生活耗材',
        '包装材料',
      ];
      const categories = [];
      for (let i = 0; i < categoryNames.length; i++)
        categories.push(
          await tx.productCategory.upsert({
            where: { code: `CAT-${i + 1}` },
            update: {},
            create: {
              code: `CAT-${i + 1}`,
              name: categoryNames[i],
              createdById,
            },
          }),
        );
      const productNames = [
        'A4复印纸 80g',
        '中性签字笔',
        '便签纸组合',
        '文件收纳盒',
        '订书机',
        '长尾夹套装',
        '无线键鼠套装',
        '27英寸显示器',
        'USB-C扩展坞',
        '高清会议摄像头',
        '激光打印机',
        '便携固态硬盘',
        '人体工学办公椅',
        '升降办公桌',
        '移动文件柜',
        '会议桌',
        '访客接待椅',
        '桌面显示器支架',
        '抽取式面巾纸',
        '洗手液补充装',
        '清洁湿巾',
        '垃圾袋组合',
        '纸杯 250ml',
        '空气清新剂',
        '五层瓦楞纸箱',
        '封箱胶带',
        '气泡缓冲膜',
        '快递包装袋',
        '打包绳',
        '标签打印纸',
      ];
      const prices = [
        2500, 180, 650, 1800, 2200, 900, 12900, 89900, 15900, 26900, 139900,
        45900, 69900, 129900, 29900, 169900, 24900, 12900, 1800, 2500, 1200,
        980, 1500, 1900, 450, 800, 3200, 200, 1500, 2900,
      ];
      for (let i = 0; i < 30; i++) {
        const code = `KF-${String(i + 1).padStart(4, '0')}`;
        await tx.product.upsert({
          where: { code },
          update: {},
          create: {
            code,
            name: productNames[i],
            categoryId: categories[Math.floor(i / 6)].id,
            specification: ['标准装', '企业装', '升级款'][i % 3],
            unit: i < 6 ? '包' : i < 18 ? '台' : '件',
            purchasePrice: prices[i],
            salesPrice: Math.round(prices[i] * 1.3),
            minStock: [10, 20, 5][i % 3],
            createdById,
          },
        });
      }
      const customers = [
        '远山科技有限公司',
        '星河文化传媒',
        '青禾贸易有限公司',
        '云栖信息技术',
        '启明教育科技',
        '森屿设计事务所',
        '恒信商贸有限公司',
        '新域电子商务',
        '锦程物流服务',
        '明川企业管理',
      ];
      for (let i = 0; i < customers.length; i++) {
        const code = `CUS-${String(i + 1).padStart(3, '0')}`;
        await tx.customer.upsert({
          where: { code },
          update: {},
          create: {
            code,
            name: customers[i],
            contact: ['张先生', '李女士', '陈先生'][i % 3],
            phone: `1380000${String(i + 1).padStart(4, '0')}`,
            email: `contact${i + 1}@example.com`,
            address: `上海市浦东新区科创路${100 + i}号`,
            remark: '开发演示数据',
            createdById,
          },
        });
      }
      const suppliers = [
        '优品办公供应链',
        '联创数码科技',
        '木本办公家具',
        '洁净日用商贸',
        '安达包装材料',
        '聚合办公设备',
        '晨光物资供应',
        '恒丰综合贸易',
      ];
      for (let i = 0; i < suppliers.length; i++) {
        const code = `SUP-${String(i + 1).padStart(3, '0')}`;
        await tx.supplier.upsert({
          where: { code },
          update: {},
          create: {
            code,
            name: suppliers[i],
            contact: ['王经理', '赵经理'][i % 2],
            phone: `1390000${String(i + 1).padStart(4, '0')}`,
            address: `苏州市工业园区创业路${20 + i}号`,
            createdById,
          },
        });
      }
      for (const [code, name, location, manager] of [
        ['WH-001', '上海中心仓', '上海市松江区物流园A栋', '陈仓管'],
        ['WH-002', '苏州备货仓', '苏州市工业园区B栋', '刘仓管'],
      ])
        await tx.warehouse.upsert({
          where: { code },
          update: {},
          create: { code, name, location, manager, createdById },
        });
    },
    { timeout: 30000 },
  );
  await seedPurchases();
  await seedSales();
  await seedFinance();
  console.log(
    'Seed完成：6角色账号、30商品、5分类、10客户、8供应商、2仓库（重复执行保留已有数据）',
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  seed()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
