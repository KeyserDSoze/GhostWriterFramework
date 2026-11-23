import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The idea of the book is the description of the book: the body of `outline/book.md`, and nowhere else. `outline/_brief.md` keeps the
// genre, the audience, the words of a scene and the synopsis. These tests are about where each text lives, what a write refuses, and what a
// book saved before this rule gets once.

const STATE = "autopilot/state.json";
const BOOK = engine.OUTLINE_BOOK_FILE;
const BRIEF = engine.OUTLINE_BRIEF_FILE;
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const clock = () => new Date("2026-01-01T00:00:00.000Z");

/** A long idea of the author's, several thousand characters, with the three plans of the book. */
function longIdea(characters) {
  const paragraph = "Mira keeps the lighthouse light alive while the harbor forgets the storm that broke the sea wall. ";
  const plans = "Long-term: the town learns the truth. Mid-term: the council falls. Short-term: the first night of the storm. ";
  let text = `Idea, promise or pitch.\n\n${plans}\n\n`;
  while (text.length < characters) text += `${paragraph}\n`;
  const cut = text.slice(0, characters);
  return /\s$/.test(cut) ? `${cut.slice(0, -1)}.` : cut;
}

const bookText = (store) => engine.parseMarkdown(store.files.get(BOOK) ?? "").body;

test("the idea round-trips at 12 000 characters: it is the body of outline/book.md, and the brief file has no idea", async () => {
  const idea = longIdea(12_000);
  const store = new MemoryBookStore(seedBookFiles());
  const saved = await engine.writeOutlineBrief(store, { idea, genre: "Mystery", wordsPerScene: 900, synopsis: "1. Mira arrives." });
  assert.equal(saved.idea, idea);
  assert.equal(bookText(store), idea, "the description of the book is the idea, whole");
  const file = engine.parseMarkdown(store.files.get(BRIEF));
  assert.equal("idea" in file.frontmatter, false, "the brief file has no idea");
  assert.equal(file.frontmatter.genre, "Mystery");
  assert.equal(file.frontmatter.wordsPerScene, 900);
  assert.equal(file.body, "1. Mira arrives.");

  const read = await engine.readOutlineBrief(store);
  assert.equal(read.brief.idea, idea, "read back whole");
  assert.deepEqual([read.brief.genre, read.brief.audience, read.brief.wordsPerScene, read.brief.synopsis], ["Mystery", "", 900, "1. Mira arrives."]);
});

test("an idea over the limit is refused: nothing is written, and the error says the length and the limit", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const before = new Map(store.files);
  const commits = store.commits.length;
  const tooLong = longIdea(engine.OUTLINE_BOOK_MAX_CHARS + 1);
  await assert.rejects(() => engine.writeOutlineBrief(store, { idea: tooLong, genre: "Thriller" }), (error) => {
    assert.ok(error instanceof engine.OutlineTextLimitError, String(error));
    assert.equal(error.code, "text_too_long");
    assert.equal(error.limit, engine.OUTLINE_BOOK_MAX_CHARS);
    assert.equal(error.length, engine.OUTLINE_BOOK_MAX_CHARS + 1);
    assert.match(error.message, /1000001 characters/);
    assert.match(error.message, /Nothing was written/);
    return true;
  });
  assert.deepEqual(new Map(store.files), before, "no file changed: not the book, not the brief");
  assert.equal(store.commits.length, commits, "no commit");
});

test("an idea of exactly the limit is accepted, and the edit of the outline refuses one over it without cutting", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  await engine.writeOutlineBrief(store, { idea: longIdea(engine.OUTLINE_BOOK_MAX_CHARS) });
  assert.equal(bookText(store).length, engine.OUTLINE_BOOK_MAX_CHARS, "exactly the limit is kept whole");
  const outline = await engine.parseOutline([...store.files].map(([path, content]) => ({ path, content })));
  assert.equal(outline.book.body.length, engine.OUTLINE_BOOK_MAX_CHARS);
  assert.equal(outline.warnings.some((warning) => warning.code === "text-too-long"), false, "no warning at the limit");
  assert.throws(() => engine.outlineChanges({ outline, edit: { kind: "book", body: longIdea(engine.OUTLINE_BOOK_MAX_CHARS + 1) } }), (error) => error instanceof engine.OutlineTextLimitError);
});

test("the description above the limit is read whole, with a warning, and a title-only edit leaves it as it is", async () => {
  const body = longIdea(engine.OUTLINE_BOOK_MAX_CHARS + 10);
  const outline = await engine.parseOutline([{ path: BOOK, content: `---\ntype: outline\nid: outline:book\n---\n\n${body}\n` }]);
  assert.equal(outline.book.body.length, engine.OUTLINE_BOOK_MAX_CHARS + 10, "never cut");
  assert.ok(outline.warnings.some((warning) => warning.code === "text-too-long" && /over the limit/.test(warning.message)));
  const { changes } = engine.outlineChanges({ outline, edit: { kind: "book", title: "Renamed" } });
  assert.match(changes[0].content, /title: Renamed/);
  assert.equal(changes[0].content.includes(body.slice(-50)), true, "the text is written as it is");
});

test("a brief file with an idea key: the key is ignored when reading, and never written again", async () => {
  const store = new MemoryBookStore({
    ...seedBookFiles(),
    [BRIEF]: "---\ntype: outline-brief\nid: outline:brief\nidea: an old idea nobody uses\ngenre: Noir\nwordsPerScene: 700\n---\n\nThe synopsis.\n",
  });
  const read = await engine.readOutlineBrief(store);
  assert.equal(read.brief.idea, "", "the old key is not the idea: the book has no description");
  assert.equal(read.brief.genre, "Noir");
  await engine.writeOutlineBrief(store, { genre: "Thriller" });
  assert.equal("idea" in engine.parseMarkdown(store.files.get(BRIEF)).frontmatter, false, "the key is dropped on the next write");
  assert.equal(store.files.has(BOOK), false, "and the book gets no description from it");
});

test("the description the autopilot wrote is not the author's idea: it reads as none, and a write replaces it", async () => {
  const store = new MemoryBookStore({
    ...seedBookFiles(),
    [BOOK]: "---\ntype: outline\nid: outline:book\norigin: autopilot\ndigest: abc123\n---\n\nA logline the autopilot wrote.\n",
  });
  assert.equal((await engine.readOutlineBrief(store)).brief.idea, "");
  await engine.writeOutlineBrief(store, { idea: "The author's own idea." });
  const file = engine.parseMarkdown(store.files.get(BOOK));
  assert.equal(file.body, "The author's own idea.");
  assert.equal(file.frontmatter.origin, "author", "the author wrote it now");
  assert.equal(file.frontmatter.digest, undefined);
});

test("a write of the idea keeps the working title and the other keys of the description", async () => {
  const store = new MemoryBookStore({
    ...seedBookFiles(),
    [BOOK]: "---\ntype: outline\nid: outline:book\ntitle: Working Title\nnote: keep me\n---\n\nold idea\n",
  });
  await engine.writeOutlineBrief(store, { idea: "new idea" });
  const file = engine.parseMarkdown(store.files.get(BOOK));
  assert.deepEqual([file.frontmatter.title, file.frontmatter.note, file.body], ["Working Title", "keep me", "new idea"]);
});

test("a book that has no description file gets one with the idea; the write is one commit for both files", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const commits = store.commits.length;
  await engine.writeOutlineBrief(store, { idea: "A new idea.", genre: "Noir" });
  assert.equal(store.commits.length, commits + 1, "one commit for the idea and the brief");
  assert.deepEqual(store.commits.at(-1).paths.sort(), [BOOK, BRIEF].sort());
});

// ─── Legacy: a state saved before the idea lived in the description ───────────────────────

function legacyState(idea) {
  const state = engine.createAutopilotState(clock(), {}, FAST);
  return { ...state, brief: { idea, synopsis: "", targetChapters: 2, scenesPerChapter: 2, wordsPerScene: 300, genre: "", audience: "" }, concept: { done: true, generated: false, secrets: [] } };
}

async function startWith(store, state) {
  store.files.set(STATE, engine.serializeAutopilotState(state));
  const session = new engine.AutopilotSession({ bookId: "book", store, ai: createFakeAutopilotAi({ reviewVerdict: () => "approve" }), host: "server", hostLabel: "test", retryDelayMs: 0, now: clock });
  await session.start({ options: FAST });
  await session.waitForIdle();
  return engine.parseAutopilotState(store.files.get(STATE));
}

test("a legacy idea and a book with no description: the idea is written into outline/book.md once, in the start commit", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const idea = longIdea(3000);
  const commits = store.commits.length;
  await startWith(store, legacyState(idea));
  assert.equal(bookText(store), idea, "the legacy idea is the description now");
  const first = store.commits[commits];
  assert.match(first.message, /Autopilot: started/, "the migration is in the start commit");
  assert.ok(first.paths.includes(BOOK) && first.paths.includes(STATE), "the description and the state in one commit");
  const again = await engine.readOutlineBrief(store);
  assert.equal(again.brief.idea, idea);
});

test("a legacy idea and a book whose description the author wrote: the author's file wins, and nothing is overwritten", async () => {
  const authored = "---\ntype: outline\nid: outline:book\ntitle: Working Title\n---\n\nThe author's own description.\n";
  const store = new MemoryBookStore({ ...seedBookFiles(), [BOOK]: authored });
  const state = await startWith(store, legacyState("The old idea from the state."));
  assert.equal(store.files.get(BOOK), authored, "book.md is exactly as the author wrote it");
  assert.equal(state.brief.idea, "The author's own description.", "the brief shows the author's description as the idea");
});
