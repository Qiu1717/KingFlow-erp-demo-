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
  salesRemainingQuantity,
  shipmentSchema,
  type SalesOrderRecord,
  type SalesItem,
  type ShipmentInput,
} from '@kingflow/shared';
import axios from 'axios';
import { useAuth } from '../../stores/auth';
import { postShipment } from './api';
import { MoneyText } from '../../components/common';
import { errorMessage } from '../../services/client';
export function ShipmentForm({
  order,
  open,
  onClose,
}: {
  order: SalesOrderRecord;
  open: boolean;
  onClose: () => void;
}) {
  const mobile = !Grid.useBreakpoint().lg;
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [remark, setRemark] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ key: string; body: ShipmentInput } | null>(null);
  const { message } = App.useApp();
  const client = useQueryClient();
  const userId = useAuth((state) => state.auth?.user.id);
  const storageKey = `kf-shipment-${userId}-${order.id}`;
  useEffect(() => {
    if (open) {
      setQuantities(
        Object.fromEntries(
          order.items.map((item) => [item.id, salesRemainingQuantity(item)]),
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
            body: ShipmentInput;
          };
          if (
            !shipmentSchema.safeParse(parsed.body).success ||
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
    mutationFn: ({ body, key }: { body: ShipmentInput; key: string }) =>
      postShipment(body, key),
    onSuccess: () => {
      void message.success('出库成功，库存与应收已同步');
      for (const key of [
        'sales-orders',
        'sales-shipments',
        'stocks',
        'stock-movements',
        'receivables',
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
          'INVALID_CUSTOMER',
          'EXCESS_SHIPMENT',
          'INSUFFICIENT_STOCK',
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
    const body: ShipmentInput = attempt.current?.body ?? {
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
      setError('至少填写一条大于0的出库数量');
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
  const quantityControl = (item: SalesItem, index: number) => (
    <InputNumber
      aria-label={`本次出库数量${index + 1}`}
      min={0}
      max={salesRemainingQuantity(item)}
      precision={0}
      inputMode="numeric"
      value={quantities[item.id] ?? 0}
      disabled={
        mutation.isPending || !!attempt.current || !salesRemainingQuantity(item)
      }
      onChange={(value) =>
        setQuantities({ ...quantities, [item.id]: value ?? 0 })
      }
    />
  );
  return (
    <Drawer
      title="创建销售出库"
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
              {error && attempt.current ? '重试原请求' : '确认出库'}
            </Button>
          </Space>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        message={`来源 ${order.number} · ${order.warehouse.name}`}
        description="正式出库将同时更新库存、库存流水、销售订单与应收款。已过账单据不能修改。"
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
                <span>已出库 {item.shippedQuantity}</span>
                <span>剩余 {salesRemainingQuantity(item)}</span>
              </div>
              <label className="mobile-posting-quantity">
                <span>本次出库数量</span>
                {quantityControl(item, index)}
              </label>
              <div className="mobile-item-total">
                <span>本次出库金额</span>
                <MoneyText
                  cents={(quantities[item.id] ?? 0) * item.unitPrice}
                />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Table<SalesItem>
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
            { title: '已出库', dataIndex: 'shippedQuantity', width: 75 },
            {
              title: '剩余',
              width: 70,
              render: (_, item) => salesRemainingQuantity(item),
            },
            {
              title: '本次出库',
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
        本次出库金额{' '}
        <strong>
          <MoneyText cents={total} />
        </strong>
      </div>
      <Input.TextArea
        aria-label="出库备注"
        placeholder="出库备注（可选）"
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
