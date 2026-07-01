import { create } from "zustand";
import type { CanonSection } from "@/lib/canonSections";

export interface DossierEntry {
  id: string;
  title: string;
  section: CanonSection | string;
  path: string;
  content: string;
  slug?: string;
  bookId?: string;
  imagePath?: string;
  /** Object URL for the entity thumbnail, if loaded. Revoked on close. */
  imageUrl?: string;
  /** Free x/y position when floating (popup). */
  x?: number;
  y?: number;
}

interface DossierState {
  /** The single dossier anchored on the right. */
  docked: DossierEntry | null;
  /** Detached dossiers shown as floating popups. */
  floating: DossierEntry[];
  /** Open a dossier: always (re)anchor on the right, replacing the docked one. */
  openDossier: (entry: DossierEntry) => void;
  /** Detach a dossier into a floating popup. */
  undock: (id: string) => void;
  /** Re-anchor a floating dossier on the right (replaces the docked one). */
  dock: (id: string) => void;
  /** Move a floating popup. */
  moveFloating: (id: string, x: number, y: number) => void;
  /** Close a dossier (docked or floating) and revoke its image URL. */
  closeDossier: (id: string) => void;
  clearDossiers: () => void;
}

function revoke(entry: DossierEntry | null | undefined) {
  if (entry?.imageUrl) {
    try { URL.revokeObjectURL(entry.imageUrl); } catch { /* ignore */ }
  }
}

export const useDossierStore = create<DossierState>((set, get) => ({
  docked: null,
  floating: [],
  openDossier: (entry) => {
    const { docked, floating } = get();
    // If this entry is already floating, just update it in place (keep it detached).
    if (floating.some((f) => f.id === entry.id)) {
      set({ floating: floating.map((f) => (f.id === entry.id ? { ...entry, x: f.x, y: f.y } : f)) });
      return;
    }
    // Otherwise anchor it on the right, replacing (and revoking) the previous docked one.
    if (docked && docked.id !== entry.id) revoke(docked);
    set({ docked: entry });
  },
  undock: (id) => {
    const { docked, floating } = get();
    if (docked?.id === id) {
      const offset = 40 + floating.length * 24;
      set({ docked: null, floating: [{ ...docked, x: offset, y: offset }, ...floating] });
    }
  },
  dock: (id) => {
    const { docked, floating } = get();
    const entry = floating.find((f) => f.id === id);
    if (!entry) return;
    if (docked && docked.id !== id) revoke(docked);
    set({ docked: { ...entry, x: undefined, y: undefined }, floating: floating.filter((f) => f.id !== id) });
  },
  moveFloating: (id, x, y) => {
    set((state) => ({ floating: state.floating.map((f) => (f.id === id ? { ...f, x, y } : f)) }));
  },
  closeDossier: (id) => {
    const { docked, floating } = get();
    if (docked?.id === id) { revoke(docked); set({ docked: null }); return; }
    const entry = floating.find((f) => f.id === id);
    if (entry) revoke(entry);
    set({ floating: floating.filter((f) => f.id !== id) });
  },
  clearDossiers: () => {
    const { docked, floating } = get();
    revoke(docked);
    floating.forEach(revoke);
    set({ docked: null, floating: [] });
  },
}));
