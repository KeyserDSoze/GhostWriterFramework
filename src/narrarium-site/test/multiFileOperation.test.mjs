import assert from "node:assert/strict";
import test from "node:test";
import { currentRevisionToken, fileRevisionMatches, fileUpdateCounts, markFileUpdatesApplied, markFileUpdatesFailed, markFileUpdatesUndone, pendingFileUpdates } from "../src/assistant/multiFileOperation.ts";

const updates = [
  { path: "a.md", content: "A" },
  { path: "b.md", content: "B" },
  { path: "c.md", content: "C" },
];

test("subset apply preserves every unapplied proposal", () => {
  const selected = pendingFileUpdates(updates, ["b.md"]);
  assert.deepEqual(selected.map((update) => update.path), ["b.md"]);
  const next = markFileUpdatesApplied(updates, { "b.md": { previousContent: "old B", appliedHash: "hash-b" } });
  assert.deepEqual(next.map((update) => [update.path, update.status]), [["a.md", undefined], ["b.md", "applied"], ["c.md", undefined]]);
  assert.deepEqual(pendingFileUpdates(next).map((update) => update.path), ["a.md", "c.md"]);
});

test("atomic failure records exact failed and pending files for retry", () => {
  const next = markFileUpdatesFailed(updates, ["a.md", "c.md"], "branch conflict");
  assert.deepEqual(fileUpdateCounts(next), { pending: 1, applied: 0, failed: 2 });
  assert.deepEqual(pendingFileUpdates(next).map((update) => update.path), ["a.md", "b.md", "c.md"]);
});

test("undo returns only applied files to pending without discarding other proposals", () => {
  const applied = markFileUpdatesApplied(updates, {
    "a.md": { previousContent: null, appliedHash: "hash-a" },
    "b.md": { previousContent: "old B", appliedHash: "hash-b" },
  });
  const undone = markFileUpdatesUndone(applied, ["a.md"]);
  assert.equal(undone[0].status, "pending");
  assert.equal(undone[0].appliedHash, undefined);
  assert.equal(undone[1].status, "applied");
  assert.equal(undone[2].status, undefined);
});

test("revision tokens support original SHAs, resulting hashes, and stale undo refusal", () => {
  assert.equal(fileRevisionMatches("git-sha", "git-sha", "content-hash"), true);
  assert.equal(fileRevisionMatches("content-hash", "new-git-sha", "content-hash"), true);
  assert.equal(fileRevisionMatches("applied-hash", "newer-sha", "intervening-edit"), false);
  assert.equal(currentRevisionToken("content-hash", "new-git-sha", "content-hash"), "content-hash");
});

test("create update and delete recovery states retain the required content", () => {
  const mixed = markFileUpdatesApplied(updates, {
    "a.md": { previousContent: null, appliedHash: "created" },
    "b.md": { previousContent: "before update", appliedHash: "updated" },
    "c.md": { previousContent: "before delete", appliedHash: "deleted" },
  });
  assert.equal(mixed[0].previousContent, null);
  assert.equal(mixed[1].previousContent, "before update");
  assert.equal(mixed[2].previousContent, "before delete");
});
