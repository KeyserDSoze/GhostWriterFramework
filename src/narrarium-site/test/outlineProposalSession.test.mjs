import assert from "node:assert/strict";
import test from "node:test";
import { parseAssistantSession, parseAssistantSessionJson, serializeAssistantSession } from "../src/assistant/sessionSchema.ts";

const session = (updates) => ({
  id: "session-1", title: "Outline", contextTitle: "Outline", updatedAt: "2026-11-21T10:00:00.000Z", attachments: [],
  messages: [{ id: "message-1", role: "assistant", text: "proposal", action: { kind: "undo-file-updates", bookId: "book-1", toolId: "edit-outline", owner: "writer", repo: "novel", branch: "main", sourceRevision: "head", sourceRevisions: Object.fromEntries(updates.map((update) => [update.path, null])), generatedAt: "2026-11-21T10:00:00.000Z", updates } }],
});

test("a saved chat keeps a proposal of the outline that deleted an entry, ready to be undone", () => {
  const updates = [
    { path: "outline/chapters/004.md", content: null, previousContent: "---\nnumber: 4\n---\nFour", status: "applied", appliedHash: null },
    { path: "outline/chapters/005.md", content: "---\nnumber: 5\n---\nFive", previousContent: "---\nnumber: 5\n---\nOld", status: "applied", appliedHash: "abc" },
  ];
  const restored = parseAssistantSessionJson(serializeAssistantSession(parseAssistantSession(session(updates))));
  const action = restored.messages[0].action;
  assert.ok(action && "updates" in action);
  assert.deepEqual(action.updates, updates);
  assert.equal(restored.quarantinedActions.length, 0);
});

test("a saved chat never keeps a deletion outside the outline executable", () => {
  const restored = parseAssistantSession(session([{ path: "chapters/001-wake/chapter.md", content: null }]));
  assert.equal(restored.messages[0].action, undefined);
  assert.equal(restored.quarantinedActions.length, 1);
});
