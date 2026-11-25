import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type LocalAccountSnapshot } from "@/account/types";
import { accountContentHash, compareAccountManifests, initialAccountManifest, nextAccountManifest } from "@/account/vectorClock";
import { parseAccountRepositoryFiles, serializeAccountRepository } from "@/account/serialization";
import { mergeLocalDeviceSettings, projectSyncableSettings } from "@/account/dataProjection";
import { reconciledAccountData } from "@/account/accountSync";
import { assertOfflineSettingsPatchAllowed, cacheOfflineSettings, loadCachedSettingsForHydration, projectSafeSettings } from "@/drive/settingsCache";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { useSettingsStore, LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION } from "@/store/settingsStore";
import { bookBranchMemory, recordBranchUse } from "@/branches/memory";
import { chooseBranch } from "@/branches/memoryEdits";
import { setOpenBook } from "@/branches/openBook";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const T1 = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-21T10:00:00.000Z";
const T3 = "2026-11-22T10:00:00.000Z";
const book: BookEntry = { id: "book-1", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, addedAt: T1 };
const COSTS = emptyCostsFile();

function snapshot(settings: AppSettings, clock: Record<string, number> = { "device-a": 1 }): LocalAccountSnapshot {
  return { dirty: true, manifest: { ...initialAccountManifest("device-a"), vectorClock: clock }, data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings, costs: COSTS, clipboard: [], chats: [] } };
}

/** Device A works on `feature/ending`, which it created, after `main`. */
function deviceA(): AppSettings {
  const base: AppSettings = { ...DEFAULT_SETTINGS, books: [{ ...book, activeBranch: "main", activeBranchAt: T1 }], branchMemory: { "writer/novel": recordBranchUse(undefined, "main", T1, { current: true }) } };
  return { ...base, ...chooseBranch(base, base.books[0], "feature/ending", T2, { createdHere: true }) };
}

/** What another device gets of the account data of `settings`: the files written by one, read by the other. */
async function throughTheAccountData(settings: AppSettings): Promise<AppSettings> {
  const serialized = await serializeAccountRepository(snapshot(settings));
  return parseAccountRepositoryFiles(serialized.files).data.settings;
}

describe("the memory of the branches in the account data that syncs", () => {
  it("travels in settings.json with the schema version as it was, and comes back with the hash that was written", async () => {
    const serialized = await serializeAccountRepository(snapshot(deviceA()));
    expect(ACCOUNT_SYNC_SCHEMA_VERSION).toBe(1);
    expect(serialized.manifest.schemaVersion).toBe(1);
    const parsed = parseAccountRepositoryFiles(serialized.files);
    expect(parsed.data.settings.branchMemory).toEqual(deviceA().branchMemory);
    expect(await accountContentHash(parsed.data)).toBe(serialized.manifest.contentHash);
    // Branch names and dates: no token of any kind.
    expect(JSON.stringify(parsed.data.settings.branchMemory)).not.toMatch(/token|ghp_|github_pat/i);
  });

  it("is covered by the content hash, so a copy that differs only in it is another copy", async () => {
    const before = await serializeAccountRepository(snapshot(deviceA()));
    const settings = deviceA();
    const after = await serializeAccountRepository(snapshot({ ...settings, ...chooseBranch(settings, settings.books[0], "main", T3) }, { "device-b": 1 }));
    expect(before.manifest.contentHash).not.toBe(after.manifest.contentHash);
    expect(compareAccountManifests(before.manifest, after.manifest)).toBe("diverged");
  });

  it("leaves out which branch this device is on: that stays here, and comes back when another copy is adopted", async () => {
    const settings = { ...deviceA(), books: [{ ...deviceA().books[0], adoptedFrom: "main" }] };
    const portable = projectSyncableSettings(settings).books[0];
    expect(portable).not.toHaveProperty("activeBranch");
    expect(portable).not.toHaveProperty("activeBranchAt");
    expect(portable).not.toHaveProperty("adoptedFrom");
    const remote = await throughTheAccountData(settings);
    expect(remote.books[0]).not.toHaveProperty("activeBranchAt");
    const merged = mergeLocalDeviceSettings(settings, remote);
    expect(merged.books[0]).toMatchObject({ activeBranch: "feature/ending", activeBranchAt: T2, adoptedFrom: "main" });
    expect(merged.branchMemory).toEqual(settings.branchMemory);
  });

  it("is kept exactly by an older client that knows nothing of it, with its own edit, as a valid newer copy", async () => {
    const first = await serializeAccountRepository(snapshot({ ...deviceA(), branchMemory: { ...deviceA().branchMemory, "writer/future": { knownBranches: [{ name: "x", lastUsedAt: T1, futureFlag: 3 } as never], updatedAt: T1, futureField: { kept: true } } as never } }));
    const parsed = parseAccountRepositoryFiles(first.files);
    const edited = { ...parsed.data.settings, ui: { ...parsed.data.settings.ui, language: "it" as const } };
    const second = await serializeAccountRepository({ dirty: true, manifest: nextAccountManifest({ ...parsed.manifest, vectorClock: { "device-a": 1 } }, "device-old"), data: { ...parsed.data, settings: edited } });
    const back = parseAccountRepositoryFiles(second.files);
    expect(back.data.settings.ui.language).toBe("it");
    expect(back.data.settings.branchMemory).toEqual(parsed.data.settings.branchMemory);
    expect(await accountContentHash(back.data)).toBe(second.manifest.contentHash);
    expect(compareAccountManifests(second.manifest, first.manifest)).toBe("ahead");
  });

  it("survives loading the settings again, and the offline copy of the settings", () => {
    expect(migrateSettings(deviceA()).branchMemory).toEqual(deviceA().branchMemory);
    expect(migrateSettings(DEFAULT_SETTINGS).branchMemory).toBeUndefined();
    expect(projectSafeSettings(deviceA()).branchMemory).toEqual(deviceA().branchMemory);
  });

  it("changes offline too, with the branch of the book: choosing a branch needs no connection", () => {
    const settings = deviceA();
    const patch = chooseBranch(settings, settings.books[0], "draft/offline", T3, { createdHere: true });
    expect(() => assertOfflineSettingsPatchAllowed(settings, patch)).not.toThrow();
    expect(() => assertOfflineSettingsPatchAllowed(settings, { books: [{ ...settings.books[0], adoptedFrom: "main", activeBranch: "x", activeBranchAt: T3, localBranchName: "draft" }] })).not.toThrow();
  });
});

describe("two devices whose copies of the account data both changed", () => {
  const otherBook = { ...book, id: "book-2", repo: "other" };

  it("keep for each book the memory changed last, whichever copy the person chooses for the rest", () => {
    const local = { ...DEFAULT_SETTINGS, books: [book, otherBook], branchMemory: { "writer/novel": recordBranchUse(undefined, "local-newer", T3, { current: true }), "writer/other": recordBranchUse(undefined, "local-older", T1, { current: true }) } };
    const remote = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: "it" as const }, books: [book, otherBook], branchMemory: { "writer/novel": recordBranchUse(undefined, "remote-older", T1, { current: true }), "writer/other": recordBranchUse(undefined, "remote-newer", T2, { current: true }) } };
    const request = { local: snapshot(local), remotes: [{ backend: "google-drive" as const, manifest: snapshot(remote).manifest, data: snapshot(remote).data }] };
    for (const choice of ["local", "google-drive"] as const) {
      const data = reconciledAccountData(request as never, choice);
      expect(data.settings.ui.language).toBe(choice === "local" ? "en" : "it");
      expect(data.settings.branchMemory?.["writer/novel"]?.lastWorkingBranch).toBe("local-newer");
      expect(data.settings.branchMemory?.["writer/other"]?.lastWorkingBranch).toBe("remote-newer");
    }
  });
});

describe("another device opens the branch chosen last", () => {
  const identity = "workspace:device-b";
  beforeEach(() => { localStorage.clear(); setOpenBook(null); useSettingsStore.setState({ settings: DEFAULT_SETTINGS, accountIdentity: identity, accountGeneration: 0 }); });
  afterEach(() => setOpenBook(null));

  async function loadOnDeviceB(deviceBSettings: AppSettings): Promise<AppSettings> {
    const remote = await throughTheAccountData(deviceA());
    useSettingsStore.getState().replaceSettingsFromTrustedLoad(mergeLocalDeviceSettings(deviceBSettings, remote), { accountGeneration: 0, accountIdentity: identity, source: { kind: "local", schemaVersion: LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION } });
    return useSettingsStore.getState().settings;
  }

  it("takes it on loading, remembering the branch it had, when its own choice is older", async () => {
    const loaded = await loadOnDeviceB({ ...DEFAULT_SETTINGS, books: [{ ...book, activeBranch: "main", activeBranchAt: T1 }] });
    expect(loaded.books[0]).toMatchObject({ activeBranch: "feature/ending", activeBranchAt: T2, adoptedFrom: "main" });
    expect(bookBranchMemory(loaded, book)?.knownBranches.map((entry) => entry.name)).toEqual(["feature/ending", "main"]);
  });

  it("takes it on a new device, which had never opened the book", async () => {
    const loaded = await loadOnDeviceB({ ...DEFAULT_SETTINGS, books: [] });
    expect(loaded.books[0]).toMatchObject({ activeBranch: "feature/ending", activeBranchAt: T2, adoptedFrom: "" });
  });

  it("keeps its own choice when it is newer", async () => {
    const loaded = await loadOnDeviceB({ ...DEFAULT_SETTINGS, books: [{ ...book, activeBranch: "draft/b", activeBranchAt: T3 }] });
    expect(loaded.books[0]).toMatchObject({ activeBranch: "draft/b", activeBranchAt: T3 });
    expect(loaded.books[0].adoptedFrom).toBeUndefined();
  });

  it("does not move the book on the screen: it takes the branch the next time the book is opened", async () => {
    setOpenBook(book.id);
    const loaded = await loadOnDeviceB({ ...DEFAULT_SETTINGS, books: [{ ...book, activeBranch: "main", activeBranchAt: T1 }] });
    expect(loaded.books[0]).toMatchObject({ activeBranch: "main", activeBranchAt: T1 });
  });

  it("puts nothing of it in the offline cache that is not in the settings", () => {
    cacheOfflineSettings("workspace:device-b", deviceA());
    expect(loadCachedSettingsForHydration("workspace:device-b")?.settings.branchMemory).toEqual(deviceA().branchMemory);
  });
});
