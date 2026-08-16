import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ASSISTANT_SESSION_BYTES, parseAssistantLosslessSegment, parseAssistantSession, parseAssistantSessionJson, serializeAssistantLosslessSegment, serializeAssistantSession } from "../src/assistant/sessionSchema.ts";

function legacy(overrides = {}) {
  return { id: "session-1", title: "Legacy", contextTitle: "Book", updatedAt: "2026-08-15T10:00:00.000Z", messages: [], ...overrides };
}

test("legacy sessions migrate missing arrays and compaction defaults to schema v1", () => {
  const migrated = parseAssistantSession(legacy());
  assert.equal(migrated.schemaVersion, 1);
  assert.deepEqual(migrated.attachments, []);
  assert.deepEqual(migrated.quarantinedActions, []);
  assert.equal(migrated.compactSummary, "");
  assert.equal(migrated.compactedMessageCount, 0);
  assert.match(serializeAssistantSession(migrated), /"schemaVersion": 1/);
});

test("unsafe persisted actions are quarantined and cannot remain executable", () => {
  const migrated = parseAssistantSession(legacy({
    messages: [{ id: "message-1", role: "assistant", text: "Delete it", action: { kind: "confirm-delete", bookId: "book-1", target: "note", path: "../../book.md", title: "Unsafe" } }],
  }));
  assert.equal(migrated.messages[0].action, undefined);
  assert.equal(migrated.quarantinedActions.length, 1);
  const roundTrip = parseAssistantSessionJson(serializeAssistantSession(migrated));
  assert.equal(roundTrip.messages[0].action, undefined);
  assert.equal(roundTrip.quarantinedActions.length, 1);
});

test("versioned and malformed sessions fail closed", () => {
  assert.throws(() => parseAssistantSession({ ...legacy(), schemaVersion: 1 }), /arrays are required/);
  assert.throws(() => parseAssistantSession({ ...legacy(), id: "../bad", attachments: [] }), /session.id is invalid/);
  assert.throws(() => parseAssistantSession({ ...legacy(), updatedAt: "yesterday", attachments: [] }), /updatedAt is invalid/);
  assert.throws(() => parseAssistantSession({ ...legacy(), attachments: [{ id: "a", name: "a", mimeType: "text/plain", kind: "text", sizeBytes: -1 }] }), /sizeBytes is invalid/);
  assert.throws(() => parseAssistantSessionJson("{"), /valid JSON/);
});

test("session validation and migration use the effective 8 MiB cloud payload limit", () => {
  const aboveLegacyLimit = 5 * 1024 * 1024 + 1;
  assert.equal(MAX_ASSISTANT_SESSION_BYTES, 8 * 1024 * 1024);
  assert.doesNotThrow(() => parseAssistantSession(legacy({ attachments: [] }), aboveLegacyLimit));
  assert.throws(() => parseAssistantSession(legacy({ attachments: [] }), MAX_ASSISTANT_SESSION_BYTES + 1), /size limit/);
});

test("archived action provenance survives schema validation and serialization", () => {
  const archiveAction = {
    messageId: "message-1", kind: "apply-file-updates", bookId: "book-1", toolId: "multi-file-edit",
    owner: "writer", repo: "novel", branch: "main", sourceRevision: "head123",
    sourceRevisions: { "plot.md": "plot123" }, generatedAt: "2026-08-15T10:00:00.000Z", paths: ["plot.md"],
  };
  const migrated = parseAssistantSessionJson(serializeAssistantSession(parseAssistantSession(legacy({
    attachments: [], archive: { summary: "", messageCount: 1, actions: [archiveAction], attachments: [] },
  }))));
  assert.deepEqual(migrated.archive.actions, [archiveAction]);
});

test("lossless compaction segments preserve full messages, actions, and attachment bodies", () => {
  const segment = {
    format: /** @type {const} */ ("narrarium-assistant-chat-segment"), version: /** @type {const} */ (1), id: "segment-1", createdAt: "2026-08-16T10:00:00.000Z",
    messages: [{ id: "message-1", role: "assistant", text: "proposal", action: { kind: "apply-file-updates", bookId: "book-1", toolId: "multi-file-edit", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head", sourceRevisions: { "plot.md": "sha" }, generatedAt: "2026-08-16T10:00:00.000Z", updates: [{ path: "plot.md", content: "new", previousContent: "old" }] } }],
    attachments: [{ id: "attachment-1", name: "notes.txt", mimeType: "text/plain", kind: "text", sizeBytes: 5, textContent: "notes" }],
  };
  const restored = parseAssistantLosslessSegment(JSON.parse(serializeAssistantLosslessSegment(/** @type {import("../src/assistant/store.ts").AssistantLosslessSegment} */ (segment))));
  assert.deepEqual(restored.messages[0].action, segment.messages[0].action);
  assert.equal(restored.attachments[0].textContent, "notes");
  const primary = serializeAssistantSession(parseAssistantSession(legacy({ attachments: [], losslessSegments: [segment] })));
  assert.doesNotMatch(primary, /losslessSegments/);
});

test("legacy compacted sessions are explicitly marked incomplete", () => {
  const migrated = parseAssistantSession(legacy({ attachments: [], compactedMessageCount: 4, compactSummary: "summary" }));
  assert.equal(migrated.losslessArchive.complete, false);
  assert.deepEqual(migrated.losslessArchive.missingRanges, [{ from: 0, to: 3, reason: "Legacy compaction did not preserve original records." }]);
});
