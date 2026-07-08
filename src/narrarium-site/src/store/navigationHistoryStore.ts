import { create } from "zustand";

export interface NavigationHistoryEntry {
  pathname: string;
  label: string;
  kind: string;
  bookId: string;
  updatedAt: number;
}

interface NavigationHistoryState {
  current: NavigationHistoryEntry | null;
  previous: NavigationHistoryEntry | null;
  record: (entry: NavigationHistoryEntry) => void;
}

export const useNavigationHistoryStore = create<NavigationHistoryState>()((set, get) => ({
  current: null,
  previous: null,
  record: (entry) => {
    const { current, previous } = get();
    if (current?.pathname === entry.pathname) {
      set({ current: { ...current, ...entry, updatedAt: Date.now() } });
      return;
    }
    set({ current: entry, previous: current ?? previous });
  },
}));
