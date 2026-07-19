import { create } from "zustand";

const DISMISSED_UPDATE_KEY = "narrarium-dismissed-update-version";

interface AppUpdateState {
  worker: ServiceWorker | null;
  version: string | null;
  promptOpen: boolean;
  setAvailable: (worker: ServiceWorker, version: string) => void;
  dismissPrompt: () => void;
}

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  worker: null,
  version: null,
  promptOpen: false,
  setAvailable: (worker, version) => {
    const current = get();
    if (current.worker === worker && current.version === version) return;
    set({
      worker,
      version,
      promptOpen: localStorage.getItem(DISMISSED_UPDATE_KEY) !== version,
    });
  },
  dismissPrompt: () => {
    const version = get().version;
    if (version) localStorage.setItem(DISMISSED_UPDATE_KEY, version);
    set({ promptOpen: false });
  },
}));
