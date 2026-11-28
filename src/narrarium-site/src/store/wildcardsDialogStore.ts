import { create } from "zustand";
import type { WildcardConsultResult } from "narrarium-engine";

/**
 * The consultation of the room from a right click (or from the Copilot): what it is about, and, for a selection, the field it was selected in, so that a
 * rewrite the author keeps goes back where it came from. The dialog that runs it is loaded only when this is open.
 */

export interface WildcardsTarget {
  kind: "selection" | "paragraph" | "chapter";
  /** The chapter's slug. */
  chapter: string;
  /** The scene's slug (`paragraph`), or its number as the address has it (`selection`). */
  paragraph?: string;
}

/** Where a selection was made: the field, the range and its whole text when the room was asked (a rewrite goes in only if it is still the same). */
export interface WildcardsSelection {
  text: string;
  editable: HTMLTextAreaElement | HTMLInputElement | null;
  range: { start: number; end: number } | null;
  sourceValue: string;
}

export interface WildcardsRequest {
  bookId: string;
  target: WildcardsTarget;
  selection?: WildcardsSelection;
  /** A consultation already made (the Copilot's): shown at once, in the table of its ideas. */
  result?: WildcardConsultResult;
  /** What the author asked the room, when they asked something. */
  question?: string;
}

interface WildcardsDialogState {
  request: WildcardsRequest | null;
  open: (request: WildcardsRequest) => void;
  close: () => void;
}

export const useWildcardsDialogStore = create<WildcardsDialogState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Open the room («Out-of-the-box ideas…») on a selection, a scene or a chapter. */
export function openWildcardsDialog(request: WildcardsRequest): void {
  useWildcardsDialogStore.getState().open(request);
}
