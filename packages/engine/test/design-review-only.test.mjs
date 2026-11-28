import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// A review of the design on request: the chapters of the Synopsis that are not written are judged chapter by chapter and, for the whole design, its structure is analysed; nothing
// is designed or written, the design that was kept is not touched, and the run stops. The author decides about the findings: asks the autopilot to fix one, takes it herself, or
// says it is not a problem.

const {
  AutopilotDesignError,
  AutopilotSession,
  FINDING_ACTIONS,
  STALE_SIGNATURE,
  beginDesignReview,
  decideFinding,
  designFlow,
  nextDesignReview,
  normalizeAutopilotState,
  normalizeDesignStart,
  parseAutopilotState,
  serializeAutopilotState,
  serializeOutlineChapter,
  writeOutlineBrief,
} = engine;

const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-28T09:00:00.000Z");
const STATE = "autopilot/state.json";

const refused = (call, code) => assert.throws(call, (error) => error instanceof AutopilotDesignError && error.code === code, code);

test("a review on request is asked for the whole design or for chosen chapters, stands alone, and anything else is refused", () => {
  assert.deepEqual(normalizeDesignStart({ reviewOnly: true }), { reviewOnly: {} });
  assert.deepEqual(normalizeDesignStart({ reviewOnly: {} }), { reviewOnly: {} });
  assert.deepEqual(normalizeDesignStart({ reviewOnly: { chapters: [4, 2, 4] } }), { reviewOnly: { chapters: [2, 4] } });
  for (const bad of [
    { reviewOnly: false }, { reviewOnly: "yes" }, { reviewOnly: [] }, { reviewOnly: { chapters: [] } }, { reviewOnly: { chapters: "4" } }, { reviewOnly: { chapters: [0] } },
    { reviewOnly: { chapters: [1.5] } }, { reviewOnly: { chapters: ["1"] } }, { reviewOnly: { chapters: [1], rounds: 3 } },
    { reviewOnly: true, chapters: 8 }, { reviewOnly: true, workflow: { rubric: true } }, { reviewOnly: true, review: { maxRounds: 2 } },
  ]) refused(() => normalizeDesignStart(bad), "invalid_request");
  const flow = designFlow({ reviewing: { startedAt: "x" } });
  assert.deepEqual([flow.rubric, flow.chapterReview, flow.coherence, flow.alternatives], [true, true, true, 0], "the whole design is analysed");
  assert.equal(designFlow({ reviewing: { startedAt: "x", chapters: [3] } }).coherence, false, "chosen chapters are judged, the structure is not");
});

const state = (extra = {}) => ({ concept: { done: true }, design: { startedAt: "2026-11-27T09:00:00.000Z", chapters: 6, rounds: [], endedAt: "2026-11-27T10:00:00.000Z", outcome: "target", ...extra } });
const context = { now: "2026-11-28T09:00:00.000Z", outlineChapters: 6, language: "en" };
const sealed = (chapter) => ({ sig: "0123abcd", round: 1, at: "2026-11-27T09:30:00.000Z", overall: 7, verdict: "ok", summary: `Chapter ${chapter} holds.` });

test("a review on request keeps the design as it is, forgets the reviews it asks again, and makes the analysis stale for the whole design", () => {
  const base = state({ reviewed: { 1: sealed(1), 2: sealed(2), 3: sealed(3) }, coherence: { sig: "aaaaaaaa", round: 1, at: "t", findings: [], summary: "x" }, rubric: {} });
  const whole = beginDesignReview(base, {}, context);
  assert.deepEqual(whole.design.reviewing, { startedAt: "2026-11-28T09:00:00.000Z" });
  assert.equal(whole.design.reviewed, undefined, "every chapter is judged again");
  assert.equal(whole.design.coherence.sig, STALE_SIGNATURE, "and the structure analysed again, with its findings kept to carry what was decided");
  assert.equal(whole.design.outcome, "target", "the design is not touched");
  assert.equal(whole.design.endedAt, "2026-11-27T10:00:00.000Z");
  assert.equal(base.design.reviewed["1"].summary, "Chapter 1 holds.", "the state it was given is not changed");
  const some = beginDesignReview(base, { chapters: [2, 5] }, context);
  assert.deepEqual(some.design.reviewing, { startedAt: "2026-11-28T09:00:00.000Z", chapters: [2, 5] });
  assert.deepEqual(Object.keys(some.design.reviewed), ["1", "3"], "only the chapters asked for are forgotten");
  assert.equal(some.design.coherence.sig, "aaaaaaaa", "the structure is not analysed for chosen chapters");
  // A book that was never designed by the autopilot gets a record that says so.
  const bare = beginDesignReview({ concept: { done: false } }, {}, context);
  assert.deepEqual([bare.design.outcome, bare.design.chapters, bare.design.rounds, bare.design.endedAt], ["author", 6, [], "2026-11-28T09:00:00.000Z"]);
  // A review asked again is a review.
  assert.deepEqual(beginDesignReview(whole, { chapters: [1] }, context).design.reviewing.chapters, [1]);
  assert.equal(normalizeAutopilotState(JSON.parse(serializeAutopilotState({ ...bare, schemaVersion: 1 }))).design.reviewing.startedAt, "2026-11-28T09:00:00.000Z", "kept when the state is saved and read again");
});

test("a review on request is refused while a design run goes on, for a Synopsis with no chapter, and for a chapter that is not in it", () => {
  refused(() => beginDesignReview({ concept: { done: false }, design: { startedAt: "x", chapters: 6, rounds: [] } }, {}, context), "design_active");
  refused(() => beginDesignReview({ concept: { done: false } }, {}, { ...context, outlineChapters: 0 }), "design_no_chapters");
  refused(() => beginDesignReview({ concept: { done: false } }, { chapters: [7] }, context), "invalid_request");
  assert.throws(() => beginDesignReview({ concept: { done: false } }, {}, { ...context, outlineChapters: 0, language: "it" }), /La Sinossi non ha capitoli da rivedere\./);
});

async function describedBook(extra = {}) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }), ...extra });
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

function makeSession(store, ai) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  return { session, events, state: () => parseAutopilotState(store.files.get(STATE)) };
}

async function run(store, ai, start) {
  const made = makeSession(store, ai);
  await made.session.start(start);
  await made.session.waitForIdle();
  return { ...made, state: made.state() };
}

const names = (ai) => ai.calls.map((call) => call.json?.name);
const DESIGN = { design: { chapters: 6, workflow: { rubric: true, chapterReview: true, coherence: true } }, options: { readersOnPlan: false, pauseAfterPlan: false } };
const FINDING = { severity: "major", kind: "timeline", chapters: [4, 5], requires: [5], text: "The ferry runs on a closed day.", proposal: "Move it a day." };
const asked = (ai) => ai.calls.filter((call) => call.json?.name === "design_chapter_review").map((call) => [...call.user.slice(call.user.indexOf("CHAPTERS UNDER REVIEW:")).matchAll(/^Chapter (\d+)[^\n]*:$/gm)].map((match) => Number(match[1])));

async function designed(extra = {}) {
  const store = await describedBook(extra);
  const ai = createFakeAutopilotAi({ coherence: () => ({ findings: [FINDING], summary: "One thing." }) });
  const first = await run(store, ai, DESIGN);
  assert.equal(first.state.design.outcome, "target", first.state.lastError?.message);
  return { store, first };
}

test("a review of the whole design on request judges every chapter again and analyses the structure again, designs nothing, and stops with what it found", async () => {
  const { store, first } = await designed();
  const ai = createFakeAutopilotAi({ chapterRubric: (chapter) => (chapter === 3 ? { pace: 4 } : 8), coherence: () => ({ findings: [{ ...FINDING, severity: "critical", text: "The ferry runs on a closed day, and the harbor is shut." }], summary: "Worse." }) });
  const made = await run(store, ai, { design: { reviewOnly: true } });
  assert.equal(made.state.status, "paused", made.state.lastError?.message);
  assert.deepEqual(names(ai), ["design_chapter_review", "design_chapter_review", "design_coherence"], "no concept, no design, no director's review");
  assert.deepEqual(asked(ai), [[1, 2, 3, 4], [5, 6]]);
  assert.match(ai.calls[0].user, /This is a review on request of the design as it is now\./);
  assert.equal(made.events.filter((event) => event.type === "run-ended").at(-1).code, "designReviewed");
  assert.equal(made.state.message, "Review of the design done: one open finding, one chapter with weak points.");
  // The design was not touched.
  assert.deepEqual(made.state.design.rounds, first.state.design.rounds);
  assert.equal(made.state.design.outcome, "target");
  assert.equal(made.state.design.endedAt, first.state.design.endedAt);
  assert.deepEqual(made.state.plan, first.state.plan);
  assert.deepEqual(made.state.design.reviewing, { startedAt: "2026-11-28T09:00:00.000Z" });
  // What it found.
  assert.equal(made.state.design.reviewed["3"].verdict, "revise");
  assert.equal(made.state.design.reviewed["1"].verdict, "ok");
  assert.equal(made.state.design.coherence.findings.length, 1);
  assert.equal(made.state.design.coherence.findings[0].severity, "critical", "the same finding, read again");
  assert.equal(made.state.design.coherence.findings[0].id, first.state.design.coherence.findings[0].id, "under the id it had");
  assert.equal(made.state.design.coherence.findings[0].round, first.state.design.coherence.findings[0].round);
  assert.ok(made.state.design.rubric["chapter:3"].history.length >= 2, "the evolution goes on");
  // The files of the book: nothing but the state.
  assert.deepEqual([...store.files.keys()].filter((path) => /^chapters\/[^/]+\/(?!chapter\.md$)/.test(path)), []);
});

test("a review of chosen chapters judges those with the chapters beside them and nothing else", async () => {
  const { store, first } = await designed();
  const ai = createFakeAutopilotAi({ chapterRubric: (chapter) => (chapter === 4 ? { twists: 5 } : 8) });
  const made = await run(store, ai, { design: { reviewOnly: { chapters: [4] } } });
  assert.equal(made.state.status, "paused", made.state.lastError?.message);
  assert.deepEqual(names(ai), ["design_chapter_review"]);
  assert.deepEqual(asked(ai), [[4]]);
  assert.match(ai.calls[0].user, /THE CHAPTERS BESIDE THEM[^\n]*:\nChapter 3:[\s\S]*Chapter 5:/);
  assert.equal(made.state.message, "Review of the design of chapter 4 done: 1 with weak points.");
  assert.equal(made.state.design.reviewed["4"].verdict, "revise");
  for (const number of [1, 2, 3, 5, 6]) assert.deepEqual(made.state.design.reviewed[String(number)], first.state.design.reviewed[String(number)], `chapter ${number} keeps its review`);
  assert.deepEqual(made.state.design.coherence, first.state.design.coherence, "the structure is not analysed again");
  // Asked again, it is judged again, though nothing changed.
  const again = createFakeAutopilotAi();
  const second = await run(store, again, { design: { reviewOnly: { chapters: [4] } } });
  assert.deepEqual(names(again), ["design_chapter_review"]);
  assert.equal(second.state.design.reviewed["4"].verdict, "ok");
});

test("a book the autopilot never designed, with a Synopsis of the author's, is reviewed as it is: nothing is rewritten, and the book gets a record of the review", async () => {
  const entries = Object.fromEntries([1, 2, 3].map((number) => [`outline/chapters/00${number}.md`, serializeOutlineChapter({ number, title: `Mine ${number}`, body: `I decided what happens in ${number}.`, origin: "author" })]));
  const store = await describedBook(entries);
  const ai = createFakeAutopilotAi({ coherence: () => ({ findings: [{ severity: "major", kind: "plot-hole", chapters: [2], requires: [2], text: "Nothing explains the key.", proposal: "Show it." }], summary: "x" }) });
  const made = await run(store, ai, { design: { reviewOnly: true } });
  assert.equal(made.state.status, "paused", made.state.lastError?.message);
  assert.deepEqual(names(ai), ["design_chapter_review", "design_coherence"]);
  assert.deepEqual([made.state.design.outcome, made.state.design.chapters, made.state.design.rounds], ["author", 3, []]);
  assert.equal(made.state.design.coherence.findings.find((entry) => entry.source === "ai").owner, "author");
  for (const [path, content] of Object.entries(entries)) assert.equal(store.files.get(path), content, "the author's entry is as the author wrote it");
  assert.equal(made.state.plan, null);
  assert.equal([...store.files.keys()].filter((path) => path.startsWith("outline/chapters/")).length, 3, "no placeholder entry is made");
  assert.match(made.state.message, /^Review of the design done: one open finding, 0 chapters with weak points\.$/);
});

test("a review is refused for a book with no chapters and while a design run goes on; any other start leaves the review", async () => {
  const empty = await describedBook();
  const made = makeSession(empty, createFakeAutopilotAi());
  await assert.rejects(made.session.start({ design: { reviewOnly: true } }), (error) => error instanceof AutopilotDesignError && error.code === "design_no_chapters");
  const { store } = await designed();
  const ai = createFakeAutopilotAi();
  const reviewing = await run(store, ai, { design: { reviewOnly: true } });
  assert.ok(reviewing.state.design.reviewing);
  // The author goes on: the review is over, and the run does what any run does after a design: it writes.
  const next = makeSession(store, createFakeAutopilotAi());
  await next.session.start({ limits: { chapters: 1 } });
  await next.session.waitForIdle();
  assert.equal(next.state().design.reviewing, undefined);
  assert.equal(next.state().design.outcome, "target");
  assert.equal(next.state().plan.chapters.filter((chapter) => chapter.status === "done").length, 1);
  // A design run that goes on refuses a review.
  const running = await describedBook();
  const half = makeSession(running, createFakeAutopilotAi({ delayMs: 10 }));
  await half.session.start({ design: { chapters: 4 }, options: { readersOnPlan: false, pauseAfterPlan: false, budgetLimit: 0.0015 } });
  await half.session.waitForIdle();
  assert.equal(half.state().design.endedAt, undefined, "the design goes on after the money cap");
  await assert.rejects(half.session.start({ design: { reviewOnly: true } }), (error) => error instanceof AutopilotDesignError && error.code === "design_active");
});

test("a review on request ignores a question that waits and what the author left pending: it does the review and stops", async () => {
  const { store } = await designed();
  const current = parseAutopilotState(store.files.get(STATE));
  const withQuestion = { ...current, status: "waiting-author", question: { id: "q1", kind: "director", question: "Which way?", context: "", options: [], askedAt: "2026-11-28T08:00:00.000Z" } };
  await store.commit([{ path: STATE, content: serializeAutopilotState(withQuestion), expectedHash: await (await store.read(STATE)).hash }], "question");
  const ai = createFakeAutopilotAi();
  const made = await run(store, ai, { design: { reviewOnly: { chapters: [2] } } });
  assert.deepEqual(names(ai), ["design_chapter_review"]);
  assert.equal(made.events.filter((event) => event.type === "run-ended").at(-1).code, "designReviewed");
  assert.equal(made.state.status, "waiting-author", "the question still waits");
  assert.equal(made.state.question?.id, "q1");
});

test("the planner asks nothing while a review on request has nothing left to judge", () => {
  const base = { startedAt: "x", chapters: 2, rounds: [] };
  assert.equal(nextDesignReview({ design: { ...base, reviewing: { startedAt: "x", chapters: [9] } } }, { files: new Map(), chapters: [], outline: { book: null, chapters: [] } }), null);
});

const finding = (extra = {}) => ({ id: "a-00000001", source: "ai", kind: "contradiction", severity: "major", chapters: [4], requires: [4], text: "Orrin is in two places.", owner: "autopilot", status: "open", round: 1, seen: 1, ...extra });
const withFindings = (...findings) => ({ concept: { done: true }, design: { startedAt: "x", chapters: 6, rounds: [], coherence: { sig: "0123abcd", round: 1, at: "t", summary: "", findings } } });
const AT = "2026-11-28T10:00:00.000Z";

test("the author decides about a finding: asks the autopilot to fix it, takes it herself, says it is not a problem, or takes the decision back", () => {
  assert.deepEqual([...FINDING_ACTIONS], ["fix", "mine", "dismiss", "reopen"]);
  const start = withFindings(finding({ id: "a-00000001" }), finding({ id: "a-00000002", owner: "both" }), finding({ id: "a-00000003", owner: "author" }));
  const by = (current, id) => current.design.coherence.findings.find((entry) => entry.id === id);
  const fix = decideFinding(start, { id: "a-00000001", action: "fix", reason: " Please. " }, AT);
  assert.deepEqual([by(fix, "a-00000001").status, by(fix, "a-00000001").decision], ["fixing", { by: "author", reason: "Please.", at: AT }]);
  assert.equal(by(start, "a-00000001").status, "open", "the state it was given is not changed");
  assert.equal(by(decideFinding(start, { id: "a-00000002", action: "fix" }, AT), "a-00000002").status, "fixing", "a fix that concerns both: the autopilot's part is rewritten");
  assert.deepEqual(by(decideFinding(start, { id: "a-00000003", action: "mine" }, AT), "a-00000003").decision, { by: "author", at: AT }, "no reason, none kept");
  assert.equal(by(decideFinding(start, { id: "a-00000001", action: "dismiss", reason: "It is the plan." }, AT), "a-00000001").status, "dismissed");
  const reopened = decideFinding(fix, { id: "a-00000001", action: "reopen" }, AT);
  assert.deepEqual([by(reopened, "a-00000001").status, by(reopened, "a-00000001").decision], ["open", undefined]);
  assert.equal(by(decideFinding(fix, { id: "a-00000001", action: "mine" }, AT), "a-00000001").status, "mine", "from one decision to another");
  assert.equal(by(decideFinding(start, { id: "a-00000001", action: "dismiss", reason: "x".repeat(700) }, AT), "a-00000001").decision.reason.length, 600);
  refused(() => decideFinding(start, { id: "a-00000003", action: "fix" }, AT), "not_fixable");
  refused(() => decideFinding(start, { id: "a-99999999", action: "fix" }, AT), "unknown_finding");
  refused(() => decideFinding(start, { id: 3, action: "fix" }, AT), "unknown_finding");
  refused(() => decideFinding(withFindings(finding({ status: "fixed" })), { id: "a-00000001", action: "mine" }, AT), "unknown_finding");
  refused(() => decideFinding(start, { id: "a-00000001", action: "delete" }, AT), "invalid_request");
  refused(() => decideFinding({ concept: { done: true } }, { id: "a-00000001", action: "mine" }, AT), "no_findings");
  refused(() => decideFinding(withFindings(), { id: "a-00000001", action: "mine" }, AT), "no_findings");
});

test("a decision about a finding is saved at once, never while the autopilot runs, and a finding the author asked to fix blocks the approval until the design run fixes it", async () => {
  const { store } = await designed();
  const made = makeSession(store, createFakeAutopilotAi());
  const [original] = made.state().design.coherence.findings;
  await assert.rejects(made.session.decideDesignFinding({ id: "a-99999999", action: "fix" }), (error) => error instanceof AutopilotDesignError && error.code === "unknown_finding");
  const saved = await made.session.decideDesignFinding({ id: original.id, action: "fix", reason: "Please fix it." });
  assert.equal(saved.design.coherence.findings[0].status, "fixing");
  assert.equal(made.state().design.coherence.findings[0].status, "fixing", "saved at once");
  // The author starts the design run: the finding is told to the director as asked for, blocks the approval though the director votes 9, and the chapters it revises are designed again.
  const ai = createFakeAutopilotAi({
    coherence: (call) => (call === 1 ? { findings: [FINDING], summary: "Still." } : { findings: [], summary: "Fixed." }),
    designReview: () => ({ verdict: "approve", score: 9, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x", findingDecisions: [] }),
  });
  const again = await run(store, ai, { design: { chapters: 6, review: { maxRounds: 3 } }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(again.state.design.outcome, "target", again.state.lastError?.message);
  assert.match(ai.calls.find((call) => call.json?.name === "design_review").user, /the author asked for it to be fixed\): The ferry runs on a closed day\. → Move it a day\./);
  assert.deepEqual(again.state.design.rounds.map((round) => [round.verdict, round.critical]), [["revise", 1], ["approve", 0]]);
  assert.match(ai.calls.filter((call) => call.json?.name === "chapter_design").at(-1).user, /- Critical — Chapter 5: The ferry runs on a closed day\. → Move it a day\./);
  assert.equal(again.state.design.coherence.findings[0].status, "fixed");
  // While a run goes on nothing is decided.
  const busy = makeSession(await describedBook(), createFakeAutopilotAi({ delayMs: 30 }));
  await busy.session.start({ design: { chapters: 4 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  await assert.rejects(busy.session.decideDesignFinding({ id: "a-00000001", action: "mine" }), /already running/);
  await busy.session.waitForIdle();
});
