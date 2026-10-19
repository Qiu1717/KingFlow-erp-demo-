import { createUuid } from '../../utils/uuid';
import { useEffect, useState } from 'react';
import {
  App,
  Alert,
  Button,
  DatePicker,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  salesSchema,
  calculateAmount,
  type SalesOrderRecord,
  type SalesInput,
} from '@kingflow/shared';
import { options, saveOrder } from './api';
import {
  DocumentItemsTable,
  newLine,
  priceInCents,
  type DraftLine,
} from '../../components/DocumentItemsTable';
import { MoneyText, ErrorState } from '../../components/common';
import { errorMessage } from '../../services/client';
export function OrderForm({
  open,
  order,
  onClose,
}: {
  open: boolean;
  order?: SalesOrderRecord;
  onClose: () => void;
}) {
  const [form] = Form.useForm();
  const [items, setItems] = useState<DraftLine[]>([newLine()]);
  const [error, setError] = useState('');
  const { message } = App.useApp();
  const client = useQueryClient();
  const refs = useQuery({
    queryKey: ['sales-options'],
    queryFn: async () => {
      const [products, customers, warehouses] = await Promise.all([
        options('products'),
        options('customers'),
        options('warehouses'),
      ]);
      return { products, customers, warehouses };
    },
    enabled: open,
    staleTime: 0,
  });
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(
        order
          ? {
              customerId: order.customerId,
              warehouseId: order.warehouseId,
              orderDate: dayjs(order.orderDate),
              expectedDate: order.expectedDate
                ? dayjs(order.expectedDate)
                : null,
              remark: order.remark,
            }
          : { orderDate: dayjs() },
      );
      setItems(
        order
          ? order.items.map((item) => ({
              key: createUuid(),
              productId: item.productId,
              quantity: item.quantity,
              price: (item.unitPrice / 100).toFixed(2),
            }))
          : [newLine()],
      );
      setError('');
    }
  }, [open, order, form]);
  const mutation = useMutation({
    mutationFn: (data: SalesInput) =>
      saveOrder(
        { ...data, ...(order ? { version: order.version } : {}) },
        order?.id,
      ),
    onSuccess: () => {
      void message.success('销售订单已保存');
      void client.invalidateQueries({ queryKey: ['sales-orders'] });
      void client.invalidateQueries({ queryKey: ['summary'] });
      void client.invalidateQueries({ queryKey: ['business'] });
      void client.invalidateQueries({ queryKey: ['todos'] });
      onClose();
    },
    onError: (error) => setError(errorMessage(error)),
  });
  function submit(values: Record<string, unknown>) {
    try {
      const result = salesSchema.safeParse({
        ...values,
        orderDate: dayjs(values.orderDate as dayjs.Dayjs).format('YYYY-MM-DD'),
        expectedDate: values.expectedDate
          ? dayjs(values.expectedDate as dayjs.Dayjs).format('YYYY-MM-DD')
          : null,
        items: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: priceInCents(item.price),
        })),
      });
      if (!result.success) {
        setError(result.error.issues.map((issue) => issue.message).join('；'));
        return;
      }
      setError('');
      mutation.mutate(result.data);
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  let total = 0;
  try {
    total = calculateAmount(
      items.map((item) => ({
        quantity: item.quantity,
        unitPrice: priceInCents(item.price),
      })),
    );
  } catch {
    /* Validation explains invalid or oversized amounts on submit. */
  }
  return (
    <Drawer
      title={order ? '编辑销售订单' : '新建销售订单'}
      width={920}
      open={open}
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
              disabled={!refs.data}
              onClick={() => form.submit()}
            >
              保存草稿
            </Button>
          </Space>
        </div>
      }
    >
      {refs.isError ? (
        <ErrorState error={refs.error} retry={() => void refs.refetch()} />
      ) : (
        <Form
          name="sales-order"
          form={form}
          layout="vertical"
          onFinish={submit}
          disabled={mutation.isPending}
        >
          <div className="form-grid">
            <Form.Item
              name="customerId"
              label="客户"
              rules={[{ required: true, message: '请选择客户' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                loading={refs.isLoading}
                placeholder="选择客户"
                options={refs.data?.customers.map((s) => ({
                  value: s.id,
                  label: s.name,
                  disabled: s.status !== 'ACTIVE',
                }))}
              />
            </Form.Item>
            <Form.Item
              name="warehouseId"
              label="出库仓库"
              rules={[{ required: true, message: '请选择仓库' }]}
            >
              <Select
                placeholder="选择默认出库仓库"
                options={refs.data?.warehouses.map((w) => ({
                  value: w.id,
                  label: w.name,
                  disabled: w.status !== 'ACTIVE',
                }))}
              />
            </Form.Item>
            <Form.Item
              name="orderDate"
              label="订单日期"
              rules={[{ required: true, message: '请选择订单日期' }]}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="expectedDate" label="预计交货日期">
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div className="form-section-title">商品明细</div>
          <DocumentItemsTable
            priceField="salesPrice"
            items={items}
            onChange={setItems}
            products={refs.data?.products ?? []}
            disabled={mutation.isPending}
          />
          <div className="document-total">
            订单合计{' '}
            <strong>
              <MoneyText cents={total} />
            </strong>
          </div>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={500} showCount />
          </Form.Item>
          {error && <Alert type="error" showIcon message={error} />}
          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: 20, fontSize: 12 }}
          >
            保存为草稿后可继续编辑，提交并审核通过后由仓库执行分批出库。价格和商品资料保存为订单快照。
          </Typography.Paragraph>
        </Form>
      )}
    </Drawer>
  );
}
