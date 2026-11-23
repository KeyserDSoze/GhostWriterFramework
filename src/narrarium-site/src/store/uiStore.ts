import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * How much of what the autopilot does its panels show: `full`, the last lines of the text it is writing and the last steps it finished (in the
 * mini-player, the band of the Autopilot page and the cards of the page of every book); `compact`, only its state, its step and its progress.
 */
export type AutopilotTextDetail = "full" | "compact";

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
  /** Quick notes dialog (opened with Ctrl+M or the topbar button). */
  notesOpen: boolean;
  setNotesOpen: (open: boolean) => void;
  /** «Show the text»: what the panels of the autopilot show, kept on this device. */
  autopilotText: AutopilotTextDetail;
  setAutopilotText: (detail: AutopilotTextDetail) => void;
  /** Session/connection status, read by the sync status indicator in the header. */
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
      autopilotText: "full",
      setAutopilotText: (detail) => set({ autopilotText: detail === "compact" ? "compact" : "full" }),
      authActivity: "idle",
      setAuthActivity: (activity) => set({ authActivity: activity }),
    }),
    {
      name: "narrarium-ui-state",
      version: 1,
      migrate: (persisted) => persisted as UiState,
      partialize: (state) => ({ dossierColumnHidden: state.dossierColumnHidden, autopilotText: state.autopilotText }),
      // A value this version does not know (a hand-edited storage, a later version) is the default.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<UiState>;
        return { ...current, ...stored, autopilotText: stored.autopilotText === "compact" ? "compact" : "full" };
      },
    },
  ),
);
