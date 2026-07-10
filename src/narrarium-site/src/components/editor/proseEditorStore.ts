import { create } from "zustand";

export interface ProseEditorActions {
  /** The textarea this editor controls */
  el: HTMLTextAreaElement;
  /** Open the improve flow for the current selection (or whole body if none) */
  improve: (selection: string | null) => void;
  /** Open a summary flow for the current selection (or whole body if none). */
  summarize?: (selection: string | null) => void;
  /** Open the synonym flow for a short selection */
  synonym: (selection: string) => void;
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
