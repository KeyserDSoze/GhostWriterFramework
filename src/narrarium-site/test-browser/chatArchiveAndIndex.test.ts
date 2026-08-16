import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistantArchiveAttachments, assistantArchiveMessages, createAssistantChatArchive, migrateAssistantChatArchive, parseAssistantChatArchive, serializeAssistantChatArchive } from "@/assistant/chatArchive";
import { createEmptyAssistantSession, useAssistantStore } from "@/assistant/store";
import { nextAvailableDriveFileName, uniqueGoogleExportName, uploadGoogleDriveFile, uploadMicrosoftDriveFile } from "@/drive/exportDriveClient";
import { resolveAssistantSessionUpdatedAt } from "@/assistant/chatCloud";
import { assistantSegmentSha256 } from "@/assistant/chatSegments";

describe("assistant full-fidelity archives", () => {
  it("round-trips attachment contents, action proposals, snapshots, provenance, and provider identity", async () => {
    const session = createEmptyAssistantSession("Book", { bookId: "book-1", owner: "writer", repo: "novel", branch: "draft", noteTargetPath: "notes/chat.md" });
    session.fileId = "cloud-file";
    session.revision = "etag-1";
    session.attachments = [{ id: "attachment-1", name: "image.png", mimeType: "image/png", kind: "image", sizeBytes: 12, imageDataUrl: "data:image/png;base64,YQ==" }];
    session.messages = [{ id: "message-1", role: "assistant", text: "proposal", branch: "draft", action: {
      kind: "apply-file-updates", bookId: "book-1", toolId: "multi-file-edit", owner: "writer", repo: "novel", branch: "draft",
      sourceRevision: "head", sourceRevisions: { "plot.md": "sha" }, generatedAt: "2026-08-16T10:00:00.000Z",
      updates: [{ path: "plot.md", content: "new", previousContent: "old", status: "pending" }],
    } }];
    const restored = await parseAssistantChatArchive(JSON.parse(await serializeAssistantChatArchive(createAssistantChatArchive(session, "microsoft", "writer@example.com"))));
    expect(restored.provider).toEqual({ type: "microsoft", account: "writer@example.com" });
    expect(restored.cloud).toEqual({ fileId: "cloud-file", revision: "etag-1" });
    expect(restored.session.attachments[0].imageDataUrl).toContain("base64");
    expect(restored.session.messages[0].action).toMatchObject({ branch: "draft", updates: [{ path: "plot.md", content: "new", previousContent: "old" }] });
    expect(restored.session.provenance).toMatchObject({ branch: "draft", noteTargetPath: "notes/chat.md" });
  });

  it("rejects unsupported archive versions", async () => {
    await expect(parseAssistantChatArchive({ format: "narrarium-assistant-chat", version: 2 })).rejects.toThrow(/Unsupported/);
  });

  it("rejects tampered, reordered, incomplete, and dishonest segment manifests", async () => {
    const session = createEmptyAssistantSession("Book");
    const first = { format: "narrarium-assistant-chat-segment" as const, version: 1 as const, id: "first", createdAt: "2026-08-16T10:00:00.000Z", messages: [{ id: "m1", role: "user" as const, text: "one" }], attachments: [] };
    const firstRef = { id: first.id, sha256: await assistantSegmentSha256(first) };
    const second = { format: "narrarium-assistant-chat-segment" as const, version: 1 as const, id: "second", createdAt: "2026-08-16T10:01:00.000Z", previous: firstRef, messages: [{ id: "m2", role: "assistant" as const, text: "two" }], attachments: [] };
    const secondRef = { id: second.id, sha256: await assistantSegmentSha256(second) };
    session.losslessSegments = [first, second];
    session.losslessArchive = { version: 1, head: secondRef, segmentCount: 2, messageCount: 2, attachmentCount: 0, actionCount: 0, complete: true, missingRanges: [] };
    const valid = createAssistantChatArchive(session, "google", "writer@example.com");
    await expect(parseAssistantChatArchive({ ...valid, session: { ...valid.session, losslessSegments: [{ ...first, messages: [{ ...first.messages[0], text: "tampered" }] }, second] } })).rejects.toThrow(/sequence|chain/);
    await expect(parseAssistantChatArchive({ ...valid, session: { ...valid.session, losslessSegments: [second, first] } })).rejects.toThrow(/sequence/);
    await expect(parseAssistantChatArchive({ ...valid, session: { ...valid.session, losslessSegments: [first] } })).rejects.toThrow(/incomplete/);
    await expect(parseAssistantChatArchive({ ...valid, completeness: { complete: false, missingRanges: [{ from: 0, to: 0, reason: "missing" }] } })).rejects.toThrow(/completeness/);
  });

  it("accepts an explicitly incomplete legacy archive without pretending records are present", async () => {
    const session = createEmptyAssistantSession("Legacy");
    session.losslessArchive = { version: 1, segmentCount: 0, messageCount: 0, attachmentCount: 0, actionCount: 0, complete: false, missingRanges: [{ from: 0, to: 4, reason: "Legacy records were not preserved." }] };
    const parsed = await parseAssistantChatArchive(createAssistantChatArchive(session, "microsoft", "writer@example.com"));
    expect(parsed.completeness).toEqual({ complete: false, missingRanges: session.losslessArchive.missingRanges });
  });

  it("rejects contradictory and imprecise completeness declarations", async () => {
    const session = createEmptyAssistantSession("Book");
    const archive = createAssistantChatArchive(session, "google", "writer@example.com");
    await expect(parseAssistantChatArchive({ ...archive, session: { ...archive.session, losslessArchive: { ...archive.session.losslessArchive!, complete: true, missingRanges: [{ from: 0, to: 0, reason: "missing" }] } } })).rejects.toThrow(/contradictory/);
    await expect(parseAssistantChatArchive({ ...archive, session: { ...archive.session, losslessArchive: { ...archive.session.losslessArchive!, complete: false, missingRanges: [] } } })).rejects.toThrow(/contradictory/);
    await expect(parseAssistantChatArchive({ ...archive, completeness: { complete: false, missingRanges: [] } })).rejects.toThrow(/contradictory/);
    await expect(parseAssistantChatArchive({ ...archive, session: { ...archive.session, losslessArchive: { ...archive.session.losslessArchive!, complete: false, missingRanges: [{ from: 0, to: 2, reason: "first" }, { from: 2, to: 3, reason: "overlap" }] } } })).rejects.toThrow(/ordered and non-overlapping/);
    await expect(parseAssistantChatArchive({ ...archive, session: { ...archive.session, losslessArchive: { ...archive.session.losslessArchive!, complete: false, missingRanges: [{ from: 0, to: 0, reason: "   " }] } } })).rejects.toThrow(/invalid/);
  });

  it("exports compacted lossless segments and migrates without cloud identity collisions", async () => {
    const session = createEmptyAssistantSession("Book");
    session.id = "existing";
    session.losslessSegments = [{
      format: "narrarium-assistant-chat-segment", version: 1, id: "segment-1", createdAt: "2026-08-16T10:00:00.000Z",
      messages: [{ id: "old-message", role: "assistant", text: "old", action: { kind: "navigate", to: "/app/settings", toolId: "navigate", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head", sourceRevisions: {}, generatedAt: "2026-08-16T10:00:00.000Z" } }],
      attachments: [{ id: "old-attachment", name: "old.txt", mimeType: "text/plain", kind: "text", sizeBytes: 3, textContent: "old" }],
    }];
    const head = { id: "segment-1", sha256: await assistantSegmentSha256(session.losslessSegments[0]) };
    session.losslessArchive = { version: 1, head, segmentCount: 1, messageCount: 1, attachmentCount: 1, actionCount: 1, complete: true, missingRanges: [] };
    session.messages = [{ id: "new-message", role: "user", text: "new" }];
    const archive = await parseAssistantChatArchive(JSON.parse(await serializeAssistantChatArchive(createAssistantChatArchive(session, "google", "writer@example.com"))));
    expect(assistantArchiveMessages(archive).map((message) => message.text)).toEqual(["old", "new"]);
    expect(assistantArchiveAttachments(archive)[0].textContent).toBe("old");
    const migrated = migrateAssistantChatArchive(archive, ["existing"]);
    expect(migrated.id).not.toBe("existing");
    expect(migrated.fileId).toBeUndefined();
    expect(migrated.revision).toBeUndefined();
  });
});

describe("assistant mutation ordering", () => {
  beforeEach(() => useAssistantStore.setState({ sessions: [], currentSession: createEmptyAssistantSession("Book") }));

  it("touches stream, action, and clear mutations with monotonic revisions and times", () => {
    const store = useAssistantStore.getState();
    const initial = store.currentSession!;
    store.updateCurrentSession((session) => ({ ...session, messages: [{ id: "message-1", role: "assistant", text: "" }] }));
    const streamed = useAssistantStore.getState().currentSession!;
    useAssistantStore.getState().updateMessage("message-1", { text: "chunk", action: undefined });
    const action = useAssistantStore.getState().currentSession!;
    useAssistantStore.getState().clearMessages();
    const cleared = useAssistantStore.getState().currentSession!;
    expect([initial, streamed, action, cleared].map((entry) => entry.contentRevision)).toEqual([0, 1, 2, 3]);
    expect(Date.parse(streamed.updatedAt)).toBeGreaterThan(Date.parse(initial.updatedAt));
    expect(Date.parse(action.updatedAt)).toBeGreaterThan(Date.parse(streamed.updatedAt));
    expect(Date.parse(cleared.updatedAt)).toBeGreaterThan(Date.parse(action.updatedAt));
  });
});

describe("Drive collision policy", () => {
  it("uses the same deterministic rename shape for provider exports", () => {
    const existing = ["chat.md", "chat (1).md", "CHAT (2).MD"];
    expect(nextAvailableDriveFileName("chat.md", existing)).toBe("chat (3).md");
  });

  it("renames Google exports rather than creating an ambiguous duplicate", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init = {}) => {
      if (init.method === "POST") return new Response(JSON.stringify({ id: "new", name: ".tmp" }), { status: 200 });
      if (init.method === "PATCH") return new Response(JSON.stringify({ id: "new", name: JSON.parse(String(init.body)).name }), { status: 200 });
      return new Response(JSON.stringify({ files: [{ id: "old", name: "chat.md" }] }), { status: 200 });
    });
    const uploaded = await uploadGoogleDriveFile("token", "folder", "chat.md", "text/markdown", new Blob(["chat"]));
    expect(uploaded.name).toBe(uniqueGoogleExportName("chat.md", "new"));
    fetchMock.mockRestore();
  });

  it("elects deterministic distinct names for concurrent Google allocations", async () => {
    let upload = 0;
    const allocations = ["b-allocation", "a-allocation"];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init = {}) => {
      if (init.method === "POST") return new Response(JSON.stringify({ id: allocations[upload++], name: ".tmp" }), { status: 200 });
      if (init.method === "PATCH") {
        const id = String(_url).includes("a-allocation") ? "a-allocation" : "b-allocation";
        return new Response(JSON.stringify({ id, name: JSON.parse(String(init.body)).name }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    });
    const [first, second] = await Promise.all([
      uploadGoogleDriveFile("token", "folder", "chat.md", "text/markdown", new Blob(["one"])),
      uploadGoogleDriveFile("token", "folder", "chat.md", "text/markdown", new Blob(["two"])),
    ]);
    expect(first.name).not.toBe(second.name);
    fetchMock.mockRestore();
  });

  it("asks OneDrive to use the same rename-on-collision behavior", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new", name: "chat (1).md" }), { status: 200 }));
    await uploadMicrosoftDriveFile("token", "Exports", "chat.md", "text/markdown", new Blob(["chat"]));
    expect(String(fetchMock.mock.calls[1][0])).toContain("@microsoft.graph.conflictBehavior=rename");
    fetchMock.mockRestore();
  });

  it("prefers meaningful embedded time over provider metadata and falls back for legacy files", () => {
    expect(resolveAssistantSessionUpdatedAt("2026-08-15T10:00:00Z", "2026-08-16T10:00:00Z")).toBe("2026-08-15T10:00:00Z");
    expect(resolveAssistantSessionUpdatedAt(undefined, "2026-08-16T10:00:00Z")).toBe("2026-08-16T10:00:00Z");
  });
});
