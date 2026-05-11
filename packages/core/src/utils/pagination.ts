export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(items: T[], page: number, limit: number): { items: T[]; pagination: Pagination } {
  const safeLimit = Math.max(1, limit);
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * safeLimit;
  const sliced = items.slice(start, start + safeLimit);
  return {
    items: sliced,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / safeLimit)),
    },
  };
}
