import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyAssistantSession, useAssistantStore } from "../src/assistant/store.ts";
import { parseAssistantSession, serializeAssistantSession } from "../src/assistant/sessionSchema.ts";
import { upsertAssistantSessionMeta } from "../src/assistant/sessionAutosave.ts";

// Brainstorming is a mode of the Copilot on the Synopsis page: its chats are the Copilot's chats, tagged with the mode and their book, and the
// Copilot's own chat waits aside while the mode lasts and comes back as it was.

const target = (bookId = "book-1") => ({ bookId, title: `Brainstorming · ${bookId}` });

function reset() {
  useAssistantStore.setState({ open: false, launchMode: null, busy: false, currentSession: null, brainstorming: null, copilotSession: null, pageLauncher: null });
}

test("a chat of Brainstorming keeps its mode and its book through a save and a load", () => {
  const session = createEmptyAssistantSession("Brainstorming · The Glass Harbor", undefined, { bookId: "book-1" });
  assert.equal(session.mode, "brainstorming");
  assert.equal(session.bookId, "book-1");
  const loaded = parseAssistantSession(JSON.parse(serializeAssistantSession(session)));
  assert.equal(loaded.mode, "brainstorming");
  assert.equal(loaded.bookId, "book-1");
  const copilot = parseAssistantSession(JSON.parse(serializeAssistantSession(createEmptyAssistantSession("Book"))));
  assert.equal(copilot.mode, undefined, "a chat of the Copilot has no mode");
  assert.equal(copilot.bookId, undefined);
});

test("a mode this version does not know is a chat of the Copilot, and a chat of Brainstorming without a book is refused", () => {
  const base = JSON.parse(serializeAssistantSession(createEmptyAssistantSession("Book")));
  assert.equal(parseAssistantSession({ ...base, mode: "journal", bookId: "book-1" }).mode, undefined);
  assert.throws(() => parseAssistantSession({ ...base, mode: "brainstorming" }), /session\.bookId/);
  assert.throws(() => parseAssistantSession({ ...base, mode: "brainstorming", bookId: "../other" }), /session\.bookId/);
});

test("the list of the chats says which ones are Brainstorming's, and of which book", () => {
  const brainstorm = createEmptyAssistantSession("Brainstorming · A", undefined, { bookId: "book-1" });
  const copilot = createEmptyAssistantSession("Book");
  const sessions = upsertAssistantSessionMeta(upsertAssistantSessionMeta([], copilot, { fileId: copilot.id }), brainstorm, { fileId: brainstorm.id });
  assert.deepEqual(sessions.map((meta) => [meta.mode, meta.bookId]), [["brainstorming", "book-1"], [undefined, undefined]]);
});

test("starting Brainstorming keeps the Copilot's chat aside, and ending it brings that chat back as it was", () => {
  reset();
  const copilot = createEmptyAssistantSession("Book");
  copilot.messages = [{ id: "m1", role: "user", text: "Summarize chapter 2" }];
  useAssistantStore.setState({ currentSession: copilot });
  useAssistantStore.getState().startBrainstorming(target());
  let state = useAssistantStore.getState();
  assert.deepEqual(state.brainstorming, target());
  assert.equal(state.open, true);
  assert.equal(state.launchMode, "chat");
  assert.equal(state.currentSession, null, "the panel opens the book's latest chat of Brainstorming, or a new one");
  assert.equal(state.copilotSession, copilot);

  const brainstorm = createEmptyAssistantSession(target().title, undefined, { bookId: "book-1" });
  state.setCurrentSession(brainstorm);
  state.stopBrainstorming();
  state = useAssistantStore.getState();
  assert.equal(state.brainstorming, null);
  assert.equal(state.currentSession, copilot, "the Copilot's chat is back, the same object");
  assert.equal(state.copilotSession, null);
});

test("the Copilot's launcher ends Brainstorming too, and a Brainstorming of another book never shows the chat of the first", () => {
  reset();
  const copilot = createEmptyAssistantSession("Book");
  useAssistantStore.setState({ currentSession: copilot });
  const store = useAssistantStore.getState();
  store.startBrainstorming(target("book-1"));
  const first = createEmptyAssistantSession(target("book-1").title, undefined, { bookId: "book-1" });
  useAssistantStore.getState().setCurrentSession(first);
  useAssistantStore.getState().startBrainstorming(target("book-1"));
  assert.equal(useAssistantStore.getState().currentSession, first, "the same book keeps its chat");
  useAssistantStore.getState().startBrainstorming(target("book-2"));
  assert.equal(useAssistantStore.getState().currentSession, null, "another book opens its own");
  assert.equal(useAssistantStore.getState().copilotSession, copilot, "the Copilot's chat is still the one kept aside");
  useAssistantStore.getState().launch("chat");
  const state = useAssistantStore.getState();
  assert.equal(state.brainstorming, null);
  assert.equal(state.currentSession, copilot);
  assert.equal(state.open, true);
});

test("ending Brainstorming when it is not on changes nothing", () => {
  reset();
  const copilot = createEmptyAssistantSession("Book");
  useAssistantStore.setState({ currentSession: copilot });
  useAssistantStore.getState().stopBrainstorming();
  assert.equal(useAssistantStore.getState().currentSession, copilot);
  useAssistantStore.getState().launch("voice");
  assert.equal(useAssistantStore.getState().currentSession, copilot);
});
