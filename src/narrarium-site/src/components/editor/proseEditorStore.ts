import { create } from "zustand";

/**
 * An action a page adds to the context menu of one of its text areas (the Outline adds «Develop this chapter» and «Check against the canon and the
 * nearby chapters»): a label in the language of the app, an icon among the menu's own, and what it does with the selection (or the whole text).
 */
export interface ProseEditorExtraAction {
  id: string;
  label: string;
  icon?: "sparkles" | "check";
  run: (selection: string | null) => void;
}

export interface ProseEditorActions {
  /** The textarea this editor controls */
  el: HTMLTextAreaElement;
  /** Open the improve flow for the current selection (or whole body if none) */
  improve: (selection: string | null) => void;
  /** Open a summary flow for the current selection (or whole body if none). */
  summarize?: (selection: string | null) => void;
  /** Open the synonym flow for a short selection */
  synonym: (selection: string) => void;
  /** Open the merge draft+final flow. Present only on split/draft/final pages. */
  merge?: () => void;
  /** Actions of the page for this text area, after «Improve» and «Summarize». */
  extra?: ProseEditorExtraAction[];
  /** What «Improve» and «Summarize» on the whole text are called here, when it is not a paragraph (the Outline: «Improve the entry»). */
  labels?: { improveAll?: string; summaryAll?: string };
}

interface ProseEditorState {
  editors: ProseEditorActions[];
  register: (actions: ProseEditorActions) => () => void;
  /** Find the registered editor whose textarea is the given element. */
  forElement: (el: EventTarget | null) => ProseEditorActions | undefined;
}

export const useProseEditorStore = create<ProseEditorState>()((set, get) => ({
  editors: [],
  register: (actions) => {
    set((s) => ({ editors: [...s.editors.filter((e) => e.el !== actions.el), actions] }));
    return () => set((s) => ({ editors: s.editors.filter((e) => e.el !== actions.el) }));
  },
  forElement: (el) => get().editors.find((e) => e.el === el),
}));
