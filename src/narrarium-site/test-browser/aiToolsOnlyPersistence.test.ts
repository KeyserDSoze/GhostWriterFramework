import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickAiRuntimeConfig, redactAiRuntimeConfig } from "narrarium-engine";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, saveLocalAccountSettings } from "@/account/accountLocalStore";
import { resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { mergeLocalDeviceSettings, projectSyncableSettings } from "@/account/dataProjection";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import {
  assertOfflineSettingsPatchAllowed,
  cacheOfflineSettings,
  cacheSettings,
  loadCachedSettings,
  projectSafeSettings,
  reconcileCachedSettings,
  SAFE_SETTINGS_KEYS,
} from "@/drive/settingsCache";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";

const account = "google:sub-owner";
const off = (): AppSettings => ({ ...DEFAULT_SETTINGS, aiToolsOnly: false });

describe("«Tools only» in the settings", () => {
  it("is on unless the author turned it off: the settings of an author who never touched it say nothing", () => {
    expect(DEFAULT_SETTINGS.aiToolsOnly).toBeUndefined();
    expect(redactAiRuntimeConfig(pickAiRuntimeConfig(DEFAULT_SETTINGS)).toolsOnly).toBe(true);
  });

  it.each([true, false])("keeps %s through the migration that every copy of the settings goes through", (value) => {
    expect(migrateSettings({ ...DEFAULT_SETTINGS, aiToolsOnly: value }).aiToolsOnly).toBe(value);
  });

  it.each([["the word false", "false"], ["a number", 0], ["nothing", null], ["a list", [false]]])("drops %s, as the engine ignores it: it never turns «Tools only» off by accident", (_name, value) => {
    const migrated = migrateSettings({ ...DEFAULT_SETTINGS, aiToolsOnly: value });
    expect(migrated.aiToolsOnly).toBeUndefined();
    expect(redactAiRuntimeConfig(pickAiRuntimeConfig(migrated)).toolsOnly).toBe(true);
  });
});

describe("«Tools only» in the offline cache", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("is one of the safe settings the cache keeps", () => {
    expect(SAFE_SETTINGS_KEYS).toContain("aiToolsOnly");
    expect(projectSafeSettings(off()).aiToolsOnly).toBe(false);
    expect(projectSafeSettings(DEFAULT_SETTINGS).aiToolsOnly).toBeUndefined();
  });

  it("is still off after the settings are cached and read back, for an author who is offline", () => {
    cacheSettings(account, off(), "revision-1");
    expect(loadCachedSettings(account)?.aiToolsOnly).toBe(false);
    cacheSettings(account, { ...DEFAULT_SETTINGS, aiToolsOnly: true }, "revision-2");
    expect(loadCachedSettings(account)?.aiToolsOnly).toBe(true);
  });

  it("is kept when the cloud's copy is reconciled with the cache", () => {
    cacheSettings(account, off(), "revision-1");
    const reconciled = reconcileCachedSettings(account, off(), "revision-1");
    expect(reconciled.settings.aiToolsOnly).toBe(false);
  });

  it("cannot be changed offline, like the rest of the AI routing: it decides which models answer, and the cloud has the last word", () => {
    expect(() => assertOfflineSettingsPatchAllowed(DEFAULT_SETTINGS, { aiToolsOnly: false })).toThrow(/aiToolsOnly cannot be changed offline/);
    cacheOfflineSettings(account, off());
    expect(loadCachedSettings(account)?.aiToolsOnly).toBe(false);
  });
});

describe("«Tools only» in the account's own data", () => {
  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("narrarium-local-account");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    localStorage.clear();
    resetLocalWorkspaceIdentityForTests();
  });
  afterEach(() => closeAccountLocalStoreForTests());

  it("goes into the data that every device of the account shares, and into what is read back from it", () => {
    expect(projectSyncableSettings(off()).aiToolsOnly).toBe(false);
    const wire = JSON.parse(JSON.stringify(projectSyncableSettings(off())));
    expect(migrateSettings(wire).aiToolsOnly).toBe(false);
  });

  it("is the remote device's choice when a device adopts the account's data", () => {
    const merged = mergeLocalDeviceSettings({ ...DEFAULT_SETTINGS, aiToolsOnly: true }, off());
    expect(merged.aiToolsOnly).toBe(false);
  });

  it("is kept in the local account store, and is a change to sync: turning it off is not 'nothing changed'", async () => {
    const first = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    expect(first.dirty).toBe(false);
    const manifest = await saveLocalAccountSettings(off());
    const restored = await loadLocalAccountSnapshot();
    expect(restored?.data.settings.aiToolsOnly).toBe(false);
    expect(restored?.dirty).toBe(true);
    expect(manifest.snapshotId).not.toBe(first.manifest.snapshotId);
  });
});

describe("«Tools only» in the configuration the personal server gets", () => {
  it.each([[false, false], [true, true], [undefined, true]])("says %s to the engine, and is %s once the server has stored it and read it back", (value, inForce) => {
    const settings = { ...DEFAULT_SETTINGS, ...(value === undefined ? {} : { aiToolsOnly: value }) };
    const picked = pickAiRuntimeConfig(settings);
    expect(picked.toolsOnly).toBe(value);
    const stored = JSON.parse(JSON.stringify(picked));
    expect(pickAiRuntimeConfig(stored).toolsOnly).toBe(value);
    expect(redactAiRuntimeConfig(pickAiRuntimeConfig(stored)).toolsOnly).toBe(inForce);
  });
});
