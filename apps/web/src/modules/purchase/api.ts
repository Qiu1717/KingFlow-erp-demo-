import { get, http } from '../../services/client';
import type {
  MasterRecord,
  PageData,
  PurchaseOrderRecord,
  ReceiptRecord,
  PurchaseInput,
  ReceiptInput,
} from '@kingflow/shared';
export async function options(
  resource: 'products' | 'suppliers' | 'warehouses',
) {
  const result: MasterRecord[] = [];
  let page = 1;
  while (true) {
    const data = await get<PageData<MasterRecord>>(`/${resource}`, {
      page,
      pageSize: 100,
      sortBy: 'code',
      sortOrder: 'asc',
    });
    result.push(...data.items);
    if (result.length >= data.total) return result;
    page++;
  }
}
export const orderDetail = (id: string) =>
  get<PurchaseOrderRecord>(`/purchase-orders/${id}`);
export const saveOrder = async (data: PurchaseInput, id?: string) =>
  (
    await http.request<{ data: PurchaseOrderRecord }>({
      url: `/purchase-orders${id ? '/' + id : ''}`,
      method: id ? 'PATCH' : 'POST',
      data,
    })
  ).data.data;
export const orderAction = async (
  id: string,
  action: string,
  body: object = {},
) =>
  (
    await http.post<{ data: PurchaseOrderRecord }>(
      `/purchase-orders/${id}/${action}`,
      body,
    )
  ).data.data;
export const postReceipt = async (data: ReceiptInput, key: string) =>
  (
    await http.post<{ data: ReceiptRecord }>('/goods-receipts', data, {
      headers: { 'Idempotency-Key': key },
    })
  ).data.data;
