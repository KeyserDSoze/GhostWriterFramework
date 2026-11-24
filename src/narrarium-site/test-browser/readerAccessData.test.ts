import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type LocalAccountSnapshot } from "@/account/types";
import { accountContentHash, compareAccountManifests, initialAccountManifest, nextAccountManifest } from "@/account/vectorClock";
import { parseAccountRepositoryFiles, serializeAccountRepository } from "@/account/serialization";
import { mergeLocalDeviceSettings, projectSyncableSettings } from "@/account/dataProjection";
import { assertOfflineSettingsPatchAllowed, cacheOfflineSettings, cacheSettings, projectSafeSettings } from "@/drive/settingsCache";
import { browserCallsSecrets } from "@/autopilot/calls/wire";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings, type ReaderPasswordRecord } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";
import { pickAiRuntimeConfig } from "narrarium-engine";

const PASSWORD_A = "Alpha-PASSWORD-canary-7731";
const PASSWORD_B = "Bravo-PASSWORD-canary-9902";
const record = (number: number, value: string, patch: Partial<ReaderPasswordRecord> = {}): ReaderPasswordRecord => ({ id: `r${number}`, label: `Reader ${number}`, value, createdAt: "2026-11-25T10:00:00.000Z", secretName: `READER_PASSWORD_00${number}`, status: "active", ...patch });
const withPasswords = (settings: AppSettings = DEFAULT_SETTINGS): AppSettings => ({ ...settings, readerAccess: { "me/book": [record(1, PASSWORD_A), record(2, PASSWORD_B, { status: "pending" })] } });

const COSTS = emptyCostsFile();

function snapshot(settings: AppSettings, clock: Record<string, number> = { "device-a": 1 }): LocalAccountSnapshot {
  return { dirty: true, manifest: { ...initialAccountManifest("device-a"), vectorClock: clock }, data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings, costs: COSTS, clipboard: [], chats: [] } };
}

describe("the reader passwords in the account data that syncs", () => {
  it("travel in settings.json, with the schema version as it was: no client is made to refuse the data", async () => {
    const serialized = await serializeAccountRepository(snapshot(withPasswords()));
    expect(ACCOUNT_SYNC_SCHEMA_VERSION).toBe(1);
    expect(serialized.manifest.schemaVersion).toBe(1);
    const settingsFile = JSON.parse(serialized.files.get("settings.json")!) as AppSettings;
    expect(settingsFile.readerAccess?.["me/book"]).toHaveLength(2);
    expect(settingsFile.readerAccess?.["me/book"]?.[0]).toMatchObject({ label: "Reader 1", value: PASSWORD_A, secretName: "READER_PASSWORD_001", status: "active" });
    // Nowhere else in the repository's files.
    for (const [path, content] of serialized.files) if (path !== "settings.json") expect(content).not.toContain("canary");
  });

  it("come back from the files the same, with the content hash that was written", async () => {
    const serialized = await serializeAccountRepository(snapshot(withPasswords()));
    const parsed = parseAccountRepositoryFiles(serialized.files);
    expect(parsed.data.settings.readerAccess).toEqual(withPasswords().readerAccess);
    expect(await accountContentHash(parsed.data)).toBe(serialized.manifest.contentHash);
  });

  it("are covered by the content hash, so a copy that differs only in them is a different copy", async () => {
    const without = await serializeAccountRepository(snapshot(DEFAULT_SETTINGS));
    const withThem = await serializeAccountRepository(snapshot(withPasswords()));
    const changed = await serializeAccountRepository(snapshot({ ...withPasswords(), readerAccess: { "me/book": [record(1, PASSWORD_B)] } }));
    expect(new Set([without.manifest.contentHash, withThem.manifest.contentHash, changed.manifest.contentHash]).size).toBe(3);
    expect(compareAccountManifests({ ...withThem.manifest }, { ...changed.manifest })).toBe("diverged");
  });

  it("are the same on two devices that wrote the same data, whatever order the keys came in", async () => {
    const reordered = { ...DEFAULT_SETTINGS, readerAccess: { "me/book": [{ status: "active", secretName: "READER_PASSWORD_001", createdAt: "2026-11-25T10:00:00.000Z", value: PASSWORD_A, label: "Reader 1", id: "r1" }, record(2, PASSWORD_B, { status: "pending" })] as ReaderPasswordRecord[] } };
    expect((await serializeAccountRepository(snapshot(withPasswords()))).manifest.contentHash).toBe((await serializeAccountRepository(snapshot(reordered))).manifest.contentHash);
  });

  describe("an older client, which knows nothing of the field, neither loses nor mangles it", () => {
    /** What an older client does with data it reads: parse it with its own code, edit what it knows (here: the UI language) and write it back. */
    async function olderClientEdits(files: ReadonlyMap<string, string>, vectorClock: Record<string, number>) {
      const parsed = parseAccountRepositoryFiles(files);
      const edited = { ...parsed.data.settings, ui: { ...parsed.data.settings.ui, language: "it" as const } };
      return serializeAccountRepository({ dirty: true, manifest: nextAccountManifest({ ...parsed.manifest, vectorClock }, "device-old"), data: { ...parsed.data, settings: edited } });
    }

    it("keeps every record exactly, and the fields it does not know of", async () => {
      const future = { ...record(3, "future-value-xxxx"), notes: { colour: "red" }, version: 7 };
      const settings: AppSettings = { ...DEFAULT_SETTINGS, readerAccess: { "me/book": [record(1, PASSWORD_A), future as ReaderPasswordRecord], "me/other": [record(2, PASSWORD_B)] }, futureSetting: { kept: true } } as AppSettings;
      const first = await serializeAccountRepository(snapshot(settings));
      const second = await olderClientEdits(first.files, { "device-a": 1 });
      const back = parseAccountRepositoryFiles(second.files).data.settings;
      expect(back.ui.language).toBe("it");
      expect(back.readerAccess).toEqual(settings.readerAccess);
      expect((back as unknown as { futureSetting: unknown }).futureSetting).toEqual({ kept: true });
      expect(JSON.parse(second.files.get("settings.json")!).readerAccess).toEqual(JSON.parse(first.files.get("settings.json")!).readerAccess);
    });

    it("is still a valid copy for the newer client: the hash matches and the clock moves on", async () => {
      const first = await serializeAccountRepository(snapshot(withPasswords()));
      const second = await olderClientEdits(first.files, { "device-a": 1 });
      const parsed = parseAccountRepositoryFiles(second.files);
      expect(await accountContentHash(parsed.data)).toBe(second.manifest.contentHash);
      expect(compareAccountManifests(second.manifest, first.manifest)).toBe("ahead");
    });
  });

  it("are adopted with the rest of the settings from another copy, and kept when the device-only fields are put back", async () => {
    const remote = projectSyncableSettings(withPasswords());
    expect(remote.readerAccess).toEqual(withPasswords().readerAccess);
    const merged = mergeLocalDeviceSettings({ ...DEFAULT_SETTINGS, readerAccess: undefined }, withPasswords());
    expect(merged.readerAccess).toEqual(withPasswords().readerAccess);
  });

  it("survive loading settings again (migration neither drops nor rewrites them)", () => {
    expect(migrateSettings(withPasswords()).readerAccess).toEqual(withPasswords().readerAccess);
    expect(migrateSettings(DEFAULT_SETTINGS).readerAccess).toBeUndefined();
  });
});

describe("the reader passwords stay out of everything that is not the account data", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); useSettingsStore.setState({ settings: DEFAULT_SETTINGS }); });

  it("are in no part of the offline settings cache or the session credentials", () => {
    const settings = withPasswords();
    cacheSettings("workspace:test", settings, "rev-1");
    cacheOfflineSettings("workspace:test", settings);
    for (const storage of [JSON.stringify(localStorage), JSON.stringify(sessionStorage)]) {
      expect(storage).not.toContain("canary");
      expect(storage).not.toContain("readerAccess");
    }
    expect(JSON.stringify(projectSafeSettings(settings))).not.toContain("canary");
  });

  it("are refused as an offline edit: they change only with GitHub in reach", () => {
    expect(() => assertOfflineSettingsPatchAllowed(DEFAULT_SETTINGS, { readerAccess: withPasswords().readerAccess })).toThrow();
  });

  it("are hidden from every record of an AI call, and are in no configuration sent to an AI or a server", () => {
    useSettingsStore.setState({ settings: withPasswords() });
    expect(browserCallsSecrets()).toEqual(expect.arrayContaining([PASSWORD_A, PASSWORD_B]));
    const aiConfig = JSON.stringify(pickAiRuntimeConfig(withPasswords()));
    expect(aiConfig).not.toContain("canary");
    expect(aiConfig).not.toContain("readerAccess");
  });
});
