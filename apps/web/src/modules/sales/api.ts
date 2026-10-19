import { get, http } from '../../services/client';
import type {
  MasterRecord,
  PageData,
  SalesOrderRecord,
  ShipmentRecord,
  SalesInput,
  ShipmentInput,
} from '@kingflow/shared';
export async function options(
  resource: 'products' | 'customers' | 'warehouses',
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
  get<SalesOrderRecord>(`/sales-orders/${id}`);
export const saveOrder = async (data: SalesInput, id?: string) =>
  (
    await http.request<{ data: SalesOrderRecord }>({
      url: `/sales-orders${id ? '/' + id : ''}`,
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
    await http.post<{ data: SalesOrderRecord }>(
      `/sales-orders/${id}/${action}`,
      body,
    )
  ).data.data;
export const postShipment = async (data: ShipmentInput, key: string) =>
  (
    await http.post<{ data: ShipmentRecord }>('/sales-shipments', data, {
      headers: { 'Idempotency-Key': key },
    })
  ).data.data;
