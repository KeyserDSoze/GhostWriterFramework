import { useEffect, useRef } from "react";
import { create } from "zustand";
import { triggerCurrentSave } from "@/store/saveStore";

export interface RepositorySyncRegistration {
  /** True while a repository sync is already running. */
  busy: boolean;
  /** Save/commit/push the active book repository. */
  sync: () => void | Promise<void>;
}

interface RepositorySyncState {
  current: RepositorySyncRegistration | null;
  setCurrent: (registration: RepositorySyncRegistration | null) => void;
}

export const useRepositorySyncStore = create<RepositorySyncState>()((set) => ({
  current: null,
  setCurrent: (registration) => set({ current: registration }),
}));

/** Trigger the current book sync after flushing active page edits, when possible. */
export async function triggerCurrentRepositorySync(): Promise<boolean> {
  const current = useRepositorySyncStore.getState().current;
  if (!current || current.busy) return false;
  await triggerCurrentSave();
  await current.sync();
  return true;
}

export function useRegisterRepositorySync(registration: { enabled?: boolean; busy: boolean; onSync: () => void | Promise<void> }) {
  const { enabled = true, busy, onSync } = registration;
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  useEffect(() => {
    if (!enabled) {
      useRepositorySyncStore.getState().setCurrent(null);
      return;
    }
    const sync = () => onSyncRef.current();
    useRepositorySyncStore.getState().setCurrent({ busy, sync });
    return () => {
      useRepositorySyncStore.setState((state) => (state.current?.sync === sync ? { current: null } : state));
    };
  }, [busy, enabled]);
}
