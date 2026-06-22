import { useCallback } from "react";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { loadCloudSettings, saveCloudSettings, TokenExpiredError } from "./cloudSettingsClient";

/** Hook that provides load/save helpers for Google Drive or OneDrive settings. */
export function useSettings() {
  const { syncStatus, lastSynced } = useSettingsStore();
  const {
    setSettings,
    setSyncStatus,
    setDriveFileId,
    setLastSynced,
  } = useSettingsStore();

  const load = useCallback(async () => {
    // Read token at call time to avoid stale closure (e.g. called right after setAuth)
    const { accessToken, user, invalidateToken } = useAuthStore.getState();
    if (!accessToken || !user) return;
    setSyncStatus("loading");
    try {
      const result = await loadCloudSettings(user.provider, accessToken);
      setDriveFileId(result.fileId);
      setSettings(result.settings);
      setLastSynced(new Date().toISOString());
      setSyncStatus("idle");
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        invalidateToken();
        setSyncStatus("error");
        return;
      }
      console.error("Drive load error:", err);
      setSyncStatus("error");
    }
  }, [setDriveFileId, setLastSynced, setSettings, setSyncStatus]);

  const save = useCallback(async () => {
    // Read token at call time to avoid stale closure
    const { accessToken, user, invalidateToken } = useAuthStore.getState();
    if (!accessToken || !user) return;
    setSyncStatus("saving");
    try {
      // Read latest settings directly from store to avoid stale closure
      const currentSettings = useSettingsStore.getState().settings;
      const fileId = await saveCloudSettings(user.provider, accessToken, currentSettings);
      setDriveFileId(fileId);
      setLastSynced(new Date().toISOString());
      setSyncStatus("idle");
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        invalidateToken();
        setSyncStatus("error");
        return;
      }
      console.error("Drive save error:", err);
      setSyncStatus("error");
    }
  }, [setDriveFileId, setLastSynced, setSyncStatus]);

  return { syncStatus, lastSynced, load, save };
}
