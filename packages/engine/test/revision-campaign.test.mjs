import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// Campaigns: «revise THESE chapters now, for THIS reason, in order, then go on with the plan», for the reason `outline-change` (the author applies the Synopsis
// to the book): exactly the chapters the author chose are rewritten, one after the other, kept ones are kept, the ones left for later are neither asked about nor
// decided by the autopilot, and the plan goes on. The campaign is the author's (saved at once), survives a restart and is cancelled by the author.

const { AutopilotSession, RevisionCampaignError, loadBookSnapshot, parseAutopilotState } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const clock = () => new Date("2026-01-01T00:00:00.000Z");
const folder = (number) => `chapters/00${number}-chapter-title-${number}`;
const scene = (number, index = 1) => `${folder(number)}/00${index}-scene-${index}-title.md`;

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const labelsSince = (ai, mark) => ai.calls.slice(mark).map((call) => call.label);
const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);
const reply = (json) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" });

/** The fake AI, with an impact that rewrites the first scene of the chapter rewritten to follow its entry (and never a later chapter). */
function rewritingAi() {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  return {
    calls: base.calls,
    async complete(request) {
      if (request.json?.name !== "revision_impact") return base.complete(request);
      base.calls.push(request);
      const only = /written scenes of chapter (\d+) must be rewritten/i.exec(request.user);
      return only ? reply({ summary: "The first scene follows the entry.", targets: [{ chapterNumber: Number(only[1]), sceneNumber: 1, instruction: "Follow the new entry." }] }) : reply({ summary: "Nothing later.", targets: [] });
    },
  };
}

function newSession(store, ai) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

async function run(store, ai, start = {}) {
  const { session, events } = newSession(store, ai);
  await session.start(start);
  await session.waitForIdle();
  return { session, events, state: stateOf(store) };
}

async function finishedBook(chapters = 4) {
  const store = new MemoryBookStore(seedBookFiles({ chapters }));
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { state } = await run(store, ai, { brief: { idea: "x", targetChapters: chapters, scenesPerChapter: 2, wordsPerScene: 300 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  return store;
}

async function outlineOf(store) {
  const paths = (await store.list()).filter((entry) => entry.path.startsWith("outline/"));
  return engine.parseOutline(await Promise.all(paths.map(async (entry) => store.read(entry.path))));
}

async function editEntries(store, numbers) {
  for (const number of numbers) {
    const result = engine.outlineChanges({ outline: await outlineOf(store), edit: { kind: "update", number, entry: { body: `NEW-ENTRY-${number}: the synopsis says something else now.` } } });
    await store.commit(result.changes, "the author edits the synopsis");
  }
}

const digestOf = async (store, number) => (await outlineOf(store)).chapters.find((entry) => entry.number === number).contentDigest;

test("applying the Synopsis rewrites exactly the chosen chapters, in order, with the author's words, keeps the kept one, leaves the later one to the author, and the book goes on", async () => {
  const store = await finishedBook(4);
  await editEntries(store, [1, 2, 3, 4]);
  const before = Object.fromEntries([1, 2, 3, 4].map((number) => [number, store.files.get(scene(number))]));
  const ai = rewritingAi();
  const { session } = newSession(store, ai);
  const fingerprint3 = await digestOf(store, 3);
  const result = await session.reviseChapters({
    reason: "outline-change",
    note: "The vault comes first.",
    chapters: [{ number: 3, mode: "follow", fingerprint: fingerprint3 }, { number: 1, mode: "follow", instruction: "Mira arrives at night." }, { number: 2, mode: "keep" }, { number: 4, mode: "later" }],
  });
  assert.deepEqual(result.campaign.chapters.map((item) => [item.number, item.mode, item.status]), [[1, "follow", "waiting"], [2, "keep", "done"], [3, "follow", "waiting"], [4, "later", "done"]], "in the order of the book; what needs no model is done at once");
  assert.equal(result.campaign.note, "The vault comes first.");
  let state = stateOf(store);
  assert.equal(state.plan.chapters[1].outlineDigest, await digestOf(store, 2), "the kept chapter follows its entry at once");
  assert.deepEqual(state.deferredChanges.map((entry) => [entry.kind, entry.number, entry.fingerprint]), [["outline", 4, await digestOf(store, 4)]]);
  const status = Object.fromEntries(result.frozen.changes.map((entry) => [entry.number, entry]));
  assert.deepEqual(Object.keys(status).map(Number), [1, 3, 4], "chapter 2 has nothing to decide any more");
  assert.deepEqual([status[1].pending?.action, status[3].pending?.action, status[4].deferred?.at], ["rewrite-to-outline", "rewrite-to-outline", "2026-01-01T00:00:00.000Z"]);
  assert.equal(engine.summarizeAutopilotState(state).campaign.total, 2);

  const mark = ai.calls.length;
  const { events } = await run(store, ai);
  state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  const labels = labelsSince(ai, mark);
  const impacts = ai.calls.slice(mark).filter((call) => call.label === "autopilot:impact");
  assert.equal(impacts.length, 2, labels.join(", "));
  assert.match(impacts[0].user, /chapter 1[^]*NEW-ENTRY-1/i);
  assert.match(impacts[0].user, /The vault comes first\.[^]*Mira arrives at night\./, "the author's words, for all and for the chapter");
  assert.match(impacts[1].user, /chapter 3[^]*NEW-ENTRY-3/i);
  assert.doesNotMatch(impacts.map((call) => call.user).join("\n"), /BEFORE THE CHANGE/, "no later chapter is checked: the author chose each chapter that changes");
  assert.ok(labels.indexOf("autopilot:revise:1.1") < labels.indexOf("autopilot:director-review:1"));
  assert.ok(labels.indexOf("autopilot:director-review:1") < labels.indexOf("autopilot:revise:3.1"), "chapter 1, then chapter 3");
  assert.ok(labels.indexOf("autopilot:revise:3.1") < labels.indexOf("director:book"), "then the book goes on to its end");
  assert.ok(!labels.some((label) => /:(2|4)\.\d$|:(2|4)$/.test(label) && !label.startsWith("director:book")), labels.join(", "));
  assert.notEqual(store.files.get(scene(1)), before[1]);
  assert.notEqual(store.files.get(scene(3)), before[3]);
  assert.equal(store.files.get(scene(2)), before[2], "kept");
  assert.equal(store.files.get(scene(4)), before[4], "left for later");
  assert.equal(state.campaign, undefined, "done, and gone");
  assert.deepEqual(insights(events, "campaignChapterDone").map((event) => event.chapterNumber), [1, 3]);
  assert.equal(insights(events, "campaignDone").length, 1);
  assert.match(insights(events, "campaignDone")[0].title, /2 chapters rewritten/);
  assert.equal(state.question, null, "the change left for later is not asked about");
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), [], "every chapter it rewrote is frozen again");
  const later = (await newSession(store, ai).session.frozenStatus()).changes;
  assert.deepEqual(later.map((entry) => [entry.number, entry.kind, Boolean(entry.deferred), entry.pending ?? null]), [[4, "outline", true, null]], "and it still waits for the author");
  assert.deepEqual([state.plan.chapters[0].outlineDigest, state.plan.chapters[2].outlineDigest], [await digestOf(store, 1), await digestOf(store, 3)]);
});

test("a chapter added at the end of the Synopsis waits for the campaign: the chosen chapters are rewritten first, then the book grows (and a plan to read still pauses)", async () => {
  const store = await finishedBook(2);
  await editEntries(store, [1]);
  const appended = engine.outlineChanges({ outline: await outlineOf(store), edit: { kind: "append", entry: { title: "The Return", body: "Mira comes back years later." } } });
  await store.commit(appended.changes, "the author adds a chapter");
  const ai = rewritingAi();
  const { session } = newSession(store, ai);
  await session.reviseChapters({ reason: "outline-change", chapters: [{ number: 1, mode: "follow" }] });
  const mark = ai.calls.length;
  const { state } = await run(store, ai, { options: { pauseAfterPlan: true } });
  const labels = labelsSince(ai, mark);
  assert.equal(state.status, "paused", `${state.message} ${labels.join(", ")}`);
  assert.match(state.message, /plan is ready/i, "the plan of the new chapter waits for the author, as every plan does");
  assert.ok(labels.indexOf("autopilot:revise:1.1") >= 0 && labels.indexOf("autopilot:revise:1.1") < labels.indexOf("autopilot:plan"), labels.join(", "));
  assert.ok(labels.indexOf("autopilot:director-review:1") < labels.indexOf("autopilot:plan"), "chapter 1 is closed again before the book grows");
  assert.equal(state.campaign, undefined);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.number), [1, 2, 3]);
});

test("a change left for later, or not decided yet, stays one when the book grows: the plan made again around the written chapters keeps the entry each one followed", async () => {
  const store = await finishedBook(3);
  await editEntries(store, [1, 2]);
  const followed = stateOf(store).plan.chapters.map((chapter) => chapter.outlineDigest);
  const appended = engine.outlineChanges({ outline: await outlineOf(store), edit: { kind: "append", entry: { title: "The Return", body: "Mira comes back years later." } } });
  await store.commit(appended.changes, "the author adds a chapter");
  const ai = rewritingAi();
  await newSession(store, ai).session.reviseChapters({ reason: "outline-change", chapters: [{ number: 1, mode: "later" }] });
  const { state } = await run(store, ai);
  // The book grew; chapter 1 is still left for later and chapter 2 is asked about, as before the plan was made again.
  assert.equal(state.status, "waiting-author", `${state.status} ${state.lastError?.message ?? ""}`);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.number), [1, 2, 3, 4]);
  assert.deepEqual(state.plan.chapters.slice(0, 3).map((chapter) => chapter.outlineDigest), followed, "the entries the written chapters follow");
  assert.equal(state.question?.kind, "outline-change");
  assert.equal(state.question.frozen.number, 2);
  assert.deepEqual(state.deferredChanges.map((entry) => entry.number), [1]);
  const status = await newSession(store, ai).session.frozenStatus();
  assert.deepEqual(status.changes.map((entry) => [entry.number, entry.kind, Boolean(entry.deferred)]), [[1, "outline", true], [2, "outline", false]]);
});

test("the author's refusals: a chapter with no change, a change that moved on, a second campaign while one waits, and a request that is no campaign", async () => {
  const store = await finishedBook(2);
  await editEntries(store, [1]);
  const { session } = newSession(store, rewritingAi());
  const refused = (input) => session.reviseChapters(input).then(() => null, (error) => (error instanceof RevisionCampaignError ? error.code : String(error)));
  assert.equal(await refused({ reason: "outline-change", chapters: [{ number: 2, mode: "follow" }] }), "not_changed");
  assert.equal(await refused({ reason: "outline-change", chapters: [{ number: 1, mode: "follow", fingerprint: "0000000000000000" }] }), "stale");
  assert.equal(await refused({ reason: "outline-change", chapters: [] }), "invalid_request");
  assert.equal(await refused({ reason: "outline-change", chapters: [{ number: 1, mode: "rewrite" }] }), "invalid_request");
  assert.equal(await refused({ reason: "outline-change", chapters: [{ number: 1, mode: "follow" }, { number: 1, mode: "keep" }] }), "invalid_request");
  assert.equal(await refused({ reason: "review-target", chapters: [{ number: 1, mode: "follow" }] }), "invalid_request");
  assert.equal(stateOf(store).campaign, undefined, "nothing was saved");
  await session.reviseChapters({ reason: "outline-change", chapters: [{ number: 1, mode: "follow" }] });
  assert.equal(await refused({ reason: "outline-change", chapters: [{ number: 1, mode: "keep" }] }), "campaign_active", "one at a time: wait for it, or cancel what waits");
  assert.deepEqual(engine.REVISION_CAMPAIGN_ERROR_CODES, ["invalid_request", "campaign_active", "not_changed", "stale", "not_finished", "nothing_to_review", "no_proposal"]);
  assert.deepEqual(["stale", "frozen", 409, undefined].map(engine.isRevisionCampaignErrorCode), [true, false, false, false]);
});

test("cancelling: what waits ends and is left for the author, nothing is rewritten or asked, and the book is as it was", async () => {
  const store = await finishedBook(2);
  await editEntries(store, [1, 2]);
  const ai = rewritingAi();
  const { session } = newSession(store, ai);
  await session.reviseChapters({ reason: "outline-change", chapters: [{ number: 1, mode: "follow" }, { number: 2, mode: "follow" }] });
  const cancelled = await session.cancelRevisionCampaign();
  assert.equal(cancelled.campaign, null);
  assert.deepEqual(cancelled.frozen.changes.map((entry) => [entry.number, Boolean(entry.deferred)]), [[1, true], [2, true]]);
  const before = store.files.get(scene(1));
  const mark = ai.calls.length;
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(labelsSince(ai, mark), [], "nothing to do: the changes wait for the author");
  assert.equal(state.question, null);
  assert.equal(store.files.get(scene(1)), before);
  // A campaign whose chapter is being worked keeps it: only what waits ends.
  const working = { campaign: { id: "c", reason: "outline-change", createdAt: "2026-01-01T00:00:00.000Z", chapters: [{ number: 1, mode: "follow", status: "working", fingerprint: "1111111111111111" }, { number: 2, mode: "follow", status: "waiting", fingerprint: "2222222222222222" }] } };
  const { deferredChanges: _left, ...clean } = state;
  const next = engine.cancelRevisionCampaign({ ...clean, ...working }, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(next.campaign.chapters.map((item) => item.status), ["working", "cancelled"]);
  assert.deepEqual(next.deferredChanges.map((entry) => [entry.number, entry.fingerprint]), [[2, "2222222222222222"]]);
});

test("a campaign is in the state: a run that stops after one step goes on with it after a restart, and a run in progress takes one recorded meanwhile", async () => {
  const store = await finishedBook(3);
  await editEntries(store, [1, 3]);
  const ai = rewritingAi();
  await newSession(store, ai).session.reviseChapters({ reason: "outline-change", chapters: [{ number: 1, mode: "follow" }, { number: 3, mode: "follow" }] });
  const { state: paused } = await run(store, ai, { limits: { steps: 2 } });
  assert.equal(paused.status, "paused", paused.lastError?.message);
  assert.deepEqual(paused.campaign.chapters.map((item) => item.status), ["working", "waiting"]);
  assert.equal(engine.summarizeAutopilotState(paused).campaign.current, 1);
  // Another host (a restart) goes on from the state.
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.campaign, undefined);
  assert.deepEqual([state.plan.chapters[0].outlineDigest, state.plan.chapters[2].outlineDigest], [await digestOf(store, 1), await digestOf(store, 3)]);
});

test("the frozen-edits mode does not touch the chapters of a campaign, nor the ones left for later; the others are decided as ever", async () => {
  const store = await finishedBook(3);
  await editEntries(store, [1, 2, 3]);
  const before = store.files.get(scene(2));
  const ai = rewritingAi();
  const { session } = newSession(store, ai);
  await session.updateOptions({ frozenEdits: "auto" });
  await session.reviseChapters({ reason: "outline-change", chapters: [{ number: 1, mode: "follow" }, { number: 2, mode: "later" }] });
  const { state, events } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(store.files.get(scene(2)), before, "left for later: «auto» does not rewrite it");
  assert.deepEqual(insights(events, "outlineWrittenAuto").map((event) => event.chapterNumber), [3], "the change nobody chose for is the mode's");
  assert.equal(state.deferredChanges.length, 1);
});

test("a reason that stops its campaign (the extension point of a later reason): the chapters that wait end as cancelled, are left for the author, and the stop is said with its words", async () => {
  const store = await finishedBook(3);
  await editEntries(store, [1, 2, 3]);
  const ai = rewritingAi();
  await newSession(store, ai).session.reviseChapters({ reason: "outline-change", chapters: [{ number: 1, mode: "follow" }, { number: 2, mode: "follow" }, { number: 3, mode: "follow" }] });
  const handler = engine.REVISION_REASON_HANDLERS["outline-change"];
  // Stop once one chapter is done: a rule such as «the target is reached».
  handler.stop = (state, campaign) => (campaign.chapters.some((item) => item.status === "done") ? "Target reached." : null);
  try {
    const mark = ai.calls.length;
    const { state, events } = await run(store, ai);
    assert.equal(state.status, "completed", state.lastError?.message);
    const labels = labelsSince(ai, mark);
    assert.ok(labels.includes("autopilot:revise:1.1"), labels.join(", "));
    assert.ok(!labels.some((label) => /revise:(2|3)\./.test(label)), labels.join(", "));
    const stopped = insights(events, "campaignStopped");
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].detail, "Target reached.");
    assert.equal(insights(events, "campaignDone").length, 0, "a campaign that stopped is not said to be done");
    assert.equal(state.campaign, undefined);
    assert.deepEqual(state.deferredChanges.map((entry) => entry.number), [2, 3], "left for the author, as a cancel leaves them");
    assert.equal(state.question, null);
  } finally {
    delete handler.stop;
  }
});

test("the merge of a step and of the author's write: the author's new campaign, and the chapters the author cancelled that had not begun", () => {
  const item = (number, status) => ({ number, mode: "follow", status });
  const campaign = (id, ...chapters) => ({ id, reason: "outline-change", createdAt: "2026-01-01T00:00:00.000Z", chapters });
  assert.deepEqual(engine.mergeCampaign(undefined, undefined, campaign("new", item(1, "waiting"))), campaign("new", item(1, "waiting")), "recorded while the step ran");
  const base = campaign("c", item(1, "waiting"), item(2, "waiting"));
  const working = campaign("c", item(1, "working"), item(2, "waiting"));
  const stored = campaign("c", item(1, "cancelled"), item(2, "cancelled"));
  assert.deepEqual(engine.mergeCampaign(working, base, stored).chapters.map((entry) => entry.status), ["working", "cancelled"], "what began finishes");
  assert.deepEqual(engine.mergeCampaign(working, base, undefined).chapters.map((entry) => entry.status), ["working", "cancelled"]);
  assert.equal(engine.mergeCampaign(campaign("c", item(1, "waiting")), campaign("c", item(1, "waiting")), undefined), undefined);
  assert.equal(engine.mergeCampaign(working, base, base), working, "the author did nothing: the run's");
});

test("a state with a campaign and changes left for later reads back as it was, and an odd one is no campaign", () => {
  const campaign = { id: "campaign_1", reason: "outline-change", note: "Why.", createdAt: "2026-01-01T00:00:00.000Z", chapters: [{ number: 2, mode: "follow", status: "working", fingerprint: "abcdef0123456789", instruction: "Do it.", startedAt: "2026-01-01T00:00:00.000Z" }, { number: 3, mode: "later", status: "done", endedAt: "2026-01-01T00:00:00.000Z" }] };
  const deferredChanges = [{ kind: "outline", number: 3, fingerprint: "1234567890abcdef", at: "2026-01-01T00:00:00.000Z" }];
  const read = parseAutopilotState(JSON.stringify({ ...engine.createAutopilotState(clock()), campaign, deferredChanges }));
  assert.deepEqual([read.campaign, read.deferredChanges], [campaign, deferredChanges]);
  for (const odd of [{ ...campaign, reason: "nonsense" }, { ...campaign, chapters: [] }, { ...campaign, id: "" }, "campaign"]) assert.equal(parseAutopilotState(JSON.stringify({ campaign: odd })).campaign, undefined);
  assert.deepEqual(parseAutopilotState(JSON.stringify({ campaign: { ...campaign, chapters: [...campaign.chapters, { number: 2, mode: "keep", status: "waiting" }, { number: 9, mode: "sometimes", status: "waiting" }] } })).campaign.chapters.map((item) => item.number), [2, 3], "each chapter once, and only what is one");
  assert.equal(parseAutopilotState(JSON.stringify({ deferredChanges: [{ kind: "outline", number: 1 }] })).deferredChanges, undefined);
});

test("the client of the personal server speaks the campaign routes when the server says it has them, and refuses before sending to one that does not", async () => {
  const log = [];
  const makeClient = (features) => new engine.NarrariumServerClient({
    baseUrl: "http://127.0.0.1:24242",
    token: "nrs_me",
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/info") return Response.json({ serverId: "s", name: "Home", version: "0.1.19", protocol: 1, features });
      log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json({ campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } });
    },
  });
  const client = makeClient([engine.SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY]);
  const request = { reason: "outline-change", note: "Why.", chapters: [{ number: 2, mode: "follow", fingerprint: "abcdef0123456789" }, { number: 3, mode: "later" }] };
  assert.deepEqual(await client.reviseChapters("my book", request), { campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } });
  await client.cancelRevisionCampaign("my book");
  assert.deepEqual(log, [
    { method: "POST", path: "/api/v1/books/my%20book/autopilot/campaign", body: request },
    { method: "DELETE", path: "/api/v1/books/my%20book/autopilot/campaign", body: undefined },
  ]);
  const older = makeClient(["autopilot", "autopilot-frozen"]);
  await assert.rejects(older.reviseChapters("my book", request), (error) => error.code === "feature_unavailable" && error.status === 501 && /autopilot-outline-apply/.test(error.message));
  await assert.rejects(older.cancelRevisionCampaign("my book"), (error) => error.code === "feature_unavailable");
  assert.equal(log.length, 2, "nothing was sent to the older server");
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY, "autopilot-outline-apply");
  assert.equal(engine.serverSupportsOutlineApply({ features: ["autopilot-outline-apply"] }), true);
  assert.equal(engine.serverSupportsOutlineApply(["autopilot-outline-apply"]), true);
  assert.equal(engine.serverSupportsOutlineApply({ features: ["autopilot-frozen"] }), false);
  assert.equal(engine.serverSupportsOutlineApply(null), false);
});
