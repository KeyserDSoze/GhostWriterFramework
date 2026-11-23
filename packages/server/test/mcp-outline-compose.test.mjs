import test from "node:test";
import assert from "node:assert/strict";
import { outlineChanges, outlineChapterPath, outlineIndex, parseOutline, serializeOutlineBook, serializeOutlineChapter } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { sha } from "./mcp-outline-helpers.mjs";

// What is the tool's in the series of edits of the outline (S9): the edits as a model writes them (flat, with a `kind`), the rule that a text, an entry or a description
// is replaced only by someone who read it, the words of every refusal (they name the edit by its place in the call and the tool that gives the hash), and the line each
// edit leaves in `applied`. The series itself, the identity of every entry and the reading of only the files that are needed are the engine's (`composeOutlineEdits`), and
// its tests are in the engine: packages/engine/test/outline-compose.test.mjs. The engine is still the oracle here: what the tool composes must be what the engine makes when
// it is asked for the same edits one at a time, and the files read again between them.

// New exports are read from the namespace: before they exist each test fails by itself instead of breaking the whole file.
const { OUTLINE_EDIT_MAX_EDITS, OUTLINE_EDIT_MAX_FILES, ToolError, appliedLine, checkOutlineEdits, composeToolEdits } = testing;

const entryPath = outlineChapterPath;
const BOOK = "outline/book.md";

/** An outline in memory: `entries` are `[number, fields]`, `book` the fields of the description (or none). */
function memory(entries, book = null) {
  const files = new Map();
  for (const [number, fields] of entries) {
    const content = serializeOutlineChapter({ number, ...fields });
    files.set(entryPath(number), { content, hash: sha(content) });
  }
  if (book) {
    const content = serializeOutlineBook(book);
    files.set(BOOK, { content, hash: sha(content) });
  }
  return files;
}

const four = () => memory([[1, { title: "E1", body: "one" }], [2, { title: "E2", body: "two" }], [3, { title: "E3", body: "three" }], [4, { title: "E4", body: "four" }]], { title: "Working", body: "The book." });
const hashOf = (files, number) => files.get(entryPath(number)).hash;

/** What the tool gives the engine: where the files are, which are known without reading them, and the reads that were made. */
function sourceOf(files) {
  const reads = [];
  return {
    reads,
    index: outlineIndex([...files].map(([file, { hash }]) => [file, hash])),
    paths: [...files.keys()],
    read: async (file) => {
      reads.push(file);
      const known = files.get(file);
      return known ? { path: file, ...known } : null;
    },
  };
}

const compose = async (files, edits, { ghostwriters = ["default"], ...options } = {}) => {
  const source = sourceOf(files);
  return { source, composed: await composeToolEdits(source, edits, ghostwriters, options) };
};

const applied = (files, changes) => {
  const next = new Map(files);
  for (const change of changes) {
    if (change.content === null) next.delete(change.path);
    else next.set(change.path, { content: change.content, hash: sha(change.content) });
  }
  return next;
};

/** The edit of a call as the engine takes it. */
function engineEdit(edit) {
  const entry = { ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.body !== undefined ? { body: edit.body } : {}), ...(edit.ghostwriter !== undefined ? { ghostwriter: edit.ghostwriter } : {}) };
  switch (edit.kind) {
    case "update": return { kind: "update", number: edit.number, entry };
    case "append": return { kind: "append", entry };
    case "insert": return { kind: "insert", at: edit.at, entry };
    case "move": return { kind: "move", from: edit.from, to: edit.to };
    case "remove": return { kind: "remove", number: edit.number, renumber: edit.renumber === true };
    default: return { kind: "book", ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.body !== undefined ? { body: edit.body } : {}) };
  }
}

/** The oracle: the engine makes the edits one at a time, and reads every file again after each. */
async function reference(files, edits, ghostwriters = ["default"]) {
  let current = new Map(files);
  for (const edit of edits) {
    const outline = await parseOutline([...current].map(([file, { content, hash }]) => ({ path: file, content, hash })));
    current = applied(current, outlineChanges({ outline, edit: engineEdit(edit), ghostwriters }).changes);
  }
  return current;
}

const contents = (files) => [...files].map(([file, { content }]) => [file, content]).sort(([left], [right]) => (left < right ? -1 : 1));

const refused = (code, pattern) => (error) => {
  assert.ok(error instanceof ToolError, `a ToolError, not ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, error.message);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

// ─── The same files as the engine makes ────────────────────────────────────

test("S9 compose: a series makes the files the engine makes when it is asked for the same edits one at a time; they are written once, each expecting the file that was read", async () => {
  const files = four();
  const edits = [
    { kind: "insert", at: 2, title: "N1", body: "a new second chapter" },
    { kind: "move", from: 5, to: 1 },
    { kind: "update", number: 4, body: "two, changed", expectedHash: hashOf(files, 2) },
    { kind: "remove", number: 5, renumber: true, expectedHash: hashOf(files, 3) },
    { kind: "append", title: "N2", ghostwriter: "default" },
    { kind: "book", body: "The book, changed.", expectedHash: files.get(BOOK).hash },
  ];
  const { composed } = await compose(files, edits);
  const wanted = await reference(files, edits);
  assert.deepEqual(contents(applied(files, composed.changes)), contents(wanted));
  assert.deepEqual(composed.changes.map((change) => change.path), [...new Set(composed.changes.map((change) => change.path))].sort(), "each file once, in order of path");
  for (const change of composed.changes) {
    assert.equal(change.expectedHash, files.has(change.path) ? files.get(change.path).hash : null, `${change.path} expects the file that was read (null: it did not exist)`);
  }
  const titles = [1, 2, 3, 4, 5].map((number) => /title: (.*)/.exec(applied(files, composed.changes).get(entryPath(number)).content)?.[1]);
  assert.deepEqual(titles, ["E4", "E1", "N1", "E2", "N2"], "the entries are where the edits put them");
  assert.ok(composed.changes.every((change) => change.content === null || /origin: author/.test(change.content)), "everything it writes is the author's");
});

test("S9 compose: the text of an entry that exists is replaced only by someone who has seen it, and so is the removal of one: expectedHash is required, and one that is not the entry's is a conflict", async () => {
  const files = four();
  const h2 = hashOf(files, 2);
  const h3 = hashOf(files, 3);

  await assert.rejects(() => compose(files, [{ kind: "update", number: 2, body: "new" }]), refused("expected_hash_required", /outline\/chapters\/002\.md[^]*read_outline_entry/));
  await assert.rejects(() => compose(files, [{ kind: "update", number: 2, body: "new", expectedHash: h3 }]), refused("conflict", /outline\/chapters\/002\.md/));
  await assert.rejects(() => compose(files, [{ kind: "update", number: 2, body: "new", expectedHash: "a".repeat(64) }]), refused("conflict"));
  const replaced = await compose(files, [{ kind: "update", number: 2, body: "new", expectedHash: h2 }]);
  assert.deepEqual([replaced.composed.updated, replaced.composed.entries.map((entry) => [entry.number, entry.path])], [[2], [[2, entryPath(2)]]]);
  assert.equal(replaced.composed.entries[0].hash, sha(replaced.composed.changes[0].content), "the hash it gives is the one of the file as written");

  // A title or a ghostwriter changes no text: it needs no hash, and is checked when it has one.
  const titled = await compose(files, [{ kind: "update", number: 2, title: "Two" }]);
  assert.deepEqual(titled.composed.updated, [2]);
  assert.match(applied(files, titled.composed.changes).get(entryPath(2)).content, /title: Two[^]*\n\ntwo\n$/, "the text it did not name is kept");
  await assert.rejects(() => compose(files, [{ kind: "update", number: 2, title: "Two", expectedHash: h3 }]), refused("conflict"));
  assert.equal((await compose(files, [{ kind: "update", number: 2, title: "Two", expectedHash: h2 }])).composed.changes.length, 1);

  // An entry that is not there is made, and has no hash to give: a hash is a claim that it was there.
  const made = await compose(files, [{ kind: "update", number: 9, title: "Nine", body: "nine" }]);
  assert.deepEqual([made.composed.created, made.composed.updated], [[9], []]);
  assert.ok(made.composed.warnings.some((warning) => warning.code === "gap"), "chapters 5 to 8 have no entry: the engine says so");
  await assert.rejects(() => compose(files, [{ kind: "update", number: 9, body: "nine", expectedHash: h2 }]), refused("conflict", /^edits\[0\] \(update chapter 9\): chapter 9 has no entry now \(outline\/chapters\/009\.md\), so the hash you gave cannot be its: it was removed since you read it\. Read the outline again and retry\. Nothing was written\.$/));

  // The same for removing.
  await assert.rejects(() => compose(files, [{ kind: "remove", number: 2 }]), refused("expected_hash_required", /outline\/chapters\/002\.md/));
  await assert.rejects(() => compose(files, [{ kind: "remove", number: 2, expectedHash: h3 }]), refused("conflict"));
  const removed = await compose(files, [{ kind: "remove", number: 2, expectedHash: h2 }]);
  assert.deepEqual([removed.composed.removed, removed.composed.changes.map((change) => [change.path, change.content])], [[2], [[entryPath(2), null]]]);
  await assert.rejects(() => compose(files, [{ kind: "remove", number: 9 }]), refused("not_found", /chapter 9/));
  await assert.rejects(() => compose(files, [{ kind: "move", from: 9, to: 1 }]), refused("not_found", /chapter 9/));
});

test("S9 compose: the description of the book is replaced only with the hash of outline/book.md, and made without one", async () => {
  const files = four();
  const hash = files.get(BOOK).hash;
  await assert.rejects(() => compose(files, [{ kind: "book", body: "New." }]), refused("expected_hash_required", /outline\/book\.md[^]*read_outline/));
  await assert.rejects(() => compose(files, [{ kind: "book", body: "New.", expectedHash: hashOf(files, 1) }]), refused("conflict", /outline\/book\.md/));
  const done = await compose(files, [{ kind: "book", body: "New.", expectedHash: hash }]);
  assert.deepEqual([done.composed.book?.created, done.composed.book?.path, done.composed.book?.hash], [false, BOOK, sha(done.composed.changes[0].content)]);
  const titled = await compose(files, [{ kind: "book", title: "Another working title" }]);
  assert.match(titled.composed.changes[0].content, /title: Another working title[^]*\n\nThe book\.\n$/, "the text is kept");
  await assert.rejects(() => compose(files, [{ kind: "book", title: "Another", expectedHash: "b".repeat(64) }]), refused("conflict"));

  const bare = memory([[1, { title: "E1", body: "one" }]]);
  const created = await compose(bare, [{ kind: "book", title: "Working", body: "The book." }]);
  assert.deepEqual([created.composed.book?.created, created.composed.changes.map((change) => [change.path, change.expectedHash])], [true, [[BOOK, null]]]);
  await assert.rejects(() => compose(bare, [{ kind: "book", body: "x", expectedHash: hash }]), refused("conflict"));
});

test("S9 compose: a hash is the hash of the entry as it was read, wherever the series puts it; an entry made by an earlier edit has none, and what was verified once need not be again", async () => {
  const files = four();
  const h1 = hashOf(files, 1);
  const h2 = hashOf(files, 2);

  // E1 is chapter 2 after the insert: the hash read for chapter 1 is still its hash.
  const followed = await compose(files, [{ kind: "insert", at: 1, title: "N1" }, { kind: "update", number: 2, body: "one, changed", expectedHash: h1 }]);
  assert.deepEqual(followed.composed.updated, [2]);
  assert.match(applied(files, followed.composed.changes).get(entryPath(2)).content, /title: E1[^]*one, changed/);
  assert.match(applied(files, followed.composed.changes).get(entryPath(1)).content, /title: N1/);

  // Chapter 1 is the new one now: the hash is not its (and no hash can be).
  await assert.rejects(() => compose(files, [{ kind: "insert", at: 1, title: "N1" }, { kind: "update", number: 1, body: "x", expectedHash: h1 }]), refused("conflict", /edits\[1\][^]*made by an earlier edit/));
  const fresh = await compose(files, [{ kind: "insert", at: 1, title: "N1" }, { kind: "update", number: 1, body: "the new chapter, written" }]);
  assert.deepEqual([fresh.composed.created, fresh.composed.updated], [[1], []], "writing what you made yourself needs no hash");
  assert.match(applied(files, fresh.composed.changes).get(entryPath(1)).content, /the new chapter, written/);

  // The same hash for a removal after a move, and for a replacement of a moved entry.
  const moved = await compose(files, [{ kind: "move", from: 4, to: 1 }, { kind: "remove", number: 1, expectedHash: hashOf(files, 4) }]);
  assert.deepEqual(moved.composed.removed, [4]);
  await assert.rejects(() => compose(files, [{ kind: "move", from: 4, to: 1 }, { kind: "remove", number: 1, expectedHash: hashOf(files, 1) }]), refused("conflict"));

  // Verified once: the second edit of the same entry in the series needs no hash again; one that came after a change with no text in it does.
  const twice = await compose(files, [{ kind: "update", number: 2, body: "two, again", expectedHash: h2 }, { kind: "update", number: 2, body: "two, once more" }]);
  assert.match(applied(files, twice.composed.changes).get(entryPath(2)).content, /two, once more/);
  await assert.rejects(() => compose(files, [{ kind: "update", number: 2, title: "Two" }, { kind: "update", number: 2, body: "two, again" }]), refused("expected_hash_required", /edits\[1\]/));
  await assert.rejects(() => compose(files, [{ kind: "update", number: 2, body: "two, again", expectedHash: h2 }, { kind: "update", number: 2, body: "x", expectedHash: hashOf(files, 3) }]), refused("conflict"), "a hash that is given is always checked");
});

test("S9 compose: an edit that is not valid names itself (its place in the list and its kind) and leaves nothing behind", async () => {
  const files = four();
  await assert.rejects(() => compose(files, [{ kind: "append", title: "N" }, { kind: "remove", number: 9, expectedHash: "c".repeat(64) }]), refused("not_found", /edits\[1\][^]*remove[^]*chapter 9/));
  await assert.rejects(() => compose(files, [{ kind: "update", number: 2, body: "x" }]), refused("expected_hash_required", /edits\[0\][^]*update/));
});

test("S9 compose: every edit has a line that says what it did, in the order of the series", async () => {
  const files = four();
  const { composed } = await compose(files, [
    { kind: "append", title: "N" },
    { kind: "insert", at: 2, title: "M" },
    { kind: "move", from: 1, to: 3 },
    { kind: "remove", number: 6, renumber: true },
    { kind: "update", number: 1, title: "One" },
    { kind: "update", number: 9, body: "nine" },
    { kind: "book", title: "Another" },
  ]);
  assert.equal(composed.applied.length, 7);
  assert.match(composed.applied[0], /^append chapter 5\b/);
  assert.match(composed.applied[1], /^insert chapter 2\b[^]*move up/);
  assert.match(composed.applied[2], /^move chapter 1 to 3\b/);
  assert.match(composed.applied[3], /^remove chapter 6\b[^]*move down/);
  assert.match(composed.applied[4], /^update chapter 1: title\b/);
  assert.match(composed.applied[5], /^create chapter 9: text\b/);
  assert.match(composed.applied[6], /^update the description of the book: title\b/);
  // The text of an entry is `text` in a line, as it is in the answer; a description that did not exist is written, not updated.
  const noDescription = memory([[1, { title: "E1", body: "one" }], [2, { title: "E2", body: "two" }], [3, { title: "E3", body: "three" }]]);
  const edited = await compose(noDescription, [{ kind: "update", number: 3, body: "three, changed", expectedHash: hashOf(noDescription, 3) }, { kind: "book", body: "A description." }, { kind: "move", from: 2, to: 2 }]);
  assert.deepEqual(edited.composed.applied, ["update chapter 3: text", "write the description of the book: text", "move chapter 2 to 2 (it is there already)"]);
  const bare = memory([[1, { title: "E1", body: "one" }]]);
  assert.deepEqual((await compose(bare, [{ kind: "book", title: "Working", body: "The book." }, { kind: "update", number: 2, title: "Two", body: "two", ghostwriter: "default" }])).composed.applied, ["write the description of the book: title, text", "create chapter 2: title, text, ghostwriter"]);
});

test("S9 compose: a series that would change more files than a call may is refused whole, and says what to do instead", async () => {
  assert.equal(OUTLINE_EDIT_MAX_FILES, 1000);
  assert.equal(OUTLINE_EDIT_MAX_EDITS, 50);
  const many = memory(Array.from({ length: 30 }, (_, index) => [index + 1, { title: `E${index + 1}`, body: "x" }]));
  await assert.rejects(() => compose(many, [{ kind: "insert", at: 1, title: "N" }], { maxFiles: 20 }), refused("too_many_files", /at least 31 files[^]*20/));
  const allowed = await compose(many, [{ kind: "insert", at: 11, title: "N" }], { maxFiles: 21 });
  assert.equal(allowed.composed.changes.length, 21);
  // A series that is over the limit before it is over is refused there, and says how many files it had by then.
  const long = Array.from({ length: 50 }, (_, index) => ({ kind: "insert", at: 1, title: `N${index}` }));
  await assert.rejects(() => compose(many, long, { maxFiles: 20 }), refused("too_many_files", /at least 31 files/));
});

test("S9 compose: the edits of a call are looked at before anything is read: each kind takes its own properties, and names the one it does not", () => {
  const ok = (edits) => assert.deepEqual(checkOutlineEdits(edits), edits);
  ok([{ kind: "append" }, { kind: "append", title: "T", body: "B", ghostwriter: "g" }, { kind: "append", ghostwriter: null }]);
  ok([{ kind: "insert", at: 1 }, { kind: "move", from: 1, to: 2 }, { kind: "remove", number: 3 }, { kind: "remove", number: 3, renumber: true, expectedHash: "d".repeat(64) }]);
  ok([{ kind: "update", number: 1, title: "T" }, { kind: "update", number: 1, ghostwriter: null }, { kind: "book", body: "B" }, { kind: "book", title: "" }]);
  const bad = (edits, pattern) => assert.throws(() => checkOutlineEdits(edits), refused("invalid_input", pattern));
  bad([], /at least one edit/);
  bad("update", /list of edits/);
  bad([{ kind: "update", number: 1, title: "T" }, "remove"], /edits\[1\][^]*object/);
  bad([{ kind: "append", number: 3 }], /edits\[0\][^]*append[^]*`number`[^]*takes: title, body, ghostwriter/);
  bad([{ kind: "insert", title: "T" }], /edits\[0\][^]*insert[^]*`at`[^]*required/);
  bad([{ kind: "move", from: 1 }], /edits\[0\][^]*move[^]*`to`[^]*required/);
  bad([{ kind: "move", from: 1, to: 2, title: "T" }], /move[^]*`title`/);
  bad([{ kind: "remove" }], /remove[^]*`number`[^]*required/);
  bad([{ kind: "remove", number: 1, body: "x" }], /remove[^]*`body`/);
  bad([{ kind: "update", number: 1 }], /edits\[0\][^]*update[^]*nothing[^]*title, body or ghostwriter/);
  bad([{ kind: "update", title: "T" }], /update[^]*`number`[^]*required/);
  bad([{ kind: "update", number: 1, at: 2, title: "T" }], /update[^]*`at`/);
  bad([{ kind: "book" }], /book[^]*nothing/);
  bad([{ kind: "book", number: 1, body: "B" }], /book[^]*`number`/);
  bad([{ kind: "update", number: 1, title: "T" }, { kind: "frobnicate" }], /edits\[1\][^]*frobnicate[^]*append, insert, move, remove, update, book/);
  bad([{ kind: "append", expectedHash: "e".repeat(64) }], /append[^]*`expectedHash`[^]*new entry/);
  bad([{ kind: "insert", at: 2, expectedHash: "e".repeat(64) }], /insert[^]*`expectedHash`/);
  bad(Array.from({ length: OUTLINE_EDIT_MAX_EDITS + 1 }, () => ({ kind: "append" })), /at most 50/);
  assert.equal(checkOutlineEdits(Array.from({ length: OUTLINE_EDIT_MAX_EDITS }, () => ({ kind: "append" }))).length, 50);
});

// ─── The engine's refusals, in the tool's words ────────────────────────────

test("S9 compose: every refusal of the engine is a ToolError with the code and the words of the tool; nothing else leaks out of it", async () => {
  const files = four();
  // More edits than a call may make: the same words as the check of the call, whatever calls the composer.
  const many = Array.from({ length: OUTLINE_EDIT_MAX_EDITS + 1 }, () => ({ kind: "append" }));
  await assert.rejects(() => compose(files, many), refused("invalid_input", /at most 50 edits: send the rest in another call/));
  // A file that was listed and is gone when it is read changed meanwhile: the conflict every tool gives for it, naming the file.
  const source = sourceOf(files);
  files.delete(entryPath(2));
  await assert.rejects(() => composeToolEdits(source, [{ kind: "update", number: 2, title: "x" }], ["default"]), refused("conflict", /^\[?The file changed since you read it \(outline\/chapters\/002\.md\): read it again and retry\. Nothing was written\.$/));
  // An edit of a chapter that has no entry names the tools that list the chapters, and the place of the edit in the call.
  await assert.rejects(() => compose(four(), [{ kind: "update", number: 1, title: "x" }, { kind: "move", from: 9, to: 2 }]), refused("not_found", /^edits\[1\] \(move chapter 9 to 2\): the outline has no entry for chapter 9\. read_outline lists the chapters that have one\.$/));
  // The book's own description names the other tool that gives its hash.
  await assert.rejects(() => compose(four(), [{ kind: "book", body: "New." }]), refused("expected_hash_required", /^edits\[0\] \(book\): a new description replaces a whole text, so pass the hash that read_outline gave for outline\/book\.md as expectedHash/));
  await assert.rejects(() => compose(four(), [{ kind: "remove", number: 3 }]), refused("expected_hash_required", /^edits\[0\] \(remove chapter 3\): an entry is removed only by someone who has read it, so pass the hash that read_outline_entry gave for outline\/chapters\/003\.md as expectedHash/));
});

test("S9 compose: the tool asks the engine for its rule, a hash for what it replaces and for nothing else, and the limits of a call are the engine's", async () => {
  assert.equal(OUTLINE_EDIT_MAX_EDITS, 50);
  assert.equal(OUTLINE_EDIT_MAX_FILES, 1000);
  const files = four();
  // A title, a ghostwriter, a new entry and a move are made with no hash; the text of an entry, a removal and the description are not.
  const free = await compose(files, [{ kind: "update", number: 1, title: "One" }, { kind: "update", number: 2, ghostwriter: "default" }, { kind: "append", title: "Five", body: "five" }, { kind: "insert", at: 1, body: "first" }, { kind: "move", from: 3, to: 4 }, { kind: "book", title: "Another" }]);
  assert.equal(free.composed.changes.length > 0, true);
  for (const edit of [{ kind: "update", number: 1, body: "x" }, { kind: "remove", number: 1 }, { kind: "book", body: "x" }]) {
    await assert.rejects(() => compose(files, [edit]), refused("expected_hash_required"), edit.kind);
  }
  // `ghostwriter: null` takes it away, and `renumber` closes the gap: what a model writes is what the engine is asked.
  const withGhost = memory([[1, { title: "E1", body: "one", ghostwriter: "default" }], [2, { title: "E2", body: "two" }], [3, { title: "E3", body: "three" }]]);
  const taken = await compose(withGhost, [{ kind: "update", number: 1, ghostwriter: null }, { kind: "remove", number: 2, renumber: true, expectedHash: hashOf(withGhost, 2) }]);
  assert.deepEqual(contents(applied(withGhost, taken.composed.changes)), contents(await reference(withGhost, [{ kind: "update", number: 1, ghostwriter: null }, { kind: "remove", number: 2, renumber: true }])));
  assert.doesNotMatch(applied(withGhost, taken.composed.changes).get(entryPath(1)).content, /ghostwriter/);
  assert.equal(applied(withGhost, taken.composed.changes).has(entryPath(3)), false, "the following chapter moved down");
  // A line is made from a step, whatever composed it.
  assert.equal(appliedLine({ kind: "update", number: 4, created: false, fields: ["title", "body", "ghostwriter"] }), "update chapter 4: title, text, ghostwriter");
  assert.equal(appliedLine({ kind: "remove", number: 4, renumber: true }), "remove chapter 4 (the following chapters move down one number)");
});
