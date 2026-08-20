import { useEffect, useRef } from "react";
import { create } from "zustand";
import { triggerCurrentSave } from "@/store/saveStore";
import type { ExactRepositoryTarget, RepositorySyncConflictError } from "@/repository/repositoryService";

export interface RepositorySyncConflictRequest {
  error: RepositorySyncConflictError;
  target: ExactRepositoryTarget;
}

export interface RepositorySyncRegistration {
  /** True while a repository sync is already running. */
  busy: boolean;
  /** Save/commit/push the active book repository. */
  sync: () => boolean | void | Promise<boolean | void>;
}

interface RepositorySyncState {
  current: RepositorySyncRegistration | null;
  conflict: RepositorySyncConflictRequest | null;
  setCurrent: (registration: RepositorySyncRegistration | null) => void;
  setConflict: (conflict: RepositorySyncConflictRequest | null) => void;
}

export const useRepositorySyncStore = create<RepositorySyncState>()((set) => ({
  current: null,
  conflict: null,
  setCurrent: (registration) => set({ current: registration }),
  setConflict: (conflict) => set({ conflict }),
}));

export function sameRepositorySyncTarget(a: ExactRepositoryTarget, b: ExactRepositoryTarget): boolean {
  return a.bookId === b.bookId
    && a.owner === b.owner
    && a.repo === b.repo
    && a.branch === b.branch
    && a.accountIdentity === b.accountIdentity;
}

/** Trigger the current book sync after flushing active page edits, when possible. */
export async function triggerCurrentRepositorySync(): Promise<boolean> {
  const current = useRepositorySyncStore.getState().current;
  if (!current || current.busy) return false;
  if (!await triggerCurrentSave()) return false;
  return (await current.sync()) !== false;
}

export function useRegisterRepositorySync(registration: { enabled?: boolean; busy: boolean; onSync: () => boolean | void | Promise<boolean | void> }) {
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
