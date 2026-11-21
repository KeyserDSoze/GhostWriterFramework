import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { AssistantSessionConflictError, loadAssistantSession, saveAssistantSession } from "@/assistant/chatCloud";
import { serializeAssistantSession } from "@/assistant/sessionSchema";
import { createEmptyAssistantSession, type AssistantSession } from "@/assistant/store";
import { resetGoogleAppFolderCacheForTests } from "@/drive/googleAppFolder";
import { createFakeGoogleDrive, type FakeGoogleDriveOptions } from "./helpers/fakeGoogleDrive";

const CHAT_FILE = "session-1.json";

function chat(overrides: Partial<AssistantSession> = {}): AssistantSession {
  return { ...createEmptyAssistantSession("Book"), id: "session-1", title: "Cloud chat", updatedAt: "2026-11-21T10:00:00.000Z", ...overrides };
}

function connect(options?: FakeGoogleDriveOptions) {
  const drive = createFakeGoogleDrive(options);
  vi.stubGlobal("fetch", drive.fetch);
  return { drive, token: `chat-${crypto.randomUUID()}` };
}

describe("Google chat files in a browser, where the ETag header cannot be read", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGoogleAppFolderCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the version of the file it creates as the revision, and loads it back with the same one", async () => {
    const { drive, token } = connect();
    const created = await saveAssistantSession("google", token, chat());
    expect(created.revision).toBe(String(drive.find(CHAT_FILE).version));
    const loaded = await loadAssistantSession("google", token, created.fileId);
    expect(loaded.revision).toBe(created.revision);
  });

  it("creates, repeats, updates and detects a conflict without ever sending a version as If-Match", async () => {
    const { drive, token } = connect();
    const created = await saveAssistantSession("google", token, chat());
    expect(created.revision).toBeTruthy();

    const repeated = await saveAssistantSession("google", token, chat());
    expect(repeated).toEqual(created);

    const changed = chat({ ...created, title: "Changed" });
    const updated = await saveAssistantSession("google", token, changed);
    expect(updated.fileId).toBe(created.fileId);
    expect(updated.revision).not.toBe(created.revision);
    expect(updated.revision).toBe(String(drive.find(CHAT_FILE).version));

    const retried = await saveAssistantSession("google", token, changed);
    expect(retried).toEqual(updated);

    drive.externalWrite(CHAT_FILE, serializeAssistantSession(chat({ title: "Other device" })));
    await expect(saveAssistantSession("google", token, chat({ ...updated, title: "Local edit" }))).rejects.toSatisfy((error) => error instanceof AssistantSessionConflictError && error.recoverable);

    const writes = drive.writes(CHAT_FILE);
    expect(writes).toHaveLength(1);
    for (const write of writes) expect(write.headers.has("If-Match")).toBe(false);
  });

  it("does not write over a file whose version moved after the chat was loaded", async () => {
    const { drive, token } = connect();
    const created = await saveAssistantSession("google", token, chat());
    drive.touch(CHAT_FILE);
    await expect(saveAssistantSession("google", token, chat({ ...created, title: "Local edit" }))).rejects.toBeInstanceOf(AssistantSessionConflictError);
    expect(drive.writes(CHAT_FILE)).toHaveLength(0);
  });

  it("updates a chat that carries no revision by adopting the version it reads", async () => {
    const { drive, token } = connect();
    const created = await saveAssistantSession("google", token, chat());
    const updated = await saveAssistantSession("google", token, chat({ fileId: created.fileId, title: "Changed" }));
    expect(updated.revision).toBe(String(drive.find(CHAT_FILE).version));
    expect(drive.writes(CHAT_FILE)).toHaveLength(1);
  });
});

describe("Google chat files when the ETag header can be read", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGoogleAppFolderCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps sending the ETag as If-Match, and the server refuses a stale one", async () => {
    const { drive, token } = connect({ exposeEtag: true, omitVersion: true });
    const created = await saveAssistantSession("google", token, chat());
    expect(created.revision).toBe(drive.etagOf(CHAT_FILE));

    const etagBeforeUpdate = drive.etagOf(CHAT_FILE);
    const updated = await saveAssistantSession("google", token, chat({ ...created, title: "Changed" }));
    expect(updated.revision).toBe(drive.etagOf(CHAT_FILE));
    expect(drive.writes(CHAT_FILE).map((write) => write.headers.get("If-Match"))).toEqual([etagBeforeUpdate]);

    drive.externalWrite(CHAT_FILE, serializeAssistantSession(chat({ title: "Other device" })));
    await expect(saveAssistantSession("google", token, chat({ ...updated, title: "Local edit" }))).rejects.toBeInstanceOf(AssistantSessionConflictError);
  });
});
