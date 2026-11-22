import { create } from "zustand";
import { persist } from "zustand/middleware";

interface NavGroupsState {
  /** The groups of the menu of a book that the author collapsed (`book`, `autopilot`, `profiles`, `tools`), the same for every book. */
  collapsed: string[];
  setCollapsed: (group: string, collapsed: boolean) => void;
}

/** Which groups of the menu of a book are collapsed, remembered on this device (`localStorage`): not synced, as the width of a screen is not. */
export const useNavGroupsStore = create<NavGroupsState>()(
  persist(
    (set) => ({
      collapsed: [],
      setCollapsed: (group, collapsed) => set((state) => {
        const without = state.collapsed.filter((entry) => entry !== group);
        return { collapsed: collapsed ? [...without, group] : without };
      }),
    }),
    {
      name: "narrarium-nav-groups",
      partialize: (state) => ({ collapsed: state.collapsed }),
      // What another version, or a hand, left in the storage is read as far as it is a list of names.
      merge: (persisted, current) => {
        const collapsed = (persisted as { collapsed?: unknown } | undefined)?.collapsed;
        return { ...current, collapsed: Array.isArray(collapsed) ? collapsed.filter((entry): entry is string => typeof entry === "string") : [] };
      },
    },
  ),
);
