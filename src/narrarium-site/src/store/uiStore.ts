import { create } from "zustand";

interface UiState {
  floatingHidden: boolean;
  toggleFloating: () => void;
  setFloatingHidden: (hidden: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  floatingHidden: false,
  toggleFloating: () => set((s) => ({ floatingHidden: !s.floatingHidden })),
  setFloatingHidden: (hidden) => set({ floatingHidden: hidden }),
}));
