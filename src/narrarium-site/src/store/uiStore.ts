import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  /** Mobile dossier search popup (there is no docked column on small screens). */
  dossierSearchOpen: boolean;
  setDossierSearchOpen: (open: boolean) => void;
  /** Quick notes dialog (opened with Ctrl+N or the topbar button). */
  notesOpen: boolean;
  setNotesOpen: (open: boolean) => void;
  /** Session/connection status shown as a discreet pill. */
  authActivity: "idle" | "refreshing" | "offline";
  setAuthActivity: (activity: "idle" | "refreshing" | "offline") => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
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
      dossierSearchOpen: false,
      setDossierSearchOpen: (open) => set({ dossierSearchOpen: open }),
      notesOpen: false,
      setNotesOpen: (open) => set({ notesOpen: open }),
      authActivity: "idle",
      setAuthActivity: (activity) => set({ authActivity: activity }),
    }),
    {
      name: "narrarium-ui-state",
      partialize: (state) => ({ dossierColumnHidden: state.dossierColumnHidden }),
    },
  ),
);
