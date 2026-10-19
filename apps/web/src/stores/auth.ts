import { create } from 'zustand';
import type { AuthData } from '@kingflow/shared';
export const useAuth = create<{
  auth: AuthData | null;
  setAuth: (auth: AuthData | null) => void;
}>((set) => ({ auth: null, setAuth: (auth) => set({ auth }) }));
