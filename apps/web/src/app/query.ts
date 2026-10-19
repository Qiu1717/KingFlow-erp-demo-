import { QueryClient } from '@tanstack/react-query';
import { isUnauthorized } from '../services/client';
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !isUnauthorized(error) && count < 1,
      staleTime: 15000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});
