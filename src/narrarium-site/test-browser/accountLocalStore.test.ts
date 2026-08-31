import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import {
  closeAccountLocalStoreForTests,
  deleteAllLocalAccountData,
  deleteLocalAssistantSession,
  initializeAccountLocalStore,
  listLocalAssistantSessions,
  loadLocalAccountSnapshot,
  loadLocalAssistantSession,
  markLocalAccountReplicaConfirmed,
  replaceLocalAccountSnapshot,
  saveLocalAccountClipboard,
  saveLocalAccountCosts,
  saveLocalAccountSettings,
  saveLocalAssistantSession,
  LocalAccountSnapshotChangedError,
} from "@/account/accountLocalStore";
import { resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { createEmptyAssistantSession } from "@/assistant/store";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";

describe("local account store", () => {
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

  it("persists settings and clipboard before any remote connection exists", async () => {
    const initial = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    expect(initial.dirty).toBe(false);
    const settings = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: "it" as const } };
    const firstManifest = await saveLocalAccountSettings(settings);
    const secondManifest = await saveLocalAccountClipboard([{ id: "clip", text: "offline", at: "2026-08-31T12:00:00.000Z" }]);
    const restored = await loadLocalAccountSnapshot();
    expect(restored?.data.settings.ui.language).toBe("it");
    expect(restored?.data.clipboard[0]?.text).toBe("offline");
    expect(restored?.dirty).toBe(true);
    expect(secondManifest.vectorClock[secondManifest.modifiedByDeviceId]).toBe(2);
    expect(firstManifest.snapshotId).not.toBe(secondManifest.snapshotId);
  });

  it("persists device-only book handles without advancing the sync vector", async () => {
    const initial = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    const localBook = { id: "book", storageMode: "local-only" as const, localRepositoryId: "repo-local", owner: "", repo: "", name: "Local", tokenIndex: null, activeBranch: "local:repo-local", addedAt: "2026-08-31T12:00:00.000Z" };
    await saveLocalAccountSettings({ ...DEFAULT_SETTINGS, books: [localBook] });
    const afterLogicalChange = (await loadLocalAccountSnapshot())!;
    await saveLocalAccountSettings({ ...afterLogicalChange.data.settings, books: [{ ...localBook, localRepositoryId: "other-device-id", activeBranch: "local:other-device-id" }] });
    const afterDeviceOnlyChange = (await loadLocalAccountSnapshot())!;
    expect(afterDeviceOnlyChange.manifest.snapshotId).toBe(afterLogicalChange.manifest.snapshotId);
    expect(afterDeviceOnlyChange.data.settings.books[0]?.localRepositoryId).toBe("other-device-id");
    expect(afterDeviceOnlyChange.manifest.snapshotId).not.toBe(initial.manifest.snapshotId);
  });

  it("stores chat sessions and lossless segments durably", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    const chat = createEmptyAssistantSession("Offline");
    chat.messages = [{ id: "message", role: "user", text: "Saved locally" }];
    chat.losslessSegments = [{ format: "narrarium-assistant-chat-segment", version: 1, id: "segment", createdAt: "2026-08-31T12:00:00.000Z", messages: [{ id: "old", role: "assistant", text: "Earlier" }], attachments: [] }];
    await saveLocalAssistantSession(chat);
    expect((await listLocalAssistantSessions()).map((entry) => entry.id)).toEqual([chat.id]);
    expect((await loadLocalAssistantSession(chat.id))?.losslessSegments?.[0]?.messages[0]?.text).toBe("Earlier");
    closeAccountLocalStoreForTests();
    expect((await loadLocalAssistantSession(chat.id))?.messages[0]?.text).toBe("Saved locally");
    await deleteLocalAssistantSession(chat.id);
    expect(await loadLocalAssistantSession(chat.id)).toBeNull();
  });

  it("keeps dirty state until the exact local snapshot is confirmed remotely", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    const manifest = await saveLocalAccountClipboard([{ id: "one", text: "one", at: "2026-08-31T12:00:00.000Z" }]);
    expect(await markLocalAccountReplicaConfirmed("stale")).toBe(false);
    expect((await loadLocalAccountSnapshot())?.dirty).toBe(true);
    expect(await markLocalAccountReplicaConfirmed(manifest.snapshotId)).toBe(true);
    expect((await loadLocalAccountSnapshot())?.dirty).toBe(false);
  });

  it("creates a new convergent snapshot when a remote copy is adopted", async () => {
    const local = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    const remoteData = { ...local.data, settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR" } };
    const replaced = await replaceLocalAccountSnapshot(remoteData, [{ ...local.manifest, vectorClock: { remote: 9 } }], "test reconciliation");
    expect(replaced.data.settings.costCurrency).toBe("EUR");
    expect(replaced.manifest.vectorClock.remote).toBe(9);
    expect(Object.values(replaced.manifest.vectorClock).some((value) => value === 1)).toBe(true);
    expect(replaced.dirty).toBe(true);
  });

  it("refuses to replace local data when the expected snapshot became stale", async () => {
    const local = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    await saveLocalAccountClipboard([{ id: "new", text: "new local work", at: "2026-08-31T12:00:00.000Z" }]);
    await expect(replaceLocalAccountSnapshot(local.data, [local.manifest], "stale reconciliation", local.manifest.snapshotId)).rejects.toBeInstanceOf(LocalAccountSnapshotChangedError);
    expect((await loadLocalAccountSnapshot())?.data.clipboard[0]?.text).toBe("new local work");
  });

  it("updates only device-local settings without reverting newer costs or clipboard", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    await saveLocalAccountClipboard([{ id: "new", text: "new clipboard", at: "2026-08-31T12:00:00.000Z" }]);
    const costs = { ...emptyCostsFile(), updatedAt: "2026-08-31T12:00:00.000Z", books: {} };
    await saveLocalAccountCosts(costs);
    await saveLocalAccountSettings({ ...DEFAULT_SETTINGS, books: [{ id: "local", storageMode: "local-only", localRepositoryId: "device-only", owner: "", repo: "", name: "Local", tokenIndex: null, activeBranch: "local:device-only", addedAt: "2026-08-31T12:00:00.000Z" }] });
    const current = await loadLocalAccountSnapshot();
    expect(current?.data.clipboard[0]?.text).toBe("new clipboard");
    expect(current?.data.costs.updatedAt).toBe(costs.updatedAt);
  });

  it("deletes account data only through the explicit destructive API", async () => {
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    await deleteAllLocalAccountData();
    expect(await loadLocalAccountSnapshot()).toBeNull();
  });
});
