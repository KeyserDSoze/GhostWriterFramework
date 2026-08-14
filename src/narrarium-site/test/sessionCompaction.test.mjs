import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantSessionCompactionTarget,
  mergeAssistantSessionCompaction,
} from "../src/assistant/sessionCompaction.ts";

function messages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `Message ${index}`,
  }));
}

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
  assert.equal(assistantSessionCompactionTarget(session({ compactedMessageCount: 7 })), null);
  assert.equal(assistantSessionCompactionTarget(session({ messages: messages(15), compactedMessageCount: 7 })), 9);
});

test("compaction merge preserves newer session data", () => {
  const current = session({
    messages: messages(15),
    attachments: [{ id: "a1", name: "notes.md", mimeType: "text/markdown", kind: "text", sizeBytes: 10, textContent: "notes" }],
    updatedAt: "2026-08-14T12:01:00.000Z",
  });
  const compacted = session({ compactSummary: "Summary", compactedMessageCount: 7 });
  const merged = mergeAssistantSessionCompaction(current, "session-1", compacted);

  assert.equal(merged.compactSummary, "Summary");
  assert.equal(merged.compactedMessageCount, 7);
  assert.equal(merged.messages.length, 15);
  assert.equal(merged.attachments.length, 1);
  assert.equal(merged.fileId, "drive-file");
  assert.equal(merged.updatedAt, "2026-08-14T12:01:00.000Z");
});

test("stale or cross-session compaction results are ignored", () => {
  const current = session({ compactSummary: "Newer", compactedMessageCount: 9 });
  const stale = session({ compactSummary: "Older", compactedMessageCount: 7 });
  assert.equal(mergeAssistantSessionCompaction(current, "session-1", stale), current);
  assert.equal(mergeAssistantSessionCompaction(current, "session-2", session({ compactedMessageCount: 10 })), current);
  assert.equal(mergeAssistantSessionCompaction(null, "session-1", stale), null);
});
