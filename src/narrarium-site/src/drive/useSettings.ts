import { useCallback } from "react";
import {
  initializeAccountLocalStore,
  loadLocalAccountSnapshot,
  saveLocalAccountSettings,
} from "@/account/accountLocalStore";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useCostsStore } from "@/costs/costsStore";
import { changedSettingsKeys, loadCachedSettingsForHydration } from "@/drive/settingsCache";
import { useSettingsStore, LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION } from "@/store/settingsStore";
import { accountIdentity } from "@/auth/accountIdentity";
import { useAuthStore } from "@/store/authStore";
import { loadCloudSettings, saveCloudSettings } from "@/drive/cloudSettingsClient";

const activeSettingsLoads = new Map<string, Promise<void>>();
let settingsLoadEpoch = 0;

export function invalidateSettingsLoadCoordinator(): void {
  settingsLoadEpoch += 1;
  activeSettingsLoads.clear();
}

function legacySeedSettings() {
  const current = useSettingsStore.getState().settings;
  try {
    const legacyIdentity = accountIdentity(useAuthStore.getState().user);
    return legacyIdentity ? loadCachedSettingsForHydration(legacyIdentity)?.settings ?? current : current;
  } catch {
    return current;
  }
}

/**
 * Settings are always loaded from and saved to the durable local account store.
 * Remote replicas are coordinated separately and may fail without rolling back
 * this local source of truth.
 */
export function useSettings() {
  const syncStatus = useSettingsStore((state) => state.syncStatus);
  const lastSynced = useSettingsStore((state) => state.lastSynced);

  const load = useCallback(async () => {
    const epoch = settingsLoadEpoch;
    const identity = localWorkspaceScope();
    const generation = useSettingsStore.getState().accountGeneration;
    const key = `${epoch}:${generation}:${identity}`;
    const active = activeSettingsLoads.get(key);
    if (active) return active;
    const operation = (async () => {
      const store = useSettingsStore.getState();
      const legacyIdentity = store.accountIdentity;
      const auth = useAuthStore.getState();
      if (legacyIdentity && !legacyIdentity.startsWith("workspace:") && auth.user && auth.accessToken) {
        const before = store.settings;
        store.setSyncStatus("loading");
        const result = await loadCloudSettings(auth.user.provider, auth.accessToken, store.driveFileId);
        if (useSettingsStore.getState().accountGeneration !== generation || useSettingsStore.getState().accountIdentity !== legacyIdentity) return;
        const changedKeys = changedSettingsKeys(before, useSettingsStore.getState().settings);
        store.setDriveFileId(result.fileId);
        store.setCloudRevision(result.revision);
        if (changedKeys.length) store.setOfflineConflict({ cloudSettings: result.settings, cloudRevision: result.revision, fileId: result.fileId, changedKeys });
        else store.replaceSettingsFromTrustedLoad(result.settings, { accountGeneration: generation, accountIdentity: legacyIdentity, source: { kind: "cloud", schemaVersion: 1 } });
        store.setCloudLoaded(true);
        store.setCloudReconciled(true);
        store.setSyncStatus("idle");
        return;
      }
      store.setSyncStatus("loading");
      try {
        const snapshot = await initializeAccountLocalStore({
          settings: legacySeedSettings(),
          costs: useCostsStore.getState().file,
          clipboard: useClipboardStore.getState().items,
          chats: [],
        });
        if (settingsLoadEpoch !== epoch || useSettingsStore.getState().accountGeneration !== generation) return;
        useSettingsStore.setState({ accountIdentity: identity });
        store.replaceSettingsFromTrustedLoad(snapshot.data.settings, {
          accountGeneration: generation,
          accountIdentity: identity,
          source: { kind: "local", schemaVersion: LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION },
        });
        useCostsStore.getState().hydrate(snapshot.data.costs);
        useClipboardStore.getState().hydrate(snapshot.data.clipboard);
        store.setCloudLoaded(true);
        store.setCloudReconciled(true);
        store.setOfflineConflict(null);
        store.setSyncStatus("idle");
      } catch (error) {
        console.error("Local account load error:", error);
        store.setCloudLoaded(false);
        store.setCloudReconciled(false);
        store.setSyncStatus("error");
        throw error;
      }
    })();
    activeSettingsLoads.set(key, operation);
    try { await operation; }
    finally { if (activeSettingsLoads.get(key) === operation) activeSettingsLoads.delete(key); }
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const store = useSettingsStore.getState();
    store.setSyncStatus("saving");
    try {
      const auth = useAuthStore.getState();
      if (store.accountIdentity && !store.accountIdentity.startsWith("workspace:") && auth.user && auth.accessToken) {
        const saved = await saveCloudSettings(auth.user.provider, auth.accessToken, store.settings, { fileId: store.driveFileId, revision: store.cloudRevision });
        store.setDriveFileId(saved.fileId);
        store.setCloudRevision(saved.revision);
      }
      if (!await loadLocalAccountSnapshot()) {
        await initializeAccountLocalStore({
          settings: store.settings,
          costs: useCostsStore.getState().file,
          clipboard: useClipboardStore.getState().items,
          chats: [],
        });
      }
      await saveLocalAccountSettings(useSettingsStore.getState().settings);
      store.setCloudLoaded(true);
      store.setCloudReconciled(true);
      store.setSyncStatus("idle");
      return true;
    } catch (error) {
      console.error("Local settings save error:", error);
      store.setSyncStatus("error");
      throw error;
    }
  }, []);

  const resolveOfflineConflict = useCallback(async (choice: "local" | "cloud") => {
    const state = useSettingsStore.getState();
    const conflict = state.offlineConflict;
    if (!conflict) return;
    const auth = useAuthStore.getState();
    const generation = state.accountGeneration;
    const identity = state.accountIdentity;
    if (choice === "local" && identity && !identity.startsWith("workspace:") && auth.user && auth.accessToken) {
      const saved = await saveCloudSettings(auth.user.provider, auth.accessToken, state.settings, { fileId: conflict.fileId, revision: conflict.cloudRevision });
      const current = useSettingsStore.getState();
      if (current.accountGeneration !== generation || current.accountIdentity !== identity) return;
      current.setDriveFileId(saved.fileId);
      current.setCloudRevision(saved.revision);
      current.setOfflineConflict(null);
      return;
    }
    if (choice === "cloud") {
      state.setSettings(conflict.cloudSettings);
      await saveLocalAccountSettings(conflict.cloudSettings);
    }
    state.setOfflineConflict(null);
  }, []);

  // Kept as a compatibility no-op. Signing out or disconnecting a provider must
  // never clear the authoritative local account data.
  const clearOfflineCache = useCallback(() => undefined, []);

  return { syncStatus, lastSynced, load, save, resolveOfflineConflict, clearOfflineCache };
}
