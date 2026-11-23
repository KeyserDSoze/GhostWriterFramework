import { create } from "zustand";

/**
 * Which book the window of the conflicts with GitHub is open for. The control that offers it (the error panel, the notice of «Where it runs») only asks for it; the page shows it, once, so that
 * it outlives what opened it: both go away as soon as the conflicts are resolved (the panel says they are, the notice has none to count), and the author is still reading what came of it.
 */
interface ConflictsWindow {
  bookId: string | null;
  /** The control that opened it: the focus goes back to it when the window closes, if it is still there. Kept after the window closes, for that. */
  opener: HTMLElement | null;
  open: (bookId: string, opener: HTMLElement | null) => void;
  close: () => void;
}

export const useConflictsWindow = create<ConflictsWindow>((set) => ({
  bookId: null,
  opener: null,
  open: (bookId, opener) => set({ bookId, opener }),
  close: () => set({ bookId: null }),
}));
