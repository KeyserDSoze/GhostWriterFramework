import { create } from "zustand";

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
  push: (text: string, source?: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  setItems: (items: ClipboardEntry[]) => void;
  markSynced: () => void;
}

export const useClipboardStore = create<ClipboardState>()((set) => ({
  items: loadLocal(),
  dirty: false,
  push: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((s) => {
      const without = s.items.filter((entry) => entry.text !== trimmed);
      const next = [{ id: crypto.randomUUID(), text: trimmed, at: new Date().toISOString(), source }, ...without].slice(0, MAX_ITEMS);
      persistLocal(next);
      return { items: next, dirty: true };
    });
  },
  remove: (id) => set((s) => {
    const next = s.items.filter((entry) => entry.id !== id);
    persistLocal(next);
    return { items: next, dirty: true };
  }),
  clear: () => { persistLocal([]); set({ items: [], dirty: true }); },
  setItems: (items) => { persistLocal(items); set({ items, dirty: false }); },
  markSynced: () => set({ dirty: false }),
}));
