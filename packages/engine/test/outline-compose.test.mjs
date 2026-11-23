import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as engine from "../dist/index.js";

// How a series of edits of the outline (the Scaletta) becomes ONE commit, in the engine: the author's edits (`outlineChanges`) composed one after the other, each
// on the outline the one before left; the identity of every entry followed through the renumbering, so that the hash a client read is checked against the entry it is
// of wherever the series has put it; and an entry read only when an edit is about to rewrite it, which for most series leaves the others unread, however many there
// are. The functions are pure: the outline comes as its index (paths and hashes) and a function that reads one file, and the answer is the files of one commit.
// The engine's own edits, made one at a time with every file read again between them, are the oracle.
//
// These tests were the personal server's (the MCP tool of the outline had the composer first); the web app's Outline page and Copilot will use the same function.

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { OUTLINE_COMPOSE_MAX_EDITS, OUTLINE_COMPOSE_MAX_FILES, OutlineComposeError, composeOutlineEdits, outlineEditNeedsHash, remapOutlineNumber } = engine;
const { outlineChanges, outlineChapterPath, outlineIndex, parseOutline, serializeOutlineBook, serializeOutlineChapter } = engine;

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
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

/** What the engine is given: where the files are (the index, and every path of the outline), and a way to read one, which counts the reads. */
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

/** The series as a caller that wants the safe rule makes it: a text or an entry that is replaced or deleted needs the hash that was read. */
const compose = async (files, edits, { ghostwriters = ["default"], requireHash = outlineEditNeedsHash, ...options } = {}) => {
  const source = sourceOf(files);
  return { source, composed: await composeOutlineEdits(source, edits, { ghostwriters, requireHash, ...options }) };
};

const applied = (files, changes) => {
  const next = new Map(files);
  for (const change of changes) {
    if (change.content === null) next.delete(change.path);
    else next.set(change.path, { content: change.content, hash: sha(change.content) });
  }
  return next;
};

const contents = (files) => [...files].map(([file, { content }]) => [file, content]).sort(([left], [right]) => (left < right ? -1 : 1));

// The edits, in the engine's own shape (`expectedHash` is the extension of a series).
const append = (entry = {}) => ({ kind: "append", entry });
const insert = (at, entry = {}) => ({ kind: "insert", at, entry });
const move = (from, to) => ({ kind: "move", from, to });
const remove = (number, { renumber, expectedHash } = {}) => ({ kind: "remove", number, ...(renumber ? { renumber } : {}), ...(expectedHash ? { expectedHash } : {}) });
const update = (number, entry, expectedHash) => ({ kind: "update", number, entry, ...(expectedHash ? { expectedHash } : {}) });
const book = (fields, expectedHash) => ({ kind: "book", ...fields, ...(expectedHash ? { expectedHash } : {}) });

/** The edit as the engine takes it by itself, without the hash. */
const bare = ({ expectedHash, ...edit }) => edit;

/** The oracle: the engine makes the edits one at a time, and reads every file again after each. */
async function reference(files, edits, ghostwriters = ["default"]) {
  let current = new Map(files);
  for (const edit of edits) {
    const outline = await parseOutline([...current].map(([file, { content, hash }]) => ({ path: file, content, hash })));
    current = applied(current, outlineChanges({ outline, edit: bare(edit), ghostwriters }).changes);
  }
  return current;
}

/** A rejection by the composer: the code, and the details it carries (the ones given, and no others that are wrong). */
const refused = (code, details = {}, pattern) => (error) => {
  assert.ok(error instanceof OutlineComposeError, `an OutlineComposeError, not ${error?.name}: ${error?.message}`);
  assert.equal(error.name, "OutlineComposeError");
  assert.equal(error.code, code, error.message);
  for (const [key, value] of Object.entries(details)) assert.deepEqual(error[key], value, `${code}: ${key}`);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

// ─── The same files as the engine makes ────────────────────────────────────

test("a series makes the files the engine makes when it is asked for the same edits one at a time; they are written once, each expecting the file that was read", async () => {
  const files = four();
  const edits = [
    insert(2, { title: "N1", body: "a new second chapter" }),
    move(5, 1),
    update(4, { body: "two, changed" }, hashOf(files, 2)),
    remove(5, { renumber: true, expectedHash: hashOf(files, 3) }),
    append({ title: "N2", ghostwriter: "default" }),
    book({ body: "The book, changed." }, files.get(BOOK).hash),
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
  assert.ok(composed.changes.every((change) => change.content === null || !/^digest:/m.test(change.content)), "and none has a digest: the autopilot never rewrites it");
});

test("a file that comes back to what it was is left alone, and a series that changes nothing changes no file", async () => {
  const files = four();
  const same = await compose(files, [update(2, { title: "E2" }), move(3, 3)]);
  assert.deepEqual(same.composed.changes, []);
  assert.equal(same.composed.steps.length, 2, "what was asked is still told");
  const there = await compose(files, [update(2, { body: "two, for a while" }, hashOf(files, 2)), update(2, { body: "two" })]);
  assert.deepEqual(there.composed.changes, [], "changed and changed back: nothing");
  const created = await compose(files, [append({ title: "Gone" }), remove(5)]);
  assert.deepEqual(created.composed.changes, [], "made and deleted in the same series: nothing");
  assert.deepEqual([created.composed.created, created.composed.removed], [[], []]);
});

test("a series of one edit is the edit of the engine: the same files, with no hash asked for unless the caller asks for it", async () => {
  const files = four();
  const edits = [append({ title: "Five" }), insert(2, { title: "New" }), move(1, 3), remove(2), update(4, { body: "changed" }), book({ title: "Another" })];
  for (const edit of edits) {
    const alone = await composeOutlineEdits(sourceOf(files), [edit], { ghostwriters: ["default"] });
    assert.deepEqual(contents(applied(files, alone.changes)), contents(await reference(files, [edit])), JSON.stringify(edit));
  }
  const unguarded = await composeOutlineEdits(sourceOf(files), [update(2, { body: "no hash given" }), remove(3)], { ghostwriters: ["default"] });
  assert.equal(unguarded.changes.length, 2, "without the policy of a caller a text is replaced and an entry removed with no hash: the engine's own edits never asked for one");
});

// ─── Who saw what: expectedHash ────────────────────────────────────────────

test("the text of an entry that exists is replaced only by someone who has seen it, and so is the removal of one: the hash is required by the caller's policy, and one that is not the entry's is a conflict", async () => {
  const files = four();
  const h2 = hashOf(files, 2);
  const h3 = hashOf(files, 3);
  const text = update(2, { body: "new" });

  await assert.rejects(() => compose(files, [text]), refused("expected_hash_required", { index: 0, edit: text, number: 2, path: entryPath(2), subject: "chapter" }));
  await assert.rejects(() => compose(files, [{ ...text, expectedHash: h3 }]), refused("conflict", { index: 0, number: 2, path: entryPath(2), subject: "chapter", reason: "changed" }));
  await assert.rejects(() => compose(files, [{ ...text, expectedHash: "a".repeat(64) }]), refused("conflict", { reason: "changed" }));
  const replaced = await compose(files, [{ ...text, expectedHash: h2 }]);
  assert.deepEqual([replaced.composed.updated, replaced.composed.entries.map((entry) => [entry.number, entry.path])], [[2], [[2, entryPath(2)]]]);
  assert.equal(replaced.composed.entries[0].hash, sha(replaced.composed.changes[0].content), "the hash it gives is the one of the file as written");

  // A title or a ghostwriter changes no text: the policy asks for no hash, and one that is given is checked.
  const titled = await compose(files, [update(2, { title: "Two" })]);
  assert.deepEqual(titled.composed.updated, [2]);
  assert.match(applied(files, titled.composed.changes).get(entryPath(2)).content, /title: Two[^]*\n\ntwo\n$/, "the text it did not name is kept");
  await assert.rejects(() => compose(files, [update(2, { title: "Two" }, h3)]), refused("conflict", { reason: "changed" }));
  assert.equal((await compose(files, [update(2, { title: "Two" }, h2)])).composed.changes.length, 1);

  // An entry that is not there is made, and has no hash to give: a hash is a claim that it was there.
  const made = await compose(files, [update(9, { title: "Nine", body: "nine" })]);
  assert.deepEqual([made.composed.created, made.composed.updated], [[9], []]);
  assert.ok(made.composed.warnings.some((warning) => warning.code === "gap"), "chapters 5 to 8 have no entry: the engine says so");
  await assert.rejects(() => compose(files, [update(9, { body: "nine" }, h2)]), refused("conflict", { index: 0, number: 9, path: entryPath(9), reason: "removed" }));

  // The same for removing.
  await assert.rejects(() => compose(files, [remove(2)]), refused("expected_hash_required", { number: 2, path: entryPath(2), subject: "chapter" }));
  await assert.rejects(() => compose(files, [remove(2, { expectedHash: h3 })]), refused("conflict", { reason: "changed" }));
  const removed = await compose(files, [remove(2, { expectedHash: h2 })]);
  assert.deepEqual([removed.composed.removed, removed.composed.changes.map((change) => [change.path, change.content])], [[2], [[entryPath(2), null]]]);
  await assert.rejects(() => compose(files, [remove(9)]), refused("not_found", { index: 0, edit: remove(9), number: 9 }, /chapter 9/));
  await assert.rejects(() => compose(files, [move(9, 1)]), refused("not_found", { index: 0, edit: move(9, 1), number: 9 }, /chapter 9/));
});

test("the description of the book is replaced only with the hash of outline/book.md, and made without one", async () => {
  const files = four();
  const hash = files.get(BOOK).hash;
  await assert.rejects(() => compose(files, [book({ body: "New." })]), refused("expected_hash_required", { index: 0, path: BOOK, subject: "book" }));
  await assert.rejects(() => compose(files, [book({ body: "New." }, hashOf(files, 1))]), refused("conflict", { path: BOOK, subject: "book", reason: "changed" }));
  const done = await compose(files, [book({ body: "New." }, hash)]);
  assert.deepEqual([done.composed.book?.created, done.composed.book?.path, done.composed.book?.hash], [false, BOOK, sha(done.composed.changes[0].content)]);
  const titled = await compose(files, [book({ title: "Another working title" })]);
  assert.match(titled.composed.changes[0].content, /title: Another working title[^]*\n\nThe book\.\n$/, "the text is kept");
  await assert.rejects(() => compose(files, [book({ title: "Another" }, "b".repeat(64))]), refused("conflict", { reason: "changed" }));

  const bareOutline = memory([[1, { title: "E1", body: "one" }]]);
  const created = await compose(bareOutline, [book({ title: "Working", body: "The book." })]);
  assert.deepEqual([created.composed.book?.created, created.composed.changes.map((change) => [change.path, change.expectedHash])], [true, [[BOOK, null]]]);
  await assert.rejects(() => compose(bareOutline, [book({ body: "x" }, hash)]), refused("conflict", { path: BOOK, subject: "book", reason: "removed" }));
});

test("a hash is the hash of the entry as it was read, wherever the series puts it; an entry made by an earlier edit has none, and what was verified once need not be again", async () => {
  const files = four();
  const h1 = hashOf(files, 1);
  const h2 = hashOf(files, 2);

  // E1 is chapter 2 after the insert: the hash read for chapter 1 is still its hash.
  const followed = await compose(files, [insert(1, { title: "N1" }), update(2, { body: "one, changed" }, h1)]);
  assert.deepEqual(followed.composed.updated, [2]);
  assert.match(applied(files, followed.composed.changes).get(entryPath(2)).content, /title: E1[^]*one, changed/);
  assert.match(applied(files, followed.composed.changes).get(entryPath(1)).content, /title: N1/);

  // Chapter 1 is the new one now: the hash is not its (and no hash can be).
  await assert.rejects(() => compose(files, [insert(1, { title: "N1" }), update(1, { body: "x" }, h1)]), refused("conflict", { index: 1, number: 1, reason: "made-in-series" }));
  const fresh = await compose(files, [insert(1, { title: "N1" }), update(1, { body: "the new chapter, written" })]);
  assert.deepEqual([fresh.composed.created, fresh.composed.updated], [[1], []], "writing what you made yourself needs no hash");
  assert.match(applied(files, fresh.composed.changes).get(entryPath(1)).content, /the new chapter, written/);

  // The same hash for a removal after a move, and for a replacement of a moved entry.
  const moved = await compose(files, [move(4, 1), remove(1, { expectedHash: hashOf(files, 4) })]);
  assert.deepEqual(moved.composed.removed, [4]);
  await assert.rejects(() => compose(files, [move(4, 1), remove(1, { expectedHash: hashOf(files, 1) })]), refused("conflict", { reason: "changed" }));

  // Verified once: the second edit of the same entry in the series needs no hash again; one that came after a change with no text in it does.
  const twice = await compose(files, [update(2, { body: "two, again" }, h2), update(2, { body: "two, once more" })]);
  assert.match(applied(files, twice.composed.changes).get(entryPath(2)).content, /two, once more/);
  await assert.rejects(() => compose(files, [update(2, { title: "Two" }), update(2, { body: "two, again" })]), refused("expected_hash_required", { index: 1 }));
  await assert.rejects(() => compose(files, [update(2, { body: "two, again" }, h2), update(2, { body: "x" }, hashOf(files, 3))]), refused("conflict", { index: 1, reason: "changed" }), "a hash that is given is always checked");
});

test("an edit that cannot be made names itself, by its place in the series, and leaves nothing behind", async () => {
  const files = four();
  const missing = remove(9, { expectedHash: "c".repeat(64) });
  await assert.rejects(() => compose(files, [append({ title: "N" }), missing]), refused("not_found", { index: 1, edit: missing, number: 9 }));
  const nothing = update(2, { body: "x" });
  await assert.rejects(() => compose(files, [nothing]), refused("expected_hash_required", { index: 0, edit: nothing }));
  // A hash that cannot be checked is refused, not ignored: a client that gives one believes it protects something.
  for (const edit of [{ ...append({ title: "N" }), expectedHash: "d".repeat(64) }, { ...insert(2), expectedHash: "d".repeat(64) }, { ...move(1, 2), expectedHash: "d".repeat(64) }]) {
    await assert.rejects(() => compose(files, [update(2, { title: "T" }), edit]), refused("invalid_edit", { index: 1, edit }, /expectedHash/), edit.kind);
  }
  // A kind nobody knows, and an edit that is no object.
  await assert.rejects(() => compose(files, [{ kind: "frobnicate" }]), refused("invalid_edit", { index: 0 }, /frobnicate/));
  await assert.rejects(() => compose(files, ["remove"]), refused("invalid_edit", { index: 0 }));
  // An argument that is not a number of a chapter is the engine's own refusal, as it always was.
  await assert.rejects(() => compose(files, [move(1, "two")]), TypeError);
});

test("without a policy the series asks for no hash, and a hash that is given is checked all the same", async () => {
  const files = four();
  const plain = await composeOutlineEdits(sourceOf(files), [update(2, { body: "new" }), remove(3), book({ body: "New." })], { ghostwriters: ["default"] });
  assert.equal(plain.changes.length, 3);
  await assert.rejects(() => composeOutlineEdits(sourceOf(files), [update(2, { body: "new" }, hashOf(files, 3))], { ghostwriters: ["default"] }), refused("conflict", { reason: "changed" }));
  const policy = [];
  await composeOutlineEdits(sourceOf(files), [update(2, { title: "t" }), remove(3), book({ body: "b" })], { ghostwriters: ["default"], requireHash: (edit) => (policy.push(edit.kind), false) });
  assert.deepEqual(policy, ["update", "remove", "book"], "the policy is asked about every edit that can carry a hash");
});

test("outlineEditNeedsHash is the rule of a caller that never overwrites what changed meanwhile: it needs the hash of a text it replaces, of an entry it deletes and of a description it replaces", () => {
  const needs = (edit) => outlineEditNeedsHash(edit);
  assert.deepEqual([update(1, { body: "x" }), update(1, { title: "x" }), update(1, { ghostwriter: null }), update(1, { title: "x", body: "y" })].map(needs), [true, false, false, true]);
  assert.deepEqual([remove(1), remove(1, { renumber: true })].map(needs), [true, true]);
  assert.deepEqual([book({ body: "x" }), book({ title: "x" }), book({ title: null })].map(needs), [true, false, false]);
  assert.deepEqual([append({ body: "x" }), insert(1, { body: "x" }), move(1, 2)].map(needs), [false, false, false], "a new entry has no file to compare with, and a move changes no text");
});

// ─── Warnings, as the engine says them ─────────────────────────────────────

test("what the outline says is a warning, never an error: a ghostwriter that is not there, a text that is cut, a title that is cut; and the gap it reports is the one the outline ends with", async () => {
  const files = four();
  const long = "x".repeat(20_500);
  const { composed } = await compose(files, [
    update(2, { title: "t".repeat(250), body: long, ghostwriter: "ghost-one" }, hashOf(files, 2)),
    append({ ghostwriter: "default" }),
  ]);
  const codes = composed.warnings.map((warning) => warning.code);
  for (const code of ["ghostwriter-missing", "text-too-long", "title-too-long"]) assert.ok(codes.includes(code), `${code} in ${codes}`);
  assert.equal(codes.includes("ghostwriter-invalid"), false);
  const written = applied(files, composed.changes).get(entryPath(2)).content;
  assert.match(written, /ghostwriter: ghost-one/, "it is written all the same");
  assert.equal(/\n\n(x+)\n$/.exec(written)[1].length, 20_000, "the text is cut at 20,000 characters");
  assert.equal(/title: (t+)\n/.exec(written)[1].length, 200, "and the title at 200");
  assert.equal(codes.includes("gap"), false, "no chapter is left without an entry");

  // A gap that an edit makes and a later edit fills is not told: the warning is about the outline as it ends.
  const filled = await compose(files, [remove(2, { expectedHash: hashOf(files, 2) }), update(2, { title: "Two again" })]);
  assert.equal(filled.composed.warnings.some((warning) => warning.code === "gap"), false);
  const left = await compose(files, [remove(2, { expectedHash: hashOf(files, 2) }), update(4, { title: "Four again" })]);
  assert.equal(left.composed.warnings.filter((warning) => warning.code === "gap").length, 1);
  assert.match(left.composed.warnings.find((warning) => warning.code === "gap").message, /chapters 2 have no entry/);
  const several = await compose(files, [update(2, { title: "a", body: long }, hashOf(files, 2)), update(2, { body: long })]);
  assert.equal(several.composed.warnings.filter((warning) => warning.code === "text-too-long").length, 1, "the same warning is told once");

  const none = await compose(files, [update(2, { ghostwriter: "default" })], { ghostwriters: ["default"] });
  assert.equal(none.composed.warnings.length, 0);
  const withGhost = memory([[2, { title: "E2", body: "two", ghostwriter: "ghost-one" }]]);
  const cleared = await compose(withGhost, [update(2, { ghostwriter: null })]);
  assert.doesNotMatch(applied(withGhost, cleared.composed.changes).get(entryPath(2)).content, /ghostwriter/, "null takes it away");
  // Without the list of ghostwriters they are not checked, as in the engine.
  const unchecked = await composeOutlineEdits(sourceOf(files), [update(2, { ghostwriter: "nobody" })]);
  assert.deepEqual(unchecked.warnings, []);
});

test("a gap that was in the outline before the series and is still there is not told again; one that the series made, widened or closed is told as the outline ends", async () => {
  const gapped = memory([[1, { title: "E1", body: "one" }], [2, { title: "E2", body: "two" }], [4, { title: "E4", body: "four" }], [5, { title: "E5", body: "five" }]]);
  const told = (result) => result.composed.warnings.filter((warning) => warning.code === "gap").map((warning) => warning.message);
  assert.deepEqual(told(await compose(gapped, [update(1, { title: "One again" })])), [], "chapter 3 has been without an entry all along");
  assert.deepEqual(told(await compose(gapped, [append({ title: "N" })])), [], "a new last chapter leaves the gap as it was");
  assert.deepEqual(told(await compose(gapped, [update(3, { title: "Three" })])), [], "closed: no gap");
  const widened = told(await compose(gapped, [update(8, { title: "Eight" })]));
  assert.equal(widened.length, 1);
  assert.match(widened[0], /chapters 3, 6-7 have no entry/, "the gaps the outline has now, all of them");
  const moved = told(await compose(gapped, [insert(1, { title: "N" })]));
  assert.match(moved[0] ?? "", /chapters 4 have no entry/, "an insert moves the gap with the entries after it");
  // What changes no entry does not make the series forget the gap an edit made before it.
  assert.equal(told(await compose(gapped, [update(8, { title: "Eight" }), book({ title: "Another" })])).length, 1, "the description of the book has no chapters");
  assert.equal(told(await compose(gapped, [update(8, { title: "Eight" }), move(4, 4)])).length, 1, "and a move that is not one");
});

test("an edit of a chapter that has no entry is refused by default, as a series is never made by halves; a caller may ask for the engine's own answer instead: nothing is changed, and a warning says so", async () => {
  const files = four();
  const edits = [remove(9), update(2, { title: "Two again" }), move(8, 1)];
  const { composed } = await compose(files, edits, { missing: "warn" });
  assert.deepEqual(composed.changes.map((change) => change.path), [entryPath(2)], "the edits that can be made are made");
  assert.deepEqual(composed.warnings.filter((warning) => warning.code === "not-found").map((warning) => warning.number), [9, 8]);
  assert.deepEqual(composed.steps.map((step) => [step.kind, step.missing === true]), [["remove", true], ["update", false], ["move", true]]);
  assert.deepEqual(composed.steps.map((step) => step.origin), [undefined, 2, undefined], "an entry that is not there has no origin");
  assert.deepEqual([composed.created, composed.updated, composed.removed, composed.moved], [[], [2], [], []]);
  assert.deepEqual(contents(applied(files, composed.changes)), contents(await reference(files, [update(2, { title: "Two again" })])));
  // An edit that changes nothing does not make the series forget the gap an edit made before it.
  const gapped = await compose(files, [update(8, { title: "Eight" }), remove(99), move(98, 1)], { missing: "warn" });
  assert.equal(gapped.composed.warnings.filter((warning) => warning.code === "gap").length, 1);
  await assert.rejects(() => compose(files, edits), refused("not_found", { index: 0, number: 9 }));
  await assert.rejects(() => compose(files, edits, { missing: "throw" }), refused("not_found", { index: 0 }));
});

// ─── Where the entries go ──────────────────────────────────────────────────

test("what moved is told as runs, the numbers that changed hands as a list, what was made, changed and deleted by its number, and where each entry went", async () => {
  const files = memory(Array.from({ length: 12 }, (_, index) => [index + 1, { title: `E${index + 1}`, body: `text ${index + 1}` }]));
  const inserted = await compose(files, [insert(3, { title: "N" })]);
  assert.deepEqual(inserted.composed.moved, [{ from: 3, to: 4, count: 10 }], "ten chapters, one number up: one run");
  assert.deepEqual([inserted.composed.created, inserted.composed.updated, inserted.composed.removed], [[3], [], []]);
  assert.equal(inserted.composed.changes.length, 11, "ten renamed and one new");
  assert.deepEqual([inserted.composed.changed, inserted.composed.gone], [[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], []], "every number from the insert on has another entry now");
  assert.equal(inserted.composed.chapters, 13, "and the outline has thirteen entries");

  const moved = await compose(files, [move(2, 5)]);
  assert.deepEqual(moved.composed.moved, [{ from: 2, to: 5, count: 1 }, { from: 3, to: 2, count: 3 }]);
  assert.deepEqual(moved.composed.changed, [2, 3, 4, 5]);

  const closed = await compose(files, [remove(4, { renumber: true, expectedHash: hashOf(files, 4) })]);
  assert.deepEqual([closed.composed.removed, closed.composed.moved], [[4], [{ from: 5, to: 4, count: 8 }]]);
  assert.deepEqual([closed.composed.changed, closed.composed.gone], [[4, 5, 6, 7, 8, 9, 10, 11], [12]], "the number the last entry left has no entry now");
  const kept = await compose(files, [remove(4, { expectedHash: hashOf(files, 4) })]);
  assert.deepEqual([kept.composed.moved, kept.composed.changed, kept.composed.gone, kept.composed.chapters], [[], [], [4], 11], "the others keep their numbers");

  const edited = await compose(files, [update(7, { body: "seven, changed" }, hashOf(files, 7)), book({ body: "A description." })]);
  assert.deepEqual([edited.composed.changed, edited.composed.updated, edited.composed.book?.created], [[7], [7], true]);
  assert.deepEqual(edited.composed.steps, [{ kind: "update", number: 7, created: false, fields: ["body"], origin: 7 }, { kind: "book", created: true, fields: ["body"] }]);
});

test("every edit has a step that says what it did, in the order of the series", async () => {
  const files = four();
  const { composed } = await compose(files, [
    append({ title: "N" }),
    insert(2, { title: "M" }),
    move(1, 3),
    remove(6, { renumber: true }),
    update(1, { title: "One" }),
    update(9, { body: "nine" }),
    book({ title: "Another" }),
    move(2, 2),
    // Chapter 3 is the entry that was chapter 1: the insert and the move put it there, and the hash is the one it was read with.
    update(3, { title: "Three", body: "3", ghostwriter: "default" }, hashOf(files, 1)),
  ], { requireHash: () => false });
  // `origin` is the number the entry had when the series began: a host that names the entries (the title they had) names the right one though the numbers shift.
  assert.deepEqual(composed.steps, [
    { kind: "append", number: 5 },
    { kind: "insert", at: 2 },
    { kind: "move", from: 1, to: 3, unchanged: false, origin: 1 },
    { kind: "remove", number: 6, renumber: true },
    { kind: "update", number: 1, created: false, fields: ["title"] },
    { kind: "update", number: 9, created: true, fields: ["body"] },
    { kind: "book", created: false, fields: ["title"] },
    { kind: "move", from: 2, to: 2, unchanged: true, origin: 2 },
    { kind: "update", number: 3, created: false, fields: ["title", "body", "ghostwriter"], origin: 1 },
  ]);
});

test("the identity of every entry the series did something to is told with the hash it had when the series began: where it is now, or that it is gone", async () => {
  const files = four();
  const [h1, h2, h3, h4] = [1, 2, 3, 4].map((number) => hashOf(files, number));
  const { composed } = await compose(files, [insert(1, { title: "N" }), update(2, { body: "one, changed" }, h1), remove(5, { expectedHash: h4 })]);
  assert.deepEqual(composed.identities, [
    { number: 1, hash: h1, now: 2, updated: true },
    { number: 2, hash: h2, now: 3, updated: false },
    { number: 3, hash: h3, now: 4, updated: false },
    { number: 4, hash: h4, now: null, updated: false },
  ]);
  const quiet = await compose(files, [update(3, { title: "Three, again" })]);
  assert.deepEqual(quiet.composed.identities, [{ number: 3, hash: h3, now: 3, updated: true }], "an entry nothing happened to is not in the table");
  const appended = await compose(files, [append({ title: "N" })]);
  assert.deepEqual(appended.composed.identities, [], "and an entry the series made has no hash to tell: it was not there");
});

test("the numbers of the entries after an edit follow the edit the way the engine moves the files", () => {
  assert.equal(remapOutlineNumber(insert(3), 2), 2);
  assert.equal(remapOutlineNumber(insert(3), 3), 4);
  assert.equal(remapOutlineNumber(move(5, 7), 5), 7);
  assert.equal(remapOutlineNumber(move(5, 7), 6), 5);
  assert.equal(remapOutlineNumber(move(5, 7), 8), 8);
  assert.equal(remapOutlineNumber(move(7, 2), 2), 3);
  assert.equal(remapOutlineNumber(move(7, 2), 7), 2);
  assert.equal(remapOutlineNumber(remove(4), 4), null);
  assert.equal(remapOutlineNumber(remove(4), 6), 6);
  assert.equal(remapOutlineNumber(remove(4, { renumber: true }), 6), 5);
  assert.equal(remapOutlineNumber(remove(4, { renumber: true }), 3), 3);
  assert.equal(remapOutlineNumber(append(), 9), 9);
  assert.equal(remapOutlineNumber(update(2, { title: "t" }), 2), 2);
  assert.equal(remapOutlineNumber(book({ title: "t" }), 2), 2);
});

test("remapOutlineNumber says where the engine puts every entry: made on the real files, for every kind of edit and every number", async () => {
  const files = memory(Array.from({ length: 9 }, (_, index) => [index + 1, { title: `E${index + 1}`, body: `text ${index + 1}` }]));
  for (const edit of [insert(1), insert(5), insert(10), move(2, 7), move(7, 2), move(4, 4), move(9, 1), remove(3), remove(3, { renumber: true }), remove(9, { renumber: true }), append(), update(4, { title: "x" })]) {
    const after = await reference(files, [edit]);
    for (let number = 1; number <= 9; number += 1) {
      const where = remapOutlineNumber(edit, number);
      const found = [...after].find(([file, { content }]) => file !== BOOK && new RegExp(`^text ${number}$`, "m").test(content));
      assert.equal(found ? Number(/(\d+)\.md$/.exec(found[0])[1]) : null, where, `${JSON.stringify(edit)}: chapter ${number}`);
    }
  }
});

// ─── What is read ──────────────────────────────────────────────────────────

test("an outline of any length is not read to change one entry: the entries a series has to rewrite are read, and the others are known by their path and hash", async () => {
  const many = memory(Array.from({ length: 400 }, (_, index) => [index + 1, { title: `E${index + 1}`, body: `text ${index + 1}` }]), { title: "Working", body: "The book." });
  const h5 = hashOf(many, 5);
  const one = await compose(many, [update(5, { body: "five, changed" }, h5)]);
  assert.deepEqual(one.source.reads, [entryPath(5)], "the entry itself");
  assert.deepEqual(one.composed.changes.map((change) => change.path), [entryPath(5)]);

  const several = await compose(many, [update(5, { title: "Five" }), append({ title: "N" }), remove(9, { expectedHash: hashOf(many, 9) }), book({ title: "Another" })]);
  assert.deepEqual([...several.source.reads].sort(), [BOOK, entryPath(5)], "the entry that is changed and the description; a removed entry is known by its hash, an appended one is new");
  assert.deepEqual(several.composed.changes.map((change) => change.path), [BOOK, entryPath(401), entryPath(5), entryPath(9)].sort());
  assert.equal(several.composed.changes.find((change) => change.path === entryPath(9)).expectedHash, hashOf(many, 9), "and what is deleted is deleted only if it is as it was");

  const tail = await compose(many, [insert(399, { title: "N" })]);
  assert.deepEqual(tail.source.reads.sort(), [entryPath(399), entryPath(400)], "a renumbering reads the entries it moves, and no others");
  assert.equal(tail.composed.changes.length, 3, "chapters 399 and 400 move, and one is new");
  const head = await compose(many, [insert(1, { title: "N" })]);
  assert.equal(head.source.reads.length, 400, "an insert at the head moves every entry: every one is read");
  const between = await compose(many, [move(10, 12), remove(100, { renumber: true, expectedHash: hashOf(many, 100) })]);
  assert.equal(between.source.reads.length, 3 + 300, "chapters 10 to 12, and the ones after 100 that follow the removal; none of the 87 in between");

  // Whatever is read, the files are the ones the engine makes.
  const series = [update(5, { title: "Five", body: "five, changed" }, h5), append({ title: "N" }), remove(9, { expectedHash: hashOf(many, 9) }), book({ title: "Another" })];
  const partial = await compose(many, series);
  assert.deepEqual(contents(applied(many, partial.composed.changes)), contents(await reference(many, series)));
});

test("an outline of 5000 entries is read as little as the edit allows, and what is read is counted: one entry for an update, none for an append or a removal, the ones that move for an insert near the end", async () => {
  const count = 5000;
  const big = memory(Array.from({ length: count }, (_, index) => [index + 1, { title: `Chapter ${index + 1}`, body: `What happens in chapter ${index + 1}. ${"The harbor holds its breath. ".repeat(8)}` }]), { title: "Working", body: "The book." });
  let started = performance.now();
  const update2500 = await compose(big, [update(2500, { body: "changed" }, hashOf(big, 2500))]);
  assert.deepEqual([update2500.source.reads, update2500.composed.changes.length], [[entryPath(2500)], 1], "one entry: one read");
  const appended = await compose(big, [append({ title: "The last" })]);
  assert.deepEqual([appended.source.reads, appended.composed.changes.map((change) => change.path)], [[], [entryPath(5001)]], "an append reads nothing");
  const removed = await compose(big, [remove(100, { expectedHash: hashOf(big, 100) })]);
  assert.deepEqual([removed.source.reads, removed.composed.changes.map((change) => [change.path, change.content])], [[], [[entryPath(100), null]]], "a removal reads nothing: the hash it was given and the one in the list are enough");
  const inserted = await compose(big, [insert(4999, { title: "Before the end" })]);
  assert.deepEqual(inserted.source.reads.sort(), [entryPath(4999), entryPath(5000)], "the two that move");
  assert.deepEqual([inserted.composed.created, inserted.composed.moved, inserted.composed.changes.length], [[4999], [{ from: 4999, to: 5000, count: 2 }], 3]);
  const edits = Array.from({ length: 50 }, (_, index) => update(1 + index * 90, { title: `T${index}` }));
  const fifty = await compose(big, edits);
  assert.equal(fifty.source.reads.length, 50, "fifty edits of fifty entries: fifty reads");
  assert.ok(performance.now() - started < 30_000, "and none of it takes long");

  // An insert at the head renames every entry: that is what the limit of files is for, and with the limit lifted it is made, in one list, reading every entry once.
  started = performance.now();
  const everything = await composeOutlineEdits(sourceOf(big), [insert(1, { title: "A new opening" })], { maxFiles: Number.POSITIVE_INFINITY });
  assert.equal(everything.changes.length, count + 1);
  assert.equal(everything.moved.length, 1);
  assert.ok(performance.now() - started < 30_000, `${(performance.now() - started).toFixed(0)} ms`);
});

test("an outline with a second file for a chapter, or a file that is not named as an entry is, is read whole and read again after every edit, as the engine reads it: what an edit frees is taken by the file that waited for it", async () => {
  const waiting = `---\ntype: outline-chapter\nnumber: 3\ntitle: Three, the one that waited\n---\n\nit waited\n`;
  const plain = `---\ntype: outline-chapter\nnumber: 9\ntitle: Nine, with a plain name\n---\n\nnine\n`;
  const files = four();
  files.set("outline/chapters/0003.md", { content: waiting, hash: sha(waiting) });
  files.set("outline/chapters/9.md", { content: plain, hash: sha(plain) });
  const text = (map, file) => map.get(file)?.content;

  // The entry of chapter 3 is removed, and the file that was left out because it came second now says chapter 3: the next edit is of it, in the engine's own reading.
  const series = [remove(3, { expectedHash: hashOf(files, 3) }), update(3, { title: "Three, as it is now" })];
  const whole = await compose(files, series);
  const result = applied(files, whole.composed.changes);
  assert.deepEqual(contents(result), contents(await reference(files, series)), "what the engine makes when it reads the files again after each edit");
  assert.match(text(result, entryPath(3)), /title: Three, as it is now/);
  assert.match(text(result, entryPath(3)), /it waited/, "the text is the one of the file that waited");
  assert.equal(result.has("outline/chapters/0003.md"), false, "which is the entry now, so it moves to the name of the entry");
  assert.ok(whole.source.reads.length >= files.size - 1, "the outline was read whole");

  // The same edits where the file that waited is not told: the entry of chapter 3 is made anew and the file that waited stays. An outline with odd names has to be told.
  const names = [...files.keys()].filter((file) => file !== "outline/chapters/0003.md");
  const blind = await composeOutlineEdits({ ...sourceOf(files), paths: names }, series, { ghostwriters: ["default"], requireHash: outlineEditNeedsHash });
  assert.notDeepEqual(contents(applied(files, blind.changes)), contents(result), "without the names of every file the outline is not read as the engine reads it");

  // The second file may be the only odd thing: every name the index knows is the canonical one, and only the list of the book's files shows it. Files that are not the
  // outline's are in that list, and are not read.
  const hidden = four();
  hidden.set("outline/chapters/0003.md", { content: waiting, hash: sha(waiting) });
  const everything = [...hidden.keys(), "chapters/001-arrival/chapter.md", "notes.md", "outline/act-one.md"];
  const found = { ...sourceOf(hidden), paths: everything };
  assert.ok(found.index.chapters.every((entry) => entry.path === entryPath(entry.number)), "the index knows no odd name");
  const underneath = await composeOutlineEdits(found, series, { ghostwriters: ["default"], requireHash: outlineEditNeedsHash });
  assert.deepEqual(contents(applied(hidden, underneath.changes)), contents(await reference(hidden, series)));
  assert.deepEqual([...found.reads].sort(), [...hidden.keys()].sort(), "the outline was read whole, and nothing else");

  // A name that is not the canonical one is the entry of its chapter, and an edit that moves it writes the canonical name and deletes the other.
  const moved = [insert(1, { title: "N" }), move(10, 2)];
  const wholeMoved = await compose(files, moved);
  assert.deepEqual(contents(applied(files, wholeMoved.composed.changes)), contents(await reference(files, moved)));
  assert.equal(applied(files, wholeMoved.composed.changes).has("outline/chapters/9.md"), false);
  assert.match(text(applied(files, wholeMoved.composed.changes), entryPath(2)), /Nine, with a plain name/);
  assert.equal(wholeMoved.composed.changes.every((change) => change.content === null || /origin: author/.test(change.content)), true);

  // Every edit made on the outline the one before left, in the whole reading too.
  for (const edits of [
    [append({ title: "A" }), remove(9, { expectedHash: sha(plain) })],
    [move(4, 1), update(1, { title: "Four, first" })],
    [insert(3, { title: "N" }), update(4, { title: "Three again" })],
    [book({ title: "Another", body: "Changed." }, files.get(BOOK).hash), remove(2, { renumber: true, expectedHash: hashOf(files, 2) })],
  ]) {
    const composed = await compose(files, edits);
    assert.deepEqual(contents(applied(files, composed.composed.changes)), contents(await reference(files, edits)), JSON.stringify(edits.map(bare)));
  }
});

test("the files that are not the outline's are not its business: the list of a book's files may be given whole, and an outline of any other shape than the engine reads is read as the engine reads it", async () => {
  const files = four();
  const stray = "# Act one\n\n1. Arrival.\n";
  const withStray = new Map(files);
  withStray.set("outline/act-one.md", { content: stray, hash: sha(stray) });
  const everything = [...withStray.keys(), "chapters/001-arrival/chapter.md", "notes.md", "outline/chapters/notes.md"];
  const source = { ...sourceOf(withStray), paths: everything };
  const composed = await composeOutlineEdits(source, [update(2, { title: "Two, again" })], { ghostwriters: ["default"] });
  assert.deepEqual(composed.changes.map((change) => change.path), [entryPath(2)]);
  assert.deepEqual(source.reads, [entryPath(2)], "a file that is no entry makes no difference: the outline is not read whole for it");
  // With no list of paths, the index is all there is.
  const { paths, ...indexOnly } = sourceOf(files);
  assert.deepEqual((await composeOutlineEdits(indexOnly, [update(2, { title: "Two, again" })], { ghostwriters: ["default"] })).changes.map((change) => change.path), [entryPath(2)]);
  // An outline that has nothing yet.
  const empty = await composeOutlineEdits({ index: outlineIndex([]), read: async () => null }, [book({ title: "Working", body: "A book." }), append({ title: "One" }), append({ title: "Two" })], { ghostwriters: [] });
  assert.deepEqual(empty.changes.map((change) => [change.path, change.expectedHash]), [[BOOK, null], [entryPath(1), null], [entryPath(2), null]]);
  assert.deepEqual([empty.created, empty.book?.created, empty.chapters], [[1, 2], true, 2]);
});

test("a file that was listed and is gone when it is read changed since the outline was listed: the series is a conflict, and nothing is made", async () => {
  const files = four();
  const source = sourceOf(files);
  files.delete(entryPath(2));
  await assert.rejects(() => composeOutlineEdits(source, [update(2, { title: "x" })], { ghostwriters: ["default"] }), refused("conflict", { path: entryPath(2), reason: "gone" }));
  const odd = four();
  odd.set("outline/chapters/7.md", { content: serializeOutlineChapter({ number: 7, title: "Seven" }), hash: "0".repeat(64) });
  const oddSource = sourceOf(odd);
  odd.delete("outline/chapters/7.md");
  await assert.rejects(() => composeOutlineEdits(oddSource, [update(2, { title: "x" })], { ghostwriters: ["default"] }), refused("conflict", { path: "outline/chapters/7.md", reason: "gone" }), "an outline read whole says it the same way");
});

test("an entry whose frontmatter cannot be read is moved as it is and written anew only when it is edited, with a warning", async () => {
  const files = four();
  const broken = `---\ntype: outline-chapter\ntitle: "unterminated\nnumber: 3\n---\n\nthree, broken\n`;
  files.set(entryPath(3), { content: broken, hash: sha(broken) });
  const moved = await compose(files, [insert(1, { title: "N" })]);
  assert.equal(applied(files, moved.composed.changes).get(entryPath(4)).content, broken, "moved as it is");
  const edited = await compose(files, [update(3, { body: "three, fixed" }, sha(broken))]);
  assert.ok(edited.composed.warnings.some((warning) => warning.code === "unreadable" && warning.number === 3));
  assert.match(applied(files, edited.composed.changes).get(entryPath(3)).content, /three, fixed/);
});

// ─── How many edits, how many files ────────────────────────────────────────

test("a series that would change more files than the limit is refused whole, as soon as it has, and says how many it had by then", async () => {
  assert.equal(OUTLINE_COMPOSE_MAX_FILES, 1000);
  assert.equal(OUTLINE_COMPOSE_MAX_EDITS, 50);
  const many = memory(Array.from({ length: 30 }, (_, index) => [index + 1, { title: `E${index + 1}`, body: "x" }]));
  await assert.rejects(() => compose(many, [insert(1, { title: "N" })], { maxFiles: 20 }), refused("too_many_files", { count: 31, limit: 20, index: 0 }, /at least 31 files[^]*20/));
  const allowed = await compose(many, [insert(11, { title: "N" })], { maxFiles: 21 });
  assert.equal(allowed.composed.changes.length, 21);
  // It is refused as soon as it has touched too many, not after the rest of its edits have rewritten the outline over again: the count is the one of the first edit that
  // went over (31), not the one of fifty inserts (80).
  const long = Array.from({ length: 50 }, (_, index) => insert(1, { title: `N${index}` }));
  await assert.rejects(() => compose(many, long, { maxFiles: 20 }), refused("too_many_files", { count: 31, limit: 20, index: 0 }));
  // The files it touched and put back as they were are not counted: the entries here are changed and changed back, one after the other, and nothing is left to commit.
  const there = update(1, { body: "a text" }, hashOf(many, 1));
  const back = update(1, { body: "x" });
  const thereToo = update(2, { title: "E2, for a while" });
  const backToo = update(2, { title: "E2" });
  const same = await compose(many, [there, back, thereToo, backToo], { maxFiles: 1 });
  assert.deepEqual(same.composed.changes, []);
  // ...but the limit is for every moment of the series: two files changed at once are two files, though both end as they began.
  await assert.rejects(() => compose(many, [there, thereToo, back, backToo], { maxFiles: 1 }), refused("too_many_files", { count: 2, limit: 1, index: 1 }));
  // The last edit may be the one that goes over, and a series that ends over the limit is refused the same.
  await assert.rejects(() => compose(many, [update(1, { title: "A" }), update(2, { title: "B" })], { maxFiles: 1 }), refused("too_many_files", { count: 2, limit: 1 }));
  // The limit is the caller's: none at all is a number too.
  assert.equal((await compose(many, [insert(1, { title: "N" })], { maxFiles: Number.POSITIVE_INFINITY })).composed.changes.length, 31);
});

test("a series has at most the limit of edits, and says so before anything is read", async () => {
  const files = four();
  const edits = Array.from({ length: OUTLINE_COMPOSE_MAX_EDITS + 1 }, () => append());
  const source = sourceOf(files);
  await assert.rejects(() => composeOutlineEdits(source, edits, {}), refused("too_many_edits", { count: 51, limit: 50 }, /at most 50/));
  assert.deepEqual(source.reads, []);
  assert.equal((await compose(files, edits.slice(0, OUTLINE_COMPOSE_MAX_EDITS))).composed.created.length, 50);
  await assert.rejects(() => compose(files, edits.slice(0, 4), { maxEdits: 3 }), refused("too_many_edits", { count: 4, limit: 3 }));
  assert.equal((await compose(files, edits, { maxEdits: Number.POSITIVE_INFINITY })).composed.created.length, 51);
  assert.deepEqual((await compose(files, [])).composed.changes, [], "an empty series is a series that changes nothing, not an error");
});

// ─── The engine is the oracle ──────────────────────────────────────────────

/** A small deterministic generator, so that a failure can be run again. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs of consecutive entries that moved together: `{ from, to, count }`. */
function runs(pairs) {
  const found = [];
  for (const [from, to] of [...pairs].sort(([left], [right]) => left - right)) {
    const last = found.at(-1);
    if (last && from === last.from + last.count && to === last.to + last.count) last.count += 1;
    else found.push({ from, to, count: 1 });
  }
  return found;
}

test("whatever the series, the entries end up where the engine puts them, and the identity the series followed is the identity that the engine's files show", async () => {
  const titleOf = (files, number) => /title: (.*)/.exec(files.get(entryPath(number))?.content ?? "")?.[1];
  for (let seed = 1; seed <= 120; seed += 1) {
    const next = random(seed);
    const pick = (list) => list[Math.floor(next() * list.length)];
    // Ten entries with two gaps; each original entry is E<number>, each made in the series is N<k>.
    const numbers = [1, 2, 3, 4, 7, 8, 9, 10, 12, 13];
    const original = memory(numbers.map((number) => [number, { title: `E${number}`, body: `text ${number}` }]), next() < 0.5 ? { title: "Working", body: "The book." } : null);
    let ref = new Map(original);
    const edits = [];
    const touched = new Set();
    const origins = [];
    let made = 0;
    const length = 1 + Math.floor(next() * 7);
    for (let step = 0; step < length; step += 1) {
      const current = [...ref.keys()].filter((file) => file !== BOOK).map((file) => Number(/(\d+)\.md$/.exec(file)[1])).sort((left, right) => left - right);
      const last = current.at(-1) ?? 0;
      const kind = pick(["append", "insert", "move", "remove", "update", "update"]);
      let edit;
      if (kind === "append") edit = append({ title: `N${(made += 1)}` });
      else if (kind === "insert") edit = insert(1 + Math.floor(next() * (last + 2)), { title: `N${(made += 1)}` });
      else if (kind === "move" && current.length) edit = move(pick(current), 1 + Math.floor(next() * (last + 1)));
      else if (kind === "remove" && current.length) {
        const number = pick(current);
        const title = titleOf(ref, number);
        edit = remove(number, { renumber: next() < 0.5, ...(title.startsWith("E") ? { expectedHash: original.get(entryPath(Number(title.slice(1)))).hash } : {}) });
      } else if (kind === "update") {
        const exists = current.length && next() < 0.8;
        const number = exists ? pick(current) : 1 + Math.floor(next() * (last + 2));
        const title = titleOf(ref, number);
        const known = title?.startsWith("E");
        edit = update(number, { body: `body ${step}`, ...(title === undefined ? { title: `N${(made += 1)}` } : {}) }, known ? original.get(entryPath(Number(title.slice(1)))).hash : undefined);
        if (known) touched.add(title);
      } else continue;
      edits.push(edit);
      // The entry the edit is about, by the title the reference run gives it before the edit: an original entry is E<number>, one the series made is N<k>.
      const addressed = edit.kind === "move" ? edit.from : edit.kind === "remove" || edit.kind === "update" ? edit.number : undefined;
      const addressedTitle = addressed === undefined ? undefined : titleOf(ref, addressed);
      origins.push(addressedTitle?.startsWith("E") ? Number(addressedTitle.slice(1)) : undefined);
      const outline = await parseOutline([...ref].map(([file, { content, hash }]) => ({ path: file, content, hash })));
      ref = applied(ref, outlineChanges({ outline, edit: bare(edit), ghostwriters: ["default"] }).changes);
    }
    if (!edits.length) continue;
    const label = `seed ${seed}: ${JSON.stringify(edits.map(bare))}`;

    const { composed, source } = await compose(original, edits);
    assert.deepEqual(contents(applied(original, composed.changes)), contents(ref), label);

    // The identity: where every original entry is at the end, by its title, is what the series followed.
    const finalNumbers = [...ref.keys()].filter((file) => file !== BOOK).map((file) => Number(/(\d+)\.md$/.exec(file)[1]));
    const where = new Map(finalNumbers.map((number) => [titleOf(ref, number), number]));
    const moved = numbers.filter((number) => where.has(`E${number}`) && where.get(`E${number}`) !== number).map((number) => [number, where.get(`E${number}`)]);
    assert.deepEqual(composed.moved, runs(moved), label);
    assert.deepEqual(composed.removed, numbers.filter((number) => !where.has(`E${number}`)), label);
    assert.deepEqual(composed.created, finalNumbers.filter((number) => titleOf(ref, number).startsWith("N")).sort((left, right) => left - right), label);
    assert.deepEqual(composed.updated, [...touched].filter((title) => where.has(title)).map((title) => where.get(title)).sort((left, right) => left - right), label);
    assert.deepEqual(composed.identities.map((identity) => [identity.number, identity.now]), numbers.filter((number) => where.get(`E${number}`) !== number || touched.has(`E${number}`) || !where.has(`E${number}`)).map((number) => [number, where.get(`E${number}`) ?? null]), label);
    for (const identity of composed.identities) assert.equal(identity.hash, original.get(entryPath(identity.number)).hash, `${label}: the hash is the one of the file when the series began`);
    assert.equal(composed.chapters, finalNumbers.length, label);
    assert.deepEqual(composed.steps.map((step) => step.origin), origins, `${label}: the origin of what every edit is about`);
    const reads = source.reads.filter((file) => file !== BOOK);
    assert.ok(edits.some((edit) => edit.kind === "insert" || edit.kind === "move" || (edit.kind === "remove" && edit.renumber)) || reads.length <= edits.length, `${label}: without a renumbering, only what is changed is read (${reads.length})`);
  }
});

test("the same series on the files an app has all in memory is the same commit: the caller that has every file gives them as the index and reads from the map", async () => {
  const files = memory(Array.from({ length: 300 }, (_, index) => [index + 1, { title: `E${index + 1}`, body: `text ${index + 1}` }]), { title: "Working", body: "The book." });
  const edits = [insert(2, { title: "New" }), move(10, 200), update(5, { body: "five" }), remove(299), append({ title: "Last" }), book({ body: "Another." })];
  const lazy = await compose(files, edits, { requireHash: () => false, maxFiles: Number.POSITIVE_INFINITY, maxEdits: Number.POSITIVE_INFINITY });
  assert.deepEqual(contents(applied(files, lazy.composed.changes)), contents(await reference(files, edits)));
  const inMemory = await composeOutlineEdits({ index: outlineIndex([...files].map(([file, { hash }]) => [file, hash])), read: async (file) => (files.has(file) ? { path: file, ...files.get(file) } : null) }, edits, { ghostwriters: ["default"] });
  assert.deepEqual(inMemory.changes, lazy.composed.changes);
  assert.deepEqual(inMemory.warnings, lazy.composed.warnings);
});
