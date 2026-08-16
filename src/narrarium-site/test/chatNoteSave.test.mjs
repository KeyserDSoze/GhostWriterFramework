import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatNoteDestination, reusableChatNoteOperation, retryChatNoteConflict } from "../src/assistant/chatNoteSave.ts";

const source = { bookId: "book-a", owner: "owner", repo: "a", branch: "work-a", noteTargetPath: "notes.md" };
const current = { bookId: "book-b", owner: "owner", repo: "b", branch: "work-b", noteTargetPath: "drafts/chapter/notes.md" };
const session = { id: "session-1", title: "Chat", contextTitle: "A", updatedAt: "2026-08-15T10:00:00.000Z", messages: [], attachments: [], compactSummary: "", compactedMessageCount: 0, provenance: source };

test("a provenance-bound chat keeps book A as destination while book B is open", () => {
  assert.deepEqual(resolveChatNoteDestination(session, current), { destination: source, legacyOrCrossBook: true });
});

test("legacy chat uses the explicit current destination and requires elevated confirmation", () => {
  assert.deepEqual(resolveChatNoteDestination({ ...session, provenance: undefined }, current), { destination: current, legacyOrCrossBook: true });
  assert.equal(resolveChatNoteDestination({ ...session, provenance: undefined }), null);
});

test("failed delete retries reuse the operation id instead of appending again", () => {
  /** @type {import("../src/assistant/store.ts").AssistantNoteSaveOperation} */
  const operation = { id: "operation-1", mode: "full", destination: source, status: "delete-failed", deleteAfter: true, updatedAt: "2026-08-15T10:01:00.000Z" };
  assert.equal(reusableChatNoteOperation({ ...session, noteSaveOperation: operation }, "full", source, true)?.id, "operation-1");
  assert.equal(reusableChatNoteOperation({ ...session, noteSaveOperation: operation }, "reply-summary", source, true), undefined);
});

test("an ambiguous delete response keeps the note-saved operation retryable", () => {
  /** @type {import("../src/assistant/store.ts").AssistantNoteSaveOperation} */
  const operation = { id: "operation-ambiguous", mode: "full", destination: source, status: "note-saved", deleteAfter: true, updatedAt: "2026-08-15T10:01:00.000Z" };
  assert.equal(reusableChatNoteOperation({ ...session, noteSaveOperation: operation }, "full", source, true), operation);
});

test("note append retries conflicts but never treats arbitrary failures as a missing file", async () => {
  let attempts = 0;
  const result = await retryChatNoteConflict(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("changed"), { kind: "conflict" });
    return "saved";
  });
  assert.equal(result, "saved");
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(() => retryChatNoteConflict(async () => {
    attempts += 1;
    throw Object.assign(new Error("offline"), { kind: "network" });
  }), /offline/);
  assert.equal(attempts, 1);
});
