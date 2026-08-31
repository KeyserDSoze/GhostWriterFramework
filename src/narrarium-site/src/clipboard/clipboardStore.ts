import { create } from "zustand";
import { saveLocalAccountClipboard } from "@/account/accountLocalStore";

const LOCAL_KEY = "narrarium-clipboard-v1";
const MAX_ITEMS = 20;

export interface ClipboardEntry {
  id: string;
  text: string;
  at: string;
  source?: string;
}

function loadLocal(): ClipboardEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw) as ClipboardEntry[];
  } catch {
    // ignore
  }
  return [];
}

function persistLocal(items: ClipboardEntry[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

interface ClipboardState {
  items: ClipboardEntry[];
  dirty: boolean;
  revision: number;
  push: (text: string, source?: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  setItems: (items: ClipboardEntry[]) => void;
  hydrate: (items: ClipboardEntry[]) => void;
  markSynced: (revision: number) => void;
}

export const useClipboardStore = create<ClipboardState>()((set) => ({
  items: loadLocal(),
  dirty: false,
  revision: 0,
  push: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((s) => {
      const without = s.items.filter((entry) => entry.text !== trimmed);
      const next = [{ id: crypto.randomUUID(), text: trimmed, at: new Date().toISOString(), source }, ...without].slice(0, MAX_ITEMS);
      persistLocal(next);
      void saveLocalAccountClipboard(next).catch(() => undefined);
      return { items: next, dirty: true, revision: s.revision + 1 };
    });
  },
  remove: (id) => set((s) => {
    const next = s.items.filter((entry) => entry.id !== id);
    persistLocal(next);
    void saveLocalAccountClipboard(next).catch(() => undefined);
    return { items: next, dirty: true, revision: s.revision + 1 };
  }),
  clear: () => { persistLocal([]); void saveLocalAccountClipboard([]).catch(() => undefined); set((s) => ({ items: [], dirty: true, revision: s.revision + 1 })); },
  setItems: (items) => { persistLocal(items); set((s) => ({ items, dirty: false, revision: s.revision + 1 })); },
  hydrate: (items) => { persistLocal(items); set({ items, dirty: false }); },
  markSynced: (revision) => set((s) => s.revision === revision ? { dirty: false } : s),
}));
