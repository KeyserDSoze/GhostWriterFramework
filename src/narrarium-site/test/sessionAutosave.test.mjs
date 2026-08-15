import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantSessionSaveQueue,
  assistantSessionSaveFingerprint,
  attachAssistantSessionFileId,
  upsertAssistantSessionMeta,
} from "../src/assistant/sessionAutosave.ts";

function session(overrides = {}) {
  return {
    id: "session-1",
    title: "Chat",
    contextTitle: "Book",
    updatedAt: "2026-08-14T10:00:00.000Z",
    messages: [],
    attachments: [],
    compactSummary: "",
    compactedMessageCount: 0,
    ...overrides,
  };
}

function deferred() {
  /** @type {(value?: any) => void} */
  let resolve = () => undefined;
  /** @type {(reason?: any) => void} */
  let reject = () => undefined;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("save fingerprint ignores cloud file identity but tracks chat content", () => {
  const original = session();
  assert.equal(assistantSessionSaveFingerprint(original), assistantSessionSaveFingerprint({ ...original, fileId: "drive-file" }));
  assert.notEqual(
    assistantSessionSaveFingerprint(original),
    assistantSessionSaveFingerprint({ ...original, messages: [{ id: "m1", role: "user", text: "New" }] }),
  );
});

test("session metadata upsert removes id and file duplicates", () => {
  const result = upsertAssistantSessionMeta([
    { id: "session-1", fileId: "old-file", title: "Old", contextTitle: "Old", updatedAt: "2026-01-01" },
    { id: "other-id", fileId: "new-file", title: "Duplicate file", contextTitle: "Old", updatedAt: "2026-01-01" },
    { id: "session-2", fileId: "file-2", title: "Keep", contextTitle: "Book", updatedAt: "2026-01-01" },
  ], session(), "new-file");

  assert.deepEqual(result.map((entry) => [entry.id, entry.fileId]), [
    ["session-1", "new-file"],
    ["session-2", "file-2"],
  ]);
});

test("attaching a file id preserves newer content and ignores another current session", () => {
  const latest = session({ messages: [{ id: "m1", role: "assistant", text: "Latest reply" }] });
  const attached = attachAssistantSessionFileId(latest, "session-1", "drive-file");
  assert.equal(attached.fileId, "drive-file");
  assert.equal(attached.messages[0].text, "Latest reply");

  const other = session({ id: "session-2" });
  assert.equal(attachAssistantSessionFileId(other, "session-1", "drive-file"), other);
});

test("queued saves are serialized and reuse the first created file id", async () => {
  const queue = new AssistantSessionSaveQueue();
  const first = deferred();
  const firstStarted = deferred();
  const calls = [];
  const saved = [];
  const errors = [];
  const save = async (snapshot) => {
    calls.push(snapshot);
    if (calls.length === 1) {
      firstStarted.resolve();
      return first.promise;
    }
    return "drive-file";
  };

  const firstSave = queue.enqueue(session(), save, (snapshot, fileId) => saved.push([snapshot, fileId]), (error) => errors.push(error));
  const secondSave = queue.enqueue(
    session({ messages: [{ id: "m1", role: "assistant", text: "Reply" }] }),
    save,
    (snapshot, fileId) => saved.push([snapshot, fileId]),
    (error) => errors.push(error),
  );

  await firstStarted.promise;
  assert.equal(calls.length, 1);
  first.resolve("drive-file");
  await Promise.all([firstSave, secondSave]);

  assert.equal(errors.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].fileId, "drive-file");
  assert.equal(calls[1].messages[0].text, "Reply");
  assert.equal(saved.length, 2);
});

test("a failed save does not block the next queued revision", async () => {
  const queue = new AssistantSessionSaveQueue();
  const errors = [];
  let call = 0;
  const save = async () => {
    call += 1;
    if (call === 1) throw new Error("temporary failure");
    return "drive-file";
  };

  await Promise.all([
    queue.enqueue(session(), save, () => undefined, (error) => errors.push(error)),
    queue.enqueue(session({ updatedAt: "2026-08-14T10:01:00.000Z" }), save, () => undefined, (error) => errors.push(error)),
  ]);

  assert.equal(call, 2);
  assert.equal(errors.length, 1);
});
