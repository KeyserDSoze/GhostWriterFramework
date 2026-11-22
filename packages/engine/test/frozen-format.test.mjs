import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { loadBookSnapshot, parseMarkdown, SnapshotCache } = engine;

// ─── E4b-F1: the freeze record in chapter.md, and the pure functions over a snapshot ─────────────────────────────────────

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-02-03T04:05:06.000Z";
const DIGEST = /^[0-9a-f]{16}$/;

const chapterFile = (slug, number, title, body = `# ${title}\n\nWhat the chapter is for.`, extra = "") => `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${number}\ntitle: ${title}\nsummary: The summary of ${title}.\n${extra}---\n\n${body}\n`;
const sceneFile = (chapter, slug, number, text, extra = "") => `---\ntype: paragraph\nid: paragraph:${chapter}:${slug}\nchapter: chapter:${chapter}\nnumber: ${number}\ntitle: Scene ${number}\n${extra}---\n\n${text}\n`;

/** A book of `chapters` chapters of `scenes` scenes each, none frozen. */
function bookFiles(chapters = 2, scenes = 2) {
  const files = seedBookFiles();
  for (let number = 1; number <= chapters; number += 1) {
    const slug = `${String(number).padStart(3, "0")}-chapter-${number}`;
    files[`chapters/${slug}/chapter.md`] = chapterFile(slug, number, `Chapter ${number}`);
    for (let scene = 1; scene <= scenes; scene += 1) {
      const name = `${String(scene).padStart(3, "0")}-scene-${scene}`;
      files[`chapters/${slug}/${name}.md`] = sceneFile(slug, name, scene, `The prose of scene ${scene} of chapter ${number}. Mira walks to the harbor.`);
    }
  }
  return files;
}

const ONE = "chapters/001-chapter-1";

async function frozenBook({ chapters = 2, scenes = 2, by = "author", at = AT } = {}) {
  const store = new MemoryBookStore(bookFiles(chapters, scenes));
  const snapshot = await loadBookSnapshot(store);
  for (const chapter of snapshot.chapters) await store.commit(engine.freezeChapterChanges(snapshot, chapter.slug, by, at), "freeze");
  return store;
}

const changesOf = async (store) => engine.frozenChanges(await loadBookSnapshot(store));
const edit = (store, path, change) => store.write(path, change(store.files.get(path)));

test("a chapter frozen by the author keeps a record of its text in chapter.md, and nothing else of the file changes", async () => {
  const store = new MemoryBookStore(bookFiles());
  const before = parseMarkdown(store.files.get(`${ONE}/chapter.md`));
  const snapshot = await loadBookSnapshot(store);
  const changes = engine.freezeChapterChanges(snapshot, "001-chapter-1", "author", AT);
  assert.deepEqual(changes.map((change) => change.path), [`${ONE}/chapter.md`], "only chapter.md is written");
  assert.equal(changes[0].expectedHash, snapshot.files.get(`${ONE}/chapter.md`), "a compare-and-swap on the file as it was read");
  await store.commit(changes, "freeze");
  const after = parseMarkdown(store.files.get(`${ONE}/chapter.md`));
  const { frozen, ...rest } = after.frontmatter;
  assert.deepEqual(rest, before.frontmatter, "every other key is as it was");
  assert.equal(after.body, before.body, "the body is as it was");
  assert.equal(frozen.at, AT);
  assert.equal(frozen.by, "author");
  assert.match(frozen.digest, DIGEST, "a digest of the body of chapter.md");
  assert.deepEqual(Object.keys(frozen.files).sort(), ["001-scene-1.md", "002-scene-2.md"], "every scene, by its name in the folder");
  for (const value of Object.values(frozen.files)) assert.match(value, DIGEST);

  const reloaded = await loadBookSnapshot(store);
  assert.deepEqual(reloaded.chapters[0].frozen, frozen, "the snapshot reads the record");
  assert.equal(reloaded.chapters[0].frozenProblem, undefined);
  assert.equal(reloaded.chapters[1].frozen, undefined, "the other chapter is not frozen");
  assert.deepEqual(engine.frozenChanges(reloaded), [], "nothing changed since");
});

test("a frozen chapter changes with the text of a scene or of chapter.md, not with its frontmatter, its title line or the name of its folder", async () => {
  const store = await frozenBook();
  const scene = `${ONE}/001-scene-1.md`;
  const original = store.files.get(scene);

  edit(store, scene, (text) => text.replace("Mira walks", "Mira runs"));
  let [change] = await changesOf(store);
  assert.deepEqual([change.number, change.slug, change.changed], [1, "001-chapter-1", { added: [], removed: [], modified: ["001-scene-1.md"], body: false }]);

  store.write(scene, original);
  assert.deepEqual(await changesOf(store), [], "the text as it was frozen is no change");

  edit(store, scene, (text) => text.replace("title: Scene 1\n", "title: Scene 1\nsummary: A summary another tool wrote.\n"));
  edit(store, scene, (text) => text.replaceAll("\n", "\r\n"));
  assert.deepEqual(await changesOf(store), [], "the frontmatter of a scene and its line endings are no change");

  edit(store, `${ONE}/chapter.md`, (text) => text.replace("# Chapter 1", "# The Glass Harbor").replace("title: Chapter 1", "title: The Glass Harbor"));
  assert.deepEqual(await changesOf(store), [], "a new title, in the frontmatter and in the heading of the body, is no change");

  edit(store, `${ONE}/chapter.md`, (text) => text.replace("What the chapter is for.", "What the chapter is really for."));
  [change] = await changesOf(store);
  assert.equal(change.changed.body, true, "the text of chapter.md is");
  assert.deepEqual(change.changed.modified, []);
});

test("scenes added, removed, renamed and reordered", async () => {
  const store = await frozenBook({ scenes: 3 });
  const path = (name) => `${ONE}/${name}.md`;

  store.write(path("004-scene-4"), sceneFile("001-chapter-1", "004-scene-4", 4, "A scene the author added."));
  let [change] = await changesOf(store);
  assert.deepEqual(change.changed, { added: ["004-scene-4.md"], removed: [], modified: [], body: false });
  store.write(path("004-scene-4"), null);

  const third = store.files.get(path("003-scene-3"));
  store.write(path("003-scene-3"), null);
  [change] = await changesOf(store);
  assert.deepEqual(change.changed, { added: [], removed: ["003-scene-3.md"], modified: [], body: false });

  store.write(path("003-the-end"), third);
  assert.deepEqual(await changesOf(store), [], "a scene whose file was renamed, with the same text, is no change");
  store.write(path("003-the-end"), null);
  store.write(path("003-scene-3"), third);

  const first = store.files.get(path("001-scene-1"));
  const second = store.files.get(path("002-scene-2"));
  store.write(path("001-scene-1"), second);
  store.write(path("002-scene-2"), first);
  [change] = await changesOf(store);
  assert.deepEqual(change.changed.modified, ["001-scene-1.md", "002-scene-2.md"], "two scenes that swapped places changed the chapter");
});

test("the folder of a frozen chapter renamed or swapped with another is the same frozen chapter", async () => {
  const store = await frozenBook();
  for (const path of [...store.files.keys()].filter((entry) => entry.startsWith(`${ONE}/`))) {
    store.write(path.replace(ONE, "chapters/001-the-glass-harbor"), store.files.get(path).replaceAll("001-chapter-1", "001-the-glass-harbor"));
    store.write(path, null);
  }
  const snapshot = await loadBookSnapshot(store);
  assert.equal(snapshot.chapters[0].slug, "001-the-glass-harbor");
  assert.ok(snapshot.chapters[0].frozen, "the record moved with chapter.md");
  assert.deepEqual(engine.frozenChanges(snapshot), []);
});

test("a change says which chapter, who froze it and when, and its fingerprint follows the text", async () => {
  const store = await frozenBook({ by: "autopilot", at: LATER });
  const scene = `chapters/002-chapter-2/002-scene-2.md`;
  edit(store, scene, (text) => text.replace("harbor", "lighthouse"));
  const [change] = await changesOf(store);
  assert.deepEqual([change.number, change.slug, change.by, change.frozenAt, change.title], [2, "002-chapter-2", "autopilot", LATER, "Chapter 2"]);
  assert.match(change.fingerprint, /^[0-9a-z]{8,}$/);
  assert.equal((await changesOf(store))[0].fingerprint, change.fingerprint, "the same text, the same fingerprint");
  edit(store, scene, (text) => text.replace("lighthouse", "lighthouse at night"));
  const [again] = await changesOf(store);
  assert.notEqual(again.fingerprint, change.fingerprint, "another edit, another fingerprint");
});

test("a record that cannot be read is a warning and the chapter counts as not frozen; `frozen: false` is no record", async () => {
  const broken = {
    "frozen: yes\n": /frozen/i,
    "frozen:\n  at: 2026-01-01T00:00:00.000Z\n  by: author\n": /digest/i,
    "frozen:\n  at: 2026-01-01T00:00:00.000Z\n  by: author\n  digest: 0123456789abcdef\n  files: nothing\n": /files/i,
    "frozen:\n  at: yesterday\n  by: author\n  digest: 0123456789abcdef\n  files: {}\n": /at/i,
    "frozen:\n  at: 2026-01-01T00:00:00.000Z\n  by: the cat\n  digest: 0123456789abcdef\n  files: {}\n": /by/i,
  };
  for (const [yaml, problem] of Object.entries(broken)) {
    const files = bookFiles(1);
    files[`${ONE}/chapter.md`] = chapterFile("001-chapter-1", 1, "Chapter 1", undefined, yaml);
    const snapshot = await loadBookSnapshot(new MemoryBookStore(files));
    assert.equal(snapshot.chapters[0].frozen, undefined, yaml);
    assert.match(snapshot.chapters[0].frozenProblem ?? "", problem, yaml);
    assert.deepEqual(engine.frozenChanges(snapshot), [], "never a change, never an error");
  }
  const files = bookFiles(1);
  files[`${ONE}/chapter.md`] = chapterFile("001-chapter-1", 1, "Chapter 1", undefined, "frozen: false\n");
  const snapshot = await loadBookSnapshot(new MemoryBookStore(files));
  assert.equal(snapshot.chapters[0].frozen, undefined);
  assert.equal(snapshot.chapters[0].frozenProblem, undefined);
});

test("a record is read tolerantly: any case of `by`, a moment in any zone, digests in capitals", async () => {
  const store = await frozenBook();
  const frozen = parseMarkdown(store.files.get(`${ONE}/chapter.md`)).frontmatter.frozen;
  const upper = Object.fromEntries(Object.entries(frozen.files).map(([name, digest]) => [name, digest.toUpperCase()]));
  const yaml = `frozen:\n  at: "2026-01-01T02:00:00+02:00"\n  by: Author\n  digest: "${frozen.digest.toUpperCase()}"\n  files:\n${Object.entries(upper).map(([name, digest]) => `    ${name}: "${digest}"`).join("\n")}\n`;
  const files = bookFiles(1);
  files[`${ONE}/chapter.md`] = chapterFile("001-chapter-1", 1, "Chapter 1", undefined, yaml);
  const snapshot = await loadBookSnapshot(new MemoryBookStore(files));
  assert.deepEqual(snapshot.chapters[0].frozen, { at: AT, by: "author", digest: frozen.digest, files: frozen.files });
  assert.deepEqual(engine.frozenChanges(snapshot), []);
  assert.deepEqual(engine.parseChapterFreeze(undefined), {}, "no record, no problem");
  assert.ok(engine.parseChapterFreeze({ at: AT }).problem);
});

test("unfreezing removes the record and nothing else; marking reviewed freezes the text as it is now and keeps who froze it", async () => {
  const store = await frozenBook({ by: "autopilot" });
  const scene = `${ONE}/001-scene-1.md`;
  edit(store, scene, (text) => text.replace("Mira walks", "Mira stops"));
  let snapshot = await loadBookSnapshot(store);
  await store.commit(engine.markReviewedChanges(snapshot, "001-chapter-1", LATER), "reviewed");
  snapshot = await loadBookSnapshot(store);
  assert.deepEqual(engine.frozenChanges(snapshot), [], "the change is now part of the frozen text");
  assert.equal(snapshot.chapters[0].frozen.by, "autopilot", "who froze it does not change");
  assert.equal(snapshot.chapters[0].frozen.at, LATER);

  const before = store.files.get(`chapters/002-chapter-2/chapter.md`);
  const { frozen: _frozen, ...frontmatter } = parseMarkdown(before).frontmatter;
  await store.commit(engine.unfreezeChapterChanges(snapshot, "002-chapter-2"), "unfreeze");
  const after = parseMarkdown(store.files.get(`chapters/002-chapter-2/chapter.md`));
  assert.deepEqual(after.frontmatter, frontmatter);
  assert.equal(after.body, parseMarkdown(before).body);
  snapshot = await loadBookSnapshot(store);
  assert.equal(snapshot.chapters[1].frozen, undefined);
  assert.deepEqual(engine.unfreezeChapterChanges(snapshot, "002-chapter-2"), [], "a chapter that is not frozen has nothing to unfreeze");
});

test("freezing a folder of scenes without chapter.md creates it; a chapter.md whose YAML cannot be read, or a folder that does not exist, is refused", async () => {
  const files = bookFiles(1);
  delete files[`${ONE}/chapter.md`];
  const store = new MemoryBookStore(files);
  let snapshot = await loadBookSnapshot(store);
  const [created] = engine.freezeChapterChanges(snapshot, "001-chapter-1", "author", AT);
  assert.equal(created.expectedHash, null, "created only if nobody made it meanwhile");
  await store.commit([created], "freeze");
  snapshot = await loadBookSnapshot(store);
  assert.equal(snapshot.chapters[0].frozen.by, "author");
  assert.equal(parseMarkdown(store.files.get(`${ONE}/chapter.md`)).frontmatter.type, "chapter");
  assert.deepEqual(engine.frozenChanges(snapshot), []);

  store.write(`${ONE}/chapter.md`, "---\ntitle: [unclosed\n---\n\nBody.\n");
  snapshot = await loadBookSnapshot(store);
  assert.throws(() => engine.freezeChapterChanges(snapshot, "001-chapter-1", "author", AT), (error) => error.code === "frontmatter_invalid");
  assert.throws(() => engine.freezeChapterChanges(snapshot, "009-nowhere", "author", AT), (error) => error instanceof engine.FrozenChapterError && error.code === "chapter_not_found");
});

test("the record the autopilot builds from the texts it read is the one the snapshot checks", async () => {
  const store = new MemoryBookStore(bookFiles(1));
  const snapshot = await loadBookSnapshot(store);
  const chapter = snapshot.chapters[0];
  const record = engine.chapterFreezeRecord({
    at: AT,
    by: "autopilot",
    chapterBody: parseMarkdown(store.files.get(chapter.path)).body,
    scenes: chapter.paragraphs.map((paragraph) => ({ name: paragraph.path.split("/").pop(), body: parseMarkdown(store.files.get(paragraph.path)).body })),
  });
  const [change] = engine.freezeChapterChanges(snapshot, chapter.slug, "autopilot", AT);
  assert.deepEqual(parseMarkdown(change.content).frontmatter.frozen, record);
});

/** A store that counts what it reads. */
function counting(files) {
  const store = new MemoryBookStore(files);
  const reads = [];
  const read = store.read.bind(store);
  store.read = async (path) => {
    reads.push(path);
    return read(path);
  };
  return { store, reads };
}

/** A book of `count` chapters frozen by the autopilot, its records built from the texts as the autopilot builds them. */
function frozenFiles(count, scenes = 2) {
  const files = {};
  for (let number = 1; number <= count; number += 1) {
    const slug = `${String(number).padStart(4, "0")}-chapter-${number}`;
    const sceneTexts = Array.from({ length: scenes }, (_, index) => ({ name: `${String(index + 1).padStart(3, "0")}-scene-${index + 1}.md`, body: `Scene ${index + 1} of chapter ${number}: the harbor at dawn.` }));
    for (const scene of sceneTexts) files[`chapters/${slug}/${scene.name}`] = sceneFile(slug, scene.name.slice(0, -3), Number(scene.name.slice(0, 3)), scene.body);
    const body = `# Chapter ${number}\n\nWhat chapter ${number} is for.`;
    const record = engine.chapterFreezeRecord({ at: AT, by: "autopilot", chapterBody: body, scenes: sceneTexts });
    const yaml = `frozen:\n  at: ${record.at}\n  by: ${record.by}\n  digest: "${record.digest}"\n  files:\n${Object.entries(record.files).map(([name, digest]) => `    ${name}: "${digest}"`).join("\n")}\n`;
    files[`chapters/${slug}/chapter.md`] = chapterFile(slug, number, `Chapter ${number}`, body, yaml);
  }
  return files;
}

test("detection reads nothing: a snapshot loaded again reads only the files that changed, and frozenChanges reads no file", async () => {
  const { store, reads } = counting(frozenFiles(20));
  const cache = new SnapshotCache();
  let snapshot = await loadBookSnapshot(store, cache);
  assert.equal(engine.frozenChanges(snapshot).length, 0);
  store.write("chapters/0007-chapter-7/002-scene-2.md", store.files.get("chapters/0007-chapter-7/002-scene-2.md").replace("dawn", "dusk"));
  store.write("chapters/0013-chapter-13/chapter.md", store.files.get("chapters/0013-chapter-13/chapter.md").replace("is for.", "is for, now."));
  reads.length = 0;
  snapshot = await loadBookSnapshot(store, cache);
  assert.deepEqual(reads.sort(), ["chapters/0007-chapter-7/002-scene-2.md", "chapters/0013-chapter-13/chapter.md"]);
  reads.length = 0;
  const changes = engine.frozenChanges(snapshot);
  assert.deepEqual(reads, [], "no read to tell a change");
  assert.deepEqual(changes.map((change) => [change.number, change.changed.modified, change.changed.body]), [[7, ["002-scene-2.md"], false], [13, [], true]]);
});

test("5000 frozen chapters: a change is found by reading only the files that changed", async () => {
  const { store, reads } = counting(frozenFiles(5000));
  const cache = new SnapshotCache();
  let snapshot = await loadBookSnapshot(store, cache);
  assert.equal(snapshot.chapters.length, 5000);
  assert.ok(snapshot.chapters.every((chapter) => chapter.frozen), "every chapter is frozen");
  let started = performance.now();
  assert.deepEqual(engine.frozenChanges(snapshot), []);
  const quiet = performance.now() - started;

  for (const number of [17, 2500, 4999]) {
    const path = `chapters/${String(number).padStart(4, "0")}-chapter-${number}/001-scene-1.md`;
    store.write(path, store.files.get(path).replace("dawn", "noon"));
  }
  reads.length = 0;
  snapshot = await loadBookSnapshot(store, cache);
  assert.equal(reads.length, 3, "three files changed, three files read");
  reads.length = 0;
  started = performance.now();
  const changes = engine.frozenChanges(snapshot);
  const elapsed = performance.now() - started;
  assert.deepEqual(reads, []);
  assert.deepEqual(changes.map((change) => change.number), [17, 2500, 4999]);
  assert.ok(quiet < 1000 && elapsed < 1000, `5000 frozen chapters are checked in ${Math.round(quiet)} ms and ${Math.round(elapsed)} ms, without reading`);
});

test("chapter.md written whole by a host keeps the record the file holds now: left out, made up or changed, the record stays the file's", async () => {
  const { keepChapterFreeze } = engine;
  const store = await frozenBook({ chapters: 1, scenes: 1 });
  const path = `${ONE}/chapter.md`;
  const current = store.files.get(path);
  const record = parseMarkdown(current).frontmatter.frozen;
  assert.match(record.digest, DIGEST);

  // A model rewrote the chapter and left the record out: the record comes back exactly, everything else is what the model wrote.
  const rewritten = "---\ntype: chapter\nid: chapter:001-chapter-1\nnumber: 1\ntitle: Chapter 1\nsummary: A summary the model wrote.\n---\n\n# Chapter 1\n\nWhat the chapter is now for.\n";
  const kept = keepChapterFreeze(rewritten, current);
  assert.deepEqual(parseMarkdown(kept).frontmatter, { ...parseMarkdown(rewritten).frontmatter, frozen: record });
  assert.equal(parseMarkdown(kept).body, parseMarkdown(rewritten).body);
  assert.ok(kept.startsWith("---\ntype: chapter\nid: chapter:001-chapter-1\nnumber: 1\ntitle: Chapter 1\nsummary: A summary the model wrote.\nfrozen:\n"), "the keys the model wrote keep their text and order");
  store.write(path, kept);
  const [change] = await changesOf(store);
  assert.deepEqual([change.slug, change.changed.body], ["001-chapter-1", true], "the change of the frozen chapter is noticed");

  // A record that is changed or made up is not the model's to write.
  const forged = { ...record, digest: "0000000000000000" };
  assert.deepEqual(parseMarkdown(keepChapterFreeze(renderWith(rewritten, forged), current)).frontmatter.frozen, record, "a changed record is the file's again");
  const unfrozen = chapterFile("002-chapter-2", 2, "Chapter 2");
  const madeUp = keepChapterFreeze(renderWith(unfrozen, forged), unfrozen);
  assert.equal(Object.hasOwn(parseMarkdown(madeUp).frontmatter, "frozen"), false, "a record on a chapter that has none is taken out");
  assert.deepEqual(parseMarkdown(madeUp).frontmatter, parseMarkdown(unfrozen).frontmatter);

  // Nothing to do: the same record (in any order of its keys), a chapter with no record, a new chapter.
  const sameRecord = renderWith(rewritten, { files: record.files, digest: record.digest, by: record.by, at: record.at });
  assert.equal(keepChapterFreeze(sameRecord, current), sameRecord);
  assert.equal(keepChapterFreeze(rewritten, unfrozen), rewritten);
  assert.equal(keepChapterFreeze(rewritten, null), rewritten);
  assert.equal(keepChapterFreeze(rewritten.replace("\n---\n", "\nfrozen: false\n---\n"), unfrozen), rewritten.replace("\n---\n", "\nfrozen: false\n---\n"), "`frozen: false` is no record");

  // A text without a frontmatter gets the record alone; a frontmatter that cannot be read, in the text or in the file, is left as it is.
  assert.deepEqual(parseMarkdown(keepChapterFreeze("# Chapter 1\n\nOnly prose.\n", current)), { frontmatter: { frozen: record }, body: "# Chapter 1\n\nOnly prose.", hasFrontmatter: true });
  const broken = "---\ntitle: [unclosed\n---\n\nProse.\n";
  assert.equal(keepChapterFreeze(broken, current), broken);
  assert.equal(keepChapterFreeze(rewritten, broken), rewritten);
  assert.deepEqual(engine.parseChapterFilePath(path), { chapter: "001-chapter-1" }, "the hosts call it for the chapter.md of a chapter");
});

/** A chapter.md with its `frozen` set to `record`, every other key as it is. */
function renderWith(content, record) {
  const { frontmatter, body } = parseMarkdown(content);
  return engine.renderMarkdown({ ...frontmatter, frozen: record }, body);
}
