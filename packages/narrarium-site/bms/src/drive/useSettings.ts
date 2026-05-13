import { useCallback } from "react";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import {
  findSettingsFile,
  loadSettings,
  createSettingsFile,
  saveSettings,
  TokenExpiredError,
} from "./driveClient";

/** Hook that provides load/save helpers for Google Drive settings. */
export function useSettings() {
  const { driveFileId, syncStatus, lastSynced } = useSettingsStore();
  const {
    setSettings,
    setSyncStatus,
    setDriveFileId,
    setLastSynced,
  } = useSettingsStore();

  const load = useCallback(async () => {
    // Read token at call time to avoid stale closure (e.g. called right after setAuth)
    const accessToken = useAuthStore.getState().accessToken;
    if (!accessToken) return;
    setSyncStatus("loading");
    try {
      // Re-read driveFileId at call time for the same reason
      const fileId0 = useSettingsStore.getState().driveFileId;
      let fileId = fileId0;
      if (!fileId) {
        fileId = await findSettingsFile(accessToken);
      }
      if (fileId) {
        setDriveFileId(fileId);
        const loaded = await loadSettings(accessToken, fileId);
        setSettings(loaded);
      } else {
        // First time – create the file with defaults
        const newId = await createSettingsFile(accessToken, DEFAULT_SETTINGS);
        setDriveFileId(newId);
        setSettings(DEFAULT_SETTINGS);
      }
      setLastSynced(new Date().toISOString());
      setSyncStatus("idle");
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        // Token was invalidated by driveClient; AuthGuard will re-auth on next render
        setSyncStatus("error");
        return;
      }
      console.error("Drive load error:", err);
      setSyncStatus("error");
    }
  }, [setDriveFileId, setLastSynced, setSettings, setSyncStatus]);

  const save = useCallback(async () => {
    // Read token at call time to avoid stale closure
    const accessToken = useAuthStore.getState().accessToken;
    if (!accessToken) return;
    setSyncStatus("saving");
    try {
      // Re-read driveFileId at call time
      const fileId0 = useSettingsStore.getState().driveFileId;
      let fileId = fileId0;
      if (!fileId) {
        fileId = await findSettingsFile(accessToken);
        if (!fileId) {
          fileId = await createSettingsFile(accessToken, DEFAULT_SETTINGS);
        }
        setDriveFileId(fileId);
      }
      // Read latest settings directly from store to avoid stale closure
      const currentSettings = useSettingsStore.getState().settings;
      await saveSettings(accessToken, fileId, currentSettings);
      setLastSynced(new Date().toISOString());
      setSyncStatus("idle");
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        // Token was invalidated; AuthGuard will detect it and trigger silent reauth
        setSyncStatus("error");
        return;
      }
      console.error("Drive save error:", err);
      setSyncStatus("error");
    }
  }, [setDriveFileId, setLastSynced, setSyncStatus]);

  return { syncStatus, lastSynced, load, save };
}
