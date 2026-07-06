import { useEffect } from "react";
import { create } from "zustand";

export interface PageActionRegistration {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
}

interface PageActionsState {
  actions: PageActionRegistration[];
  setActions: (actions: PageActionRegistration[]) => void;
}

export const usePageActionsStore = create<PageActionsState>()((set) => ({
  actions: [],
  setActions: (actions) => set({ actions }),
}));

export function useRegisterPageActions(actions: PageActionRegistration[], enabled = true) {
  useEffect(() => {
    if (!enabled) {
      usePageActionsStore.getState().setActions([]);
      return;
    }
    usePageActionsStore.getState().setActions(actions);
    return () => {
      usePageActionsStore.getState().setActions([]);
    };
  }, [enabled, actions]);
}
