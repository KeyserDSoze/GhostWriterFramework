import type { ReactNode } from "react";
import { create } from "zustand";

/**
 * What a page adds to the menu of a selection (the right-click menu, and on a touch screen the menu of its floating button) for the text of one of its
 * regions: the reader adds «Annotate». The page registers it while it is shown; the menu asks it, when it opens, whether the place belongs to it, keeps
 * what it captured then (a selection is lost as soon as the focus moves into the menu) and draws what it returns, from the page's own chunk.
 */
export interface SelectionMenuExtension {
  id: string;
  /** What this extension keeps of the place and the selection the menu opened on, or null when they are not its own. */
  capture: (target: EventTarget | null, selection: Selection | null) => unknown | null;
  /** The items it adds at the top of the menu. */
  render: (input: { context: unknown; close: () => void; touch: boolean; menuX: number }) => ReactNode;
  /** It shows its own toolbar for a selection on a touch screen: the menu's floating button stays hidden for that selection. */
  ownsTouchSelection?: (selection: Selection | null) => boolean;
}

interface SelectionMenuState {
  extensions: SelectionMenuExtension[];
  register: (extension: SelectionMenuExtension) => () => void;
  /** Set by the menu: opens it at a point of the screen, as a right click there would (false when it has nothing to show). */
  openMenu: ((x: number, y: number, target: EventTarget | null) => boolean) | null;
  setOpenMenu: (open: SelectionMenuState["openMenu"]) => void;
}

export const useSelectionMenuStore = create<SelectionMenuState>()((set) => ({
  extensions: [],
  register: (extension) => {
    set((state) => ({ extensions: [...state.extensions.filter((entry) => entry.id !== extension.id), extension] }));
    return () => set((state) => ({ extensions: state.extensions.filter((entry) => entry !== extension) }));
  },
  openMenu: null,
  setOpenMenu: (openMenu) => set({ openMenu }),
}));
