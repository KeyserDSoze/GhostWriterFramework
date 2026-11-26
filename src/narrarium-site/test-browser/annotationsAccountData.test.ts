import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type LocalAccountSnapshot } from "@/account/types";
import { accountContentHash, compareAccountManifests, initialAccountManifest, nextAccountManifest } from "@/account/vectorClock";
import { parseAccountRepositoryFiles, serializeAccountRepository } from "@/account/serialization";
import { mergeLocalDeviceSettings, projectSyncableSettings } from "@/account/dataProjection";
import { reconciledAccountData } from "@/account/accountSync";
import { assertOfflineSettingsPatchAllowed, assertOfflineSettingsReplacementAllowed, cacheOfflineSettings, loadCachedSettings, projectSafeSettings } from "@/drive/settingsCache";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import type { AnnotationAccountSettings } from "@/annotations/accountTags";
import type { AnnotationTagDefinition } from "@/annotations/model";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const T1 = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-21T10:00:00.000Z";
const T3 = "2026-11-22T10:00:00.000Z";
const COSTS = emptyCostsFile();

function tag(id: string, patch: Partial<AnnotationTagDefinition> = {}): AnnotationTagDefinition {
  return { id, name: `Tag ${id}`, description: "Look at the pace.", mark: { underline: "dotted", color: "teal", icon: "clock" }, createdAt: T1, updatedAt: T1, ...patch };
}

const ANNOTATIONS: AnnotationAccountSettings = { tags: [tag("doubt-1a2b"), tag("pace-3c4d", { deletedAt: T2, updatedAt: T2 })], publicNoticeSeen: ["writer/novel"] };
const withAnnotations = (settings: AppSettings = DEFAULT_SETTINGS, annotations: AnnotationAccountSettings = ANNOTATIONS): AppSettings => ({
  ...settings,
  annotations,
  reader: { ...settings.reader, showAnnotations: false },
});

function snapshot(settings: AppSettings, clock: Record<string, number> = { "device-a": 1 }): LocalAccountSnapshot {
  return { dirty: true, manifest: { ...initialAccountManifest("device-a"), vectorClock: clock }, data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings, costs: COSTS, clipboard: [], chats: [] } };
}

describe("the tags of the annotations in the account data that syncs", () => {
  it("travel in settings.json with the schema version as it was, and come back with the hash that was written", async () => {
    const serialized = await serializeAccountRepository(snapshot(withAnnotations()));
    expect(ACCOUNT_SYNC_SCHEMA_VERSION).toBe(1);
    expect(serialized.manifest.schemaVersion).toBe(1);
    const file = JSON.parse(serialized.files.get("settings.json")!) as AppSettings;
    expect(file.annotations).toEqual(ANNOTATIONS);
    expect(file.reader.showAnnotations).toBe(false);
    const parsed = parseAccountRepositoryFiles(serialized.files);
    expect(parsed.data.settings.annotations).toEqual(ANNOTATIONS);
    expect(await accountContentHash(parsed.data)).toBe(serialized.manifest.contentHash);
  });

  it("are covered by the content hash, so a copy that differs only in them is another copy", async () => {
    const before = await serializeAccountRepository(snapshot(withAnnotations()));
    const after = await serializeAccountRepository(snapshot(withAnnotations(DEFAULT_SETTINGS, { ...ANNOTATIONS, tags: [tag("doubt-1a2b", { name: "Doubts", updatedAt: T3 })] }), { "device-b": 1 }));
    expect(before.manifest.contentHash).not.toBe(after.manifest.contentHash);
    expect(compareAccountManifests(before.manifest, after.manifest)).toBe("diverged");
  });

  describe("an older client, which knows nothing of them, neither loses nor mangles them", () => {
    /** What an older client does with data it reads: parse it with its own code, edit what it knows (the language) and write it back. */
    async function olderClientEdits(files: ReadonlyMap<string, string>) {
      const parsed = parseAccountRepositoryFiles(files);
      const edited = { ...parsed.data.settings, ui: { ...parsed.data.settings.ui, language: "it" as const } };
      return serializeAccountRepository({ dirty: true, manifest: nextAccountManifest({ ...parsed.manifest, vectorClock: { "device-a": 1 } }, "device-old"), data: { ...parsed.data, settings: edited } });
    }

    it("keeps every tag exactly, tombstones and fields of a newer app included, and the setting of the reader", async () => {
      const future = { ...tag("future-5e6f"), mark: { underline: "zigzag", color: "plum", icon: "lightning" }, instructions: { model: "fast" } } as unknown as AnnotationTagDefinition;
      const annotations = { ...ANNOTATIONS, tags: [...ANNOTATIONS.tags!, future], futureField: { kept: true } } as AnnotationAccountSettings;
      const first = await serializeAccountRepository(snapshot(withAnnotations(DEFAULT_SETTINGS, annotations)));
      const second = await olderClientEdits(first.files);
      const back = parseAccountRepositoryFiles(second.files).data.settings;
      expect(back.ui.language).toBe("it");
      expect(back.annotations).toEqual(annotations);
      expect(back.reader.showAnnotations).toBe(false);
      expect(JSON.parse(second.files.get("settings.json")!).annotations).toEqual(JSON.parse(first.files.get("settings.json")!).annotations);
    });

    it("is still a valid copy for the newer client: the hash matches and the clock moves on", async () => {
      const first = await serializeAccountRepository(snapshot(withAnnotations()));
      const second = await olderClientEdits(first.files);
      const parsed = parseAccountRepositoryFiles(second.files);
      expect(await accountContentHash(parsed.data)).toBe(second.manifest.contentHash);
      expect(compareAccountManifests(second.manifest, first.manifest)).toBe("ahead");
    });
  });

  it("survive loading the settings again, being adopted from another copy, and the safe copy of the settings", () => {
    expect(migrateSettings(withAnnotations()).annotations).toEqual(ANNOTATIONS);
    expect(migrateSettings(withAnnotations()).reader.showAnnotations).toBe(false);
    // Absent, the reader shows the marks: nothing is added to the settings of who never changed it.
    expect(migrateSettings(DEFAULT_SETTINGS).annotations).toBeUndefined();
    expect(migrateSettings(DEFAULT_SETTINGS).reader).not.toHaveProperty("showAnnotations");
    expect(projectSyncableSettings(withAnnotations()).annotations).toEqual(ANNOTATIONS);
    expect(mergeLocalDeviceSettings(DEFAULT_SETTINGS, withAnnotations()).annotations).toEqual(ANNOTATIONS);
    expect(projectSafeSettings(withAnnotations()).annotations).toEqual(ANNOTATIONS);
    expect(projectSafeSettings(DEFAULT_SETTINGS)).not.toHaveProperty("annotations");
  });

  describe("offline", () => {
    beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

    it("change like the annotations themselves: names, marks and instructions, no credential", () => {
      const settings = withAnnotations();
      expect(() => assertOfflineSettingsPatchAllowed(settings, { annotations: { ...ANNOTATIONS, tags: [...ANNOTATIONS.tags!, tag("new-7g8h")] } })).not.toThrow();
      expect(() => assertOfflineSettingsPatchAllowed(settings, { reader: { ...settings.reader, showAnnotations: true } })).not.toThrow();
      expect(() => assertOfflineSettingsReplacementAllowed(settings, { ...settings, annotations: { publicNoticeSeen: ["writer/novel", "writer/other"] } })).not.toThrow();
    });

    it("are kept by the offline copy of the settings, and come back from it", () => {
      cacheOfflineSettings("workspace:test", DEFAULT_SETTINGS);
      cacheOfflineSettings("workspace:test", withAnnotations());
      const loaded = loadCachedSettings("workspace:test");
      expect(loaded?.annotations).toEqual(ANNOTATIONS);
      expect(loaded?.reader.showAnnotations).toBe(false);
    });
  });
});

describe("two devices whose copies of the account data both changed", () => {
  it("keep every tag of both, of each its newest version and a deletion over an edit of the same moment, whichever copy is chosen", async () => {
    const local = withAnnotations(DEFAULT_SETTINGS, {
      tags: [tag("doubt-1a2b", { name: "Doubt (renamed here)", updatedAt: T3 }), tag("local-only-1111"), tag("pace-3c4d", { name: "Pace", updatedAt: T2 })],
      publicNoticeSeen: ["writer/novel"],
    });
    const remote = withAnnotations({ ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: "it" } }, {
      tags: [tag("pace-3c4d", { deletedAt: T2, updatedAt: T2 }), tag("doubt-1a2b", { name: "Doubt (older)", updatedAt: T2 }), tag("remote-only-2222")],
      publicNoticeSeen: ["writer/other"],
    });
    const request = { local: snapshot(local), remotes: [{ backend: "google-drive" as const, manifest: snapshot(remote).manifest, data: snapshot(remote).data }] };

    for (const choice of ["local", "google-drive"] as const) {
      const data = await reconciledAccountData(request as never, choice);
      expect(data.settings.ui.language).toBe(choice === "local" ? "en" : "it");
      const tags = data.settings.annotations?.tags ?? [];
      // The chosen copy's order first, then what only the other has.
      expect(tags.map((entry) => entry.id)).toEqual(choice === "local" ? ["doubt-1a2b", "local-only-1111", "pace-3c4d", "remote-only-2222"] : ["pace-3c4d", "doubt-1a2b", "remote-only-2222", "local-only-1111"]);
      expect(tags.find((entry) => entry.id === "doubt-1a2b")?.name).toBe("Doubt (renamed here)");
      expect(tags.find((entry) => entry.id === "pace-3c4d")?.deletedAt).toBe(T2);
      expect(data.settings.annotations?.publicNoticeSeen).toEqual(["writer/novel", "writer/other"]);
    }
  });

  it("add nothing to copies that never had annotations", async () => {
    const request = { local: snapshot(DEFAULT_SETTINGS), remotes: [{ backend: "github" as const, manifest: snapshot(DEFAULT_SETTINGS).manifest, data: snapshot(DEFAULT_SETTINGS).data }] };
    expect((await reconciledAccountData(request as never, "github")).settings).not.toHaveProperty("annotations");
  });
});
