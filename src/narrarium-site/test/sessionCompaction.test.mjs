import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PERSISTED_CHAT_BYTES } from "../src/assistant/chatCloud.ts";
import { serializeAssistantSession } from "../src/assistant/sessionSchema.ts";
import {
  assistantSessionCompactionTarget,
  appendAssistantArchiveRecords,
  archiveAction,
  compactionText,
  MAX_ARCHIVE_RECORD_BYTES,
  MAX_COMPACTION_INPUT_CHARS,
  mergeAssistantSessionCompaction,
} from "../src/assistant/sessionCompaction.ts";

/** @param {number} count @returns {import("../src/assistant/store.ts").AssistantMessage[]} */
function messages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `Message ${index}`,
  }));
}

/** @param {Partial<import("../src/assistant/store.ts").AssistantSession>} [overrides] @returns {import("../src/assistant/store.ts").AssistantSession} */
function session(overrides = {}) {
  return {
    id: "session-1",
    fileId: "drive-file",
    title: "Chat",
    contextTitle: "Book",
    updatedAt: "2026-08-14T12:00:00.000Z",
    messages: messages(13),
    attachments: [],
    compactSummary: "",
    compactedMessageCount: 0,
    ...overrides,
  };
}

test("compaction starts only when a new prefix exceeds the threshold", () => {
  assert.equal(assistantSessionCompactionTarget(session({ messages: messages(12) })), null);
  assert.equal(assistantSessionCompactionTarget(session()), 7);
  assert.equal(assistantSessionCompactionTarget(session({ messages: messages(6), compactedMessageCount: 7 })), null);
  assert.equal(assistantSessionCompactionTarget(session({ messages: messages(15), compactedMessageCount: 7 })), 9);
});

test("size pressure compacts huge active content and attachment-only sessions", () => {
  assert.equal(assistantSessionCompactionTarget(session({ messages: [{ id: "huge", role: "user", text: "x".repeat(400_000) }] })), 1);
  assert.equal(assistantSessionCompactionTarget(session({ messages: [], attachments: [{ id: "image", name: "map.png", mimeType: "image/png", kind: "image", sizeBytes: 500_000, imageDataUrl: "x".repeat(500_000) }] })), 0);
});

test("compaction merge preserves newer session data", () => {
  const current = session({
    messages: messages(15),
    attachments: [{ id: "a1", name: "notes.md", mimeType: "text/markdown", kind: "text", sizeBytes: 10, textContent: "notes" }],
    updatedAt: "2026-08-14T12:01:00.000Z",
  });
  const compacted = session({ messages: messages(13).slice(7), compactSummary: "Summary", compactedMessageCount: 7, archive: { summary: "Summary", messageCount: 7, actions: [], attachments: [] } });
  const merged = mergeAssistantSessionCompaction(current, "session-1", compacted);

  assert.equal(merged.compactSummary, "Summary");
  assert.equal(merged.compactedMessageCount, 7);
  assert.equal(merged.messages.length, 8);
  assert.equal(merged.attachments.length, 1);
  assert.equal(merged.fileId, "drive-file");
  assert.equal(merged.updatedAt, "2026-08-14T12:01:00.000Z");
});

test("compaction archives source attachments but preserves concurrently added ones", () => {
  /** @type {import("../src/assistant/store.ts").AssistantAttachment} */
  const oldAttachment = { id: "old", name: "old.txt", mimeType: "text/plain", kind: "text", sizeBytes: 10, textContent: "old" };
  /** @type {import("../src/assistant/store.ts").AssistantAttachment} */
  const newAttachment = { id: "new", name: "new.txt", mimeType: "text/plain", kind: "text", sizeBytes: 10, textContent: "new" };
  const current = session({ messages: messages(13), attachments: [oldAttachment, newAttachment] });
  const compacted = session({
    messages: messages(13).slice(7),
    attachments: [],
    compactSummary: "Summary",
    compactedMessageCount: 7,
    archive: { summary: "Summary", messageCount: 7, actions: [], attachments: [{ id: "old", name: "old.txt", mimeType: "text/plain", kind: "text", sizeBytes: 10 }] },
  });
  const merged = mergeAssistantSessionCompaction(current, "session-1", compacted);
  assert.deepEqual(merged.attachments.map((attachment) => attachment.id), ["new"]);
  assert.deepEqual(merged.archive.attachments.map((attachment) => attachment.id), ["old"]);
});

test("compaction input is incremental and bounded for huge messages", () => {
  const value = session({
    messages: [{ id: "huge", role: "user", text: "x".repeat(MAX_COMPACTION_INPUT_CHARS * 2) }, ...messages(12)],
    archive: { summary: "Earlier decisions", messageCount: 20, actions: [], attachments: [] },
  });
  const text = compactionText(value, 7);
  assert.ok(text.length <= MAX_COMPACTION_INPUT_CHARS);
  assert.match(text, /PREVIOUS ARCHIVE SUMMARY/);
  assert.match(text, /content truncated/);
  assert.match(text, /Message 5/);
});

test("archived actions retain provenance without full mutation snapshots", () => {
  const archived = archiveAction("message-1", {
    kind: "apply-file-updates",
    bookId: "book",
    toolId: "multi-file-edit",
    owner: "writer",
    repo: "novel",
    branch: "main",
    sourceRevision: "abc123",
    sourceRevisions: { "plot.md": "plot123" },
    generatedAt: "2026-08-15T10:00:00.000Z",
    updates: [{ path: "plot.md", content: "x".repeat(100_000), previousContent: "old" }],
  });
  assert.deepEqual(archived, {
    messageId: "message-1", kind: "apply-file-updates", bookId: "book", toolId: "multi-file-edit",
    owner: "writer", repo: "novel", branch: "main", sourceRevision: "abc123",
    sourceRevisions: { "plot.md": "plot123" }, generatedAt: "2026-08-15T10:00:00.000Z", paths: ["plot.md"],
  });
  assert.ok(JSON.stringify(archived).length < 1_000);
});

test("long chats retain every compact action and attachment audit record beyond 200", async () => {
  /** @type {import("../src/assistant/store.ts").AssistantSessionArchive} */
  const previous = {
    summary: "Earlier",
    messageCount: 250,
    actions: Array.from({ length: 250 }, (_, index) => ({ messageId: `old-message-${index}`, kind: "navigate", paths: [] })),
    attachments: Array.from({ length: 250 }, (_, index) => ({ id: `old-attachment-${index}`, name: `old-${index}.txt`, mimeType: "text/plain", kind: "text", sizeBytes: index })),
  };
  const records = await appendAssistantArchiveRecords(
    previous,
    [{ messageId: "new-message", kind: "navigate", toolId: "navigate", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head", sourceRevisions: {}, generatedAt: "2026-08-15T10:00:00.000Z", paths: [] }],
    [{ id: "new-attachment", name: "new.txt", mimeType: "text/plain", kind: "text", sizeBytes: 3, textContent: "new" }],
  );

  assert.equal(records.actions.length, 251);
  assert.equal(records.actions[0].messageId, "old-message-0");
  assert.equal(records.attachments.length, 251);
  assert.equal(records.attachments[0].id, "old-attachment-0");
  assert.equal("textContent" in records.attachments[250], false);
});

test("indefinite archive growth is folded into exact counts and hash-chain commitments", async () => {
  let archive = { summary: "Earlier", messageCount: 0, actions: [], attachments: [] };
  const count = 1_000;
  /** @type {import("../src/assistant/store.ts").AssistantArchivedAction[]} */
  const actions = Array.from({ length: count }, (_, index) => ({
    messageId: `message-${index}`,
    kind: "apply-file-updates",
    owner: "writer",
    repo: "novel",
    branch: "main",
    sourceRevision: `revision-${index}`,
    paths: [`chapters/${String(index).padStart(4, "0")}-${"x".repeat(900)}.md`],
  }));
  const attachmentCount = 3_000;
  /** @type {import("../src/assistant/store.ts").AssistantAttachment[]} */
  const attachments = Array.from({ length: attachmentCount }, (_, index) => ({ id: `attachment-${index}`, name: `${"n".repeat(240)}-${index}.txt`, mimeType: "text/plain", kind: "text", sizeBytes: index }));
  const records = await appendAssistantArchiveRecords(archive, actions, attachments);
  archive = { ...archive, ...records, messageCount: count };

  assert.equal(archive.actions.length + archive.rollup.actionCount, count);
  assert.equal(archive.attachments.length + archive.rollup.attachmentCount, attachmentCount);
  assert.match(archive.rollup.actionDigest, /^[a-f0-9]{64}$/);
  assert.match(archive.rollup.attachmentDigest, /^[a-f0-9]{64}$/);
  assert.ok(new TextEncoder().encode(JSON.stringify({ actions: archive.actions, attachments: archive.attachments })).length <= MAX_ARCHIVE_RECORD_BYTES);
  const persistedBytes = new TextEncoder().encode(serializeAssistantSession(session({ messages: [], fileId: undefined, archive, compactedMessageCount: count }))).length;
  assert.ok(persistedBytes < MAX_PERSISTED_CHAT_BYTES);
});

test("repeated compaction removes only the proven prefix and preserves appended context", () => {
  const current = session({ messages: messages(15), compactSummary: "First", compactedMessageCount: 7, archive: { summary: "First", messageCount: 7, actions: [], attachments: [] } });
  const result = session({ messages: messages(15).slice(9), compactSummary: "Second", compactedMessageCount: 16, archive: { summary: "Second", messageCount: 16, actions: [], attachments: [] } });
  const merged = mergeAssistantSessionCompaction(current, "session-1", result);
  assert.deepEqual(merged.messages.map((message) => message.id), messages(15).slice(9).map((message) => message.id));
  assert.equal(merged.archive.messageCount, 16);
});

test("stale or cross-session compaction results are ignored", () => {
  const current = session({ compactSummary: "Newer", compactedMessageCount: 9 });
  const stale = session({ compactSummary: "Older", compactedMessageCount: 7 });
  assert.equal(mergeAssistantSessionCompaction(current, "session-1", stale), current);
  assert.equal(mergeAssistantSessionCompaction(current, "session-2", session({ compactedMessageCount: 10 })), current);
  assert.equal(mergeAssistantSessionCompaction(null, "session-1", stale), null);
});
