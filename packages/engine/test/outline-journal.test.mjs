import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as engine from "../dist/index.js";

// The journal of the Synopsis (`outline/changes.yml`): every series of edits of the entries, with when, who and what happened to each chapter, written in the
// commit of the series, readable by a person and mergeable between two devices. The autopilot never decides from it.

const {
  OUTLINE_CHANGES_FILE, OUTLINE_JOURNAL_KEEP_DAYS, OUTLINE_JOURNAL_MAX_SERIES, OUTLINE_JOURNAL_MAX_CHAPTERS,
  appendOutlineJournal, composeOutlineEdits, markOutlineJournalReviewed, mergeOutlineJournals, outlineChapterPath, outlineEntryDigest, outlineIndex,
  outlineJournalChange, outlineJournalChaptersOf, parseOutline, parseOutlineJournal, pruneOutlineJournal, serializeOutlineChapter, serializeOutlineJournal,
} = engine;

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const NOW = new Date("2026-11-26T10:00:00.000Z");
const entry = (number, title, body) => serializeOutlineChapter({ number, title, body });

/** An outline in memory, by path: `[number, title, body]`. */
function outline(entries) {
  return new Map(entries.map(([number, title, body]) => [outlineChapterPath(number), entry(number, title, body)]));
}

/** The files a commit changes, from the outline before to the one after. */
function diff(before, after) {
  const changes = [];
  for (const [path, content] of after) if (before.get(path) !== content) changes.push({ path, content, expectedHash: before.has(path) ? sha(before.get(path)) : null });
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, content: null, expectedHash: sha(before.get(path)) });
  return changes;
}

const lines = (chapters) => chapters.map((item) => [item.chapter, item.change, item.from ?? null, item.title ?? null, item.was ?? null, item.edited ?? false]);

const FOUR = [[1, "Arrival", "Mira arrives."], [2, "The key", "Mira finds the key."], [3, "The vault", "Mira opens the vault."], [4, "The ledger", "Mira reads the ledger."]];

test("the journal is a file of the outline that is never an entry, and no content of the book", async () => {
  assert.equal(OUTLINE_CHANGES_FILE, "outline/changes.yml");
  const parsed = await parseOutline([{ path: "outline/chapters/001.md", content: entry(1, "One", "One.") }, { path: OUTLINE_CHANGES_FILE, content: "version: 1\nseries: []\n" }]);
  assert.deepEqual(parsed.chapters.map((item) => item.number), [1]);
  assert.deepEqual(parsed.warnings, [], "no «not an entry» warning");
  assert.deepEqual(outlineIndex([[OUTLINE_CHANGES_FILE, "h"], ["outline/chapters/001.md", "h1"]]).chapters.map((item) => item.path), ["outline/chapters/001.md"]);
  assert.deepEqual([OUTLINE_JOURNAL_KEEP_DAYS, OUTLINE_JOURNAL_MAX_SERIES, OUTLINE_JOURNAL_MAX_CHAPTERS], [180, 200, 200]);
});

test("each chapter of a series: created, modified, moved from another chapter, removed, with the digests before and after", async () => {
  const before = outline(FOUR);
  // Chapter 1 rewritten, the vault before the key (2 and 3 swap), a new chapter 5, chapter 4 gone.
  const after = outline([[1, "Arrival at night", "Mira arrives at night."], [2, "The vault", "Mira opens the vault."], [3, "The key", "Mira finds the key."], [5, "The flood", "The harbor floods."]]);
  const changes = diff(before, after);
  const change = await outlineJournalChange({ journal: null, before, changes, by: "author", now: NOW, id: "s1" });
  assert.equal(change.path, OUTLINE_CHANGES_FILE);
  assert.equal(change.expectedHash, null, "a new file");
  const journal = parseOutlineJournal(change.content);
  assert.equal(journal.series.length, 1);
  const [series] = journal.series;
  assert.deepEqual({ id: series.id, at: series.at, by: series.by }, { id: "s1", at: NOW.toISOString(), by: "author" });
  assert.deepEqual(lines(series.chapters), [
    [1, "modified", null, "Arrival at night", "Arrival", false],
    [2, "moved", 3, "The vault", "The key", false],
    [3, "moved", 2, "The key", "The vault", false],
    [4, "removed", null, "The ledger", null, false],
    [5, "created", null, "The flood", null, false],
  ]);
  const digest = async (title, body) => outlineEntryDigest({ title, body });
  assert.equal(series.chapters[1].before, await digest("The key", "Mira finds the key."), "what chapter 2 had");
  assert.equal(series.chapters[1].after, await digest("The vault", "Mira opens the vault."), "what it has now");
  assert.equal(series.chapters[3].after, undefined);
  assert.equal(series.chapters[4].before, undefined);
  assert.deepEqual(series.chapters.map((item) => item.summary), [
    "The entry of chapter 1 «Arrival at night» changed (it was «Arrival»).",
    "Chapter 2 is now «The vault» of chapter 3 (it was «The key»).",
    "Chapter 3 is now «The key» of chapter 2 (it was «The vault»).",
    "Chapter 4 «The ledger» is no longer in the Synopsis.",
    "Chapter 5 «The flood» is new.",
  ]);
});

test("a series that moves an entry and changes it is followed by its title, and the composer's word makes it exact", async () => {
  const before = outline(FOUR);
  const after = outline([[1, "Arrival", "Mira arrives."], [2, "The vault", "Mira opens the vault at dawn."], [3, "The key", "Mira finds the key."], [4, "The ledger", "Mira reads the ledger."]]);
  const changes = diff(before, after);
  const guessed = await outlineJournalChange({ journal: null, before, changes, by: "author", now: NOW });
  assert.deepEqual(lines(parseOutlineJournal(guessed.content).series[0].chapters), [[2, "moved", 3, "The vault", "The key", true], [3, "moved", 2, "The key", "The vault", false]]);
  // An insert at 2: without the composer's word the new entry is chapter 2's entry changed; with it, a new entry, and the others moved.
  const inserted = outline([[1, "Arrival", "Mira arrives."], [2, "The storm", "A storm."], [3, "The key", "Mira finds the key."], [4, "The vault", "Mira opens the vault."], [5, "The ledger", "Mira reads the ledger."]]);
  const plain = await outlineJournalChange({ journal: null, before, changes: diff(before, inserted), by: "author", now: NOW });
  assert.deepEqual(lines(parseOutlineJournal(plain.content).series[0].chapters)[0], [2, "modified", null, "The storm", "The key", false]);
  const hinted = await outlineJournalChange({ journal: null, before, changes: diff(before, inserted), by: "author", now: NOW, hints: { created: [2], moved: [{ from: 2, to: 3, count: 3 }] } });
  assert.deepEqual(lines(parseOutlineJournal(hinted.content).series[0].chapters), [
    [2, "created", null, "The storm", "The key", false],
    [3, "moved", 2, "The key", "The vault", false],
    [4, "moved", 3, "The vault", "The ledger", false],
    [5, "moved", 4, "The ledger", null, false],
  ]);
});

test("the composer's series and the journal of its commit agree, with the composer's word", async () => {
  const files = new Map([...outline(FOUR)].map(([path, content]) => [path, { content, hash: sha(content) }]));
  const source = { index: outlineIndex([...files].map(([path, { hash }]) => [path, hash])), paths: [...files.keys()], read: async (path) => (files.has(path) ? { path, ...files.get(path) } : null) };
  const composed = await composeOutlineEdits(source, [{ kind: "move", from: 3, to: 2 }, { kind: "update", number: 2, entry: { body: "Mira opens the vault at dawn." } }, { kind: "append", entry: { title: "The flood", body: "The harbor floods." } }], { ghostwriters: [] });
  const before = new Map([...files].map(([path, { content }]) => [path, content]));
  const change = await outlineJournalChange({ journal: null, before, changes: composed.changes, by: "brainstorming", note: "The vault first, and the flood at the end.", now: NOW, hints: { created: composed.created, moved: composed.moved } });
  const [series] = parseOutlineJournal(change.content).series;
  assert.equal(series.by, "brainstorming");
  assert.equal(series.note, "The vault first, and the flood at the end.");
  assert.deepEqual(lines(series.chapters), [[2, "moved", 3, "The vault", "The key", true], [3, "moved", 2, "The key", "The vault", false], [5, "created", null, "The flood", null, false]]);
});

test("a change of a frontmatter, or of the description of the book alone, is no news of chapters", async () => {
  const before = new Map([["outline/chapters/001.md", entry(1, "One", "One.")], ["outline/book.md", "---\ntype: outline\nid: outline:book\n---\n\nThe book.\n"]]);
  const changes = [
    { path: "outline/chapters/001.md", content: entry(1, "One", "One.").replace("number: 1", "number: 1\nnote: kept"), expectedHash: null },
    { path: "outline/book.md", content: "---\ntype: outline\nid: outline:book\n---\n\nAnother book.\n", expectedHash: null },
  ];
  assert.equal(await outlineJournalChange({ journal: null, before, changes, by: "author", now: NOW }), null);
});

test("the summary is in the language of the book", async () => {
  const before = outline(FOUR.slice(0, 2));
  const after = outline([[1, "Arrival", "Mira arrives."], [3, "The flood", "The harbor floods."]]);
  const change = await outlineJournalChange({ journal: null, before, changes: diff(before, after), by: "mcp", language: "Italiano", now: NOW });
  assert.deepEqual(parseOutlineJournal(change.content).series[0].chapters.map((item) => item.summary), ["Il capitolo 2 «The key» non è più nella Sinossi.", "Il capitolo 3 «The flood» è nuovo."]);
});

test("each series is appended, the file says what it is, and every chapter is one line of it", async () => {
  const before = outline(FOUR);
  const first = await outlineJournalChange({ journal: null, before, changes: diff(before, outline([...FOUR.slice(0, 3), [4, "The ledger", "Mira burns the ledger."]])), by: "author", now: NOW, id: "first" });
  const afterFirst = new Map([...before, [outlineChapterPath(4), entry(4, "The ledger", "Mira burns the ledger.")]]);
  const second = await outlineJournalChange({ journal: { content: first.content, hash: sha(first.content) }, before: afterFirst, changes: [{ path: outlineChapterPath(5), content: entry(5, "The flood", "The harbor floods."), expectedHash: null }], by: "autopilot", now: new Date(NOW.getTime() + 60_000), id: "second" });
  assert.equal(second.expectedHash, sha(first.content), "the journal as it was read");
  assert.ok(second.content.startsWith("# The journal of the Synopsis"), second.content.slice(0, 80));
  assert.match(second.content, /^version: 1$/m);
  const series = parseOutlineJournal(second.content).series;
  assert.deepEqual(series.map((entry) => [entry.id, entry.by]), [["first", "author"], ["second", "autopilot"]]);
  // A chapter is one line: what two devices append are lines at the end of the file.
  assert.match(second.content, /^\s+- \{ chapter: 4, change: modified, title: The ledger, before: [0-9a-f]{16}, after: [0-9a-f]{16}, summary: The entry of chapter 4 «The ledger» changed\. \}$/m);
  assert.deepEqual(parseOutlineJournal(serializeOutlineJournal(parseOutlineJournal(second.content))), parseOutlineJournal(second.content), "a round trip keeps it");
});

test("a file that is not the journal, or an item that is not one, is left out and never stops a write", () => {
  for (const text of [null, "", "not: [yaml", "- a list", "version: 1\nseries: nothing\n", "series:\n  - id: x\n"]) assert.deepEqual(parseOutlineJournal(text), { series: [] }, String(text));
  const journal = parseOutlineJournal([
    "version: 1",
    "series:",
    "  - { id: good, at: '2026-11-20T10:00:00Z', by: author, chapters: [{ chapter: 2, change: modified, summary: ok, before: abcdef0123456789, after: zz }] }",
    "  - { id: odd, at: yesterday, by: author, chapters: [{ chapter: 1, change: created, summary: no }] }",
    "  - { id: nobody, at: '2026-11-20T10:00:00Z', by: somebody, chapters: [{ chapter: 1, change: created, summary: no }] }",
    "  - { id: empty, at: '2026-11-20T10:00:00Z', by: mcp, chapters: [{ chapter: 0, change: created }, { chapter: 3, change: renamed }] }",
    "  - { id: good, at: '2026-11-21T10:00:00Z', by: mcp, chapters: [{ chapter: 9, change: removed, summary: twice }] }",
  ].join("\n"));
  assert.deepEqual(journal.series.map((entry) => entry.id), ["good"]);
  assert.deepEqual(journal.series[0].chapters, [{ chapter: 2, change: "modified", before: "abcdef0123456789", summary: "ok" }], "a digest that is not one is left out");
});

test("two devices that wrote apart are merged: every series once, in order of time, and the latest «reviewed»", async () => {
  const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);
  const series = (id, minutes) => ({ id, at: at(minutes).toISOString(), by: "author", chapters: [{ chapter: 1, change: "modified", summary: id }] });
  const base = appendOutlineJournal(null, series("base", 0), at(0));
  const laptop = appendOutlineJournal(base, series("laptop", 5), at(5));
  const phone = markOutlineJournalReviewed({ content: appendOutlineJournal(base, series("phone", 3), at(3)), hash: "h" }, at(4)).content;
  const merged = mergeOutlineJournals(laptop, phone);
  assert.deepEqual(merged.series.map((entry) => entry.id), ["base", "phone", "laptop"]);
  assert.equal(merged.reviewedAt, at(4).toISOString());
  assert.deepEqual(mergeOutlineJournals(phone, laptop), merged, "in any order");
  assert.deepEqual(mergeOutlineJournals(laptop, laptop).series.map((entry) => entry.id), ["base", "laptop"], "a series is there once");
});

test("the journal keeps the last 180 days, and at most the newest 200 series", () => {
  const day = 86_400_000;
  const series = (id, daysAgo) => ({ id, at: new Date(NOW.getTime() - daysAgo * day).toISOString(), by: "author", chapters: [{ chapter: 1, change: "modified", summary: id }] });
  const kept = pruneOutlineJournal({ series: [series("old", 181), series("edge", 180), series("recent", 2), series("ahead", -1)] }, NOW);
  assert.deepEqual(kept.series.map((entry) => entry.id), ["edge", "recent", "ahead"]);
  const many = pruneOutlineJournal({ series: Array.from({ length: 230 }, (_, index) => series(`s${String(index).padStart(3, "0")}`, 230 - index)).filter((entry) => Date.parse(entry.at) > NOW.getTime() - 179 * day) }, NOW);
  assert.ok(many.series.length <= 200);
  const crowded = pruneOutlineJournal({ series: Array.from({ length: 250 }, (_, index) => ({ ...series(`s${String(index).padStart(3, "0")}`, 0), at: new Date(NOW.getTime() - (250 - index) * 60_000).toISOString() })) }, NOW);
  assert.equal(crowded.series.length, 200);
  assert.equal(crowded.series[0].id, "s050", "the newest are kept");
});

test("a series that renumbers a long Synopsis lists 200 chapters and says how many more", () => {
  const before = new Map(Array.from({ length: 300 }, (_, index) => [index + 1, { title: `C${index + 1}`, digest: `d${String(index + 1).padStart(15, "0")}` }]));
  const after = new Map(Array.from({ length: 300 }, (_, index) => [index + 2, before.get(index + 1)]));
  const { chapters, more } = outlineJournalChaptersOf(before, after, "en", { moved: [{ from: 1, to: 2, count: 300 }] });
  assert.equal(chapters.length, 200);
  assert.equal(more, 101);
  assert.deepEqual(lines(chapters.slice(0, 2)), [[1, "removed", null, "C1", null, false], [2, "moved", 1, "C1", "C2", false]]);
});

test("marking what changed as reviewed keeps the series and says when", () => {
  const text = appendOutlineJournal(null, { id: "s", at: NOW.toISOString(), by: "author", chapters: [{ chapter: 1, change: "created", summary: "new" }] }, NOW);
  const marked = markOutlineJournalReviewed({ content: text, hash: sha(text) }, new Date(NOW.getTime() + 1000));
  assert.equal(marked.path, OUTLINE_CHANGES_FILE);
  assert.equal(marked.expectedHash, sha(text));
  const journal = parseOutlineJournal(marked.content);
  assert.equal(journal.reviewedAt, new Date(NOW.getTime() + 1000).toISOString());
  assert.deepEqual(journal.series.map((entry) => entry.id), ["s"]);
  assert.equal(markOutlineJournalReviewed(null, NOW).expectedHash, null);
});

test("a sync joins the journal two sides wrote apart, on both, and leaves every other conflict to whoever settles it", async () => {
  const { MemoryBookStore } = await import("../dist/testing/index.js");
  const series = (id, minutes) => ({ id, at: new Date(NOW.getTime() + minutes * 60_000).toISOString(), by: "author", chapters: [{ chapter: 1, change: "modified", summary: id }] });
  const base = appendOutlineJournal(null, series("base", 0), NOW);
  const local = new MemoryBookStore({ [OUTLINE_CHANGES_FILE]: base, "book.md": "same" });
  const remote = new MemoryBookStore({ [OUTLINE_CHANGES_FILE]: base, "book.md": "same" });
  const first = await engine.syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual(first.conflicts, []);
  local.write(OUTLINE_CHANGES_FILE, appendOutlineJournal(base, series("browser", 5), NOW));
  remote.write(OUTLINE_CHANGES_FILE, appendOutlineJournal(base, series("server", 3), NOW));
  local.write("book.md", "mine");
  remote.write("book.md", "theirs");
  const second = await engine.syncBookStores({ local, remote, base: first.base });
  assert.deepEqual(second.conflicts, ["book.md"], "a file nobody can join is a conflict as ever");
  assert.deepEqual(second.merged, [OUTLINE_CHANGES_FILE]);
  assert.equal(local.files.get(OUTLINE_CHANGES_FILE), remote.files.get(OUTLINE_CHANGES_FILE), "the same text on both sides");
  assert.deepEqual(parseOutlineJournal(local.files.get(OUTLINE_CHANGES_FILE)).series.map((entry) => entry.id), ["base", "server", "browser"]);
  assert.equal(second.base.get(OUTLINE_CHANGES_FILE), sha(local.files.get(OUTLINE_CHANGES_FILE)), "the base knows the joined text: the next sync has nothing to do with it");
  const third = await engine.syncBookStores({ local, remote, base: second.base, resolveConflict: () => "local" });
  assert.deepEqual([third.conflicts, third.merged, third.uploaded], [[], undefined, ["book.md"]]);
  assert.equal(engine.mergeBookFileVersions("book.md", "a", "b"), null);
  // A host that wants every conflict for itself turns the joining off.
  local.write(OUTLINE_CHANGES_FILE, appendOutlineJournal(local.files.get(OUTLINE_CHANGES_FILE), series("again", 9), NOW));
  remote.write(OUTLINE_CHANGES_FILE, appendOutlineJournal(remote.files.get(OUTLINE_CHANGES_FILE), series("there", 8), NOW));
  const plain = await engine.syncBookStores({ local, remote, base: third.base, merge: null });
  assert.deepEqual(plain.conflicts, [OUTLINE_CHANGES_FILE]);
});
