import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Typography,
  Tag,
} from 'antd';
import type { TableProps } from 'antd';
import {
  Plus,
  Download,
  Search,
  RotateCcw,
  Package,
  Users,
  Truck,
  Warehouse,
  FolderTree,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  labels,
  singular,
  type MasterRecord,
  type Resource,
  can,
} from '@kingflow/shared';
import {
  PageHeader,
  FilterBar,
  DataTable,
  StatusTag,
  MoneyText,
  PermissionGuard,
  ErrorState,
  ConfirmDialog,
} from '../../../components/common';
import { listRecords, deleteRecord, saveRecord, allCategories } from '../api';
import { RecordDrawer } from '../components/RecordDrawer';
import { useAuth } from '../../../stores/auth';
import { errorMessage, http } from '../../../services/client';

const descriptions: Record<Resource, string> = {
  products: '维护商品档案与价格，让每一笔业务都有据可依。',
  categories: '用清晰的商品分类，让业务管理更有条理。',
  customers: '沉淀客户资料，连接每一次合作。',
  suppliers: '统一管理供应商资料，建立可靠的采购网络。',
  warehouses: '管理仓库档案，为多仓库独立核算做好准备。',
};
const icons = {
  products: Package,
  categories: FolderTree,
  customers: Users,
  suppliers: Truck,
  warehouses: Warehouse,
};
export function MasterPage({ resource }: { resource: Resource }) {
  const [params, setParams] = useSearchParams();
  const [form] = Form.useForm();
  const [drawer, setDrawer] = useState<{
    open: boolean;
    record?: MasterRecord;
    readOnly?: boolean;
  }>({ open: params.get('create') === '1' });
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const auth = useAuth((state) => state.auth);
  const writable =
    !!auth && can(auth.user.role.permissions, `${resource}:write`);
  const query = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? undefined,
    categoryId: params.get('categoryId') ?? undefined,
    page: Number(params.get('page') ?? 1),
    pageSize: Number(params.get('pageSize') ?? 10),
    sortBy: params.get('sortBy') ?? 'createdAt',
    sortOrder: params.get('sortOrder') ?? 'desc',
  };
  const records = useQuery({
    queryKey: [resource, 'list', query],
    queryFn: () => listRecords(resource, query),
  });
  const categories = useQuery({
    queryKey: ['categories', 'options'],
    queryFn: allCategories,
    enabled: resource === 'products',
  });
  function updateParams(changes: Record<string, string | number | undefined>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      return next;
    });
  }
  async function changeStatus(record: MasterRecord) {
    setBusy(record.id);
    try {
      await saveRecord(
        resource,
        { status: record.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
        record.id,
        record.updatedAt,
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: [resource] }),
        client.invalidateQueries({ queryKey: ['summary'] }),
        client.invalidateQueries({ queryKey: ['business'] }),
        client.invalidateQueries({ queryKey: ['todos'] }),
        client.invalidateQueries({ queryKey: ['stock-alerts'] }),
      ]);
      void message.success('状态已更新');
    } catch (error) {
      void message.error(errorMessage(error));
      throw error;
    } finally {
      setBusy(null);
    }
  }
  async function remove(record: MasterRecord) {
    setBusy(record.id);
    try {
      await deleteRecord(resource, record.id);
      await Promise.all([
        client.invalidateQueries({ queryKey: [resource] }),
        client.invalidateQueries({ queryKey: ['summary'] }),
        client.invalidateQueries({ queryKey: ['business'] }),
        client.invalidateQueries({ queryKey: ['todos'] }),
        client.invalidateQueries({ queryKey: ['stock-alerts'] }),
      ]);
      void message.success('删除成功');
      if (records.data?.items.length === 1 && query.page > 1)
        updateParams({ page: query.page - 1 });
    } catch (error) {
      void message.error(errorMessage(error));
      throw error;
    } finally {
      setBusy(null);
    }
  }
  async function exportCsv() {
    setExporting(true);
    try {
      const res = await http.get('/products/export.csv', {
        params: query,
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'KingFlow-商品资料.csv';
      link.click();
      URL.revokeObjectURL(url);
      void message.success('导出成功');
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }
  const columns: TableProps<MasterRecord>['columns'] = [
    {
      title: `${singular[resource]}编码`,
      dataIndex: 'code',
      width: 145,
      sorter: true,
      sortOrder:
        query.sortBy === 'code'
          ? query.sortOrder === 'asc'
            ? 'ascend'
            : 'descend'
          : null,
      render: (code: string) => (
        <Typography.Text className="code-text">{code}</Typography.Text>
      ),
    },
    {
      title: `${singular[resource]}名称`,
      dataIndex: 'name',
      width: 210,
      sorter: true,
      sortOrder:
        query.sortBy === 'name'
          ? query.sortOrder === 'asc'
            ? 'ascend'
            : 'descend'
          : null,
      render: (name: string) => <span className="entity-name">{name}</span>,
    },
    ...(resource === 'products'
      ? [
          {
            title: '商品分类',
            width: 110,
            render: (_: unknown, row: MasterRecord) => (
              <Tag bordered={false}>{row.category?.name}</Tag>
            ),
          },
          {
            title: '规格 / 单位',
            width: 150,
            render: (_: unknown, row: MasterRecord) => (
              <span className="muted">
                {row.specification || '—'} / {row.unit}
              </span>
            ),
          },
          {
            title: '采购价',
            width: 105,
            render: (_: unknown, row: MasterRecord) => (
              <MoneyText cents={row.purchasePrice ?? 0} />
            ),
          },
          {
            title: '销售价',
            width: 105,
            render: (_: unknown, row: MasterRecord) => (
              <MoneyText cents={row.salesPrice ?? 0} />
            ),
          },
          { title: '库存预警', dataIndex: 'minStock', width: 90 },
        ]
      : resource === 'categories'
        ? []
        : resource === 'warehouses'
          ? [
              { title: '所在位置', dataIndex: 'location', width: 220 },
              { title: '负责人', dataIndex: 'manager', width: 100 },
            ]
          : [
              { title: '联系人', dataIndex: 'contact', width: 100 },
              { title: '联系电话', dataIndex: 'phone', width: 140 },
              {
                title: '地址',
                dataIndex: 'address',
                width: 220,
                ellipsis: true,
              },
            ]),
    {
      title: '状态',
      dataIndex: 'status',
      width: 95,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 125,
      sorter: true,
      sortOrder:
        query.sortBy === 'updatedAt'
          ? query.sortOrder === 'asc'
            ? 'ascend'
            : 'descend'
          : null,
      render: (date: string) =>
        new Date(date).toLocaleDateString('zh-CN', {
          timeZone: 'Asia/Shanghai',
        }),
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: writable ? 225 : 65,
      render: (_: unknown, row: MasterRecord) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            onClick={() =>
              setDrawer({ open: true, record: row, readOnly: true })
            }
          >
            查看
          </Button>
          {writable && (
            <>
              <Button
                type="link"
                size="small"
                disabled={busy === row.id}
                onClick={() => setDrawer({ open: true, record: row })}
              >
                编辑
              </Button>
              <Button
                type="link"
                size="small"
                loading={busy === row.id}
                onClick={() =>
                  ConfirmDialog({
                    modal,
                    title: `确定${row.status === 'ACTIVE' ? '停用' : '启用'}该${singular[resource]}？`,
                    content: row.name,
                    onConfirm: () => changeStatus(row),
                  })
                }
              >
                {row.status === 'ACTIVE' ? '停用' : '启用'}
              </Button>
              <Button
                type="link"
                danger
                size="small"
                disabled={busy === row.id}
                onClick={() =>
                  ConfirmDialog({
                    modal,
                    title: `删除${singular[resource]}`,
                    content: `确认删除「${row.name}」？已被引用的资料不可删除，建议停用。`,
                    onConfirm: () => remove(row),
                  })
                }
              >
                删除
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];
  const Icon = icons[resource];
  return (
    <>
      <PageHeader
        title={labels[resource]}
        description={descriptions[resource]}
        actions={
          <>
            {resource === 'products' && (
              <Button
                icon={<Download size={15} />}
                onClick={() => void exportCsv()}
                loading={exporting}
              >
                导出 CSV
              </Button>
            )}
            <PermissionGuard permission={`${resource}:write`}>
              <Button
                type="primary"
                icon={<Plus size={17} />}
                onClick={() => setDrawer({ open: true })}
              >
                新增{singular[resource]}
              </Button>
            </PermissionGuard>
          </>
        }
      />
      <div className="resource-banner">
        <div className="banner-icon">
          <Icon size={22} />
        </div>
        <div>
          <span className="banner-label">{singular[resource]}档案</span>
          <div>
            <strong>{records.data?.total ?? '—'}</strong>
            <span className="muted"> 条符合当前筛选的资料</span>
          </div>
        </div>
        <div className="banner-tip">
          <span className="live-dot" /> 数据库实时同步{' '}
          <span className="tip-divider">|</span>{' '}
          {writable ? '可维护资料' : '当前角色只读'}
        </div>
      </div>
      <Card className="table-card" styles={{ body: { padding: 0 } }}>
        <FilterBar>
          <Form
            name="master-filter"
            form={form}
            layout="inline"
            initialValues={{
              q: query.q,
              status: query.status,
              categoryId: query.categoryId,
            }}
            onFinish={(values) => updateParams({ ...values, page: 1 })}
          >
            <Form.Item name="q">
              <Input
                allowClear
                prefix={<Search size={15} className="muted" />}
                placeholder="搜索编码或名称"
                style={{ width: 240 }}
                onPressEnter={() => form.submit()}
              />
            </Form.Item>
            {resource === 'products' && (
              <Form.Item name="categoryId">
                <Select
                  allowClear
                  placeholder="全部分类"
                  style={{ width: 150 }}
                  loading={categories.isLoading}
                  options={categories.data?.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                />
              </Form.Item>
            )}
            <Form.Item name="status">
              <Select
                allowClear
                placeholder="全部状态"
                style={{ width: 125 }}
                options={[
                  { value: 'ACTIVE', label: '启用中' },
                  { value: 'INACTIVE', label: '已停用' },
                ]}
              />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit">
                  查询
                </Button>
                <Button
                  icon={<RotateCcw size={14} />}
                  onClick={() => {
                    form.resetFields();
                    form.setFieldsValue({
                      q: '',
                      status: undefined,
                      categoryId: undefined,
                    });
                    setParams({});
                  }}
                >
                  重置
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </FilterBar>
        <div className="table-title">
          <span>
            全部{singular[resource]} <Tag>{records.data?.total ?? 0}</Tag>
          </span>
          <span className="muted">金额单位：人民币元 · 数据实时保存</span>
        </div>
        {records.isError ? (
          <ErrorState
            error={records.error}
            retry={() => void records.refetch()}
          />
        ) : (
          <DataTable<MasterRecord>
            columns={columns}
            dataSource={records.data?.items}
            loading={records.isLoading || records.isFetching}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total: records.data?.total,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (total) => `共 ${total} 条`,
              onChange: (page, pageSize) =>
                updateParams({
                  page: pageSize === query.pageSize ? page : 1,
                  pageSize,
                }),
            }}
            onChange={(_pagination, _filters, sorter) => {
              if (!Array.isArray(sorter) && sorter.field)
                updateParams({
                  sortBy: String(sorter.field),
                  sortOrder: sorter.order === 'ascend' ? 'asc' : 'desc',
                  page: 1,
                });
            }}
          />
        )}
      </Card>
      <RecordDrawer
        {...drawer}
        open={drawer.open && (!!drawer.readOnly || writable)}
        resource={resource}
        onClose={() => {
          setDrawer({ open: false });
          if (params.has('create')) updateParams({ create: undefined });
        }}
      />
    </>
  );
}
