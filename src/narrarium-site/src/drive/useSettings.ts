import { useCallback } from "react";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { loadCloudSettings, saveCloudSettings, TokenExpiredError } from "./cloudSettingsClient";
import { accountIdentity, isAccountIdentityCurrent } from "@/auth/accountIdentity";
import { useToast } from "@/components/ui/use-toast";
import { useTranslation } from "react-i18next";
import { cacheOfflineSettings, cacheSettings, clearSettingsCache, loadCachedSettingsForHydration, reconcileCachedSettings } from "@/drive/settingsCache";
import { CLOUD_SETTINGS_SOURCE_SCHEMA_VERSION } from "@/store/settingsStore";

/** Hook that provides load/save helpers for Google Drive or OneDrive settings. */
export function useSettings() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const { syncStatus, lastSynced } = useSettingsStore();
  const {
    replaceSettingsFromTrustedLoad,
    setSyncStatus,
    setDriveFileId,
    setCloudRevision,
    setLastSynced,
    setCloudLoaded,
    setOfflineConflict,
  } = useSettingsStore();

  const load = useCallback(async () => {
    // Read token at call time to avoid stale closure (e.g. called right after setAuth)
    const { accessToken, user, invalidateToken } = useAuthStore.getState();
    if (!user) {
      setCloudLoaded(false);
      return;
    }
    const expectedIdentity = accountIdentity(user);
    if (!expectedIdentity) return;
    const accountGeneration = useSettingsStore.getState().accountGeneration;
    const ownsLoad = () => isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)
      && useSettingsStore.getState().accountGeneration === accountGeneration;
    if (navigator.onLine === false) {
      const cached = loadCachedSettingsForHydration(expectedIdentity);
      if (cached) replaceSettingsFromTrustedLoad(cached.settings, { accountGeneration, accountIdentity: cached.accountIdentity, source: cached.source });
      else setCloudLoaded(false);
      setSyncStatus(cached ? "idle" : "error");
      return;
    }
    if (!accessToken) {
      setCloudLoaded(false);
      return;
    }
    setSyncStatus("loading");
    try {
      const result = await loadCloudSettings(user.provider, accessToken);
      if (!ownsLoad()) return;
      const reconciliation = reconcileCachedSettings(expectedIdentity, result.settings, result.revision);
      setDriveFileId(result.fileId);
      setCloudRevision(result.revision);
      replaceSettingsFromTrustedLoad(reconciliation.settings, { accountGeneration, accountIdentity: expectedIdentity, source: { kind: "cloud", schemaVersion: CLOUD_SETTINGS_SOURCE_SCHEMA_VERSION } });
      if (reconciliation.kind === "conflict") {
        setOfflineConflict({ cloudSettings: result.settings, cloudRevision: result.revision, fileId: result.fileId, changedKeys: reconciliation.changedKeys });
      } else if (reconciliation.kind === "merged") {
        const saved = await saveCloudSettings(user.provider, accessToken, reconciliation.settings, { fileId: result.fileId, revision: result.revision });
        if (!ownsLoad()) return;
        setDriveFileId(saved.fileId);
        setCloudRevision(saved.revision);
        setOfflineConflict(null);
        cacheSettings(expectedIdentity, reconciliation.settings, saved.revision);
      } else {
        setOfflineConflict(null);
        cacheSettings(expectedIdentity, result.settings, result.revision);
      }
      if (result.diagnostics.length) toast({ title: t("settingsRepair.title"), description: result.diagnostics.join("\n"), variant: "destructive" });
      setLastSynced(new Date().toISOString());
      setCloudLoaded(true);
      setSyncStatus("idle");
    } catch (err) {
      if (!ownsLoad()) return;
      if (err instanceof TokenExpiredError) {
        const current = useAuthStore.getState();
        if (current.accessToken === accessToken && current.user?.provider === user.provider) invalidateToken();
        setSyncStatus("error");
        return;
      }
      console.error("Drive load error:", err);
      setSyncStatus("error");
    }
  }, [replaceSettingsFromTrustedLoad, setCloudLoaded, setCloudRevision, setDriveFileId, setLastSynced, setOfflineConflict, setSyncStatus, t, toast]);

  const save = useCallback(async (): Promise<boolean> => {
    // Read token at call time to avoid stale closure
    const { accessToken, user, invalidateToken } = useAuthStore.getState();
    if (!user) throw new Error("Cannot save settings without an authenticated account.");
    const expectedIdentity = accountIdentity(user);
    if (!expectedIdentity) throw new Error("Cannot save settings without an immutable account identity.");
    const ownsSave = () => isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user);
    if (navigator.onLine === false) {
      cacheOfflineSettings(expectedIdentity, useSettingsStore.getState().settings);
      setCloudLoaded(true);
      setSyncStatus("error");
      throw new Error(t("settings.offlineSaveBlocked"));
    }
    if (!accessToken) throw new Error("Cannot save settings without an access token.");
    setSyncStatus("saving");
    try {
      // Read latest settings directly from store to avoid stale closure
      const currentSettings = useSettingsStore.getState().settings;
      const { driveFileId, cloudRevision } = useSettingsStore.getState();
      const saved = await saveCloudSettings(user.provider, accessToken, currentSettings, { fileId: driveFileId, revision: cloudRevision });
      const currentAuth = useAuthStore.getState();
      if (!ownsSave() || currentAuth.accessToken !== accessToken) throw new Error("The authenticated account or token changed while settings were saving.");
      setDriveFileId(saved.fileId);
      setCloudRevision(saved.revision);
      cacheSettings(expectedIdentity, currentSettings, saved.revision);
      setOfflineConflict(null);
      setLastSynced(new Date().toISOString());
      setSyncStatus("idle");
      return true;
    } catch (err) {
      if (!ownsSave() || useAuthStore.getState().accessToken !== accessToken) {
        setSyncStatus("error");
        throw err;
      }
      if (err instanceof TokenExpiredError) {
        const current = useAuthStore.getState();
        if (current.accessToken === accessToken && current.user?.provider === user.provider) invalidateToken();
        setSyncStatus("error");
        throw err;
      }
      console.error("Drive save error:", err);
      setSyncStatus("error");
      toast({ title: t("settings.syncError"), description: String(err), variant: "destructive" });
      throw err;
    }
  }, [setCloudLoaded, setCloudRevision, setDriveFileId, setLastSynced, setOfflineConflict, setSyncStatus, t, toast]);

  const resolveOfflineConflict = useCallback(async (choice: "local" | "cloud") => {
    const { accessToken, user } = useAuthStore.getState();
    const state = useSettingsStore.getState();
    const conflict = state.offlineConflict;
    const identity = accountIdentity(user);
    if (!accessToken || !user || !identity || !conflict || navigator.onLine === false) return;
    const accountGeneration = state.accountGeneration;
    if (choice === "cloud") {
      replaceSettingsFromTrustedLoad(conflict.cloudSettings, { accountGeneration, accountIdentity: identity, source: { kind: "cloud", schemaVersion: CLOUD_SETTINGS_SOURCE_SCHEMA_VERSION } });
      setDriveFileId(conflict.fileId);
      setCloudRevision(conflict.cloudRevision);
      setOfflineConflict(null);
      cacheSettings(identity, conflict.cloudSettings, conflict.cloudRevision);
      return;
    }
    setSyncStatus("saving");
    try {
      const localSettings = state.settings;
      const saved = await saveCloudSettings(user.provider, accessToken, localSettings, { fileId: conflict.fileId, revision: conflict.cloudRevision });
      setDriveFileId(saved.fileId);
      setCloudRevision(saved.revision);
      setOfflineConflict(null);
      setLastSynced(new Date().toISOString());
      cacheSettings(identity, localSettings, saved.revision);
      setSyncStatus("idle");
    } catch (error) {
      setSyncStatus("error");
      throw error;
    }
  }, [replaceSettingsFromTrustedLoad, setCloudRevision, setDriveFileId, setLastSynced, setOfflineConflict, setSyncStatus]);

  const clearOfflineCache = useCallback(() => {
    const identity = accountIdentity(useAuthStore.getState().user);
    if (identity) clearSettingsCache(identity);
  }, []);

  return { syncStatus, lastSynced, load, save, resolveOfflineConflict, clearOfflineCache };
}
