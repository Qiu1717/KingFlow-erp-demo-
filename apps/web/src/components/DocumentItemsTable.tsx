import { createUuid } from '../utils/uuid';
import { Button, Grid, InputNumber, Select, Table, Typography } from 'antd';
import { Plus, Trash2 } from 'lucide-react';
import type { MasterRecord } from '@kingflow/shared';
import { MoneyText } from './common';
export interface DraftLine {
  key: string;
  productId: string;
  quantity: number;
  price: string;
}
export function priceInCents(value: string) {
  if (!/^\d+(\.\d{0,2})?$/.test(value))
    throw new Error('请输入非负金额，最多两位小数');
  const [whole, decimal = ''] = value.split('.');
  return Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
}
export const newLine = (): DraftLine => ({
  key: createUuid(),
  productId: '',
  quantity: 1,
  price: '0.00',
});
export function DocumentItemsTable({
  items,
  onChange,
  products,
  disabled,
  priceField = 'purchasePrice',
}: {
  items: DraftLine[];
  onChange: (items: DraftLine[]) => void;
  products: MasterRecord[];
  disabled?: boolean;
  priceField?: 'purchasePrice' | 'salesPrice';
}) {
  const mobile = !Grid.useBreakpoint().lg;
  const update = (index: number, data: Partial<DraftLine>) =>
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...data } : item)),
    );
  const productControl = (row: DraftLine, index: number) => (
    <>
      <Select
        aria-label={`明细商品${index + 1}`}
        value={row.productId || undefined}
        showSearch
        optionFilterProp="label"
        placeholder="搜索编码或名称"
        style={{ width: '100%' }}
        disabled={disabled}
        options={products.map((p) => ({
          value: p.id,
          label: `${p.code} · ${p.name}`,
          disabled: p.status !== 'ACTIVE',
        }))}
        onChange={(id) => {
          const product = products.find((p) => p.id === id)!;
          update(index, {
            productId: id,
            price: ((product[priceField] ?? 0) / 100).toFixed(2),
          });
        }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {products.find((p) => p.id === row.productId)?.specification ||
          `选择商品后自动带入参考${priceField === 'salesPrice' ? '销售' : '采购'}价`}
      </Typography.Text>
    </>
  );
  const quantityControl = (row: DraftLine, index: number) => (
    <InputNumber
      aria-label={`明细数量${index + 1}`}
      min={1}
      max={1000000}
      precision={0}
      inputMode="numeric"
      value={row.quantity}
      disabled={disabled}
      style={{ width: '100%' }}
      onChange={(value) => update(index, { quantity: value ?? 0 })}
    />
  );
  const priceControl = (row: DraftLine, index: number) => (
    <InputNumber<string>
      aria-label={`明细单价${index + 1}`}
      stringMode
      inputMode="decimal"
      min="0"
      max="10000000"
      precision={2}
      value={row.price}
      disabled={disabled}
      style={{ width: '100%' }}
      onChange={(value) => update(index, { price: value ?? '0' })}
    />
  );
  const amount = (row: DraftLine) => {
    try {
      return <MoneyText cents={row.quantity * priceInCents(row.price)} />;
    } catch {
      return '—';
    }
  };
  return (
    <>
      {mobile ? (
        <div className="mobile-document-items">
          {items.map((row, index) => (
            <section
              className="mobile-document-item"
              key={row.key}
              aria-label={`商品明细${index + 1}`}
            >
              <div className="mobile-item-heading">
                <strong>商品明细 {index + 1}</strong>
                <Button
                  type="text"
                  danger
                  aria-label={`移除明细${index + 1}`}
                  icon={<Trash2 size={17} />}
                  disabled={disabled || items.length === 1}
                  onClick={() =>
                    onChange(items.filter((item) => item.key !== row.key))
                  }
                />
              </div>
              {productControl(row, index)}
              <div className="mobile-item-inputs">
                <label>
                  <span>数量</span>
                  {quantityControl(row, index)}
                </label>
                <label>
                  <span>单价（元）</span>
                  {priceControl(row, index)}
                </label>
              </div>
              <div className="mobile-item-total">
                <span>明细金额</span>
                {amount(row)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Table<DraftLine>
          size="small"
          rowKey="key"
          pagination={false}
          scroll={{ x: 740 }}
          dataSource={items}
          columns={[
            {
              title: '商品 / 规格',
              width: 285,
              render: (_, row, index) => productControl(row, index),
            },
            {
              title: '数量',
              width: 110,
              render: (_, row, index) => quantityControl(row, index),
            },
            {
              title: '单价（元）',
              width: 135,
              render: (_, row, index) => priceControl(row, index),
            },
            {
              title: '金额',
              width: 125,
              render: (_, row) => {
                try {
                  return (
                    <MoneyText cents={row.quantity * priceInCents(row.price)} />
                  );
                } catch {
                  return '—';
                }
              },
            },
            {
              title: '',
              width: 45,
              render: (_, row) => (
                <Button
                  type="text"
                  danger
                  aria-label="移除明细"
                  icon={<Trash2 size={15} />}
                  disabled={disabled || items.length === 1}
                  onClick={() =>
                    onChange(items.filter((item) => item.key !== row.key))
                  }
                />
              ),
            },
          ]}
        />
      )}
      <Button
        type="dashed"
        block
        icon={<Plus size={15} />}
        style={{ marginTop: 12 }}
        disabled={disabled || items.length >= 100}
        onClick={() => onChange([...items, newLine()])}
      >
        添加商品明细
      </Button>
    </>
  );
}
