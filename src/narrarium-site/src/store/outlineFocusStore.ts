import { create } from "zustand";

/**
 * The entry of the Outline the author is working on, so that the Copilot reads the outline around it ("the chapter" on the Outline page is
 * an entry of it). Set by the Outline page when a field of an entry takes the focus.
 */
export const useOutlineFocusStore = create<{ bookId: string | null; number: number | null; focus: (bookId: string, number: number | null) => void }>()((set) => ({
  bookId: null,
  number: null,
  focus: (bookId, number) => set({ bookId, number }),
}));
