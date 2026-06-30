import { create } from "zustand";
import { useEffect, useRef } from "react";

export interface PageSaveRegistration {
  /** Whether there are unsaved changes right now. */
  dirty: boolean;
  /** Run the page's save action. */
  save: () => void | Promise<void>;
}

interface SaveState {
  current: PageSaveRegistration | null;
  setCurrent: (registration: PageSaveRegistration | null) => void;
}

export const useSaveStore = create<SaveState>()((set) => ({
  current: null,
  setCurrent: (registration) => set({ current: registration }),
}));

/** Trigger the active page's save action (used by Ctrl+S and the context menu). */
export async function triggerCurrentSave(): Promise<boolean> {
  const current = useSaveStore.getState().current;
  if (!current) return false;
  await current.save();
  return true;
}

/**
 * Register the current page's save action so global shortcuts and the context menu
 * can invoke it. The latest onSave is kept in a ref so re-renders don't thrash the store.
 */
export function useRegisterPageSave(registration: { dirty: boolean; enabled?: boolean; onSave: () => void | Promise<void> }) {
  const { dirty, enabled = true, onSave } = registration;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!enabled) {
      useSaveStore.getState().setCurrent(null);
      return;
    }
    const save = () => onSaveRef.current();
    useSaveStore.getState().setCurrent({ dirty, save });
    return () => {
      useSaveStore.setState((state) => (state.current?.save === save ? { current: null } : state));
    };
  }, [dirty, enabled]);
}
