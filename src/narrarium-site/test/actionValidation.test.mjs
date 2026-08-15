import assert from "node:assert/strict";
import test from "node:test";
import { sourceRevisionFromFiles, validateAssistantAction } from "../src/assistant/actionValidation.ts";

const now = Date.parse("2026-08-14T12:00:00.000Z");
const revisions = { "chapters/001/001.md": "sha-1" };
/** @type {import("../src/assistant/store.ts").AssistantAction} */
const action = {
  kind: "apply-paragraph-rewrite",
  bookId: "book",
  chapterSlug: "001",
  paragraphPath: "chapters/001/001.md",
  proposedBody: "New body",
  toolId: "rewrite-current-paragraph",
  owner: "Owner",
  repo: "Book",
  branch: "feature/draft",
  sourceRevision: sourceRevisionFromFiles(revisions),
  sourceRevisions: revisions,
  generatedAt: "2026-08-14T11:00:00.000Z",
};

function validate(overrides = {}) {
  return validateAssistantAction({
    action,
    owner: "owner",
    repo: "book",
    branch: "feature/draft",
    expectedToolId: "rewrite-current-paragraph",
    toolEnabled: true,
    sourceRevision: sourceRevisionFromFiles(revisions),
    now,
    ...overrides,
  });
}

test("accepts a fresh action bound to the current repository, branch, tool, and revision", () => {
  assert.equal(validate(), null);
});

test("cloud-loaded legacy actions without provenance fail closed", () => {
  assert.equal(validate({ action: { kind: "apply-paragraph-rewrite", bookId: "book", chapterSlug: "001", paragraphPath: "chapters/001/001.md", proposedBody: "Old" } }), "missing-provenance");
});

test("malformed cloud action shapes and unsafe paths fail closed", () => {
  assert.equal(validate({ action: { ...action, paragraphPath: "../secrets.md" } }), "invalid-action");
  assert.equal(validate({ action: { ...action, proposedBody: { unsafe: true } } }), "invalid-action");
  assert.equal(validate({ action: { ...action, sourceRevisions: { "../outside.md": "sha" } } }), "missing-provenance");
});

test("rejects repository, branch, tool policy, and source revision mismatches", () => {
  assert.equal(validate({ repo: "another-book" }), "repository-mismatch");
  assert.equal(validate({ branch: "main" }), "branch-mismatch");
  assert.equal(validate({ expectedToolId: "review-context" }), "tool-mismatch");
  assert.equal(validate({ toolEnabled: false }), "tool-disabled");
  assert.equal(validate({ sourceRevision: sourceRevisionFromFiles({ "chapters/001/001.md": "sha-2" }) }), "source-revision-mismatch");
});

test("rejects expired, invalid, and implausibly future generation timestamps", () => {
  assert.equal(validate({ action: { ...action, generatedAt: "2026-08-12T11:00:00.000Z" } }), "expired");
  assert.equal(validate({ action: { ...action, generatedAt: "invalid" } }), "expired");
  assert.equal(validate({ action: { ...action, generatedAt: "2026-08-14T13:00:00.000Z" } }), "expired");
});

test("source revision serialization is stable across path insertion order", () => {
  assert.equal(sourceRevisionFromFiles({ "b.md": null, "a.md": "sha-a" }), sourceRevisionFromFiles({ "a.md": "sha-a", "b.md": null }));
});
