import { create } from "zustand";
import { persist } from "zustand/middleware";
import { AppSettings, DEFAULT_SETTINGS } from "@/types/settings";

type SettingsSyncStatus = "idle" | "loading" | "saving" | "error";

interface SettingsState {
  settings: AppSettings;
  syncStatus: SettingsSyncStatus;
  /** Drive file ID once the settings file has been found/created */
  driveFileId: string | null;
  lastSynced: string | null; // ISO-8601

  setSettings: (settings: AppSettings) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  setSyncStatus: (status: SettingsSyncStatus) => void;
  setDriveFileId: (id: string) => void;
  setLastSynced: (iso: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      syncStatus: "idle",
      driveFileId: null,
      lastSynced: null,

      setSettings: (settings) => set({ settings }),
      patchSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      setSyncStatus: (syncStatus) => set({ syncStatus }),
      setDriveFileId: (driveFileId) => set({ driveFileId }),
      setLastSynced: (lastSynced) => set({ lastSynced }),
    }),
    {
      name: "narrarium-settings-cache",
      // Keep credentials and AI connection strings in Drive/OneDrive, not localStorage.
      partialize: (state) => ({
        driveFileId: state.driveFileId,
        lastSynced: state.lastSynced,
      }),
    },
  ),
);
