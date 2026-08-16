import { useCallback } from "react";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { loadCloudSettings, saveCloudSettings, TokenExpiredError } from "./cloudSettingsClient";
import { accountIdentity, isAccountIdentityCurrent } from "@/auth/accountIdentity";
import { useToast } from "@/components/ui/use-toast";
import { useTranslation } from "react-i18next";

/** Hook that provides load/save helpers for Google Drive or OneDrive settings. */
export function useSettings() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const { syncStatus, lastSynced } = useSettingsStore();
  const {
    setSettings,
    setSyncStatus,
    setDriveFileId,
    setLastSynced,
    setCloudLoaded,
  } = useSettingsStore();

  const load = useCallback(async () => {
    // Read token at call time to avoid stale closure (e.g. called right after setAuth)
    const { accessToken, user, invalidateToken } = useAuthStore.getState();
    if (!accessToken || !user) {
      setCloudLoaded(false);
      return;
    }
    const expectedIdentity = accountIdentity(user);
    const ownsLoad = () => isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user);
    setSyncStatus("loading");
    try {
      const result = await loadCloudSettings(user.provider, accessToken);
      if (!ownsLoad()) return;
      setDriveFileId(result.fileId);
      setSettings(result.settings);
      if (result.diagnostics.length) toast({ title: t("settingsRepair.title"), description: result.diagnostics.join("\n"), variant: "destructive" });
      setLastSynced(new Date().toISOString());
      setCloudLoaded(true);
      setSyncStatus("idle");
    } catch (err) {
      if (!ownsLoad()) return;
      if (err instanceof TokenExpiredError) {
        invalidateToken();
        setSyncStatus("error");
        return;
      }
      console.error("Drive load error:", err);
      setSyncStatus("error");
    }
  }, [setCloudLoaded, setDriveFileId, setLastSynced, setSettings, setSyncStatus, t, toast]);

  const save = useCallback(async () => {
    // Read token at call time to avoid stale closure
    const { accessToken, user, invalidateToken } = useAuthStore.getState();
    if (!accessToken || !user) return;
    const expectedIdentity = accountIdentity(user);
    const ownsSave = () => isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user);
    setSyncStatus("saving");
    try {
      // Read latest settings directly from store to avoid stale closure
      const currentSettings = useSettingsStore.getState().settings;
      const fileId = await saveCloudSettings(user.provider, accessToken, currentSettings);
      if (!ownsSave()) return;
      setDriveFileId(fileId);
      setLastSynced(new Date().toISOString());
      setSyncStatus("idle");
    } catch (err) {
      if (!ownsSave()) return;
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
