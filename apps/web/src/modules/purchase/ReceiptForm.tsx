import { createUuid } from '../../utils/uuid';
import { useEffect, useState, useRef } from 'react';
import {
  App,
  Grid,
  Alert,
  Button,
  Drawer,
  Input,
  InputNumber,
  Space,
  Table,
} from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  remainingQuantity,
  receiptSchema,
  type PurchaseOrderRecord,
  type PurchaseItem,
  type ReceiptInput,
} from '@kingflow/shared';
import axios from 'axios';
import { useAuth } from '../../stores/auth';
import { postReceipt } from './api';
import { MoneyText } from '../../components/common';
import { errorMessage } from '../../services/client';
export function ReceiptForm({
  order,
  open,
  onClose,
}: {
  order: PurchaseOrderRecord;
  open: boolean;
  onClose: () => void;
}) {
  const mobile = !Grid.useBreakpoint().lg;
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [remark, setRemark] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ key: string; body: ReceiptInput } | null>(null);
  const { message } = App.useApp();
  const client = useQueryClient();
  const userId = useAuth((state) => state.auth?.user.id);
  const storageKey = `kf-receipt-${userId}-${order.id}`;
  useEffect(() => {
    if (open) {
      setQuantities(
        Object.fromEntries(
          order.items.map((item) => [item.id, remainingQuantity(item)]),
        ),
      );
      setRemark('');
      setError('');
      attempt.current = null;
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as {
            key: string;
            body: ReceiptInput;
          };
          if (
            !receiptSchema.safeParse(parsed.body).success ||
            parsed.body.orderId !== order.id ||
            typeof parsed.key !== 'string'
          )
            throw new Error('invalid');
          attempt.current = parsed;
          setQuantities(
            Object.fromEntries(
              parsed.body.items.map((item) => [
                item.orderItemId,
                item.quantity,
              ]),
            ),
          );
          setRemark(parsed.body.remark);
          setError('存在结果未确认的提交，请使用原幂等键重试。');
        } catch {
          sessionStorage.removeItem(storageKey);
        }
      }
    }
  }, [open, order.id, storageKey]);
  const mutation = useMutation({
    mutationFn: ({ body, key }: { body: ReceiptInput; key: string }) =>
      postReceipt(body, key),
    onSuccess: () => {
      void message.success('入库成功，库存与应付已同步');
      for (const key of [
        'purchase-orders',
        'goods-receipts',
        'stocks',
        'stock-movements',
        'payables',
        'summary',
        'business',
        'todos',
        'reports',
        'finance',
        'stock-alerts',
      ])
        void client.invalidateQueries({ queryKey: [key] });
      attempt.current = null;
      sessionStorage.removeItem(storageKey);
      onClose();
    },
    onError: (error) => {
      if (
        axios.isAxiosError(error) &&
        error.response &&
        [
          'VALIDATION_ERROR',
          'INVALID_CATEGORY',
          'INVALID_PRODUCT',
          'INVALID_WAREHOUSE',
          'INVALID_SUPPLIER',
          'EXCESS_RECEIPT',
          'FOREIGN_ITEM',
          'INVALID_STATE',
          'NOT_FOUND',
          'STOCK_OVERFLOW',
        ].includes(error.response.data?.error?.code)
      ) {
        attempt.current = null;
        sessionStorage.removeItem(storageKey);
      }
      setError(errorMessage(error));
    },
  });
  function submit() {
    const body: ReceiptInput = attempt.current?.body ?? {
      orderId: order.id,
      remark,
      items: order.items
        .filter((item) => (quantities[item.id] ?? 0) > 0)
        .map((item) => ({
          orderItemId: item.id,
          quantity: quantities[item.id],
        })),
    };
    if (!body.items.length) {
      setError('至少填写一条大于0的入库数量');
      return;
    }
    // InputNumber 手动键入时可能保留超出上限的值，提交前按剩余量再校验一次。
    const excessive = body.items.filter((line) => {
      const item = order.items.find((row) => row.id === line.orderItemId);
      return !item || line.quantity > remainingQuantity(item);
    });
    if (excessive.length) {
      setError('本次入库数量不能超过剩余可入库数量');
      return;
    }
    attempt.current ??= { key: createUuid(), body };
    sessionStorage.setItem(storageKey, JSON.stringify(attempt.current));
    setError('');
    mutation.mutate(attempt.current);
  }
  const total = order.items.reduce(
    (sum, item) => sum + (quantities[item.id] ?? 0) * item.unitPrice,
    0,
  );
  // 手动键入会绕过 InputNumber 的 max 限制，这里把实际超出的行显式标出来。
  const overLimit = order.items.some(
    (item) => (quantities[item.id] ?? 0) > remainingQuantity(item),
  );
  const quantityControl = (item: PurchaseItem, index: number) => (
    <InputNumber
      aria-label={`本次入库数量${index + 1}`}
      min={0}
      max={remainingQuantity(item)}
      precision={0}
      inputMode="numeric"
      status={
        (quantities[item.id] ?? 0) > remainingQuantity(item)
          ? 'error'
          : undefined
      }
      value={quantities[item.id] ?? 0}
      disabled={
        mutation.isPending || !!attempt.current || !remainingQuantity(item)
      }
      onChange={(value) =>
        setQuantities({ ...quantities, [item.id]: value ?? 0 })
      }
    />
  );
  return (
    <Drawer
      title="创建采购入库"
      open={open}
      width={800}
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      destroyOnHidden
      footer={
        <div className="drawer-footer">
          <Space>
            <Button disabled={mutation.isPending} onClick={onClose}>
              取消
            </Button>
            <Button
              type="primary"
              loading={mutation.isPending}
              onClick={submit}
            >
              {error && attempt.current ? '重试原请求' : '确认入库'}
            </Button>
          </Space>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        message={`来源 ${order.number} · ${order.warehouse.name}`}
        description="正式入库将同时更新库存、库存流水、采购订单与应付款。已过账单据不能修改。"
        style={{ marginBottom: 22 }}
      />
      {mobile ? (
        <div className="mobile-document-items">
          {order.items.map((item, index) => (
            <section className="mobile-document-item" key={item.id}>
              <div className="mobile-item-heading">
                <strong>{item.productName}</strong>
                <span className="muted">{item.unit}</span>
              </div>
              <div className="code-text">{item.productCode}</div>
              <div className="mobile-item-progress">
                <span>订购 {item.quantity}</span>
                <span>已入库 {item.receivedQuantity}</span>
                <span>剩余 {remainingQuantity(item)}</span>
              </div>
              <label className="mobile-posting-quantity">
                <span>本次入库数量</span>
                {quantityControl(item, index)}
              </label>
              <div className="mobile-item-total">
                <span>本次入库金额</span>
                <MoneyText
                  cents={(quantities[item.id] ?? 0) * item.unitPrice}
                />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Table<PurchaseItem>
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ x: 600 }}
          dataSource={order.items}
          columns={[
            {
              title: '商品',
              render: (_, item) => (
                <>
                  {item.productName}
                  <div className="muted">{item.productCode}</div>
                </>
              ),
            },
            { title: '订购', dataIndex: 'quantity', width: 70 },
            { title: '已入库', dataIndex: 'receivedQuantity', width: 75 },
            {
              title: '剩余',
              width: 70,
              render: (_, item) => remainingQuantity(item),
            },
            {
              title: '本次入库',
              width: 130,
              render: (_, item, index) => quantityControl(item, index),
            },
            {
              title: '金额',
              render: (_, item) => (
                <MoneyText
                  cents={(quantities[item.id] ?? 0) * item.unitPrice}
                />
              ),
            },
          ]}
        />
      )}
      <div className="document-total">
        本次入库金额{' '}
        <strong>
          <MoneyText cents={total} />
        </strong>
      </div>
      {overLimit && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          message="本次入库数量不能超过剩余可入库数量"
        />
      )}
      <Input.TextArea
        aria-label="入库备注"
        placeholder="入库备注（可选）"
        maxLength={500}
        rows={3}
        value={remark}
        disabled={mutation.isPending || !!attempt.current}
        onChange={(event) => setRemark(event.target.value)}
      />
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginTop: 18 }}
        />
      )}
    </Drawer>
  );
}
