import { create } from "zustand";
import { outsideCheckUrls, runOutsideCheck, type OutsideCheckResult } from "@/readerUpdate/outsideCheck";

/** The result of the check of a published reader from outside, one per address, shared by the cards that show it (it is the same answer wherever it is read). */
interface OutsideEntry { result: OutsideCheckResult | null; running: boolean; checkedAt: number | null }
const EMPTY: OutsideEntry = { result: null, running: false, checkedAt: null };

interface OutsideStore {
  entries: Record<string, OutsideEntry>;
  /** Forget what was found: a new publication makes it stale. */
  reset: (siteUrl: string) => void;
  check: (siteUrl: string) => Promise<OutsideCheckResult>;
}

export const useOutsideStore = create<OutsideStore>((set, get) => ({
  entries: {},
  reset: (siteUrl) => set({ entries: { ...get().entries, [siteUrl]: EMPTY } }),
  check: async (siteUrl) => {
    set({ entries: { ...get().entries, [siteUrl]: { ...(get().entries[siteUrl] ?? EMPTY), running: true, result: null } } });
    const result = await runOutsideCheck(outsideCheckUrls(siteUrl, Date.now()));
    set({ entries: { ...get().entries, [siteUrl]: { result, running: false, checkedAt: Date.now() } } });
    return result;
  },
}));

export function useOutsideCheck(siteUrl: string | null): OutsideEntry & { check: () => Promise<OutsideCheckResult | null>; reset: () => void } {
  const entry = useOutsideStore((state) => (siteUrl ? state.entries[siteUrl] : undefined)) ?? EMPTY;
  return { ...entry, check: () => (siteUrl ? useOutsideStore.getState().check(siteUrl) : Promise.resolve(null)), reset: () => { if (siteUrl) useOutsideStore.getState().reset(siteUrl); } };
}
