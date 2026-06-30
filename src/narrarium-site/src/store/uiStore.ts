import { create } from "zustand";

interface UiState {
  floatingHidden: boolean;
  toggleFloating: () => void;
  setFloatingHidden: (hidden: boolean) => void;
  debugOpen: boolean;
  setDebugOpen: (open: boolean) => void;
  /** Whether the book-actions panel (image/commit/PR/export + navigable rows) is open. */
  actionsOpen: boolean;
  setActionsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  floatingHidden: false,
  toggleFloating: () => set((s) => ({ floatingHidden: !s.floatingHidden })),
  setFloatingHidden: (hidden) => set({ floatingHidden: hidden }),
  debugOpen: false,
  setDebugOpen: (open) => set({ debugOpen: open }),
  actionsOpen: false,
  setActionsOpen: (open) => set({ actionsOpen: open }),
}));
