import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantSessionSaveQueue,
  assistantSessionSaveFingerprint,
  assistantSessionSaveRetryPlan,
  attachAssistantSessionCloudHandle,
  clearFailedAssistantSessionSaveFingerprint,
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

test("a transient failure clears only its unchanged fingerprint so the same session can retry", () => {
  const fingerprints = new Map([["session-1", "failed"]]);
  assert.equal(clearFailedAssistantSessionSaveFingerprint(fingerprints, "session-1", "failed"), true);
  assert.equal(fingerprints.has("session-1"), false);

  fingerprints.set("session-1", "newer");
  assert.equal(clearFailedAssistantSessionSaveFingerprint(fingerprints, "session-1", "failed"), false);
  assert.equal(fingerprints.get("session-1"), "newer");
});

test("permanent autosave failures stop without retrying", () => {
  assert.deepEqual(assistantSessionSaveRetryPlan({ code: "ASSISTANT_SESSION_TOO_LARGE" }, 0), { kind: "stop", reason: "permanent" });
  assert.deepEqual(assistantSessionSaveRetryPlan({ code: "INVALID_ASSISTANT_SESSION" }, 0), { kind: "stop", reason: "permanent" });
  assert.deepEqual(assistantSessionSaveRetryPlan({ code: "ASSISTANT_SESSION_CONFLICT" }, 0), { kind: "stop", reason: "permanent" });
  assert.deepEqual(assistantSessionSaveRetryPlan({ status: 401 }, 0), { kind: "stop", reason: "permanent" });
});

test("transient autosave failures use bounded exponential retries", () => {
  assert.deepEqual(assistantSessionSaveRetryPlan({ status: 503 }, 0), { kind: "retry", attempt: 1, delayMs: 1_000 });
  assert.deepEqual(assistantSessionSaveRetryPlan({ status: 429 }, 1), { kind: "retry", attempt: 2, delayMs: 2_000 });
  assert.deepEqual(assistantSessionSaveRetryPlan(new TypeError("offline"), 2), { kind: "retry", attempt: 3, delayMs: 4_000 });
  assert.deepEqual(assistantSessionSaveRetryPlan({ status: 503 }, 3), { kind: "stop", reason: "exhausted" });
});

test("session metadata upsert removes id and file duplicates", () => {
  const result = upsertAssistantSessionMeta([
    { id: "session-1", fileId: "old-file", title: "Old", contextTitle: "Old", updatedAt: "2026-01-01" },
    { id: "other-id", fileId: "new-file", title: "Duplicate file", contextTitle: "Old", updatedAt: "2026-01-01" },
    { id: "session-2", fileId: "file-2", title: "Keep", contextTitle: "Book", updatedAt: "2026-01-01" },
  ], session(), { fileId: "new-file", revision: "r2" });

  assert.deepEqual(result.map((entry) => [entry.id, entry.fileId]), [
    ["session-1", "new-file"],
    ["session-2", "file-2"],
  ]);
});

test("attaching a file id preserves newer content and ignores another current session", () => {
  const latest = session({ messages: [{ id: "m1", role: "assistant", text: "Latest reply" }] });
  const attached = attachAssistantSessionCloudHandle(latest, "session-1", { fileId: "drive-file", revision: "r1" });
  assert.equal(attached.fileId, "drive-file");
  assert.equal(attached.messages[0].text, "Latest reply");

  const other = session({ id: "session-2" });
  assert.equal(attachAssistantSessionCloudHandle(other, "session-1", { fileId: "drive-file" }), other);
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
    return { fileId: "drive-file", revision: "r2" };
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
  first.resolve({ fileId: "drive-file", revision: "r1" });
  await Promise.all([firstSave, secondSave]);

  assert.equal(errors.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].fileId, "drive-file");
  assert.equal(calls[1].revision, "r1");
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
    return { fileId: "drive-file", revision: "r1" };
  };

  await Promise.all([
    queue.enqueue(session(), save, () => undefined, (error) => errors.push(error)),
    queue.enqueue(session({ updatedAt: "2026-08-14T10:01:00.000Z" }), save, () => undefined, (error) => errors.push(error)),
  ]);

  assert.equal(call, 2);
  assert.equal(errors.length, 1);
});

test("account reset ignores an in-flight save and clears its cloud handle", async () => {
  const queue = new AssistantSessionSaveQueue();
  const pending = deferred();
  const saved = [];
  const errors = [];
  const first = queue.enqueue(session(), () => pending.promise, (...args) => saved.push(args), (error) => errors.push(error));
  queue.reset();
  pending.resolve({ fileId: "old-account-file", revision: "old-revision" });
  await first;
  assert.deepEqual(saved, []);
  assert.deepEqual(errors, []);

  const calls = [];
  await queue.enqueue(session(), async (snapshot) => {
    calls.push(snapshot);
    return { fileId: "new-account-file", revision: "new-revision" };
  }, () => undefined, (error) => errors.push(error));
  assert.equal(calls[0].fileId, undefined);
});

test("retiring a session waits for its in-flight autosave and blocks recreation", async () => {
  const queue = new AssistantSessionSaveQueue();
  const pending = deferred();
  const started = deferred();
  let saves = 0;
  const first = queue.enqueue(session({ fileId: "cloud-file" }), async () => {
    saves += 1;
    started.resolve();
    return pending.promise;
  }, () => undefined, () => undefined);
  await started.promise;
  const retired = queue.retire("session-1");
  await queue.enqueue(session({ updatedAt: "2026-08-15T11:00:00.000Z" }), async () => {
    saves += 1;
    return { fileId: "recreated" };
  }, () => undefined, () => undefined);
  assert.equal(saves, 1);
  pending.resolve({ fileId: "cloud-file", revision: "r1" });
  await Promise.all([first, retired]);
  assert.equal(saves, 1);
});
