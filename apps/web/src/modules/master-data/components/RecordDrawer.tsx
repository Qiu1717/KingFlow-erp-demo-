import {
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useEffect } from 'react';
import {
  fields,
  schemas,
  singular,
  type MasterRecord,
  type Resource,
} from '@kingflow/shared';
import { FormDrawer, MoneyText, StatusTag } from '../../../components/common';
import { allCategories, saveRecord } from '../api';
import { errorMessage } from '../../../services/client';
import { Link } from 'react-router-dom';
import { PermissionGuard } from '../../../components/common';
import { App } from 'antd';

interface Props {
  resource: Resource;
  open: boolean;
  record?: MasterRecord;
  readOnly?: boolean;
  onClose: () => void;
}
export function RecordDrawer({
  resource,
  open,
  record,
  readOnly = false,
  onClose,
}: Props) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const client = useQueryClient();
  const categories = useQuery({
    queryKey: ['categories', 'options'],
    queryFn: allCategories,
    enabled: open && resource === 'products',
  });
  const mutation = useMutation({
    mutationFn: (data: object) =>
      saveRecord(resource, data, record?.id, record?.updatedAt),
    onSuccess: () => {
      void message.success(record ? '保存成功' : '新增成功');
      void client.invalidateQueries({ queryKey: [resource] });
      void client.invalidateQueries({ queryKey: ['summary'] });
      onClose();
    },
    onError: (error) => {
      void message.error(errorMessage(error));
      if (axios.isAxiosError(error)) {
        const errors = error.response?.data?.error?.fields as
          Record<string, string[]> | undefined;
        if (errors)
          form.setFields(
            Object.entries(errors).map(([name, errors]) => ({ name, errors })),
          );
      }
    },
  });
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      record
        ? {
            ...record,
            purchasePrice:
              record.purchasePrice === undefined
                ? undefined
                : (record.purchasePrice / 100).toFixed(2),
            salesPrice:
              record.salesPrice === undefined
                ? undefined
                : (record.salesPrice / 100).toFixed(2),
          }
        : {
            status: 'ACTIVE',
            unit: '件',
            purchasePrice: '0.00',
            salesPrice: '0.00',
            minStock: 0,
          },
    );
  }, [open, record, form]);
  function submit(values: Record<string, unknown>) {
    const data = { ...values };
    for (const field of fields[resource]) {
      if (field.kind === 'money') {
        const raw = String(values[field.key] ?? '');
        if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
          form.setFields([
            { name: field.key, errors: ['请输入非负金额，最多两位小数'] },
          ]);
          return;
        }
        const [whole, fraction = ''] = raw.split('.');
        data[field.key] = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      } else if (field.kind === 'number')
        data[field.key] = values[field.key] ?? 0;
      else data[field.key] = values[field.key] ?? '';
    }
    const result = schemas[resource].safeParse(data);
    if (!result.success) {
      form.setFields(
        result.error.issues.map((issue) => ({
          name: issue.path,
          errors: [issue.message],
        })),
      );
      return;
    }
    mutation.mutate(result.data);
  }
  const title = readOnly
    ? `${singular[resource]}详情`
    : `${record ? '编辑' : '新增'}${singular[resource]}`;
  return (
    <FormDrawer
      title={title}
      open={open}
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      footer={
        readOnly ? undefined : (
          <div className="drawer-footer">
            <Space>
              <Button onClick={onClose} disabled={mutation.isPending}>
                取消
              </Button>
              <Button
                type="primary"
                loading={mutation.isPending}
                onClick={() => form.submit()}
              >
                保存
              </Button>
            </Space>
          </div>
        )
      }
    >
      {readOnly && record ? (
        <>
          <div className="record-hero">
            <div className="record-avatar">{record.name.slice(0, 1)}</div>
            <div>
              <Typography.Title level={4}>{record.name}</Typography.Title>
              <Typography.Text type="secondary">{record.code}</Typography.Text>
            </div>
          </div>
          <Descriptions
            column={1}
            bordered
            size="small"
            items={[
              { key: 'code', label: '编码', children: record.code },
              { key: 'name', label: '名称', children: record.name },
              ...fields[resource].map((field) => ({
                key: field.key,
                label: field.label,
                children:
                  field.kind === 'money' ? (
                    <MoneyText
                      cents={Number(
                        record[field.key as keyof MasterRecord] ?? 0,
                      )}
                    />
                  ) : (
                    String(
                      field.key === 'categoryId'
                        ? (record.category?.name ?? '—')
                        : (record[field.key as keyof MasterRecord] ?? '—'),
                    )
                  ),
              })),
              {
                key: 'status',
                label: '状态',
                children: <StatusTag status={record.status} />,
              },
              {
                key: 'createdAt',
                label: '创建时间',
                children: new Date(record.createdAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                }),
              },
              {
                key: 'updatedAt',
                label: '更新时间',
                children: new Date(record.updatedAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                }),
              },
            ]}
          />
          {resource === 'customers' && (
            <PermissionGuard permission="sales:read">
              <Link to={`/sales-orders?customerId=${record.id}`}>
                <Button style={{ marginTop: 20 }}>查看关联销售订单</Button>
              </Link>
            </PermissionGuard>
          )}
          {resource === 'suppliers' && (
            <PermissionGuard permission="purchase:read">
              <Link to={`/purchase-orders?supplierId=${record.id}`}>
                <Button style={{ marginTop: 20 }}>查看关联采购订单</Button>
              </Link>
            </PermissionGuard>
          )}
        </>
      ) : (
        <Form
          name="master-record"
          form={form}
          layout="vertical"
          onFinish={submit}
          requiredMark="optional"
          disabled={mutation.isPending}
        >
          <div className="form-section-title">基本信息</div>
          <div className="form-grid">
            <Form.Item
              name="code"
              label={`${singular[resource]}编码`}
              rules={[
                { required: true, message: '请输入编码' },
                { max: 40, message: '最多40字符' },
              ]}
            >
              <Input placeholder="例如 KF-0031" maxLength={40} />
            </Form.Item>
            <Form.Item
              name="name"
              label={`${singular[resource]}名称`}
              rules={[
                { required: true, message: '请输入名称' },
                { max: 100, message: '最多100字符' },
              ]}
            >
              <Input
                placeholder={`请输入${singular[resource]}名称`}
                maxLength={100}
              />
            </Form.Item>
          </div>
          {fields[resource].map((field) => (
            <Form.Item
              key={field.key}
              name={field.key}
              label={field.label}
              rules={
                field.required
                  ? [{ required: true, message: `请填写${field.label}` }]
                  : []
              }
            >
              {field.kind === 'category' ? (
                <Select
                  placeholder="请选择商品分类"
                  loading={categories.isLoading}
                  showSearch
                  optionFilterProp="label"
                  notFoundContent={
                    categories.isError
                      ? '分类加载失败，请关闭重试'
                      : '暂无分类，请先新增分类'
                  }
                  options={categories.data?.map((c) => ({
                    value: c.id,
                    label: c.name,
                    disabled:
                      c.status !== 'ACTIVE' && c.id !== record?.categoryId,
                  }))}
                />
              ) : field.kind === 'money' ? (
                <InputNumber<string>
                  stringMode
                  min="0"
                  max="10000000"
                  precision={2}
                  step="0.01"
                  prefix="¥"
                  style={{ width: '100%' }}
                />
              ) : field.kind === 'number' ? (
                <InputNumber
                  min={0}
                  max={1000000000}
                  precision={0}
                  style={{ width: '100%' }}
                />
              ) : field.kind === 'textarea' ? (
                <Input.TextArea maxLength={500} rows={3} showCount />
              ) : (
                <Input
                  maxLength={
                    field.key === 'address'
                      ? 250
                      : field.key === 'email'
                        ? 120
                        : field.key === 'phone'
                          ? 30
                          : field.key === 'contact' || field.key === 'manager'
                            ? 60
                            : field.key === 'unit'
                              ? 20
                              : 100
                  }
                  placeholder={`请输入${field.label}`}
                />
              )}
            </Form.Item>
          ))}
          <Form.Item name="status" label="资料状态">
            <Select
              options={[
                { value: 'ACTIVE', label: '启用中' },
                { value: 'INACTIVE', label: '已停用' },
              ]}
            />
          </Form.Item>
          <div className="inline-note">
            {resource === 'products'
              ? '价格以人民币展示，后台以整数分存储。历史订单价格不随参考价改变。'
              : '资料保存后实时写入数据库。停用后将不能用于新业务单据。'}
          </div>
        </Form>
      )}
    </FormDrawer>
  );
}
