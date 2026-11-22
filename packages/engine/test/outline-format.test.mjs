import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { parseMarkdown } = engine;

const files = (record) => Object.entries(record).map(([path, content]) => ({ path, content }));

function entryText({ number, title, body = "", ghostwriter, origin, digest, extra = "" }) {
  const lines = ["---", "type: outline-chapter", `id: outline-chapter:${String(number).padStart(3, "0")}`, `number: ${number}`];
  if (title !== undefined) lines.push(`title: ${JSON.stringify(title)}`);
  if (ghostwriter) lines.push(`ghostwriter: ${ghostwriter}`);
  if (origin) lines.push(`origin: ${origin}`);
  if (digest) lines.push(`digest: ${JSON.stringify(digest)}`);
  if (extra) lines.push(extra);
  lines.push("---", "", body, "");
  return lines.join("\n");
}

/** The outline of a store as the engine reads it, with the hashes the edits need. */
async function outlineOf(store) {
  const paths = (await store.list()).filter((entry) => entry.path.startsWith("outline/"));
  return engine.parseOutline(await Promise.all(paths.map(async (entry) => store.read(entry.path))));
}

async function apply(store, edit, extra = {}) {
  const result = engine.outlineChanges({ outline: await outlineOf(store), edit, ...extra });
  await store.commit(result.changes, "outline edit");
  return { result, outline: await outlineOf(store) };
}

const summary = (outline) => outline.chapters.map((entry) => [entry.number, entry.title, entry.origin]);

// ─── Where the files are ────────────────────────────────────────────────────

test("one file per chapter, numbered like the folders of the chapters", () => {
  assert.equal(engine.OUTLINE_DIRECTORY, "outline");
  assert.equal(engine.OUTLINE_BOOK_FILE, "outline/book.md");
  assert.equal(engine.OUTLINE_CHAPTERS_DIRECTORY, "outline/chapters");
  assert.equal(engine.outlineChapterPath(7), "outline/chapters/007.md");
  assert.equal(engine.outlineChapterPath(1234), "outline/chapters/1234.md");
  assert.equal(engine.outlineChapterPath(7).split("/").pop(), `${engine.formatOrdinal(7)}.md`, "the same zero-padding as the folders of the chapters");
  assert.deepEqual(engine.parseOutlineChapterPath("outline/chapters/007.md"), { number: 7, canonical: true });
  assert.deepEqual(engine.parseOutlineChapterPath("outline/chapters/5000.md"), { number: 5000, canonical: true });
  assert.deepEqual(engine.parseOutlineChapterPath("outline/chapters/7.md"), { number: 7, canonical: false });
  for (const path of ["outline/chapters/000.md", "outline/chapters/notes.md", "outline/chapters/007-intro.md", "outline/book.md", "chapters/007/chapter.md", "outline/chapters/x/007.md"]) {
    assert.equal(engine.parseOutlineChapterPath(path), null, path);
  }
});

// ─── Reading ────────────────────────────────────────────────────────────────

test("the outline is read from its files: the book's description and one entry per chapter, the number from the file's name", async () => {
  const outline = await engine.parseOutline(files({
    "outline/book.md": "---\ntype: outline\nid: outline:book\ntitle: Working Title\n---\n\nA harbor built on glass hides a lie.\n",
    "outline/chapters/002.md": entryText({ number: 2, title: "The Storm", body: "The storm breaks the wall.", ghostwriter: "noir" }),
    "outline/chapters/001.md": entryText({ number: 1, title: "The Arrival", body: "Mira arrives." }),
    "outline/chapters/003.md": entryText({ number: 3, body: "Without a title yet." }),
  }));
  assert.equal(outline.book.title, "Working Title");
  assert.equal(outline.book.body, "A harbor built on glass hides a lie.");
  assert.deepEqual(outline.chapters.map((entry) => [entry.number, entry.title, entry.body, entry.ghostwriter, entry.origin]), [
    [1, "The Arrival", "Mira arrives.", undefined, "author"],
    [2, "The Storm", "The storm breaks the wall.", "noir", "author"],
    [3, "", "Without a title yet.", undefined, "author"],
  ]);
  assert.deepEqual(outline.chapters.map((entry) => entry.path), ["outline/chapters/001.md", "outline/chapters/002.md", "outline/chapters/003.md"]);
  assert.ok(outline.chapters.every((entry) => /^[0-9a-f]{16}$/.test(entry.contentDigest)));
  assert.ok(outline.chapters.every((entry) => entry.intact === false), "an entry without the autopilot's digest is the author's");
  assert.deepEqual(outline.warnings, []);
});

test("the name wins over the frontmatter, and what is odd is a warning, never an error", async () => {
  const outline = await engine.parseOutline(files({
    "outline/chapters/004.md": entryText({ number: 9, title: "Four", body: "Four." }),
    "outline/chapters/007.md": entryText({ number: 7, title: "Seven", body: "Seven." }),
    "outline/chapters/0007.md": entryText({ number: 7, title: "Another seven", body: "Duplicate." }),
    "outline/chapters/notes.md": "Some notes.",
    "outline/chapters/001.md": entryText({ number: 1, title: "One", body: "One.", origin: "robot" }),
  }));
  assert.deepEqual(outline.chapters.map((entry) => [entry.number, entry.title, entry.path]), [
    [1, "One", "outline/chapters/001.md"],
    [4, "Four", "outline/chapters/004.md"],
    [7, "Seven", "outline/chapters/007.md"],
  ], "the canonical file of a number is its entry");
  const codes = outline.warnings.map((warning) => warning.code).sort();
  assert.deepEqual(codes, ["duplicate", "gap", "not-an-entry", "number-mismatch", "origin-unknown"]);
  const mismatch = outline.warnings.find((warning) => warning.code === "number-mismatch");
  assert.equal(mismatch.number, 4);
  assert.match(mismatch.message, /outline\/chapters\/004\.md/);
  assert.equal(outline.chapters[0].origin, "author", "an origin nobody knows is the author's");
  const gap = outline.warnings.find((warning) => warning.code === "gap");
  assert.match(gap.message, /2-3|5-6/);
});

test("an entry whose YAML cannot be read keeps its text, is the author's, and says where the problem is", async () => {
  const outline = await engine.parseOutline(files({ "outline/chapters/001.md": "---\ntitle: [unclosed\norigin: autopilot\n---\n\nMira arrives at night.\n" }));
  const [entry] = outline.chapters;
  assert.equal(entry.body, "Mira arrives at night.");
  assert.equal(entry.unreadable, true);
  assert.equal(entry.intact, false, "never rewritten by the autopilot");
  assert.equal(outline.warnings.length, 1);
  assert.equal(outline.warnings[0].code, "unreadable");
  assert.match(outline.warnings[0].message, /outline\/chapters\/001\.md.*line \d+/);
});

// ─── The digest: who wrote it last ──────────────────────────────────────────

test("an entry the autopilot wrote is intact until somebody changes its title, its text or its ghostwriter", async () => {
  const base = { number: 3, title: "The Lie", body: "The council lies.\n\n- The wall cracks.", ghostwriter: undefined };
  const digest = await engine.outlineEntryDigest(base);
  assert.match(digest, /^[0-9a-f]{16}$/);
  assert.equal(await engine.outlineEntryDigest({ ...base, body: "The council lies.\r\n\r\n- The wall cracks.\n\n" }), digest, "line endings and the spaces around the text do not count");
  for (const changed of [{ title: "The Truth" }, { body: "The council tells the truth." }, { ghostwriter: "noir" }]) {
    assert.notEqual(await engine.outlineEntryDigest({ ...base, ...changed }), digest, JSON.stringify(changed));
  }
  const written = engine.serializeOutlineChapter({ ...base, origin: "autopilot", digest });
  const [read] = (await engine.parseOutline([{ path: "outline/chapters/003.md", content: written }])).chapters;
  assert.equal(read.origin, "autopilot");
  assert.equal(read.digest, digest);
  assert.equal(read.contentDigest, digest);
  assert.equal(read.intact, true);
  const touched = written.replace("The council lies.", "The council lies, and Mira knows it.");
  const [edited] = (await engine.parseOutline([{ path: "outline/chapters/003.md", content: touched }])).chapters;
  assert.equal(edited.origin, "autopilot");
  assert.equal(edited.intact, false, "the author touched it: it is the author's now");
});

test("an entry is written as the format says, and read back as it was written", async () => {
  const digest = await engine.outlineEntryDigest({ title: "The Lie", body: "The council lies.", ghostwriter: "noir" });
  const text = engine.serializeOutlineChapter({ number: 7, title: "The Lie", body: "The council lies.", ghostwriter: "noir", origin: "autopilot", digest });
  assert.equal(text, `---\ntype: outline-chapter\nid: outline-chapter:007\nnumber: 7\ntitle: The Lie\nghostwriter: noir\norigin: autopilot\ndigest: ${digest}\n---\n\nThe council lies.\n`);
  const author = engine.serializeOutlineChapter({ number: 12, title: "", body: "Only text.", origin: "author", digest });
  assert.equal(author, "---\ntype: outline-chapter\nid: outline-chapter:012\nnumber: 12\norigin: author\n---\n\nOnly text.\n", "an author's entry has no digest, and no empty title");
  const kept = engine.serializeOutlineChapter({ number: 7, title: "New", body: "New text.", origin: "author", frontmatter: parseMarkdown(text.replace("origin: autopilot", "mood: grim\norigin: autopilot")).frontmatter });
  assert.match(kept, /mood: grim/, "a key the engine does not know is kept");
  assert.doesNotMatch(kept, /digest:/);
  const book = engine.serializeOutlineBook({ title: "Working Title", body: "A harbor built on glass hides a lie." });
  assert.equal(book, "---\ntype: outline\nid: outline:book\ntitle: Working Title\norigin: author\n---\n\nA harbor built on glass hides a lie.\n");
});

// ─── Edits on behalf of the author ──────────────────────────────────────────

async function seededStore() {
  const store = new MemoryBookStore(seedBookFiles());
  const digest2 = await engine.outlineEntryDigest({ title: "Two", body: "Body two." });
  store.write("outline/book.md", engine.serializeOutlineBook({ body: "The book." }));
  store.write("outline/chapters/001.md", engine.serializeOutlineChapter({ number: 1, title: "One", body: "Body one." }));
  store.write("outline/chapters/002.md", engine.serializeOutlineChapter({ number: 2, title: "Two", body: "Body two.", origin: "autopilot", digest: digest2 }));
  store.write("outline/chapters/003.md", engine.serializeOutlineChapter({ number: 3, title: "Three", body: "Body three." }));
  return store;
}

test("a chapter is appended at the end, as the author's", async () => {
  const store = await seededStore();
  const { result, outline } = await apply(store, { kind: "append", entry: { title: "Four", body: "Body four." } });
  assert.deepEqual(result.changes.map((change) => [change.path, change.expectedHash]), [["outline/chapters/004.md", null]]);
  assert.deepEqual(summary(outline), [[1, "One", "author"], [2, "Two", "autopilot"], [3, "Three", "author"], [4, "Four", "author"]]);
  assert.deepEqual(result.warnings, []);
});

test("inserting at position N renames the following entries in one list of changes, which only applies to the files as they were", async () => {
  const store = await seededStore();
  const before = await outlineOf(store);
  const result = engine.outlineChanges({ outline: before, edit: { kind: "insert", at: 2, entry: { title: "New two", body: "Inserted." } } });
  assert.deepEqual(result.changes.map((change) => change.path).sort(), ["outline/chapters/002.md", "outline/chapters/003.md", "outline/chapters/004.md"]);
  const byPath = new Map(result.changes.map((change) => [change.path, change]));
  assert.equal(byPath.get("outline/chapters/002.md").expectedHash, before.chapters[1].hash, "every rewrite expects the file it read");
  assert.equal(byPath.get("outline/chapters/004.md").expectedHash, null, "a new file must not exist yet");
  await store.commit(result.changes, "insert");
  const after = await outlineOf(store);
  assert.deepEqual(summary(after), [[1, "One", "author"], [2, "New two", "author"], [3, "Two", "author"], [4, "Three", "author"]], "what moved was moved by the author");
  assert.deepEqual(after.chapters.map((entry) => entry.body), ["Body one.", "Inserted.", "Body two.", "Body three."]);
  assert.ok(after.chapters.every((entry) => entry.digest === undefined));
  assert.deepEqual(after.warnings, []);
  await assert.rejects(store.commit(result.changes, "the same edit on files that changed"), /changed since it was read/);
});

test("an entry moves up or down, the ones in between follow", async () => {
  const store = await seededStore();
  let { outline } = await apply(store, { kind: "move", from: 1, to: 3 });
  assert.deepEqual(outline.chapters.map((entry) => entry.title), ["Two", "Three", "One"]);
  ({ outline } = await apply(store, { kind: "move", from: 3, to: 1 }));
  assert.deepEqual(outline.chapters.map((entry) => entry.title), ["One", "Two", "Three"]);
  const nothing = engine.outlineChanges({ outline, edit: { kind: "move", from: 2, to: 2 } });
  assert.deepEqual(nothing.changes, []);
  const missing = engine.outlineChanges({ outline, edit: { kind: "move", from: 9, to: 1 } });
  assert.deepEqual(missing.changes, []);
  assert.equal(missing.warnings[0].code, "not-found");
});

test("removing an entry leaves a hole unless the author asks to renumber", async () => {
  const store = await seededStore();
  const kept = await apply(store, { kind: "remove", number: 2 });
  assert.deepEqual(kept.result.changes.map((change) => [change.path, change.content]), [["outline/chapters/002.md", null]]);
  assert.deepEqual(kept.outline.chapters.map((entry) => entry.number), [1, 3]);
  assert.ok(kept.result.warnings.some((warning) => warning.code === "gap"), "the hole is said");

  const other = await seededStore();
  const closed = await apply(other, { kind: "remove", number: 1, renumber: true });
  assert.deepEqual(closed.outline.chapters.map((entry) => [entry.number, entry.title]), [[1, "Two"], [2, "Three"]]);
  assert.ok(!other.files.has("outline/chapters/003.md"));
});

test("an edit of the title, the text or the ghostwriter makes the entry the author's and keeps every other key", async () => {
  const store = await seededStore();
  store.write("outline/chapters/002.md", store.files.get("outline/chapters/002.md").replace("origin: autopilot", "mood: grim\norigin: autopilot"));
  const { result, outline } = await apply(store, { kind: "update", number: 2, entry: { body: "Rewritten by the author.", ghostwriter: "noir" } }, { ghostwriters: ["default"] });
  const entry = outline.chapters[1];
  assert.deepEqual([entry.title, entry.body, entry.ghostwriter, entry.origin, entry.digest], ["Two", "Rewritten by the author.", "noir", "author", undefined]);
  assert.match(store.files.get("outline/chapters/002.md"), /mood: grim/);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["ghostwriter-missing"], "a ghostwriter that does not exist is a warning, never an error");
  const cleared = await apply(store, { kind: "update", number: 2, entry: { ghostwriter: null } });
  assert.equal(cleared.outline.chapters[1].ghostwriter, undefined, "null takes the ghostwriter away: the book's writes it");
  const created = await apply(store, { kind: "update", number: 5, entry: { title: "Five" } });
  assert.deepEqual(created.outline.chapters.map((item) => item.number), [1, 2, 3, 5]);
  const book = await apply(store, { kind: "book", title: "Working Title", body: "A new description." });
  assert.equal(book.outline.book.title, "Working Title");
  assert.equal(book.outline.book.body, "A new description.");
  assert.equal(book.outline.book.origin, "author");
});

test("huge texts are cut to the limit of an entry, with a warning", async () => {
  const store = await seededStore();
  assert.equal(engine.OUTLINE_ENTRY_MAX_CHARS, 20_000);
  const { result, outline } = await apply(store, { kind: "append", entry: { title: `${"Long title ".repeat(60)}`, body: "x".repeat(50_000) } });
  assert.equal(outline.chapters.at(-1).body.length, engine.OUTLINE_ENTRY_MAX_CHARS);
  assert.ok(outline.chapters.at(-1).title.length <= engine.OUTLINE_TITLE_MAX_CHARS);
  assert.deepEqual(result.warnings.map((warning) => warning.code).sort(), ["text-too-long", "title-too-long"]);
});

// ─── The snapshot ───────────────────────────────────────────────────────────

test("the snapshot knows the files of the outline and their hashes without reading them", async () => {
  const store = await seededStore();
  const reads = [];
  const read = store.read.bind(store);
  store.read = (path) => {
    reads.push(path);
    return read(path);
  };
  const snapshot = await engine.loadBookSnapshot(store);
  assert.ok(!reads.some((path) => path.startsWith("outline/")), "no file of the outline was read");
  assert.equal(snapshot.outline.book.path, "outline/book.md");
  assert.deepEqual(snapshot.outline.chapters.map((entry) => [entry.number, entry.path]), [[1, "outline/chapters/001.md"], [2, "outline/chapters/002.md"], [3, "outline/chapters/003.md"]]);
  assert.equal(snapshot.outline.chapters[0].hash, snapshot.files.get("outline/chapters/001.md"));
  const bare = await engine.loadBookSnapshot(new MemoryBookStore(seedBookFiles()));
  assert.deepEqual(bare.outline, { book: null, chapters: [] });
});

// ─── No maximum ─────────────────────────────────────────────────────────────

test("an outline of 5000 chapters is read, written and given a new first chapter in reasonable time and memory", async () => {
  const count = 5000;
  const texts = [];
  for (let number = 1; number <= count; number += 1) {
    const body = `Chapter ${number}: Mira follows the lie one more step. ${"The harbor holds its breath. ".repeat(8)}`;
    texts.push({ path: engine.outlineChapterPath(number), content: engine.serializeOutlineChapter({ number, title: `Chapter ${number}`, body }), hash: `h${number}` });
  }
  const heap = process.memoryUsage().heapUsed;
  let started = performance.now();
  const outline = await engine.parseOutline(texts);
  const parsing = performance.now() - started;
  assert.equal(outline.chapters.length, count);
  assert.equal(outline.chapters.at(-1).number, count);
  assert.deepEqual(outline.warnings, []);

  started = performance.now();
  const written = outline.chapters.map((entry) => engine.serializeOutlineChapter(entry));
  const writing = performance.now() - started;
  assert.equal(written.length, count);

  started = performance.now();
  const result = engine.outlineChanges({ outline, edit: { kind: "insert", at: 1, entry: { title: "A new opening", body: "Before everything." } } });
  const inserting = performance.now() - started;
  assert.equal(result.changes.length, count + 1, "5000 renames and one new file, in one list");
  assert.equal(result.changes.filter((change) => change.expectedHash === null).length, 1);
  const last = result.changes.find((change) => change.path === engine.outlineChapterPath(count + 1));
  assert.match(last.content, /^title: Chapter 5000$/m);
  assert.match(last.content, /^number: 5001$/m);
  const grown = (process.memoryUsage().heapUsed - heap) / 1024 / 1024;
  assert.ok(parsing < 20_000 && writing < 10_000 && inserting < 10_000, `parse ${parsing.toFixed(0)} ms, write ${writing.toFixed(0)} ms, insert ${inserting.toFixed(0)} ms`);
  assert.ok(grown < 400, `${grown.toFixed(0)} MB of heap`);
});
