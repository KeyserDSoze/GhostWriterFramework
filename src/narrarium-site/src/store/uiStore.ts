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
  /** Desktop sidebar collapsed (hidden) to free up horizontal space. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Hide the docked dossier column; reopens when a dossier is opened or search is focused. */
  dossierColumnHidden: boolean;
  setDossierColumnHidden: (hidden: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  floatingHidden: false,
  toggleFloating: () => set((s) => ({ floatingHidden: !s.floatingHidden })),
  setFloatingHidden: (hidden) => set({ floatingHidden: hidden }),
  debugOpen: false,
  setDebugOpen: (open) => set({ debugOpen: open }),
  actionsOpen: false,
  setActionsOpen: (open) => set({ actionsOpen: open }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  dossierColumnHidden: false,
  setDossierColumnHidden: (hidden) => set({ dossierColumnHidden: hidden }),
}));
