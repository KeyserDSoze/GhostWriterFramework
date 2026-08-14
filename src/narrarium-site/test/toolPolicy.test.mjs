import assert from "node:assert/strict";
import test from "node:test";
import { assistantActionToolId, policyTargetEnabled, quickActionToolId } from "../src/assistant/toolPolicy.ts";

test("maps every Copilot quick action to an enforceable tool setting", () => {
  const expected = {
    fix: "rewrite-current-paragraph",
    review: "review-context",
    evaluation: "write-evaluation",
    resume: "write-resume",
    summary: "summarize-context",
    enrich: "answer-from-context",
    consistency: "answer-from-context",
    appearances: "search-book",
    reveal: "review-context",
    plot: "update-plot",
    search: "search-book",
    note: "create-note",
    diff: "show-branch-diff",
  };

  for (const [actionId, toolId] of Object.entries(expected)) {
    assert.equal(quickActionToolId(actionId), toolId);
  }
});

test("maps persisted actions to the setting that must be rechecked", () => {
  assert.equal(assistantActionToolId({ kind: "apply-paragraph-rewrite", bookId: "book", chapterSlug: "001", paragraphPath: "p.md", proposedBody: "text" }), "rewrite-current-paragraph");
  assert.equal(assistantActionToolId({ kind: "switch-book-branch", bookId: "book", branchName: "draft" }), "switch-branch");
  assert.equal(assistantActionToolId({ kind: "read-aloud", bookId: "book", title: "Chapter", paths: ["chapter.md"] }), "read-current-page");
  assert.equal(assistantActionToolId({ kind: "confirm-delete", bookId: "book", target: "paragraph", path: "p.md", title: "Paragraph" }), "delete-current-paragraph");
  assert.equal(assistantActionToolId({ kind: "navigate", to: "/app/books/book/reader" }), "open-reader");
  assert.equal(assistantActionToolId({ kind: "navigate", to: "/app/books/book/research" }), "navigate-app");
  assert.equal(assistantActionToolId({ kind: "navigate", to: "/app/books/book/audit?action=run" }), "run-audit");
  assert.equal(assistantActionToolId({ kind: "navigate", to: "/app/books/book/audit?action=delete" }), "delete-audit");
  assert.equal(assistantActionToolId({ kind: "navigate", to: "/app/books/book/audit" }), "open-audit");
  assert.equal(assistantActionToolId({ kind: "navigate", to: "/app/books/book/audit?action=run", toolId: "update-audit" }), "update-audit");
  assert.equal(assistantActionToolId({ kind: "confirm-delete", bookId: "book", target: "note", path: "notes.md", title: "Notes", toolId: "review-context" }), "delete-current-note");
});

test("an all-tools-disabled policy rejects contextual answers, quick actions, and persisted actions", () => {
  const allDisabled = () => false;
  assert.equal(policyTargetEnabled("answer-from-context", allDisabled), false);
  assert.equal(policyTargetEnabled(quickActionToolId("fix"), allDisabled), false);
  assert.equal(policyTargetEnabled(assistantActionToolId({ kind: "navigate", to: "/app/books/book/reader" }), allDisabled), false);
  assert.equal(policyTargetEnabled(null, allDisabled), false);
});
