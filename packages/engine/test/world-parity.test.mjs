import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// ─── A book without an outline and without an evaluation style asks the model exactly what it always asked ──────────────
// Three runs that go through every kind of step the outline and the evaluation style touch (the concept, a plan made in two
// batches, a revision of the plan asked by the director, the readers of the plan, the scenes, the prose, the readers, the
// specialists, the director's review in two rounds, the repairs, the consolidation, the summary of the author's chapters,
// a plan made after them with a binding synopsis, the final judgement) are recorded request by request: every byte of the
// system prompt, of the user prompt, of the schema's name, of the output limit and of the temperature. The fixture was
// written by the engine as it was before it learned the outline and the evaluation style (`UPDATE_WORLD_PARITY=1`
// writes it again, and only an intended change of the prompts of a book with neither may do that). The files the runs
// write are compared too, but for `outline/`: filling the outline from the plan is new, and wanted. So is the freeze record
// the autopilot writes in the chapter.md of every chapter it approves (E4b): the files are compared without it, and the one
// value it changes elsewhere (the hash of the chapter files in the director's judgement of the book) is computed without it,
// so that everything else stays byte for byte what it was.

const FIXTURE = new URL("./fixtures/world-parity.json", import.meta.url);
const STATE = "autopilot/state.json";
const ACTIVITY = "autopilot/activity.json";
const BOOK_OPINION = "evaluations/director/book.md";
const clock = () => new Date("2026-01-01T00:00:00.000Z");
const digest = (text) => createHash("sha256").update(text).digest("hex");

/** Entries the autopilot wrote and nobody touched since: they bind nothing, so the book is asked what it always was. */
async function intactEntries(count) {
  const files = {};
  for (let number = 1; number <= count; number += 1) {
    const title = `Chapter Title ${number}`;
    const body = `Event ${number} happens and the story turns.`;
    files[engine.outlineChapterPath(number)] = `---\ntype: outline-chapter\nnumber: ${number}\ntitle: ${title}\norigin: autopilot\ndigest: ${await engine.outlineEntryDigest({ title, body })}\n---\n\n${body}\n`;
  }
  return files;
}

/**
 * The book as the engine wrote it before it froze the chapters it approves: the same files without the freeze record (`frozen`, the last
 * key of the frontmatter of a chapter.md), and the director's judgement of the book with the source hash of those chapter files (it is
 * the hash of every file of `chapters/`, so it is the one value a record changes elsewhere). Everything else must be byte for byte the same.
 */
function withoutFreezeRecords(files) {
  const plain = { ...files };
  for (const [name, content] of Object.entries(files)) {
    if (/^chapters\/[^/]+\/chapter\.md$/.test(name)) plain[name] = content.replace(/^frozen:\n(?: {2,}.*\n)+/m, "");
  }
  if (plain[BOOK_OPINION]) {
    const chapters = Object.entries(plain).filter(([name]) => name.startsWith("chapters/")).map(([name, content]) => `${name}:${digest(content)}`).sort().join("\n");
    plain[BOOK_OPINION] = plain[BOOK_OPINION].replace(/^(source_hash: "?)[0-9a-f]{64}/m, `$1${digest(chapters)}`);
  }
  return plain;
}

function reply(json) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
}

function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const custom = script(request);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      request.signal?.throwIfAborted();
      return custom;
    },
  };
}

const { AutopilotSession, parseAutopilotState } = engine;

/** One run of the autopilot on `files`; `prepare` is what the author does to the book before it starts. */
async function run(files, ai, start, prepare) {
  const store = new MemoryBookStore(files);
  await prepare?.(store);
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock });
  await session.start(start);
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  const written = Object.entries(withoutFreezeRecords(store.toObject())).filter(([name]) => name !== STATE && name !== ACTIVITY && !name.startsWith("outline/"));
  return {
    status: state.status,
    error: state.lastError?.message ?? null,
    files: Object.fromEntries(written.map(([name, content]) => [name, digest(content)])),
    requests: ai.calls.map((call, index) => `${String(index).padStart(3, "0")} ${call.label} ${digest(JSON.stringify({ system: call.system, user: call.user, json: call.json?.name, maxOutputTokens: call.maxOutputTokens, temperature: call.temperature }))}`),
  };
}

/** A 25-chapter book: two batches of the plan, a revision the director asks for chapters 3 and 22, two readers of the plan, then chapter 1 written, reviewed twice, repaired and closed. */
async function batchedAndRevised() {
  let reviews = 0;
  const ai = scripted((request) => {
    if (request.json?.name !== "plan_review") return undefined;
    reviews += 1;
    return reviews === 1 ? reply({ verdict: "revise", score: 6, summary: "Two chapters need work.", strengths: ["Stakes"], changes: [{ chapterNumber: 3, instruction: "Make it darker." }, { chapterNumber: 22, instruction: "Make it faster." }], guidance: ["Keep the sea present."] }) : undefined;
  });
  return run({ ...seedBookFiles(), ...(await intactEntries(25)) }, ai, { brief: { idea: "A harbor built on glass hides a lie.", targetChapters: 25, scenesPerChapter: 2, wordsPerScene: 300, genre: "Mystery", audience: "Adults" }, options: { maxReaders: 2, pauseAfterPlan: false, chaptersPerRun: 1 } });
}

/** A book the author began: two chapters written (one without a summary), a binding synopsis, two chapters planned after them, written and judged, and the final judgement. */
async function importedWithSynopsis(prepare) {
  const files = { ...seedBookFiles({ title: "Il faro di sale", language: "it" }), ...(await intactEntries(4)) };
  files["chapters/001-the-arrival/chapter.md"] = "---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\nsummary: Mira arrives at the harbor and finds the lighthouse dark.\n---\n\n# The Arrival\n";
  files["chapters/001-the-arrival/001-dawn.md"] = "---\ntype: paragraph\nid: paragraph:001-the-arrival:001-dawn\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: Dawn\n---\n\nThe author's own opening scene, written before the autopilot: Mira walks down the stone steps toward the silent boats.";
  files["chapters/002-the-storm/001-wind.md"] = "---\ntype: paragraph\nid: paragraph:002-the-storm:001-wind\nchapter: chapter:002-the-storm\nnumber: 1\ntitle: Wind\n---\n\nThe author's second chapter: the wind carries salt and memory across the harbor while the council meets in secret.";
  return run(files, createFakeAutopilotAi(), {
    brief: { idea: "Un faro spento.", synopsis: "1. Mira arriva. 2. La tempesta. 3. La menzogna del consiglio. 4. L'alluvione.", targetChapters: 4, scenesPerChapter: 1, wordsPerScene: 300 },
    options: { maxReaders: 1, pauseAfterPlan: false },
  }, prepare);
}

/** A small English book written to the end with readers, specialists, a director who revises every chapter once, and the final judgement. */
async function wholeSmallBook() {
  return run({ ...seedBookFiles(), ...(await intactEntries(2)) }, createFakeAutopilotAi(), { brief: { idea: "A lighthouse keeper's last winter.", targetChapters: 2, scenesPerChapter: 2, wordsPerScene: 300 }, options: { maxReaders: 2, pauseAfterPlan: false } });
}

test("a book without an outline and without an evaluation style sends, byte for byte, the requests it always sent", async () => {
  const runs = { batchedAndRevised: await batchedAndRevised(), importedWithSynopsis: await importedWithSynopsis(), wholeSmallBook: await wholeSmallBook() };
  for (const [name, result] of Object.entries(runs)) assert.equal(result.error, null, `${name}: ${result.error}`);
  if (process.env.UPDATE_WORLD_PARITY) {
    await mkdir(new URL("./", FIXTURE), { recursive: true });
    await writeFile(FIXTURE, `${JSON.stringify(runs, null, 1)}\n`);
    return;
  }
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  for (const name of Object.keys(fixture)) {
    assert.equal(runs[name].status, fixture[name].status, `${name}: the run ends as it did`);
    assert.deepEqual(runs[name].requests, fixture[name].requests, `${name}: a request to the model changed`);
    assert.deepEqual(runs[name].files, fixture[name].files, `${name}: a file of the book changed`);
  }
  assert.ok(fixture.batchedAndRevised.requests.length > 20 && fixture.importedWithSynopsis.requests.length > 15 && fixture.wholeSmallBook.requests.length > 20, "the runs cover the whole pipeline");
});

test("the chapters the autopilot approves are frozen, and the record is the only thing that changed in the files", async () => {
  let store;
  const result = await importedWithSynopsis((book) => {
    store = book;
  });
  assert.equal(result.error, null);
  const snapshot = await engine.loadBookSnapshot(store);
  assert.deepEqual(snapshot.chapters.map((chapter) => chapter.frozen?.by ?? null), [null, null, "autopilot", "autopilot"], "the author's chapters are never frozen by the autopilot");
  assert.deepEqual(engine.frozenChanges(snapshot), []);
  const raw = store.toObject();
  const plain = withoutFreezeRecords(raw);
  const changed = Object.keys(raw).filter((name) => raw[name] !== plain[name]).sort();
  const records = snapshot.chapters.filter((chapter) => chapter.frozen).map((chapter) => chapter.path);
  assert.equal(records.length, 2);
  assert.deepEqual(changed, [...records, BOOK_OPINION].sort(), "only the records, and the hash of the chapters in the judgement of the book");
});

test("a book whose chapters the author froze, and that nobody changed, sends the same requests as the same book not frozen", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  let store;
  const result = await importedWithSynopsis(async (book) => {
    store = book;
    const snapshot = await engine.loadBookSnapshot(book);
    for (const chapter of snapshot.chapters) await book.commit(engine.freezeChapterChanges(snapshot, chapter.slug, "author", "2025-12-31T00:00:00.000Z"), "the author freezes the chapters");
  });
  assert.equal(result.error, null);
  assert.equal(result.status, fixture.importedWithSynopsis.status);
  assert.deepEqual(result.requests, fixture.importedWithSynopsis.requests, "no request changed, and none was added");
  const snapshot = await engine.loadBookSnapshot(store);
  assert.deepEqual(snapshot.chapters.map((chapter) => chapter.frozen?.by ?? null), ["author", "author", "autopilot", "autopilot"]);
  assert.deepEqual(engine.frozenChanges(snapshot), [], "the summaries the autopilot wrote into the author's chapters are no change");
});
