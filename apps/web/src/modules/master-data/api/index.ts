import type { MasterRecord, PageData, Resource } from '@kingflow/shared';
import { get, http } from '../../../services/client';
export const listRecords = (resource: Resource, params: object) =>
  get<PageData<MasterRecord>>(`/${resource}`, params);
export const saveRecord = async (
  resource: Resource,
  data: object,
  id?: string,
  updatedAt?: string,
): Promise<MasterRecord> =>
  (
    await http.request<{ data: MasterRecord }>({
      url: `/${resource}${id ? '/' + id : ''}`,
      method: id ? 'PATCH' : 'POST',
      data,
      headers: id ? { 'If-Match': `"${updatedAt}"` } : undefined,
    })
  ).data.data;
export const deleteRecord = async (resource: Resource, id: string) =>
  http.delete(`/${resource}/${id}`);
export async function allCategories() {
  const result: MasterRecord[] = [];
  let page = 1;
  while (true) {
    const data = await listRecords('categories', {
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
