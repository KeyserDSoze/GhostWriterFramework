import { create } from "zustand";
import { persist } from "zustand/middleware";
import { AppSettings, DEFAULT_SETTINGS } from "@/types/settings";

type SettingsSyncStatus = "idle" | "loading" | "saving" | "error";

interface SettingsState {
  settings: AppSettings;
  syncStatus: SettingsSyncStatus;
  driveFileId: string | null;
  lastSynced: string | null;
  cloudLoaded: boolean;

  setSettings: (settings: AppSettings) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  setSyncStatus: (status: SettingsSyncStatus) => void;
  setDriveFileId: (id: string) => void;
  setLastSynced: (iso: string) => void;
  setCloudLoaded: (loaded: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      syncStatus: "idle",
      driveFileId: null,
      lastSynced: null,
      cloudLoaded: false,

      setSettings: (settings) => set({ settings, cloudLoaded: true }),
      patchSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      setSyncStatus: (syncStatus) => set({ syncStatus }),
      setDriveFileId: (driveFileId) => set({ driveFileId }),
      setLastSynced: (lastSynced) => set({ lastSynced }),
      setCloudLoaded: (cloudLoaded) => set({ cloudLoaded }),
    }),
    {
      name: "narrarium-settings-cache",
      partialize: (state) => ({
        driveFileId: state.driveFileId,
        lastSynced: state.lastSynced,
      }),
    },
  ),
);
