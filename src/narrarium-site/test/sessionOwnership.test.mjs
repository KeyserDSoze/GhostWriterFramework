import assert from "node:assert/strict";
import test from "node:test";
import { isAssistantRequestOwned } from "../src/assistant/sessionOwnership.ts";
import { useAssistantStore } from "../src/assistant/store.ts";

/** @param {string} id @param {string} [text] @returns {import("../src/assistant/store.ts").AssistantSession} */
function session(id, text = "Initial") {
  return {
    id,
    title: "Chat",
    contextTitle: "Book",
    updatedAt: "2026-08-14T13:00:00.000Z",
    messages: [{ id: "message-1", role: "assistant", text }],
    attachments: [],
    compactSummary: "",
    compactedMessageCount: 0,
  };
}

test("session-scoped updates cannot mutate a different current chat", () => {
  useAssistantStore.setState({ currentSession: session("session-b") });
  useAssistantStore.getState().updateSession("session-a", (current) => ({ ...current, title: "Wrong" }));
  useAssistantStore.getState().updateSessionMessage("session-a", "message-1", { text: "Wrong" });

  const current = useAssistantStore.getState().currentSession;
  assert.equal(current.id, "session-b");
  assert.equal(current.title, "Chat");
  assert.equal(current.messages[0].text, "Initial");
});

test("session-scoped updates mutate only the expected chat and message", () => {
  useAssistantStore.setState({ currentSession: session("session-a") });
  useAssistantStore.getState().updateSession("session-a", (current) => ({ ...current, contextTitle: "Updated book" }));
  useAssistantStore.getState().updateSessionMessage("session-a", "message-1", { text: "Streamed reply" });
  useAssistantStore.getState().updateSessionMessage("session-a", "missing", { text: "Ignored" });

  const current = useAssistantStore.getState().currentSession;
  assert.equal(current.contextTitle, "Updated book");
  assert.equal(current.messages.length, 1);
  assert.equal(current.messages[0].text, "Streamed reply");
});

test("request ownership requires matching request, active session, and non-aborted signal", () => {
  const active = { requestId: "request-1", sessionId: "session-a", contextGeneration: 3, pathname: "/app/books/book/canon/secrets/truth", bookId: "book", branch: "main", secretPath: "secrets/truth.md" };
  const current = { contextGeneration: 3, pathname: active.pathname, bookId: active.bookId, branch: active.branch, secretPath: active.secretPath };
  assert.equal(isAssistantRequestOwned(active, active, "session-a", current, false), true);
  assert.equal(isAssistantRequestOwned(active, { ...active, requestId: "request-2" }, "session-a", current, false), false);
  assert.equal(isAssistantRequestOwned(active, active, "session-b", current, false), false);
  assert.equal(isAssistantRequestOwned(active, active, "session-a", { ...current, contextGeneration: 4 }, false), false);
  assert.equal(isAssistantRequestOwned(active, active, "session-a", { ...current, pathname: "/app/settings", bookId: null, secretPath: null }, false), false);
  assert.equal(isAssistantRequestOwned(active, active, "session-a", current, true), false);
  assert.equal(isAssistantRequestOwned(null, active, "session-a", current, false), false);
});
