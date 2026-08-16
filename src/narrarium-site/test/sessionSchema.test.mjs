import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ASSISTANT_SESSION_BYTES, parseAssistantSession, parseAssistantSessionJson, serializeAssistantSession } from "../src/assistant/sessionSchema.ts";

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
