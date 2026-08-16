import { describe, expect, it } from "vitest";
import { assistantSegmentSha256, verifyAssistantSegment } from "@/assistant/chatSegments";
import { parseAssistantSessionJson, serializeAssistantSession } from "@/assistant/sessionSchema";
import { createEmptyAssistantSession, type AssistantLosslessSegment } from "@/assistant/store";
import { deleteAssistantSession, hydrateAssistantSessionArchive, maintainAssistantSessionSegments, saveAssistantSession } from "@/assistant/chatCloud";
import { resetGoogleAppFolderCacheForTests } from "@/drive/googleAppFolder";

async function segmentedSession() {
  const session = createEmptyAssistantSession("Book");
  session.id = "session-1";
  const segment: AssistantLosslessSegment = {
    format: "narrarium-assistant-chat-segment", version: 1, id: "segment-1", createdAt: "2026-08-16T10:00:00.000Z",
    messages: [{ id: "old-message", role: "assistant", text: "old", action: { kind: "navigate", to: "/app/settings", toolId: "navigate", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head", sourceRevisions: {}, generatedAt: "2026-08-16T10:00:00.000Z" } }],
    attachments: [{ id: "old-attachment", name: "old.txt", mimeType: "text/plain", kind: "text", sizeBytes: 3, textContent: "old" }],
  };
  const head = { id: segment.id, sha256: await assistantSegmentSha256(segment) };
  return { ...session, losslessSegments: [segment], losslessArchive: { version: 1 as const, head, segmentCount: 1, messageCount: 1, attachmentCount: 1, actionCount: 1, complete: true, missingRanges: [] } };
}

describe("assistant cloud segment provider contract", () => {
  it("keeps the primary manifest bounded independently of segment payload growth", async () => {
    const session = await segmentedSession();
    session.losslessSegments![0].attachments[0].textContent = "x".repeat(900_000);
    const persisted = serializeAssistantSession(session);
    expect(persisted.length).toBeLessThan(10_000);
    expect(persisted).not.toContain("losslessSegments");
    expect(parseAssistantSessionJson(persisted).losslessArchive?.head).toEqual(session.losslessArchive?.head);
  });

  it("rejects corrupted bodies and manifest total mismatches for both provider hydration paths", async () => {
    const session = await segmentedSession();
    const segment = session.losslessSegments![0];
    await expect(verifyAssistantSegment({ ...segment, messages: [{ ...segment.messages[0], text: "tampered" }] }, session.losslessArchive!.head!)).rejects.toThrow(/integrity/);
    const actual = {
      segmentCount: session.losslessSegments!.length,
      messageCount: session.losslessSegments!.reduce((sum, entry) => sum + entry.messages.length, 0),
      attachmentCount: session.losslessSegments!.reduce((sum, entry) => sum + entry.attachments.length, 0),
      actionCount: session.losslessSegments!.reduce((sum, entry) => sum + entry.messages.filter((message) => message.action).length, 0),
    };
    expect(actual).toEqual({ segmentCount: 1, messageCount: 1, attachmentCount: 1, actionCount: 1 });
    expect({ ...actual, actionCount: 0 }).not.toMatchObject(session.losslessArchive!);
  });

  it("threads abort through the public save contract before any provider write", async () => {
    const session = await segmentedSession();
    const controller = new AbortController();
    controller.abort();
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; throw new Error("unexpected provider write"); };
    await expect(saveAssistantSession("google", "token", session, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(0);
    globalThis.fetch = original;
  });

  it("rejects total mismatch through the public hydration contract", async () => {
    const session = await segmentedSession();
    session.losslessArchive = { ...session.losslessArchive!, messageCount: 2 };
    const segment = session.losslessSegments![0];
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(segment), { status: 200 });
    await expect(hydrateAssistantSessionArchive("microsoft", "token", { ...session, losslessSegments: [] })).rejects.toThrow(/totals/);
    globalThis.fetch = original;
  });

  it.each(["google", "microsoft"] as const)("delete contract is idempotent for primary and segment cleanup on %s", async (provider) => {
    resetGoogleAppFolderCacheForTests();
    const original = globalThis.fetch;
    const deletes: string[] = [];
    globalThis.fetch = async (url, init: RequestInit = {}) => {
      const value = String(url);
      if (init.method === "DELETE") { deletes.push(value); return new Response(null, { status: 204 }); }
      if (provider === "microsoft" && value.includes("?$select=")) return new Response(JSON.stringify({ eTag: "r1" }), { status: 200 });
      if (provider === "google" && value.includes("/about")) return new Response(JSON.stringify({ user: { permissionId: "segments" } }), { status: 200 });
      if (provider === "google" && new URL(value).searchParams.get("q")?.includes("appProperties has")) return new Response(JSON.stringify({ files: [{ id: "app", name: "Narrarium", appProperties: { narrariumAppFolder: "v1" } }] }), { status: 200 });
      if (provider === "google" && value.includes("name%3D%27chat-segments%27")) return new Response(JSON.stringify({ files: [{ id: "segments" }] }), { status: 200 });
      if (provider === "google" && value.includes("narrariumChatSegmentSession")) return new Response(JSON.stringify({ files: [{ id: "segment-file", name: "segment.json" }] }), { status: 200 });
      return new Response(JSON.stringify({ ...createEmptyAssistantSession("Book"), id: "session-1" }), { status: 200, headers: { ETag: "r1" } });
    };
    await deleteAssistantSession(provider, "token", "primary-file", undefined, "session-1");
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    globalThis.fetch = original;
  });

  it.each([false, true])("reconciles Google segment create races and rejects divergent duplicates (divergent=%s)", async (divergent) => {
    resetGoogleAppFolderCacheForTests();
    const session = await segmentedSession();
    const segment = session.losslessSegments![0];
    const expectedHash = session.losslessArchive!.head!.sha256;
    const original = globalThis.fetch;
    const deleted: string[] = [];
    let segmentCreated = false;
    globalThis.fetch = async (url, init: RequestInit = {}) => {
      const value = String(url);
      const query = new URL(value).searchParams.get("q") ?? "";
      if (value.includes("/about")) return new Response(JSON.stringify({ user: { permissionId: "account" } }), { status: 200 });
      if (query.includes("narrariumAppFolder")) return new Response(JSON.stringify({ files: [{ id: "app", name: "Narrarium", appProperties: { narrariumAppFolder: "v1" } }] }), { status: 200 });
      if (query.includes("name='chat-segments'")) return new Response(JSON.stringify({ files: [{ id: "segments" }] }), { status: 200 });
      if (query.includes("name='chats'")) return new Response(JSON.stringify({ files: [{ id: "chats" }] }), { status: 200 });
      if (query.includes("narrariumChatSegmentSession")) {
        if (!segmentCreated) return new Response(JSON.stringify({ files: [] }), { status: 200 });
        const common = { name: "arbitrary-provider-name", appProperties: { narrariumChatSegment: "v1", narrariumChatSegmentSession: session.id, narrariumChatSegmentId: segment.id } };
        return new Response(JSON.stringify({ files: [
          { id: "a-existing", ...common, appProperties: { ...common.appProperties, narrariumChatSegmentHash: divergent ? "f".repeat(64) : expectedHash } },
          { id: "b-created", ...common, appProperties: { ...common.appProperties, narrariumChatSegmentHash: expectedHash } },
        ] }), { status: 200 });
      }
      if (init.method === "POST" && value.includes("upload/drive")) {
        const metadata = JSON.parse(await ((init.body as FormData).get("metadata") as Blob).text()) as { appProperties?: Record<string, string> };
        if (metadata.appProperties?.narrariumChatSegment === "v1") { segmentCreated = true; return new Response(JSON.stringify({ id: "b-created" }), { status: 200 }); }
        return new Response(JSON.stringify({ id: "primary" }), { status: 200, headers: { ETag: "r1" } });
      }
      if (value.includes("a-existing?alt=media") || value.includes("b-created?alt=media")) return new Response(JSON.stringify(segment), { status: 200 });
      if (init.method === "DELETE") { deleted.push(value); return new Response(null, { status: 204 }); }
      if (query.includes(`name='${session.id}.json'`)) return new Response(JSON.stringify({ files: [{ id: "primary", name: `${session.id}.json`, appProperties: { narrariumChat: "v1", sessionId: session.id, title: session.title, contextTitle: session.contextTitle, updatedAt: session.updatedAt, contentRevision: "0" } }] }), { status: 200 });
      if (value.includes("primary?alt=media")) return new Response(serializeAssistantSession(session), { status: 200, headers: { ETag: "r1" } });
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${value}`);
    };
    if (divergent) {
      await expect(saveAssistantSession("google", "token", session)).rejects.toThrow(/divergent provider metadata/);
      expect(deleted.some((url) => url.includes("b-created"))).toBe(true);
      expect(deleted.some((url) => url.includes("a-existing"))).toBe(false);
    } else {
      await saveAssistantSession("google", "token", session);
      expect(deleted.some((url) => url.includes("b-created"))).toBe(true);
      expect(deleted.some((url) => url.includes("a-existing"))).toBe(false);
    }
    globalThis.fetch = original;
  });

  it("uses Google provider timestamps, not client segment timestamps, for GC grace", async () => {
    resetGoogleAppFolderCacheForTests();
    const original = globalThis.fetch;
    const deleted: string[] = [];
    const properties = (id: string) => ({ narrariumChatSegment: "v1", narrariumChatSegmentSession: "orphan", narrariumChatSegmentId: id, narrariumChatSegmentHash: id === "fresh" ? "a".repeat(64) : "b".repeat(64), narrariumChatSegmentCreatedAt: "2000-01-01T00:00:00.000Z" });
    globalThis.fetch = async (url, init: RequestInit = {}) => {
      const value = String(url);
      const query = new URL(value).searchParams.get("q") ?? "";
      if (value.includes("/about")) return new Response(JSON.stringify({ user: { permissionId: "account" } }), { status: 200 });
      if (query.includes("narrariumAppFolder")) return new Response(JSON.stringify({ files: [{ id: "app", name: "Narrarium", appProperties: { narrariumAppFolder: "v1" } }] }), { status: 200 });
      if (query.includes("name='chats'")) return new Response(JSON.stringify({ files: [{ id: "chats" }] }), { status: 200 });
      if (query.includes("'chats' in parents")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
      if (query.includes("name='chat-segments'")) return new Response(JSON.stringify({ files: [{ id: "segments" }] }), { status: 200 });
      if (query.includes("'segments' in parents")) return new Response(JSON.stringify({ files: [
        { id: "fresh-file", name: "renamed-fresh", createdTime: new Date().toISOString(), appProperties: properties("fresh") },
        { id: "old-file", name: "renamed-old", createdTime: "2000-01-01T00:00:00.000Z", appProperties: properties("old") },
      ] }), { status: 200 });
      if (init.method === "DELETE") { deleted.push(value); return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${value}`);
    };
    await maintainAssistantSessionSegments("google", "token");
    expect(deleted.some((url) => url.includes("old-file"))).toBe(true);
    expect(deleted.some((url) => url.includes("fresh-file"))).toBe(false);
    globalThis.fetch = original;
  });

  it("keeps an old OneDrive segment folder when a fresh unpublished child appears on a later page", async () => {
    const original = globalThis.fetch;
    const deleted: string[] = [];
    const old = "2000-01-01T00:00:00.000Z";
    const fresh = new Date().toISOString();
    globalThis.fetch = async (url, init: RequestInit = {}) => {
      const value = String(url);
      if (init.method === "DELETE") { deleted.push(value); return new Response(null, { status: 204 }); }
      if (value === "https://graph.example/segment-page-2") return new Response(JSON.stringify({ value: [{ id: "fresh-child", name: "session-1.fresh.hash.json", createdDateTime: fresh }] }), { status: 200 });
      if (value.includes("chat-segments/session-1:/children")) return new Response(JSON.stringify({ value: [{ id: "old-child", name: "session-1.old.hash.json", createdDateTime: old }], "@odata.nextLink": "https://graph.example/segment-page-2" }), { status: 200 });
      if (value.includes("chat-segments:/children")) return new Response(JSON.stringify({ value: [{ id: "segment-folder", name: "session-1", folder: {}, createdDateTime: old }] }), { status: 200 });
      if (value.includes("chats:/children")) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      if (value.includes("graph.microsoft.com")) return new Response(JSON.stringify({ id: "folder" }), { status: 200 });
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${value}`);
    };
    await maintainAssistantSessionSegments("microsoft", "token");
    expect(deleted.some((url) => url.includes("old-child"))).toBe(true);
    expect(deleted.some((url) => url.includes("fresh-child"))).toBe(false);
    expect(deleted.some((url) => url.includes("segment-folder"))).toBe(false);
    globalThis.fetch = original;
  });

  it("holds the OneDrive maintenance lease through recursive parent delete before a concurrent save starts", async () => {
    const original = globalThis.fetch;
    const old = "2000-01-01T00:00:00.000Z";
    let releaseParentDelete!: () => void;
    const parentDelete = new Promise<void>((resolve) => { releaseParentDelete = resolve; });
    let parentDeleteStarted = false;
    let saveFetchStarted = false;
    globalThis.fetch = async (url, init: RequestInit = {}) => {
      const value = String(url);
      if (init.method === "DELETE" && value.includes("segment-folder")) {
        parentDeleteStarted = true;
        await parentDelete;
        return new Response(null, { status: 204 });
      }
      if (value.includes("chat-segments/session-1:/children")) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      if (value.includes("chat-segments:/children")) return new Response(JSON.stringify({ value: [{ id: "segment-folder", name: "session-1", folder: {}, createdDateTime: old }] }), { status: 200 });
      if (value.includes("chats:/children")) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      if (value.includes("graph.microsoft.com") && !parentDeleteStarted) return new Response(JSON.stringify({ id: "folder" }), { status: 200 });
      saveFetchStarted = true;
      throw new Error("save provider request reached test sentinel");
    };
    const maintenance = maintainAssistantSessionSegments("microsoft", "lease-race-token");
    while (!parentDeleteStarted) await Promise.resolve();
    const save = saveAssistantSession("microsoft", "lease-race-token", await segmentedSession()).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(saveFetchStarted).toBe(false);
    releaseParentDelete();
    await maintenance;
    await save;
    expect(saveFetchStarted).toBe(true);
    globalThis.fetch = original;
  });
});
