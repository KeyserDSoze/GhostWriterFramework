import { create } from "zustand";

const DISMISSED_UPDATE_KEY = "narrarium-dismissed-update-version";

interface AppUpdateState {
  worker: ServiceWorker | null;
  version: string | null;
  promptOpen: boolean;
  /**
   * This page runs an older version than the site serves: a part of it could not be loaded (the files of the old version are gone), or a new
   * version took over the app in another tab. Only a reload brings the new one, which the author chooses.
   */
  stale: boolean;
  setAvailable: (worker: ServiceWorker, version: string) => void;
  setStale: () => void;
  openPrompt: () => void;
  dismissPrompt: () => void;
}

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  worker: null,
  version: null,
  promptOpen: false,
  stale: false,
  setAvailable: (worker, version) => {
    const current = get();
    if (current.worker === worker && current.version === version) return;
    set({
      worker,
      version,
      promptOpen: localStorage.getItem(DISMISSED_UPDATE_KEY) !== version,
    });
  },
  // Said once: what could not be loaded asks the author again only through the page that failed.
  setStale: () => { if (!get().stale) set({ stale: true, promptOpen: true }); },
  openPrompt: () => set({ promptOpen: true }),
  dismissPrompt: () => {
    const version = get().version;
    if (version && !get().stale) localStorage.setItem(DISMISSED_UPDATE_KEY, version);
    set({ promptOpen: false });
  },
}));
