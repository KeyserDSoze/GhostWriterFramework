import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { applyLegacyGoogleChatImport, prepareLegacyGoogleChatImport } from "@/account/legacyGoogleChatImport";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, saveLocalAssistantSession } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { createEmptyAssistantSession, type AssistantSession } from "@/assistant/store";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const cloud = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), hydrate: vi.fn() }));
vi.mock("@/assistant/chatCloud", () => ({
  listAssistantSessionsStrict: cloud.list,
  loadAssistantSession: cloud.load,
  hydrateAssistantSessionArchive: cloud.hydrate,
}));
vi.mock("@/assistant/sessionIndex", () => ({ refreshAssistantSessionIndex: vi.fn() }));

function chat(id: string, text: string): AssistantSession {
  return {
    ...createEmptyAssistantSession("Legacy context"),
    id,
    fileId: `file-${id}`,
    revision: `revision-${id}`,
    title: `Chat ${id}`,
    updatedAt: "2026-09-01T08:00:00.000Z",
    messages: [{ id: `message-${id}`, role: "user", text }],
  };
}

describe("legacy Google chat import", () => {
  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("narrarium-local-account");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    useConnectionStore.setState({ hydrated: true, configuration: {} });
    cloud.list.mockReset();
    cloud.load.mockReset();
    cloud.hydrate.mockReset().mockImplementation(async (_provider, _token, session) => session);
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    await useConnectionStore.getState().connectGoogle({
      identity: { provider: "google", providerAccountId: "google-1", displayName: "Google Writer" },
      accessToken: "google-token",
      rememberMe: true,
    });
  });

  it("imports validated legacy chats atomically without retaining Google file identities", async () => {
    const legacy = chat("legacy-1", "Recovered message");
    cloud.list.mockResolvedValue([{ id: legacy.id, fileId: legacy.fileId, revision: legacy.revision, title: legacy.title, contextTitle: legacy.contextTitle, updatedAt: legacy.updatedAt }]);
    cloud.load.mockResolvedValue(legacy);

    const plan = await prepareLegacyGoogleChatImport();
    expect(plan).toMatchObject({ total: 1, unchanged: 0, conflicts: [] });
    await expect(applyLegacyGoogleChatImport(plan)).resolves.toBe(1);

    const local = await loadLocalAccountSnapshot();
    expect(local?.dirty).toBe(true);
    expect(local?.data.chats).toHaveLength(1);
    expect(local?.data.chats[0]).toMatchObject({ id: "legacy-1", messages: [{ text: "Recovered message" }] });
    expect(local?.data.chats[0].fileId).toBeUndefined();
    expect(local?.data.chats[0].revision).toBeUndefined();
  });

  it("refuses conflicting legacy content without changing the local chat", async () => {
    const current = chat("shared", "Current local message");
    const legacy = chat("shared", "Different legacy message");
    await saveLocalAssistantSession(current);
    cloud.list.mockResolvedValue([{ id: legacy.id, fileId: legacy.fileId, revision: legacy.revision, title: legacy.title, contextTitle: legacy.contextTitle, updatedAt: legacy.updatedAt }]);
    cloud.load.mockResolvedValue(legacy);

    const plan = await prepareLegacyGoogleChatImport();
    expect(plan.conflicts).toEqual(["shared"]);
    await expect(applyLegacyGoogleChatImport(plan)).rejects.toThrow("conflict with current local chats");
    expect((await loadLocalAccountSnapshot())?.data.chats[0]?.messages[0]?.text).toBe("Current local message");
  });
});
