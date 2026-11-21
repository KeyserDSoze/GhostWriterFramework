import { create } from "zustand";
import type { EvaluationTarget } from "narrarium-engine";

export interface AskDirectorRequest {
  bookId: string;
  target: EvaluationTarget;
}

interface AskDirectorState {
  request: AskDirectorRequest | null;
  /** Incremented whenever an opinion is saved in a book, so lists can reload. */
  savedVersion: number;
  open: (request: AskDirectorRequest) => void;
  close: () => void;
  markSaved: () => void;
}

export const useAskDirectorStore = create<AskDirectorState>()((set) => ({
  request: null,
  savedVersion: 0,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
  markSaved: () => set((state) => ({ savedVersion: state.savedVersion + 1 })),
}));

/** Open the global "What does the director think?" dialog on the book, a chapter or a scene. */
export function openAskDirector(request: AskDirectorRequest): void {
  useAskDirectorStore.getState().open(request);
}
