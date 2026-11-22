import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, loadBookSnapshot, parseAutopilotState, parseMarkdown } = engine;

// ─── E4b-F4: what a host can do outside a run (and during one), and the server's contract ───────────────────────────────

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const clock = () => new Date("2026-01-01T00:00:00.000Z");
const ONE = "chapters/001-chapter-title-1";

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const labelsSince = (ai, mark) => ai.calls.slice(mark).map((call) => call.label);

function newSession(store, ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" })) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

async function finishedBook({ chapters = 2, options = {} } = {}) {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session } = newSession(store, ai);
  await session.start({ brief: { idea: "x", targetChapters: chapters, scenesPerChapter: 2, wordsPerScene: 300 }, options: { ...FAST, ...options } });
  await session.waitForIdle();
  assert.equal(stateOf(store).status, "completed", stateOf(store).lastError?.message);
  return { store, ai };
}

function rewriteScene(store, path, text = "The author rewrote this sentence by hand.") {
  const document = parseMarkdown(store.files.get(path));
  store.write(path, store.files.get(path).replace(document.body, `${document.body}\n\n${text}`));
}

test("frozenStatus lists the changed frozen chapters with what can be done, and the summary counts them", async () => {
  const { store } = await finishedBook();
  const { session } = newSession(store);
  let status = await session.frozenStatus();
  assert.deepEqual(status.changes, []);
  assert.equal(status.mode, "ask");
  rewriteScene(store, `${ONE}/002-scene-2-title.md`);
  status = await session.frozenStatus();
  assert.equal(status.changes.length, 1);
  const [change] = status.changes;
  assert.deepEqual([change.kind, change.number, change.slug, change.title, change.by, change.frozenAt], ["frozen", 1, "001-chapter-title-1", "Chapter Title 1", "autopilot", "2026-01-01T00:00:00.000Z"]);
  assert.deepEqual(change.changed, { added: [], removed: [], modified: ["002-scene-2-title.md"], body: false });
  assert.deepEqual(change.actions, ["review-and-update", "review-only", "mark-reviewed"]);
  assert.equal(change.pending, undefined);
  assert.equal((await session.snapshot()).summary.frozenChanges, 1, "the summary says it without the state");
});

test("resolveFrozenChange: marking reviewed is one commit of chapter.md and of the state, at once", async () => {
  const { store } = await finishedBook();
  rewriteScene(store, `${ONE}/002-scene-2-title.md`);
  const { session } = newSession(store);
  const commits = store.commits.length;
  const status = await session.resolveFrozenChange(1, "mark-reviewed");
  assert.deepEqual(status.changes, []);
  assert.equal(store.commits.length, commits + 1, "one commit");
  assert.ok(store.commits.at(-1).paths.includes(`${ONE}/chapter.md`));
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), []);
  assert.equal((await session.snapshot()).summary.frozenChanges, undefined, "absent when nothing waits");
});

test("resolveFrozenChange: a review is recorded for the next run, which does it before going on with the plan", async () => {
  const { store } = await finishedBook({ chapters: 3 });
  rewriteScene(store, `${ONE}/002-scene-2-title.md`);
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session } = newSession(store, ai);
  const status = await session.resolveFrozenChange(1, "review-only");
  assert.deepEqual(status.changes.map((change) => [change.number, change.pending?.action]), [[1, "review-only"]], "listed with the decision that waits");
  const pending = stateOf(store).pendingReviews;
  assert.deepEqual(pending.map((entry) => [entry.kind, entry.number, entry.action]), [["frozen", 1, "review-only"]]);
  assert.equal((await session.snapshot()).summary.frozenChanges, undefined, "a change with a decision is no longer waiting for the author");
  // The author raises the number of chapters too: the review still comes first.
  await session.configure({ brief: { targetChapters: 4 } });
  await session.start();
  await session.waitForIdle();
  const labels = labelsSince(ai, 0);
  assert.equal(labels[0], "autopilot:director-review:1", labels.join(", "));
  assert.equal(stateOf(store).status, "completed", stateOf(store).lastError?.message);
  assert.deepEqual(stateOf(store).pendingReviews ?? [], []);
});

test("a review asked while a run goes on is done at the next step", async () => {
  const { store } = await finishedBook({ chapters: 2 });
  rewriteScene(store, `${ONE}/001-scene-1-title.md`);
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve", delayMs: 20 });
  const { session } = newSession(store, ai);
  // Two more chapters to write; the author decides about chapter 1 once the run is going.
  await session.configure({ brief: { targetChapters: 4 }, options: { frozenEdits: "notify" } });
  let asked = false;
  session.subscribe((event) => {
    if (asked || event.type !== "task-finished" || event.activity.task !== "plan") return;
    asked = true;
    session.resolveFrozenChange(1, "review-only").catch((error) => assert.fail(error));
  });
  await session.start();
  await session.waitForIdle();
  assert.ok(asked);
  const labels = labelsSince(ai, 0);
  const plan = labels.indexOf("autopilot:plan");
  const review = labels.indexOf("autopilot:director-review:1");
  assert.ok(review > plan && labels.slice(plan + 1, review).every((label) => !/^autopilot:(scenes|write):/.test(label)), labels.join(", "));
  assert.equal(stateOf(store).status, "completed", stateOf(store).lastError?.message);
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), []);
});

test("resolveFrozenChange refuses what it cannot do, with a code", async () => {
  const { store } = await finishedBook();
  const { session } = newSession(store);
  const refused = (code) => (error) => error instanceof engine.FrozenChapterError && error.code === code;
  await assert.rejects(session.resolveFrozenChange(9, "mark-reviewed"), refused("chapter_not_found"));
  await assert.rejects(session.resolveFrozenChange(1, "mark-reviewed"), refused("not_changed"), "nothing changed in chapter 1");
  rewriteScene(store, `${ONE}/001-scene-1-title.md`);
  await assert.rejects(session.resolveFrozenChange(1, "keep-text"), refused("not_changed"), "its outline did not change");
  await assert.rejects(session.resolveFrozenChange(1, "rewrite-everything"), refused("invalid_action"));
  assert.deepEqual(engine.FROZEN_CHAPTER_ERROR_CODES, ["chapter_not_found", "not_changed", "invalid_action"]);
});

test("the author freezes a chapter by hand, and unfreezes it", async () => {
  const files = seedBookFiles();
  files["chapters/001-the-arrival/001-dawn.md"] = "---\ntype: paragraph\nid: paragraph:001-the-arrival:001-dawn\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: Dawn\n---\n\nThe author's own opening, written before the autopilot.";
  const store = new MemoryBookStore(files);
  const { session } = newSession(store);
  const frozen = await session.freezeChapter("001-the-arrival");
  assert.deepEqual([frozen.slug, frozen.number, frozen.frozen.by], ["001-the-arrival", 1, "author"]);
  assert.equal((await loadBookSnapshot(store)).chapters[0].frozen.by, "author");
  rewriteScene(store, "chapters/001-the-arrival/001-dawn.md");
  const status = await session.frozenStatus();
  assert.deepEqual(status.changes.map((change) => [change.number, change.by]), [[1, "author"]]);
  assert.deepEqual(status.changes[0].actions, ["mark-reviewed"], "without a plan, only marking it reviewed can be done");
  const unfrozen = await session.unfreezeChapter("001-the-arrival");
  assert.equal(unfrozen.frozen, null);
  assert.deepEqual((await session.frozenStatus()).changes, []);
  await assert.rejects(session.freezeChapter("404-nowhere"), (error) => error.code === "chapter_not_found");
});

test("the client of the personal server speaks the frozen routes, and a server says whether it has them", async () => {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined });
    return Response.json(url.pathname.endsWith("/freeze") ? { slug: "003-the-storm", number: 3, frozen: null } : { mode: "ask", changes: [], pending: [], warnings: [] });
  };
  const client = new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch });
  assert.deepEqual(await client.frozenStatus("my book"), { mode: "ask", changes: [], pending: [], warnings: [] });
  await client.resolveFrozenChange("my book", 3, "review-only");
  await client.resolveFrozenChange("my book", 4, "rewrite-to-outline", { kind: "outline", note: "Follow it." });
  await client.freezeChapter("my book", "003-the-storm", true);
  await client.freezeChapter("my book", "003-the-storm", false);
  assert.deepEqual(log, [
    { method: "GET", path: "/api/v1/books/my%20book/autopilot/frozen", body: undefined },
    { method: "POST", path: "/api/v1/books/my%20book/autopilot/frozen/3", body: { action: "review-only" } },
    { method: "POST", path: "/api/v1/books/my%20book/autopilot/frozen/4", body: { action: "rewrite-to-outline", kind: "outline", note: "Follow it." } },
    { method: "POST", path: "/api/v1/books/my%20book/chapters/003-the-storm/freeze", body: { frozen: true } },
    { method: "POST", path: "/api/v1/books/my%20book/chapters/003-the-storm/freeze", body: { frozen: false } },
  ]);
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_FROZEN, "autopilot-frozen");
  assert.equal(engine.serverSupportsFrozenChapters({ features: ["autopilot-frozen"] }), true);
  assert.equal(engine.serverSupportsFrozenChapters({ features: ["autopilot-rules"] }), false);
  assert.equal(engine.serverSupportsFrozenChapters(null), false);
  assert.equal(engine.serverSupportsFrozenChapters({ features: "autopilot-frozen" }), false);
});

test("a state with pending reviews, a frozen question and the new revision fields is read back as it was; nonsense is dropped", () => {
  const base = engine.createAutopilotState(new Date(0));
  assert.equal(base.frozenSince, new Date(0).toISOString(), "a new state knows frozen chapters from its start");
  const state = {
    ...base,
    pendingReviews: [
      { id: "frozen-1", kind: "frozen", number: 3, action: "review-and-update", fingerprint: "abc123abc123abc1", at: "2026-01-01T00:00:00.000Z", note: "Keep Orrin afraid.", started: { at: "2026-01-01T00:00:00.000Z", phase: "review", before: { title: "T", summary: "S", keyEvents: ["E"], storySoFar: "So far." } } },
      { id: "x", kind: "frozen", number: 0, action: "review-only", fingerprint: "f", at: "" },
      { id: "y", kind: "nonsense", number: 2, action: "review-only", fingerprint: "f", at: "" },
      { id: "z", kind: "frozen", number: 2, action: "delete-the-book", fingerprint: "f", at: "" },
    ],
    frozenSeen: ["frozen:1:abc", 7, ""],
    question: { id: "frozen-3-abc", kind: "frozen-change", question: "You changed chapter 3.", context: "", options: ["A", "B"], choices: [{ id: "review-only", label: "A" }, { id: "", label: "B" }], frozen: { kind: "frozen", number: 3, slug: "003-x", fingerprint: "abc", by: "author", frozenAt: "2026-01-01T00:00:00.000Z", changed: { added: [], removed: [], modified: ["001-a.md"], body: false } }, askedAt: "2026-01-01T00:00:00.000Z" },
    revision: { id: "r", instruction: "Follow the change.", createdAt: "2026-01-01T00:00:00.000Z", targets: null, cursor: 0, afterChapter: 3, source: { kind: "frozen", chapterNumber: 3, note: "Keep Orrin afraid.", before: { title: "T", summary: "S", keyEvents: ["E"] }, after: { title: "T", summary: "S2", keyEvents: [], storySoFar: "Now." } } },
    review: { chapterNumber: 3, round: 1, readersPending: [], readerScores: [], readersSummaryDone: false, findings: [], specialistsDone: true, directorDone: false, decisions: [], repairQueue: [], previousFixes: [], history: [], authorEdit: true },
  };
  const read = engine.parseAutopilotState(engine.serializeAutopilotState(state));
  assert.deepEqual(read.pendingReviews.map((entry) => entry.id), ["frozen-1"]);
  assert.deepEqual(read.pendingReviews[0], state.pendingReviews[0]);
  assert.deepEqual(read.frozenSeen, ["frozen:1:abc"]);
  assert.equal(read.question.kind, "frozen-change");
  assert.deepEqual(read.question.choices, [{ id: "review-only", label: "A" }]);
  assert.deepEqual(read.question.frozen, state.question.frozen);
  assert.deepEqual([read.revision.afterChapter, read.revision.source.kind, read.revision.source.after.summary], [3, "frozen", "S2"]);
  assert.equal(read.review.authorEdit, true);
  const old = engine.parseAutopilotState(JSON.stringify({ plan: null }));
  assert.equal(old.frozenSince, undefined, "an older state does not say since when");
  assert.equal(old.pendingReviews, undefined);
});
