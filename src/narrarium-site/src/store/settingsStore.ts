import { create } from "zustand";
import { persist } from "zustand/middleware";
import { AppSettings, DEFAULT_SETTINGS } from "@/types/settings";
import type { SafeSettingsKey } from "@/drive/settingsCache";
import { SETTINGS_CACHE_SCHEMA_VERSION, assertOfflineSettingsReplacementAllowed } from "@/drive/settingsCache";

export const CLOUD_SETTINGS_SOURCE_SCHEMA_VERSION = 1;

type TrustedSettingsLoad = {
  accountGeneration: number;
  accountIdentity: string;
  source:
    | { kind: "cloud"; schemaVersion: typeof CLOUD_SETTINGS_SOURCE_SCHEMA_VERSION }
    | { kind: "offline-cache"; schemaVersion: typeof SETTINGS_CACHE_SCHEMA_VERSION };
};

type SettingsSyncStatus = "idle" | "loading" | "saving" | "error";

interface SettingsState {
  settings: AppSettings;
  syncStatus: SettingsSyncStatus;
  driveFileId: string | null;
  cloudRevision: string | null;
  lastSynced: string | null;
  cloudLoaded: boolean;
  accountGeneration: number;
  accountIdentity: string | null;
  offlineConflict: { cloudSettings: AppSettings; cloudRevision: string; fileId: string; changedKeys: SafeSettingsKey[] } | null;

  setSettings: (settings: AppSettings) => void;
  replaceSettingsFromTrustedLoad: (settings: AppSettings, load: TrustedSettingsLoad) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  setSyncStatus: (status: SettingsSyncStatus) => void;
  setDriveFileId: (id: string) => void;
  setCloudRevision: (revision: string | null) => void;
  setLastSynced: (iso: string) => void;
  setCloudLoaded: (loaded: boolean) => void;
  setOfflineConflict: (conflict: SettingsState["offlineConflict"]) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      syncStatus: "idle",
      driveFileId: null,
      cloudRevision: null,
      lastSynced: null,
      cloudLoaded: false,
      accountGeneration: 0,
      accountIdentity: null,
      offlineConflict: null,

      setSettings: (settings) => set((state) => {
        if (typeof navigator !== "undefined" && navigator.onLine === false) assertOfflineSettingsReplacementAllowed(state.settings, settings);
        return { settings, cloudLoaded: true };
      }),
      replaceSettingsFromTrustedLoad: (settings, load) => set((state) => {
        const validSource = load.source.kind === "cloud"
          ? load.source.schemaVersion === CLOUD_SETTINGS_SOURCE_SCHEMA_VERSION
          : load.source.kind === "offline-cache" && load.source.schemaVersion === SETTINGS_CACHE_SCHEMA_VERSION;
        if (!validSource) throw new Error("Trusted settings load source schema is invalid.");
        if (state.accountGeneration !== load.accountGeneration || state.accountIdentity !== load.accountIdentity) {
          throw new Error("Trusted settings load is stale for the current account.");
        }
        return { settings, cloudLoaded: true };
      }),
      patchSettings: (patch) => set((s) => {
        const settings = { ...s.settings, ...patch };
        if (typeof navigator !== "undefined" && navigator.onLine === false) assertOfflineSettingsReplacementAllowed(s.settings, settings);
        return { settings };
      }),
      setSyncStatus: (syncStatus) => set({ syncStatus }),
      setDriveFileId: (driveFileId) => set({ driveFileId }),
      setCloudRevision: (cloudRevision) => set({ cloudRevision }),
      setLastSynced: (lastSynced) => set({ lastSynced }),
      setCloudLoaded: (cloudLoaded) => set({ cloudLoaded }),
      setOfflineConflict: (offlineConflict) => set({ offlineConflict }),
    }),
    {
      name: "narrarium-settings-cache",
      partialize: (state) => ({
        driveFileId: state.driveFileId,
        cloudRevision: state.cloudRevision,
        lastSynced: state.lastSynced,
      }),
    },
  ),
);
