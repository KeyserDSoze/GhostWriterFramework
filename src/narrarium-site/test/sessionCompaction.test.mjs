import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PERSISTED_CHAT_BYTES } from "../src/assistant/chatCloud.ts";
import { MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES, MAX_ASSISTANT_SESSION_BYTES, parseAssistantSession, serializeAssistantSession } from "../src/assistant/sessionSchema.ts";
import {
  appendAssistantArchiveRecords,
  archiveAction,
  archiveForStorage,
  MAX_ARCHIVE_RECORD_BYTES,
  mergeAssistantSessionCompaction,
  STORAGE_ARCHIVE_BYTES,
  STORAGE_TARGET_BYTES,
  storageArchiveCount,
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

/** A chat of `count` long messages (`size` characters each), compacted through `through` (#122). @param {number} count @param {number} size @param {number} [through] */
function bigChat(count, size, through) {
  /** @type {import("../src/assistant/store.ts").AssistantMessage[]} */
  const list = Array.from({ length: count }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? "assistant" : "user", text: `${index}: ${"x".repeat(size)}` }));
  /** @type {import("../src/assistant/store.ts").ContextCompaction | undefined} */
  const compaction = through === undefined ? undefined : { id: "compaction-1", throughMessageId: list[through].id, messageCount: through + 1, coveredCount: through + 1, summary: "What was said", source: "model", trigger: "auto", at: "2026-11-27T10:00:00.000Z", beforeTokens: 900_000, afterTokens: 80_000 };
  return session({ messages: list, ...(compaction ? { contextCompactions: [compaction] } : {}) });
}

test("a chat keeps every message until it is too large to keep, and then archives only what its compaction already summarised", () => {
  // Thirteen short messages, compacted or not: nothing moves (the old count of twelve messages no longer moves anything out of the chat).
  assert.equal(storageArchiveCount(session()), 0);
  assert.equal(storageArchiveCount(bigChat(40, 1_000, 30)), 0);
  // Past 4 MB with nothing summarised yet: nothing moves either (the compaction comes first).
  assert.equal(storageArchiveCount(bigChat(30, 200_000)), 0);
  // Past 4 MB, compacted through message 19: the first messages move, the fewest that bring the chat under 3 MB, and never one after the compaction's point.
  const chat = bigChat(30, 200_000, 19);
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  assert.ok(bytes({ messages: chat.messages, attachments: [] }) > STORAGE_ARCHIVE_BYTES);
  const count = storageArchiveCount(chat);
  assert.ok(count > 0 && count <= 20, `count ${count}`);
  assert.ok(bytes({ messages: chat.messages.slice(count), attachments: [] }) <= STORAGE_TARGET_BYTES);
  assert.ok(bytes({ messages: chat.messages.slice(count - 1), attachments: [] }) > STORAGE_TARGET_BYTES);
  // Compacted only through message 2: at most three move, even if the chat stays above 3 MB.
  assert.equal(storageArchiveCount(bigChat(30, 200_000, 2)), 3);
  // Short messages, but past 2,000 of them: back to 1,500, within what the compaction covers.
  const many = bigChat(2_400, 10, 2_000);
  assert.equal(storageArchiveCount(many), 900);
  assert.equal(storageArchiveCount(bigChat(1_900, 10, 1_500)), 0);
});

test("what a chat too large to keep archives is lossless: whole messages in segments within their size, a manifest that says them, a chat that saves again", async () => {
  const chat = bigChat(30, 200_000, 19);
  const count = storageArchiveCount(chat);
  const archived = await archiveForStorage(chat, count);
  assert.deepEqual(archived.messages.map((message) => message.id), chat.messages.slice(count).map((message) => message.id));
  const kept = archived.losslessSegments.flatMap((segment) => segment.messages);
  assert.deepEqual(kept, chat.messages.slice(0, count));
  for (const segment of archived.losslessSegments) assert.ok(new TextEncoder().encode(JSON.stringify(segment)).length <= MAX_ASSISTANT_LOSSLESS_SEGMENT_BYTES);
  assert.equal(archived.losslessArchive.segmentCount, archived.losslessSegments.length);
  assert.equal(archived.losslessArchive.messageCount, count);
  const segments = archived.losslessSegments;
  assert.ok(segments.length > 1);
  assert.equal(archived.losslessArchive.head.id, segments[segments.length - 1].id);
  assert.equal(segments[segments.length - 1].previous?.id, segments[segments.length - 2].id);
  assert.equal(archived.compactedMessageCount, count);
  // The summary of the compaction is still the one in force; the attachments stay in the chat.
  assert.deepEqual(archived.contextCompactions, chat.contextCompactions);
  const saved = serializeAssistantSession(archived);
  assert.ok(new TextEncoder().encode(saved).length <= MAX_ASSISTANT_SESSION_BYTES);
  assert.equal(parseAssistantSession({ ...JSON.parse(saved), losslessSegments: archived.losslessSegments }).losslessSegments.length, archived.losslessSegments.length);
  // Merged into the chat as it is now (a message arrived in the meantime): the manifest goes with its segments.
  /** @type {import("../src/assistant/store.ts").AssistantMessage} */
  const arrived = { id: "message-new", role: "user", text: "And now?" };
  const now = { ...chat, messages: [...chat.messages, arrived] };
  const merged = mergeAssistantSessionCompaction(now, chat.id, archived);
  assert.equal(merged.messages[merged.messages.length - 1].id, "message-new");
  assert.equal(merged.messages.length, 31 - count);
  assert.deepEqual(merged.losslessArchive, archived.losslessArchive);
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
