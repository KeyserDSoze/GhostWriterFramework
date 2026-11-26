import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseMarkdown, parseOutlineJournal } from "narrarium-engine";
import { until, withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { fakeAi, holdingAi, startOf } from "./hold.mjs";
import { commitCount, enableMcp, issueToken, lastCommit, mcpBook, mcpClient, mcpFixture, mcpRoute } from "./mcp-helpers.mjs";
import { autopilotEntry, bookFile, bulkOutline, countReads, done, entryFile, invalid, onDisk, outlineFixture, refused, sha } from "./mcp-outline-helpers.mjs";
import { outlineEntryFiles } from "narrarium-engine/testing";
import { connectApp } from "./oauth-helpers.mjs";

// The tool that changes the outline (the Scaletta) through a book's MCP endpoint (S9): edit_outline, a series of the engine's own edits made in order as one commit,
// every entry it writes the author's, and never over what changed meanwhile. What the engine and the composer do with a series is in mcp-outline-compose.test.mjs;
// these tests are about the tool: what it accepts, what it writes, what it answers, who may call it, and what it leaves behind when it fails.

const num = (number) => String(number).padStart(3, "0");
const entryPath = (number) => `outline/chapters/${num(number)}.md`;
const read = async (server, number, bookId = "glass") => parseMarkdown(await onDisk(server, entryPath(number), bookId));
const exists = (server, number) => onDisk(server, entryPath(number)).then(() => true, () => false);
const hashOf = async (rpc, number) => done(await rpc.call("read_outline_entry", { number })).hash;
const bookHash = async (rpc) => done(await rpc.call("read_outline")).book.hash;
const edit = (rpc, ...edits) => rpc.call("edit_outline", { edits });
const JOURNAL = "outline/changes.yml";

/** An outline of four entries of the author and a description, for the tests of each edit. */
const plain = () => [
  bookFile({ title: "Working title", body: "The book in a few lines." }),
  entryFile(1, { title: "One", body: "text one" }),
  entryFile(2, { title: "Two", body: "text two" }),
  entryFile(3, { title: "Three", body: "text three" }),
  entryFile(4, { title: "Four", body: "text four" }),
];

const withPlain = (run, options = {}) => withServer(async (server, client) => run(server, client, await outlineFixture(server, client, { files: plain(), freeze: false })), options);

// ─── Changing an entry ─────────────────────────────────────────────────────

test("S9: edit_outline changes an entry as one commit: the engine writes the file, as the author's and with no digest, the hash that comes back is the file's, and what the answer says is what changed", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const before = commitCount(server);
    const chapterBefore = await onDisk(server, "chapters/001-arrival/chapter.md");
    const hash = await hashOf(rpc, 3);
    const answer = done(await edit(rpc, { kind: "update", number: 3, title: "The Keeper's Fear", body: "Mira finds the keeper afraid of the tide.", expectedHash: hash }));

    const file = await onDisk(server, entryPath(3));
    assert.deepEqual([answer.edited, answer.applied, answer.created, answer.updated, answer.removed, answer.moved, answer.files], [true, ["update chapter 3: title, text"], [], [3], [], [], 1]);
    assert.deepEqual(answer.entries, [{ number: 3, path: entryPath(3), hash: sha(file) }]);
    assert.deepEqual(answer.warnings, []);
    assert.match(answer.commit, /^[0-9a-f]{7,64}$/);
    assert.equal(lastCommit(server), "MCP (Claude Code): edit outline: update chapter 3: title, text");
    assert.equal(commitCount(server), before + 1, "one commit");

    const document = parseMarkdown(file);
    assert.deepEqual(document.frontmatter, { type: "outline-chapter", id: "outline-chapter:003", number: 3, title: "The Keeper's Fear", origin: "author" }, "the author's: no digest, and nothing the format does not manage was invented");
    assert.equal(document.body, "Mira finds the keeper afraid of the tide.");
    const entry = done(await rpc.call("read_outline_entry", { number: 3 }));
    assert.deepEqual([entry.hash, entry.origin, entry.intact, entry.binds, entry.title], [answer.entries[0].hash, "author", false, true, "The Keeper's Fear"]);
    assert.equal(await onDisk(server, "chapters/001-arrival/chapter.md"), chapterBefore, "an edit of the outline never touches a chapter: the freeze of chapter 1 is as it was");
  });
});

test("S9: each series of edit_outline is a series of the journal of the Synopsis, by an assistant through MCP, in the same commit, with what happened to each chapter", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const before = commitCount(server);
    done(await edit(rpc, { kind: "move", from: 3, to: 2 }, { kind: "append", title: "Five", body: "text five" }));
    assert.equal(commitCount(server), before + 1, "one commit");
    const journal = parseOutlineJournal(await onDisk(server, JOURNAL));
    assert.deepEqual(journal.series.map((series) => [series.by, series.chapters.map((item) => [item.chapter, item.change, item.from ?? null, item.title])]), [
      ["mcp", [[2, "moved", 3, "Three"], [3, "moved", 2, "Two"], [5, "created", null, "Five"]]],
    ]);
    const removable = await hashOf(rpc, 4);
    done(await edit(rpc, { kind: "remove", number: 4, expectedHash: removable }));
    const after = parseOutlineJournal(await onDisk(server, JOURNAL));
    assert.deepEqual(after.series.map((series) => series.chapters.map((item) => [item.chapter, item.change, item.title])), [[[2, "moved", "Three"], [3, "moved", "Two"], [5, "created", "Five"]], [[4, "removed", "Four"]]], "appended");
    const book = done(await edit(rpc, { kind: "book", title: "Another working title" }));
    assert.equal(book.edited, true);
    assert.equal(parseOutlineJournal(await onDisk(server, JOURNAL)).series.length, 2, "the description of the book alone is no news of chapters");
    const outline = done(await rpc.call("read_outline"));
    assert.equal(JSON.stringify(outline).includes("changes.yml"), false, "the journal is no entry of the synopsis");
  });
});

test("S9: an entry the autopilot wrote and nobody touched becomes the author's as soon as an edit writes it, and then binds the autopilot", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const storm = done(await rpc.call("read_outline_entry", { number: 2 }));
    assert.deepEqual([storm.origin, storm.intact, storm.binds], ["autopilot", true, false]);
    assert.match(await onDisk(server, entryPath(2)), /digest: /);
    const answer = done(await edit(rpc, { kind: "update", number: 2, title: "The Storm" }));
    assert.equal(answer.edited, true, "the same title is still a change: the entry was the autopilot's and is the author's now");
    assert.doesNotMatch(await onDisk(server, entryPath(2)), /digest/);
    const after = done(await rpc.call("read_outline_entry", { number: 2 }));
    assert.deepEqual([after.origin, after.intact, after.binds], ["author", false, true]);
    const again = done(await edit(rpc, { kind: "update", number: 2, title: "The Storm" }));
    assert.deepEqual([again.edited, again.files], [false, 0], "now that it is the author's, the same words change nothing");
    assert.match(again.message, /nothing to change/i);
  });
});

test("S9: an edit that changes nothing makes no commit and says so", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const before = commitCount(server);
    const answer = done(await edit(rpc, { kind: "update", number: 2, title: "Two" }, { kind: "move", from: 3, to: 3 }));
    assert.deepEqual([answer.edited, answer.files, answer.created, answer.updated, answer.commit], [false, 0, [], [], undefined]);
    assert.equal(answer.applied.length, 2, "what was asked is still told");
    assert.match(answer.message, /nothing to change/i);
    assert.equal(commitCount(server), before);
  });
});

// ─── Each kind of edit ─────────────────────────────────────────────────────

test("S9: append adds a chapter after the last one, and insert puts one at a number: the chapters from there on move one number up, as the engine moves them", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const appended = done(await edit(rpc, { kind: "append", title: "Five", body: "text five", ghostwriter: "default" }));
    assert.deepEqual([appended.created, appended.updated, appended.moved, appended.files, appended.applied], [[5], [], [], 1, ["append chapter 5"]]);
    assert.deepEqual((await read(server, 5)).frontmatter, { type: "outline-chapter", id: "outline-chapter:005", number: 5, title: "Five", ghostwriter: "default", origin: "author" });

    const before = commitCount(server);
    const inserted = done(await edit(rpc, { kind: "insert", at: 2, title: "Between", body: "a chapter in between" }));
    assert.deepEqual([inserted.created, inserted.moved, inserted.files, inserted.removed], [[2], [{ from: 2, to: 3, count: 4 }], 5, []], "four chapters move and one is new: five files");
    assert.equal(commitCount(server), before + 1, "however many files move, one commit");
    const titles = [];
    for (let number = 1; number <= 6; number += 1) titles.push((await read(server, number)).frontmatter.title);
    assert.deepEqual(titles, ["One", "Between", "Two", "Three", "Four", "Five"]);
    const moved = await read(server, 4);
    assert.deepEqual([moved.frontmatter.number, moved.frontmatter.id, moved.body], [4, "outline-chapter:004", "text three"], "a moved entry is the same entry under another number: the number and the id of the file follow");
    assert.deepEqual(inserted.entries.map((entry) => entry.number), [2], "the hashes of the entries it made; the ones that only moved are read again when they are needed");

    const past = done(await edit(rpc, { kind: "insert", at: 9, title: "Nine" }));
    assert.deepEqual([past.created, past.moved, past.warnings.map((warning) => warning.code)], [[9], [], ["gap"]], "a chapter past the end leaves a gap, which is a warning");
    assert.match(past.warnings[0].message, /chapters 7-8 have no entry/);
  });
});

test("S9: move takes an entry to another number and the ones in between follow; remove deletes an entry and leaves its number empty, or closes the gap with renumber", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const moved = done(await edit(rpc, { kind: "move", from: 1, to: 3 }));
    assert.deepEqual([moved.moved, moved.created, moved.updated, moved.removed, moved.files], [[{ from: 1, to: 3, count: 1 }, { from: 2, to: 1, count: 2 }], [], [], [], 3]);
    const titles = async (numbers) => Promise.all(numbers.map(async (number) => (await read(server, number)).frontmatter.title));
    assert.deepEqual(await titles([1, 2, 3, 4]), ["Two", "Three", "One", "Four"]);

    const hash3 = await hashOf(rpc, 3);
    const removed = done(await edit(rpc, { kind: "remove", number: 3, expectedHash: hash3 }));
    assert.deepEqual([removed.removed, removed.moved, removed.files, removed.applied], [[3], [], 1, ["remove chapter 3 (the following chapters keep their numbers)"]], "removed is the number the entry had before the call");
    assert.equal(await exists(server, 3), false);
    assert.deepEqual(removed.warnings.map((warning) => warning.code), ["gap"]);
    assert.match(removed.warnings[0].message, /chapters 3 have no entry/);
    assert.equal(await exists(server, 4), true, "the next one kept its number");

    const closed = done(await edit(rpc, { kind: "remove", number: 2, renumber: true, expectedHash: await hashOf(rpc, 2) }));
    assert.deepEqual([closed.removed, closed.moved, closed.applied], [[2], [{ from: 4, to: 3, count: 1 }], ["remove chapter 2 (the following chapters move down one number)"]]);
    assert.deepEqual(await titles([1, 3]), ["Two", "Four"]);
    assert.equal(await exists(server, 4), false);
  });
});

test("S9: update makes the entry of a chapter that has none, takes a ghostwriter away with null, and the description of the book is changed by book", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const made = done(await edit(rpc, { kind: "update", number: 7, title: "Seven", body: "text seven", ghostwriter: "default" }));
    assert.deepEqual([made.created, made.updated, made.applied], [[7], [], ["create chapter 7: title, text, ghostwriter"]]);
    assert.ok(made.warnings.some((warning) => warning.code === "gap"), "chapters 5 and 6 have no entry");
    assert.equal((await read(server, 7)).frontmatter.ghostwriter, "default");

    const hash = await hashOf(rpc, 7);
    const cleared = done(await edit(rpc, { kind: "update", number: 7, ghostwriter: null }));
    assert.deepEqual([cleared.updated, cleared.applied], [[7], ["update chapter 7: ghostwriter"]]);
    assert.equal("ghostwriter" in (await read(server, 7)).frontmatter, false, "null takes it away: the book's own writes the chapter");
    assert.equal((await read(server, 7)).body, "text seven", "and what was not named stays");
    assert.notEqual(await hashOf(rpc, 7), hash);

    const description = done(await edit(rpc, { kind: "book", body: "A better description.", expectedHash: await bookHash(rpc) }));
    assert.deepEqual([description.book?.path, description.book?.created, description.applied, description.files], ["outline/book.md", false, ["update the description of the book: text"], 1]);
    const file = parseMarkdown(await onDisk(server, "outline/book.md"));
    assert.deepEqual(file.frontmatter, { type: "outline", id: "outline:book", title: "Working title", origin: "author" });
    assert.equal(file.body, "A better description.");
    assert.equal(description.book.hash, sha(await onDisk(server, "outline/book.md")));
    const titled = done(await edit(rpc, { kind: "book", title: "Another working title" }));
    assert.equal(parseMarkdown(await onDisk(server, "outline/book.md")).frontmatter.title, "Another working title", "a title needs no hash: no text is replaced");
    assert.equal(titled.book.created, false);
  });
});

test("S9: the description of a book that has none is made by book, without a hash", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client, { files: [entryFile(1, { title: "One", body: "x" })], freeze: false });
    const made = done(await edit(rpc, { kind: "book", title: "Working title", body: "A new description." }));
    assert.deepEqual([made.book.created, made.applied], [true, ["write the description of the book: title, text"]]);
    assert.equal(done(await rpc.call("read_outline")).book.title, "Working title");
    refused(await edit(rpc, { kind: "book", body: "Again.", expectedHash: "f".repeat(64) }), "conflict");
    refused(await edit(rpc, { kind: "book", body: "Again." }), "expected_hash_required", /outline\/book\.md/);
  });
});

// ─── A series ──────────────────────────────────────────────────────────────

test("S9: a series of edits is applied in order, each to the outline the one before left, and is one commit; the hash that was read is the hash of the entry wherever the series has put it", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const hashTwo = await hashOf(rpc, 2);
    const hashFour = await hashOf(rpc, 4);
    const hashBook = await bookHash(rpc);
    const before = commitCount(server);
    const answer = done(await edit(
      rpc,
      { kind: "insert", at: 2, title: "Interlude", body: "A new chapter." },
      { kind: "update", number: 3, body: "text two, rewritten", expectedHash: hashTwo },
      { kind: "remove", number: 5, expectedHash: hashFour },
      { kind: "append", title: "Epilogue" },
      { kind: "book", body: "The book, again.", expectedHash: hashBook },
    ));
    assert.deepEqual([answer.created, answer.updated, answer.removed, answer.moved], [[2, 5], [3], [4], [{ from: 2, to: 3, count: 2 }]]);
    assert.equal(answer.files, 5, "the new chapter 2, chapter 3 and 4, chapter 5 (which was Four and is the Epilogue) and the description");
    assert.equal(commitCount(server), before + 1, "five edits, one commit");
    assert.ok(/^MCP \(Claude Code\): edit outline: insert chapter 2/.test(lastCommit(server)) && lastCommit(server).length <= 300, lastCommit(server));
    const titles = [];
    for (let number = 1; number <= 5; number += 1) titles.push((await read(server, number)).frontmatter.title);
    assert.deepEqual(titles, ["One", "Interlude", "Two", "Three", "Epilogue"]);
    assert.equal((await read(server, 3)).body, "text two, rewritten", "the text went to the entry the hash was of, which the insert had moved to 3");
    assert.deepEqual(answer.entries.map((entry) => entry.number), [2, 3, 5], "the entries it made or changed, with their hashes");
    for (const entry of answer.entries) assert.equal(entry.hash, sha(await onDisk(server, entry.path)), `${entry.path}: the hash is the file's`);
    assert.equal(answer.book.hash, sha(await onDisk(server, "outline/book.md")));
    assert.equal((await onDisk(server, "outline/book.md")).includes("The book, again."), true);
    assert.equal(answer.applied.length, 5);
  });
});

test("S9: a series that fails in the middle leaves nothing behind: no commit, no file, and the answer names the edit", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const before = commitCount(server);
    const file = await onDisk(server, entryPath(1));
    refused(await edit(rpc, { kind: "update", number: 1, title: "Changed" }, { kind: "append", title: "Five" }, { kind: "remove", number: 9, expectedHash: "a".repeat(64) }), "not_found", /edits\[2\][^]*remove[^]*chapter 9/);
    assert.equal(commitCount(server), before, "no commit");
    assert.equal(await onDisk(server, entryPath(1)), file, "the first edit was not written");
    assert.equal(await exists(server, 5), false, "nor the second");
    refused(await edit(rpc, { kind: "update", number: 2, title: "Changed" }, { kind: "update", number: 3, body: "x" }), "expected_hash_required", /edits\[1\]/);
    refused(await edit(rpc, { kind: "insert", at: 1, title: "N" }, { kind: "update", number: 1, body: "x", expectedHash: await hashOf(rpc, 1) }), "conflict", /edits\[1\]/);
    assert.equal(commitCount(server), before);
    assert.equal((await read(server, 2)).frontmatter.title, "Two");
    const entries = await server.mcp.audit.recent(4);
    assert.deepEqual(entries.filter((entry) => entry.tool === "edit_outline").map((entry) => [entry.ok, entry.code]).reverse().slice(0, 3), [[false, "not_found"], [false, "expected_hash_required"], [false, "conflict"]]);
  });
});

// ─── Never over what changed meanwhile ─────────────────────────────────────

test("S9: the text of an entry is replaced only with the hash that read_outline_entry gave, a hash that is not the file's is a conflict, and an entry that changed since it was read is never overwritten", async () => {
  await withPlain(async (server, client, { rpc }) => {
    const before = commitCount(server);
    refused(await edit(rpc, { kind: "update", number: 2, body: "A new text." }), "expected_hash_required", /outline\/chapters\/002\.md[^]*read_outline_entry/);
    refused(await edit(rpc, { kind: "update", number: 2, body: "A new text.", expectedHash: await hashOf(rpc, 3) }), "conflict", /outline\/chapters\/002\.md/);
    refused(await edit(rpc, { kind: "update", number: 2, body: "A new text.", expectedHash: "not a hash" }), "invalid_input", /expectedHash[^]*64/);
    refused(await edit(rpc, { kind: "remove", number: 2 }), "expected_hash_required");
    refused(await edit(rpc, { kind: "remove", number: 2, expectedHash: "0".repeat(64) }), "conflict");
    refused(await edit(rpc, { kind: "update", number: 2, title: "Zwei", expectedHash: "0".repeat(64) }), "conflict", undefined);
    assert.equal(commitCount(server), before, "nothing was written");

    // Someone else (the author, in the app) changes the entry between the read and the edit.
    const hash = await hashOf(rpc, 2);
    const [current] = await client.readFiles("glass", [entryPath(2)]);
    await client.commitFiles("glass", [{ path: entryPath(2), content: current.content.replace("text two", "text two, changed by the author"), expectedHash: current.hash }], "the author edits the entry");
    refused(await edit(rpc, { kind: "update", number: 2, body: "The assistant's text.", expectedHash: hash }), "conflict", /read it again/);
    refused(await edit(rpc, { kind: "remove", number: 2, expectedHash: hash }), "conflict");
    assert.equal((await read(server, 2)).body, "text two, changed by the author", "the author's text is still there");
    const afresh = await hashOf(rpc, 2);
    assert.notEqual(afresh, hash);
    assert.equal(done(await edit(rpc, { kind: "update", number: 2, body: "The assistant's text, after reading.", expectedHash: afresh })).edited, true, "read again, it is replaced");

    // An entry removed and an entry made meanwhile: the hash of what was there is the hash of nothing now.
    const gone = await hashOf(rpc, 4);
    await client.commitFiles("glass", [{ path: entryPath(4), content: null }], "the author deletes it");
    refused(await edit(rpc, { kind: "update", number: 4, body: "x", expectedHash: gone }), "conflict", /no entry/);
    refused(await edit(rpc, { kind: "remove", number: 4, expectedHash: gone }), "not_found");
  });
});

test("S9: a change that lands between the tool's reading and its commit is never overwritten either: the store compares the hash it holds with the file, and the call is a conflict", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const hash = await hashOf(rpc, 2);
    const runtime = server.books.get("glass");
    const original = runtime.store.commit;
    runtime.store.commit = async function commit(...args) {
      await writeFile(path.join(server.data.bookDirectory("glass"), entryPath(2)), "---\ntype: outline-chapter\nnumber: 2\n---\n\nwritten under the call\n");
      return original.apply(this, args);
    };
    try {
      const before = commitCount(server);
      refused(await edit(rpc, { kind: "update", number: 2, body: "The assistant's text.", expectedHash: hash }), "conflict", /outline\/chapters\/002\.md/);
      assert.equal(commitCount(server), before, "no commit");
      assert.match(await onDisk(server, entryPath(2)), /written under the call/, "and the file is what the other writer left");
    } finally {
      runtime.store.commit = original;
    }
  });
});

// ─── What the outline says ─────────────────────────────────────────────────

test("S9: a ghostwriter that does not exist, a text past 20,000 characters and a title past 200 are warnings in the answer: the entry is written all the same, as the engine writes it", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const hash = await hashOf(rpc, 2);
    const answer = done(await edit(rpc, { kind: "update", number: 2, title: "t".repeat(300), body: "x".repeat(25_000), ghostwriter: "ghost-two", expectedHash: hash }));
    assert.deepEqual(answer.warnings.map((warning) => warning.code).sort(), ["ghostwriter-missing", "text-too-long", "title-too-long"]);
    for (const warning of answer.warnings) assert.deepEqual([warning.path, warning.number, typeof warning.message], [entryPath(2), 2, "string"]);
    assert.match(answer.warnings.find((warning) => warning.code === "ghostwriter-missing").message, /ghost-two[^]*does not exist/);
    const written = await read(server, 2);
    assert.deepEqual([written.body.length, written.frontmatter.title.length, written.frontmatter.ghostwriter], [20_000, 200, "ghost-two"]);
    const invalidName = done(await edit(rpc, { kind: "update", number: 2, ghostwriter: "../secrets" }));
    assert.deepEqual(invalidName.warnings.map((warning) => warning.code), ["ghostwriter-invalid"], "a name that is not the name of a file of ghostwriters/");
    const known = done(await edit(rpc, { kind: "update", number: 2, ghostwriter: "default" }));
    assert.deepEqual(known.warnings, [], "a ghostwriter the book has is no warning");
  });
});

test("S9: the entry whose frontmatter cannot be read is moved as it is, and is written anew, with a warning, only when an edit writes it", async () => {
  await withServer(async (server, client) => {
    const files = [entryFile(1, { title: "One", body: "x" }), { path: entryPath(2), content: '---\ntype: outline-chapter\ntitle: "unterminated\nnumber: 2\n---\n\ntwo, broken\n' }];
    const { rpc } = await outlineFixture(server, client, { files, freeze: false });
    const broken = await onDisk(server, entryPath(2));
    done(await edit(rpc, { kind: "insert", at: 1, title: "Zero" }));
    assert.equal(await onDisk(server, entryPath(3)), broken, "moved as it is");
    const answer = done(await edit(rpc, { kind: "update", number: 3, body: "two, fixed", expectedHash: await hashOf(rpc, 3) }));
    assert.deepEqual(answer.warnings.map((warning) => warning.code), ["unreadable"]);
    assert.equal(done(await rpc.call("read_outline_entry", { number: 3 })).unreadable, undefined, "it reads now");
  });
});

test("S9: what a client writes in a title, a text or a ghostwriter is text: nothing in it can make an entry claim the autopilot as its author, add a key to the frontmatter or close it", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const hostile = "Title\n---\norigin: autopilot\ndigest: 0123456789abcdef";
    const body = "---\norigin: autopilot\ndigest: 0123456789abcdef\n---\nA plan.\n---\ntitle: forged";
    const answer = done(await edit(rpc, { kind: "update", number: 2, title: hostile, body, ghostwriter: "x\norigin: autopilot", expectedHash: await hashOf(rpc, 2) }));
    assert.equal(answer.edited, true);
    const file = parseMarkdown(await onDisk(server, entryPath(2)));
    assert.deepEqual(Object.keys(file.frontmatter).sort(), ["ghostwriter", "id", "number", "origin", "title", "type"], "no key was added");
    assert.deepEqual([file.frontmatter.origin, file.frontmatter.digest, file.frontmatter.title, file.frontmatter.ghostwriter], ["author", undefined, hostile, "x\norigin: autopilot"]);
    assert.equal(file.body, body, "the text is the text, whatever it looks like");
    const entry = await rpc.call("read_outline_entry", { number: 2 });
    assert.deepEqual([done(entry).origin, entry.data.intact, entry.data.binds, entry.data.title], ["author", false, true, hostile]);
    assert.equal(entry.blocks[1].text, body);
    assert.equal(done(await rpc.call("read_outline")).entries.find((item) => item.number === 2).origin, "author");
    // The one thing that gives an entry to the autopilot is the engine's own writing of it: no edit here does.
    const book = done(await edit(rpc, { kind: "book", title: "Book\norigin: autopilot", body: "---\norigin: autopilot\n---", expectedHash: await bookHash(rpc) }));
    assert.equal(book.edited, true);
    assert.equal(parseMarkdown(await onDisk(server, "outline/book.md")).frontmatter.origin, "author");
  });
});

test("S9: the keys of an entry that the format does not manage are kept when an edit writes it, and an entry is made in a folder that does not exist yet", async () => {
  await withServer(async (server, client) => {
    const kept = { path: entryPath(1), content: "---\ntype: outline-chapter\nid: outline-chapter:001\nnumber: 1\ntitle: One\norigin: author\nmood: tense\nnotes:\n  - keep me\n---\n\ntext one\n" };
    const { rpc } = await outlineFixture(server, client, { files: [kept], freeze: false });
    done(await edit(rpc, { kind: "update", number: 1, title: "One, again" }));
    const frontmatter = parseMarkdown(await onDisk(server, entryPath(1))).frontmatter;
    assert.deepEqual([frontmatter.mood, frontmatter.notes, frontmatter.title], ["tense", ["keep me"], "One, again"]);
    done(await edit(rpc, { kind: "insert", at: 1, title: "Zero" }));
    assert.deepEqual(parseMarkdown(await onDisk(server, entryPath(2))).frontmatter.mood, "tense", "and when it moves");
  });
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    await client.commitFiles("glass", [{ path: "outline/act-one.md", content: null }], "no outline at all");
    const first = done(await edit(rpc, { kind: "append", title: "The first chapter", body: "It begins." }, { kind: "book", title: "Working title", body: "A book." }));
    assert.deepEqual([first.created, first.book.created, first.files], [[1], true, 2]);
    assert.equal((await read(server, 1)).frontmatter.title, "The first chapter");
    assert.deepEqual(done(await rpc.call("read_outline")).entries.map((entry) => entry.number), [1]);
  });
});

test("S9: an outline with two files for one chapter, or an entry that says another number, is read as the engine reads it, and is edited from every file, the one that counts and the one that does not", async () => {
  await withServer(async (server, client) => {
    const files = [
      entryFile(7, { title: "Seven", body: "the one that counts" }),
      { path: "outline/chapters/0007.md", content: "---\ntype: outline-chapter\nnumber: 7\ntitle: Seven, the second file\n---\n\nthe one that does not\n" },
      { path: "outline/chapters/008.md", content: "---\ntype: outline-chapter\nnumber: 9\ntitle: Eight\n---\n\nsays nine\n" },
    ];
    const { rpc } = await outlineFixture(server, client, { files, freeze: false });
    const listed = done(await rpc.call("read_outline"));
    assert.deepEqual(listed.entries.map((entry) => [entry.number, entry.title, entry.path]), [[7, "Seven", entryPath(7)], [8, "Eight", entryPath(8)]]);
    const codes = Object.fromEntries(listed.warnings.map((warning) => [warning.code, warning.path]));
    assert.deepEqual(codes.duplicate, "outline/chapters/0007.md", "the file that does not count is said");
    assert.equal(codes["number-mismatch"], entryPath(8), "so is the number that is not the file's");
    assert.match(listed.warnings.find((warning) => warning.code === "gap").message, /chapters 1-6 have no entry/);

    const answer = done(await edit(rpc, { kind: "update", number: 7, body: "the one that counts, changed", expectedHash: await hashOf(rpc, 7) }, { kind: "update", number: 8, title: "Eight again" }));
    assert.deepEqual([answer.updated, answer.files], [[7, 8], 2]);
    assert.match(await onDisk(server, entryPath(7)), /the one that counts, changed/);
    assert.match(await onDisk(server, "outline/chapters/0007.md"), /the one that does not/, "the other file is not the edit's to touch");
    assert.equal(parseMarkdown(await onDisk(server, entryPath(8))).frontmatter.number, 8, "the engine writes the number of the file");
  });
});

test("S9: in an outline with a second file for a chapter, removing the entry that counts lets the file that waited count, and the next edit of the series is of it, as the engine reads the outline between two edits", async () => {
  await withServer(async (server, client) => {
    const waiting = { path: "outline/chapters/0003.md", content: "---\ntype: outline-chapter\nnumber: 3\ntitle: Three, the one that waited\n---\n\nit waited\n" };
    const files = [entryFile(1, { title: "One", body: "text one" }), entryFile(2, { title: "Two", body: "text two" }), entryFile(3, { title: "Three", body: "the one that counts" }), waiting];
    const { rpc } = await outlineFixture(server, client, { files, freeze: false });
    assert.equal(done(await rpc.call("read_outline_entry", { number: 3 })).title, "Three", "the file with the canonical name counts, the other is a duplicate");
    const before = commitCount(server);

    const answer = done(await edit(rpc, { kind: "remove", number: 3, expectedHash: await hashOf(rpc, 3) }, { kind: "update", number: 3, title: "Three, as it is now" }));
    assert.deepEqual([answer.edited, answer.files, commitCount(server)], [true, 2, before + 1]);
    const entry = await read(server, 3);
    assert.deepEqual([entry.frontmatter.title, entry.body.trim(), entry.frontmatter.origin], ["Three, as it is now", "it waited", "author"], "the entry that was read again after the removal is the file that waited");
    assert.equal(await onDisk(server, "outline/chapters/0003.md").then(() => true, () => false), false, "which now has the name of an entry");
    assert.equal(done(await rpc.call("read_outline")).warnings.some((warning) => warning.code === "duplicate"), false, "and the outline has no duplicate left");
  });
});

test("S9: the outline can be read and edited while the autopilot runs, and what an edit wrote is the author's: the autopilot follows it and never rewrites it", async () => {
  const ai = holdingAi();
  try {
    await withServer(async (server, client) => {
      await seededBook(client, "b", { chapters: 0 });
      // Entries the autopilot wrote earlier and nobody touched: they bind nothing, and the plan writes them again.
      await client.commitFiles("b", [await autopilotEntry(1, { title: "Chapter Title 1", body: "Event 1 happens and the story turns." }), await autopilotEntry(2, { title: "Chapter Title 2", body: "Event 2 happens and the story turns." })], "entries the autopilot wrote");
      const { slug } = await enableMcp(server, "b");
      const rpc = mcpClient(server, slug, await issueToken(server));
      await client.startAutopilot("b", startOf(2));
      await until(() => ai.isHeld(), 30_000);

      // The plan has been made, and it wrote the outline: the autopilot's own entries, which bind nothing.
      const listed = done(await rpc.call("read_outline"));
      assert.deepEqual(listed.entries.map((entry) => [entry.number, entry.origin, entry.intact, entry.written]), [[1, "autopilot", true, false], [2, "autopilot", true, false]]);
      const second = done(await rpc.call("read_outline_entry", { number: 2 }));
      const edited = done(await rpc.call("edit_outline", { edits: [{ kind: "update", number: 2, title: "The author's second chapter", body: "A chapter the author asks for.", expectedHash: second.hash }] }));
      assert.deepEqual([edited.edited, edited.updated], [true, [2]], "the book can be edited while the autopilot runs");

      ai.release();
      assert.equal((await finished(client, "b")).state.status, "completed");
      const after = done(await rpc.call("read_outline_entry", { number: 2 }));
      assert.deepEqual([after.origin, after.intact, after.binds, after.title, after.hash], ["author", false, true, "The author's second chapter", edited.entries[0].hash], "the autopilot did not rewrite it");
      const first = done(await rpc.call("read_outline_entry", { number: 1 }));
      assert.equal(first.origin, "autopilot", "and the entry nobody touched is still the autopilot's own");
    }, { ai });
  } finally {
    ai.release();
  }
});

// ─── What a call may say ───────────────────────────────────────────────────

test("S9: the schema of edit_outline is what the call is checked against, and what a tool that is told something odd says names the edit", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const before = commitCount(server);
    invalid(await rpc.call("edit_outline", {}), /edits/);
    invalid(await rpc.call("edit_outline", { edits: [] }), /edits[^]*at least 1/);
    invalid(await rpc.call("edit_outline", { edits: "update" }), /edits[^]*list/);
    invalid(await rpc.call("edit_outline", { edits: Array.from({ length: 51 }, () => ({ kind: "append" })) }), /edits[^]*at most 50/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "append" }, { kind: "frobnicate" }] }), /edits\[1\]\.kind[^]*append, insert, move, remove, update, book/);
    invalid(await rpc.call("edit_outline", { edits: [{ title: "x" }] }), /edits\[0\]\.kind[^]*required/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "append", colour: "red" }] }), /edits\[0\]\.colour[^]*not a property/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "update", number: "3", title: "x" }] }), /edits\[0\]\.number[^]*integer/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "update", number: 0, title: "x" }] }), /edits\[0\]\.number/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "update", number: 1, ghostwriter: 5 }] }), /edits\[0\]\.ghostwriter[^]*string/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "update", number: 1, title: "t".repeat(401) }] }), /edits\[0\]\.title[^]*at most 400/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "update", number: 1, ghostwriter: "g".repeat(121) }] }), /edits\[0\]\.ghostwriter/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "remove", number: 1, renumber: "yes" }] }), /edits\[0\]\.renumber[^]*true or false/);
    invalid(await rpc.call("edit_outline", { edits: [{ kind: "append" }], dryRun: true }), /dryRun[^]*not a property/);
    refused(await edit(rpc, { kind: "append", number: 3 }), "invalid_input", /edits\[0\][^]*append[^]*`number`[^]*takes: title, body, ghostwriter/);
    refused(await edit(rpc, { kind: "insert", title: "T" }), "invalid_input", /edits\[0\][^]*insert[^]*`at`[^]*required/);
    refused(await edit(rpc, { kind: "move", from: 1 }), "invalid_input", /move[^]*`to`/);
    refused(await edit(rpc, { kind: "update", number: 1 }), "invalid_input", /update[^]*nothing[^]*title, body or ghostwriter/);
    refused(await edit(rpc, { kind: "book" }), "invalid_input", /book[^]*nothing/);
    refused(await edit(rpc, { kind: "remove", number: 1, title: "x" }), "invalid_input", /remove[^]*`title`/);
    refused(await edit(rpc, { kind: "append", expectedHash: "a".repeat(64) }), "invalid_input", /append[^]*new entry/);
    assert.equal(commitCount(server), before, "nothing was written");
    assert.equal(done(await edit(rpc, ...Array.from({ length: 50 }, (_, index) => ({ kind: "append", title: `Chapter ${index + 5}` })))).created.length, 50, "fifty edits are the most, and they are allowed");
    assert.equal(commitCount(server), before + 1, "in one commit");
  });
});

test("S9: edit_outline is called with the arguments the schema it publishes describes: edits is a list of objects, ghostwriter may be null, every property is described", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const tools = (await rpc.request("tools/list", {})).json.result.tools;
    const tool = tools.find((candidate) => candidate.name === "edit_outline");
    assert.ok(tool, "edit_outline is listed");
    assert.deepEqual([tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.idempotentHint, tool.annotations.openWorldHint], [false, true, false, false], "it changes and removes, and called twice with an append it adds twice");
    assert.deepEqual(tool.inputSchema.required, ["edits"]);
    const edits = tool.inputSchema.properties.edits;
    assert.deepEqual([edits.type, edits.maxItems, edits.minItems], ["array", 50, 1]);
    assert.equal(edits.items.type, "object");
    assert.equal(edits.items.additionalProperties, false);
    assert.deepEqual(edits.items.required, ["kind"]);
    assert.deepEqual(edits.items.properties.kind.enum, ["append", "insert", "move", "remove", "update", "book"]);
    assert.deepEqual(Object.keys(edits.items.properties).sort(), ["at", "body", "expectedHash", "from", "ghostwriter", "kind", "number", "renumber", "title", "to"]);
    for (const [key, property] of Object.entries(edits.items.properties)) assert.ok(property.description?.length > 20, `${key} is described for a model that does not know the engine`);
    assert.deepEqual(edits.items.properties.ghostwriter.type, ["string", "null"], "null takes the ghostwriter away, in the standard words of JSON Schema");
    for (const word of ["ONE commit", "expectedHash", "write_file", "order"]) assert.ok(tool.description.includes(word), `the description says ${word}`);
    assert.match(tool.description, /never write the synopsis's files with write_file/i);
    for (const name of ["read_outline", "read_outline_entry"]) {
      const reading = tools.find((candidate) => candidate.name === name);
      assert.deepEqual([reading.annotations.readOnlyHint, reading.annotations.destructiveHint, reading.annotations.idempotentHint, reading.annotations.openWorldHint], [true, false, true, false], name);
    }
  });
});

// ─── Who may write ─────────────────────────────────────────────────────────

test("S9: a client sees edit_outline, and may call it, only with the write permission; the tools that read the outline are there for every client", async () => {
  await withServer(async (server, client) => {
    const { slug } = await outlineFixture(server, client);
    const clientOf = async (scopes) => mcpClient(server, slug, await issueToken(server, scopes.join("+"), scopes));
    const reader = await clientOf(["read"]);
    const runner = await clientOf(["read", "run"]);
    const writer = await clientOf(["read", "write"]);
    for (const [who, expected] of [[reader, false], [runner, false], [writer, true]]) {
      const names = await who.list();
      assert.deepEqual([names.includes("read_outline"), names.includes("read_outline_entry"), names.includes("edit_outline")], [true, true, expected]);
    }
    const before = commitCount(server);
    refused(await reader.call("edit_outline", { edits: [{ kind: "append", title: "No" }] }), "scope", /write/);
    refused(await runner.call("edit_outline", { edits: [{ kind: "append", title: "No" }] }), "scope", /write/);
    refused(await reader.call("edit_outline", {}), "scope", /write/);
    assert.equal(commitCount(server), before, "nothing was written");
    assert.equal(done(await writer.call("edit_outline", { edits: [{ kind: "append", title: "Yes" }] })).created.length, 1);
    assert.equal(commitCount(server), before + 1);
    assert.equal(done(await reader.call("read_outline_entry", { number: 7 })).title, "Yes", "and the reader reads what the writer wrote");
    assert.equal((await (await mcpRoute(server)).put({ enabled: false })).status, 200);
    const off = await writer.call("edit_outline", { edits: [{ kind: "append", title: "Off" }] });
    assert.equal(off.status, 404, "the book's MCP being off ends the tool too, with the same 404");
    assert.equal(commitCount(server), before + 1);
  });
});

test("S9: an app connected through OAuth is for one book: with the permissions the owner chose it edits that book's outline, and another book's address does not know it", async () => {
  await withServer(async (server, client) => {
    const { slug } = await outlineFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    await client.commitFiles("moon", [entryFile(1, { title: "Moonrise", body: "The moon comes up." })], "outline");
    const moon = await enableMcp(server, "moon");
    const reading = await connectApp(server, { slug, name: "Reader", scopes: ["read"] });
    const writing = await connectApp(server, { slug, name: "Writer", scopes: ["read", "write"] });
    const asReader = mcpClient(server, slug, reading.tokens.access_token);
    const asWriter = mcpClient(server, slug, writing.tokens.access_token);
    assert.equal(done(await asReader.call("read_outline")).total, 5);
    assert.equal((await asReader.list()).includes("edit_outline"), false);
    refused(await asReader.call("edit_outline", { edits: [{ kind: "append", title: "No" }] }), "scope");
    assert.equal(done(await asWriter.call("edit_outline", { edits: [{ kind: "append", title: "From an app" }] })).created.length, 1);
    assert.equal(lastCommit(server), "MCP (Writer): edit outline: append chapter 7");

    const elsewhere = mcpClient(server, moon.slug, writing.tokens.access_token);
    assert.equal((await elsewhere.call("read_outline")).status, 404, "the address of a book it is not for: the same 404 as an address that is not there");
    assert.equal((await elsewhere.call("edit_outline", { edits: [{ kind: "append", title: "No" }] })).status, 404);
    const moonReader = mcpClient(server, moon.slug, await issueToken(server, "moon reader", ["read"]));
    assert.deepEqual(done(await moonReader.call("read_outline")).entries.map((entry) => entry.title), ["Moonrise"], "a client token of the server reaches every book whose MCP is on, and sees its own outline");
    assert.equal(await onDisk(server, entryPath(1), "moon").then((file) => file.includes("Moonrise")), true, "and the other book was not touched");
  });
});

// ─── write_file does not write the outline ─────────────────────────────────

test("S9: write_file does not write in outline/: it answers forbidden and sends the model to edit_outline, for a file that exists and for one that does not, while read_file and list_files go on reading it", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const before = commitCount(server);
    const reading = await rpc.call("read_file", { path: entryPath(1) });
    const entry = done(reading);
    const content = reading.blocks[1].text;
    assert.equal(entry.writable, false, "read_file says that it cannot be written here");
    assert.match(content, /title: Arrival/, "and still reads it");
    const listing = done(await rpc.call("list_files", { directory: "outline" }));
    assert.equal(listing.files.length, 7, "book, five entries and the old file");
    assert.deepEqual([...new Set(listing.files.map((file) => file.writable))], [false], "every file of outline/ is listed as one that write_file cannot change");

    for (const target of [entryPath(1), "outline/chapters/009.md", "outline/book.md", "outline/act-one.md", "outline/act-two.md", "outline/notes/ideas.md", "outline/chapters/7.md"]) {
      const answer = await rpc.call("write_file", { path: target, content: "---\ntype: outline-chapter\norigin: autopilot\ndigest: abc\n---\n\nA file made up by hand.\n" });
      refused(answer, "forbidden", /edit_outline/);
      assert.match(answer.text, /read_outline/, `${target}: it says how to read`);
    }
    refused(await rpc.call("write_file", { path: entryPath(1), content: "x", expectedHash: entry.hash }), "forbidden", /edit_outline/, "not even with the hash of the file");
    assert.equal(commitCount(server), before, "nothing was written");
    assert.equal(await exists(server, 9), false);
    await assert.rejects(onDisk(server, "outline/act-two.md"));
    assert.equal(await onDisk(server, entryPath(1)), content, "the entry is as it was");

    refused(await rpc.call("write_file", { path: "autopilot/state.json", content: "{}" }), "forbidden", /autopilot/);
    assert.equal(done(await rpc.call("write_file", { path: "drafts/still-works.md", content: "# Still works\n" })).written, true, "the other files of the book are written as before");
    assert.equal(commitCount(server), before + 1);
  });
});

// ─── What is recorded, and what is limited ─────────────────────────────────

test("S9: the audit says which files an edit asked for and changed, with the commit it made, and never the text; a call that failed says why in a short code", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client, { files: plain(), freeze: false });
    const marker = "AUDIT-MARKER-70411";
    const hash = await hashOf(rpc, 2);
    const answer = done(await edit(rpc, { kind: "update", number: 2, body: `A text with ${marker}.`, expectedHash: hash }));
    refused(await edit(rpc, { kind: "update", number: 3, body: `Another with ${marker}.` }), "expected_hash_required");
    refused(await edit(rpc, { kind: "remove", number: 9, expectedHash: "a".repeat(64) }), "not_found");
    done(await edit(rpc, { kind: "insert", at: 4, title: marker }, { kind: "book", title: "Another" }));
    const entries = (await server.mcp.audit.recent(10)).reverse().filter((entry) => entry.tool === "edit_outline");
    // A series that changed entries changed the journal of the Synopsis too.
    assert.deepEqual(entries.map((entry) => [entry.tool, entry.ok, entry.code ?? null, [...(entry.paths ?? [])].sort(), entry.commit ?? null]), [
      ["edit_outline", true, null, [JOURNAL, entryPath(2)].sort(), answer.commit],
      ["edit_outline", false, "expected_hash_required", [entryPath(3)], null],
      ["edit_outline", false, "not_found", [entryPath(9)], null],
      ["edit_outline", true, null, ["outline/book.md", JOURNAL, entryPath(4), entryPath(5)].sort(), entries[3].commit],
    ]);
    assert.match(entries[3].commit, /^[0-9a-f]{7,64}$/);
    const log = await readFile(path.join(server.data.root, "mcp-audit.jsonl"), "utf8");
    assert.equal(log.includes(marker), false, "the audit does not hold what the outline says");
  });
});

test("S9: edit_outline counts as a call that changes the book: with the limit of writes reached the call is a 429 that does nothing, and reading the outline goes on", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const before = commitCount(server);
    assert.equal((await edit(rpc, { kind: "append", title: "Five" })).isError, false);
    assert.equal((await edit(rpc, { kind: "append", title: "Six" })).isError, false);
    const limited = await edit(rpc, { kind: "append", title: "Seven" });
    assert.deepEqual([limited.status, limited.json.code], [429, "rate_limit"]);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal(commitCount(server), before + 2, "the call over the limit did nothing");
    assert.equal(await exists(server, 7), false);
    assert.equal(done(await rpc.call("read_outline")).total, 6, "reading goes on");
  }, { limits: { mcpCallsPerMinute: 100, mcpWritesPerMinute: 2 } });
});

test("S9: while the server waits to restart for an update, edit_outline is refused like every tool that changes the book, and the tools that read the outline go on", async () => {
  await withPlain(async (server, _client, { rpc }) => {
    const before = commitCount(server);
    await server.books.requestUpdate(async () => undefined);
    try {
      refused(await edit(rpc, { kind: "append", title: "Later" }), "maintenance", /restart/);
      assert.equal(done(await rpc.call("read_outline")).total, 4);
      assert.equal(done(await rpc.call("read_outline_entry", { number: 1 })).title, "One");
    } finally {
      server.books.leaveMaintenance();
    }
    assert.equal(commitCount(server), before);
    assert.equal(done(await edit(rpc, { kind: "append", title: "Now" })).created.length, 1);
  });
});

// ─── What the autopilot does about a chapter that is written ───────────────

test("S9: an edit that changes the entry of a chapter that is written says what the autopilot does about it, as its settings say; chapters that nobody plans are told that nothing happens to them", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await outlineFixture(server, client);
    const hash = await hashOf(rpc, 1);
    const none = done(await edit(rpc, { kind: "update", number: 1, body: "Mira reaches the harbor at night.", expectedHash: hash }));
    assert.equal(none.notes.length, 1);
    assert.match(none.notes[0], /^Chapter 1 is already written[^]*no plan of the autopilot follows its entry[^]*not touched/);
    assert.equal(done(await edit(rpc, { kind: "update", number: 3, title: "Keeper" })).notes, undefined, "a chapter that is not written has no note: it is planned again from its entry");
    const both = done(await edit(rpc, { kind: "insert", at: 1, title: "Prologue" }));
    assert.match(both.notes.join(" "), /Chapters 1 and 2 are already written/, "an insert moves the entries of the chapters after it: the written ones are told, in one sentence");
  });

  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 1 });
    await client.startAutopilot("b", startOf(1));
    assert.equal((await finished(client, "b")).state.status, "completed");
    const status = await enableMcp(server, "b");
    const rpc = mcpClient(server, status.slug, await issueToken(server));
    const change = async (title) => done(await edit(rpc, { kind: "update", number: 1, title }));
    assert.match((await change("A new title")).notes[0], /^Chapter 1 is already written[^]*ask the author whether to rewrite it to follow the new entry or keep its text/);
    await client.updateAutopilotOptions("b", { frozenEdits: "auto" });
    assert.match((await change("Another new title")).notes[0], /rewrite it to follow the new entry, without asking/);
    await client.updateAutopilotOptions("b", { frozenEdits: "notify" });
    assert.match((await change("A third title")).notes[0], /only report the change, without rewriting the chapter/);
  });
});

test("S9: the notes of an edit say one sentence for each thing the autopilot does about the chapters that are written: it rewrites the one it wrote and only reports the ones the author wrote before it took the book over", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    await client.commitFiles("glass", Object.entries(outlineEntryFiles(3)).map(([path, content]) => ({ path, content })), "the chapter entries of the three");
    await client.startAutopilot("glass", startOf(3));
    assert.equal((await finished(client, "glass")).state.status, "completed");
    await client.updateAutopilotOptions("glass", { frozenEdits: "auto" });
    const answer = done(await edit(rpc, { kind: "update", number: 1, title: "One, again" }, { kind: "update", number: 3, title: "Three, again" }, { kind: "update", number: 2, title: "Two, again" }));
    assert.equal(answer.notes.length, 2, "two outcomes, two sentences");
    assert.match(answer.notes[0], /^Chapter 3 is already written: the autopilot will rewrite it to follow the new entry, without asking/);
    assert.match(answer.notes[1], /^Chapters 1 and 2 are already written: the autopilot will only report the changes, without rewriting the chapters/);
  });
});

test("S9: an entry that an edit deletes for a chapter that is written is not a change to decide about: the chapter stays in the book and the autopilot only says it; the entries that move are changes, each as the setting says", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 3 });
    await client.startAutopilot("b", startOf(3));
    assert.equal((await finished(client, "b")).state.status, "completed");
    const status = await enableMcp(server, "b");
    const rpc = mcpClient(server, status.slug, await issueToken(server));
    const hashOfEntry = async (number) => done(await rpc.call("read_outline_entry", { number })).hash;

    // The first entry is deleted and the others close the gap: chapters 1 and 2 have another entry now (the question about each is asked), and chapter 3 has none (said, not asked).
    const closed = done(await edit(rpc, { kind: "remove", number: 1, renumber: true, expectedHash: await hashOfEntry(1) }));
    assert.deepEqual(closed.notes, [
      "Chapters 1 and 2 are already written: the autopilot will ask the author whether to rewrite them to follow the new entries or keep their text.",
      "The entry of chapter 3 is no longer in the synopsis: the chapter stays in the book, and the autopilot only says it.",
    ]);

    // The last entry is deleted: its chapter stays, and nobody is asked.
    const last = done(await edit(rpc, { kind: "remove", number: 2, expectedHash: await hashOfEntry(2) }));
    assert.deepEqual(last.notes, ["The entry of chapter 2 is no longer in the synopsis: the chapter stays in the book, and the autopilot only says it."]);

    // A new entry for a chapter that has none is a change, decided as the setting says.
    await client.updateAutopilotOptions("b", { frozenEdits: "auto" });
    const back = done(await edit(rpc, { kind: "update", number: 2, title: "Back again", body: "The chapter has an entry again." }));
    assert.deepEqual(back.notes, ["Chapter 2 is already written: the autopilot will rewrite it to follow the new entry, without asking (its settings say so)."]);

    // Delete every entry: deleting the outline takes no chapter out of the plan, and the autopilot follows no entry of it any more.
    const gone = done(await edit(rpc, { kind: "remove", number: 1, expectedHash: await hashOfEntry(1) }, { kind: "remove", number: 2, expectedHash: back.entries[0].hash }));
    assert.deepEqual(gone.notes, ["Chapters 1 and 2 are already written, and no plan of the autopilot follows their entries: their text is not touched."]);
  }, { ai: fakeAi(3) });
});

test("S9: the entry of a chapter that is being written says that the autopilot decides about its change once the chapter is closed, and so does the note of an edit that changes it", async () => {
  const ai = holdingAi("autopilot:director-review:1");
  try {
    await withServer(async (server, client) => {
      await seededBook(client, "b", { chapters: 0 });
      // Entries the autopilot wrote earlier and nobody touched: they bind nothing, and the plan writes them again.
      await client.commitFiles("b", [await autopilotEntry(1, { title: "Chapter Title 1", body: "Event 1 happens and the story turns." }), await autopilotEntry(2, { title: "Chapter Title 2", body: "Event 2 happens and the story turns." })], "entries the autopilot wrote");
      const { slug } = await enableMcp(server, "b");
      const rpc = mcpClient(server, slug, await issueToken(server));
      await client.startAutopilot("b", startOf(2));
      await until(() => ai.isHeld(), 30_000);
      const entry = done(await rpc.call("read_outline_entry", { number: 1 }));
      assert.deepEqual([entry.chapter.written, entry.chapter.frozen], [true, false], "its scene is written, and it is not closed");
      assert.equal(entry.afterChange, "This chapter is being written. If this entry changes, the autopilot will say it and decide what to do once the chapter is closed.");
      const edited = done(await edit(rpc, { kind: "update", number: 1, title: "The author's new title" }));
      assert.deepEqual(edited.notes, ["Chapter 1 is being written: the autopilot will say the change and decide about it once it is closed."]);
      assert.deepEqual(done(await edit(rpc, { kind: "remove", number: 1, expectedHash: edited.entries[0].hash })).notes, ["The entry of chapter 1 is no longer in the synopsis: the chapter stays in the book, and the autopilot only says it."]);
    }, { ai });
  } finally {
    ai.release();
  }
});

// ─── An outline of any length ──────────────────────────────────────────────

test("S9: an edit of an outline of 5000 chapters reads the files it rewrites and no others: one entry for an update, none for an append or a removal, and the ones that move for an insert near the end", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    await bulkOutline(server, "glass", 5000);
    const reads = countReads(server);
    try {
      const hash = await hashOf(rpc, 2500);
      reads.reset();
      const updated = done(await edit(rpc, { kind: "update", number: 2500, body: "A new plan for chapter 2500.", expectedHash: hash }));
      assert.deepEqual([updated.updated, updated.files], [[2500], 1]);
      // Each series also reads the journal of the Synopsis, once, to add itself to it.
      assert.deepEqual(reads.outline, [entryPath(2500), JOURNAL], "one file");

      reads.reset();
      const appended = done(await edit(rpc, { kind: "append", title: "The last chapter" }));
      assert.deepEqual([appended.created, reads.outline], [[5001], [JOURNAL]], "none");

      const removable = await hashOf(rpc, 700);
      reads.reset();
      const removed = done(await edit(rpc, { kind: "remove", number: 700, expectedHash: removable }));
      assert.deepEqual([removed.removed, removed.files, reads.outline], [[700], 1, [entryPath(700), JOURNAL]], "a removal needs the hash it was given, and reads the entry it removes only for the journal");

      reads.reset();
      const inserted = done(await edit(rpc, { kind: "insert", at: 4999, title: "Before the end" }));
      assert.deepEqual([inserted.created, inserted.moved, inserted.files], [[4999], [{ from: 4999, to: 5000, count: 3 }], 4]);
      assert.deepEqual([...reads.outline].sort(), [JOURNAL, entryPath(4999), entryPath(5000), entryPath(5001)].sort(), "the three that move");
    } finally {
      reads.stop();
    }
  });
});

test("S9: a call may not change more than 1000 files: an insert that would rename more is refused whole, and says to ask the author to do it in the app", { skip: process.platform === "win32" && "a thousand files take the Windows runner longer than the 60 seconds a call has; Linux and macOS run it, and the engine's own tests pin the limit" }, async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    await bulkOutline(server, "glass", 1100);
    const before = commitCount(server);
    const refusedAnswer = await edit(rpc, { kind: "insert", at: 1, title: "At the head" });
    refused(refusedAnswer, "too_many_files", /at least 1101 files[^]*1000[^]*app/);
    refused(await edit(rpc, { kind: "insert", at: 101, title: "Still too many" }), "too_many_files", /at least 1001 files/);
    assert.equal(commitCount(server), before, "nothing was written");
    assert.equal(await exists(server, 1101), false);
    const allowed = done(await edit(rpc, { kind: "insert", at: 102, title: "Just enough" }));
    assert.deepEqual([allowed.files, allowed.created, allowed.moved], [1000, [102], [{ from: 102, to: 103, count: 999 }]], "999 renamed and one new: a thousand files, one commit");
    assert.equal(commitCount(server), before + 1);
    assert.equal((await read(server, 1100)).frontmatter.title, "Chapter 1099");
    assert.equal((await read(server, 102)).frontmatter.title, "Just enough");
  });
});
