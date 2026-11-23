import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

const { AiProviderError, AutopilotSession, askDirector, defaultDirector, parseMarkdown, serializeDirector } = engine;

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE_CHAPTER = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const WITH_READERS = (max = 1) => ({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, readers: true, maxReaders: max } });
const CHAPTER_OPINION = "evaluations/director/chapters/001-chapter-title-1.md";

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

/** The fake AI with some replies replaced: `script(request, seen)` returns undefined (default reply), an Error or a response. */
function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const seen = base.calls.filter((call) => call.label === request.label).length;
      const custom = script(request, seen);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

async function run(ai, start = ONE_CHAPTER, files = seedBookFiles({ chapters: 1 })) {
  const store = new MemoryBookStore(files);
  const emitted = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => emitted.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events: emitted, store, session };
}

const insights = (emitted, pattern) => emitted.filter((event) => event.type === "insight" && pattern.test(`${event.title} ${event.detail ?? ""}`));
const labelled = (ai, label) => ai.calls.filter((call) => call.label === label);
const withDirector = (overrides) => ({ ...seedBookFiles({ chapters: 1 }), "director.md": serializeDirector({ ...defaultDirector("en"), ...overrides }) });

/** A chapter review whose decisions cover every finding the request lists: `accept` the first one or reject them all. */
function review(request, fields, accept = false) {
  const ids = [...request.user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
  return reply({
    summary: "Judged.",
    strengths: [],
    decisions: ids.map((id, index) => ({ findingId: id, action: accept && index === 0 ? "accept" : "reject", rationale: "Because.", remediation: accept && index === 0 ? "Open with Mira already running." : "", sceneNumber: 1 })),
    extraFixes: [],
    guidance: [],
    ...fields,
  });
}

// ─── The score and the verdict ──────────────────────────────────────────────

test("scores are read on a 0-10 scale: 0-100 is divided by ten, anything else is limited, text must be numeric", () => {
  const { normalizeScore } = engine;
  assert.equal(typeof normalizeScore, "function");
  for (const [input, expected] of [[7, 7], [7.5, 7.5], [0, 0], [-2, 0], [10, 10], [85, 8.5], [100, 10], [101, 10], [1000, 10], [10.5, 1.05], ["8", 8], [" 9 ", 9], ["7,5", 7.5], ["85", 8.5], ["0", 0]]) {
    assert.equal(normalizeScore(input), expected, String(input));
  }
  for (const input of ["abc", "", "  ", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true, [], {}, "7/10"]) {
    assert.equal(normalizeScore(input), null, String(input));
  }
});

test("director verdicts are read whatever their case or spacing: Approved is approve, not revise", () => {
  const { parseDirectorVerdict } = engine;
  assert.equal(typeof parseDirectorVerdict, "function");
  for (const [input, expected] of [["approve", "approve"], ["Approved", "approve"], [" APPROVE ", "approve"], ["approved.", "approve"], ["Approvato", "approve"], ["revise", "revise"], ["Revise ", "revise"], ["revision", "revise"], ["da rivedere", "revise"], ["rewrite", "rewrite"], ["Rewrite", "rewrite"], ["riscrivere", "rewrite"]]) {
    assert.equal(parseDirectorVerdict(input), expected, input);
  }
  for (const input of ["maybe", "", "  ", null, undefined, 3, "disapprove"]) assert.equal(parseDirectorVerdict(input), null, String(input));
  const normalized = engine.normalizeDirectorOpinionOutput({ verdict: "Approved", score: "7,5", summary: "Great" });
  assert.equal(normalized.verdict, "approve", "the pure normalizer no longer turns Approved into revise");
  assert.equal(normalized.score, 7.5);
  assert.equal(engine.normalizeDirectorOpinionOutput({ verdict: "who knows", score: 4, summary: "x" }).verdict, "revise", "and still falls back for what it cannot read");
});

// ─── The chapter review ─────────────────────────────────────────────────────

test("an approve below the director's approval score is treated as revise: the accepted fixes are applied and the chapter is reviewed again", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:director-review:1" && seen === 0 ? review(request, { verdict: "approve", score: 5 }, true) : undefined);
  const { state, events: emitted, store } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(labelled(ai, "autopilot:repair:1.1").length, 1, "the accepted fix is applied: the 5/10 'approval' did not close the chapter");
  assert.equal(labelled(ai, "autopilot:director-review:1").length, 2, "and the chapter is judged again");
  const warning = insights(emitted, /approval score/i)[0];
  assert.ok(warning, "the reason is in the record");
  assert.match(warning.title, /5\/10/);
  assert.match(warning.title, /7\/10/);
  assert.equal(warning.tone, "warning");
  const history = parseMarkdown(store.files.get(CHAPTER_OPINION));
  assert.equal(history.frontmatter.verdict, "approve", "the last round (8/10) approved it");
  assert.equal(state.plan.chapters[0].score, 8);
});

test("an approve below the score with no applicable fix closes the chapter as it is, and says why", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:director-review:1" && seen === 0 ? review(request, { verdict: "approve", score: 5 }) : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(labelled(ai, "autopilot:repair:1.1").length, 0);
  assert.equal(labelled(ai, "autopilot:director-review:1").length, 1);
  const warning = insights(emitted, /approval score/i)[0];
  assert.ok(warning);
  assert.match(warning.title, /5\/10/);
  assert.match(warning.title, /7\/10/);
  assert.match(warning.title, /as it is|no applicable fix/i);
  assert.equal(insights(emitted, /without any applicable fix/i).length, 0, "one message, not two");
});

test("the threshold is the profile's own approval score", async () => {
  const lenient = scripted((request) => request.label === "autopilot:director-review:1" ? review(request, { verdict: "approve", score: 5 }) : undefined);
  const easy = await run(lenient, ONE_CHAPTER, withDirector({ approvalScore: 4 }));
  assert.equal(labelled(lenient, "autopilot:director-review:1").length, 1, "5 is enough for a director who wants 4");
  assert.equal(insights(easy.events, /approval score/i).length, 0);
  assert.equal(easy.state.plan.chapters[0].score, 5);

  const strict = scripted((request) => request.label === "autopilot:director-review:1" ? review(request, { verdict: "approve", score: 8 }) : undefined);
  const hard = await run(strict, ONE_CHAPTER, withDirector({ approvalScore: 9 }));
  assert.equal(hard.state.status, "completed");
  assert.ok(insights(hard.events, /approval score/i).some((event) => /8\/10/.test(event.title) && /9\/10/.test(event.title)));

  const exact = scripted((request) => request.label === "autopilot:director-review:1" ? review(request, { verdict: "approve", score: 7 }, true) : undefined);
  const boundary = await run(exact);
  assert.equal(labelled(exact, "autopilot:director-review:1").length, 1, "a score equal to the approval score approves: its fixes are applied and the chapter closes");
  assert.equal(labelled(exact, "autopilot:repair:1.1").length, 1);
  assert.equal(insights(boundary.events, /approval score/i).length, 0);
});

test("a revise stays a revise whatever the score", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:director-review:1" && seen === 0 ? review(request, { verdict: "revise", score: 9 }, true) : undefined);
  const { state } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(labelled(ai, "autopilot:repair:1.1").length, 1);
});

test("a chapter review without a usable score is rejected and retried once with the reason, never given a default", async () => {
  for (const [score, pattern] of [[undefined, /"score" is missing/], ["high", /"score" is not a number/], [null, /"score" is missing/], ["", /"score" is missing/]]) {
    const ai = scripted((request, seen) => request.label === "autopilot:director-review:1" && seen === 0 ? review(request, { verdict: "approve", score }) : undefined, { reviewVerdict: () => "approve" });
    const { state, events: emitted } = await run(ai);
    assert.equal(state.status, "completed", String(score));
    const reviews = labelled(ai, "autopilot:director-review:1");
    assert.equal(reviews.length, 2, String(score));
    assert.match(reviews[1].user, /previous reply to this request was rejected because:.*director's chapter review was rejected/s, String(score));
    assert.match(reviews[1].user, pattern, String(score));
    assert.ok(emitted.some((event) => event.code === "failureRetry"));
  }
  const never = scripted((request) => request.label === "autopilot:director-review:1" ? review(request, { verdict: "approve", score: undefined }) : undefined);
  const { state } = await run(never);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /"score" is missing/);
  assert.equal(state.lastError.task, "director-review");
  assert.notEqual(state.plan.chapters[0].status, "done");
});

test("scores out of 100 are scaled and the record shows the real value", async () => {
  for (const [given, shown] of [[85, 8.5], ["7,5", 7.5], [250, 10]]) {
    const ai = scripted((request) => request.label === "autopilot:director-review:1" ? review(request, { verdict: "approve", score: given }) : undefined);
    const { state, store } = await run(ai);
    assert.equal(state.plan.chapters[0].score, shown, String(given));
    assert.equal(parseMarkdown(store.files.get(CHAPTER_OPINION)).frontmatter.score, shown, String(given));
  }
});

test("verdict variants in a chapter review are read, an unknown one is rejected", async () => {
  const approved = scripted((request) => request.label === "autopilot:director-review:1" ? review(request, { verdict: " Approved. ", score: 8 }) : undefined);
  const first = await run(approved);
  assert.equal(first.state.status, "completed");
  assert.equal(labelled(approved, "autopilot:director-review:1").length, 1);

  const nonsense = scripted((request) => request.label === "autopilot:director-review:1" ? review(request, { verdict: "maybe", score: 8 }) : undefined);
  const second = await run(nonsense);
  assert.equal(second.state.status, "error");
  assert.match(second.state.lastError.message, /"verdict" must be "approve" or "revise"/);
});

// ─── The plan review ────────────────────────────────────────────────────────

const planReview = (fields) => reply({ summary: "Judged.", strengths: [], changes: [], guidance: [], ...fields });

test("a plan approved below the approval score is revised when the director asked for changes", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:plan-review" && seen === 0
    ? planReview({ verdict: "approve", score: 5, changes: [{ chapterNumber: 1, instruction: "Raise the stakes." }] })
    : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(labelled(ai, "autopilot:plan").length, 2, "the plan was written again");
  assert.match(labelled(ai, "autopilot:plan")[1].user, /Raise the stakes\./);
  assert.equal(state.plan.rounds, 1);
  assert.ok(insights(emitted, /approval score/i).some((event) => /5\/10/.test(event.title)));
});

test("a plan approved below the score with no change to make is approved as it is, with the reason", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:plan-review" && seen === 0 ? planReview({ verdict: "approve", score: 5 }) : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(labelled(ai, "autopilot:plan").length, 1);
  assert.equal(state.plan.approved, true);
  assert.ok(insights(emitted, /approval score/i).length >= 1);
});

test("a plan review without a score is rejected and retried; verdict variants and 0-100 scores are read", async () => {
  const missing = scripted((request, seen) => request.label === "autopilot:plan-review" && seen === 0 ? planReview({ verdict: "approve" }) : undefined);
  const first = await run(missing);
  assert.equal(first.state.status, "completed");
  assert.equal(labelled(missing, "autopilot:plan-review").length, 2);
  assert.match(labelled(missing, "autopilot:plan-review")[1].user, /"score" is missing/);

  const variants = scripted((request) => request.label === "autopilot:plan-review" ? planReview({ verdict: " APPROVED ", score: 85 }) : undefined);
  const second = await run(variants);
  assert.equal(second.state.status, "completed");
  assert.equal(labelled(variants, "autopilot:plan-review").length, 1);
  assert.ok(second.events.some((event) => event.type === "insight" && /Plan approved by the director \(9\/10\)/.test(event.title)), "85/100 is 8.5, shown rounded like every plan score");
});

// ─── The director on demand and the final review ────────────────────────────

const opinionAi = (json) => ({ calls: [], async complete() { return reply(json); } });
const ask = (json, files = seedBookFiles({ chapters: 1 }), target = { kind: "book" }) => askDirector({ store: new MemoryBookStore(files), ai: opinionAi(json), target });
const BASE = { summary: "A view.", strengths: [], concerns: [], decisions: [], nextSteps: [] };

test("the director's opinion approves only at the approval score, and reads verdicts and scores like the autopilot", async () => {
  const approved = await ask({ ...BASE, verdict: "Approved", score: 8 });
  assert.equal(approved.opinion.verdict, "approve", "Approved is not revise");
  assert.equal(approved.opinion.score, 8);
  assert.equal((await ask({ ...BASE, verdict: " APPROVE ", score: "8" })).opinion.verdict, "approve");

  const low = await ask({ ...BASE, verdict: "approve", score: 5 });
  assert.equal(low.opinion.verdict, "revise");
  assert.match(low.opinion.decisions[0], /approval score/i);
  assert.match(low.opinion.decisions[0], /5\/10/);
  assert.match(low.opinion.decisions[0], /7\/10/);

  assert.equal((await ask({ ...BASE, verdict: "approve", score: 5 }, withDirector({ approvalScore: 4 }))).opinion.verdict, "approve");
  assert.equal((await ask({ ...BASE, verdict: "approve", score: 7 })).opinion.verdict, "approve", "equal to the approval score");
  assert.equal((await ask({ ...BASE, verdict: "rewrite", score: 3 })).opinion.verdict, "rewrite");
  assert.equal((await ask({ ...BASE, verdict: "revise", score: 9 })).opinion.verdict, "revise");
  assert.equal((await ask({ ...BASE, verdict: "approve", score: 85 })).opinion.score, 8.5);
  assert.equal((await ask({ ...BASE, verdict: "approve", score: "7,5" })).opinion.score, 7.5);
});

test("the director's opinion is never made of a missing score or an unknown verdict", async () => {
  for (const [json, pattern] of [
    [{ ...BASE, verdict: "approve" }, /"score" is missing/],
    [{ ...BASE, verdict: "approve", score: "great" }, /"score" is not a number/],
    [{ ...BASE, score: 8 }, /"verdict" is missing/],
    [{ ...BASE, verdict: "maybe", score: 8 }, /"verdict" must be one of "approve", "revise" or "rewrite"/],
  ]) {
    const error = await ask(json).then(() => null, (failure) => failure);
    assert.ok(error instanceof engine.AiReplyRejectedError, JSON.stringify(json));
    assert.match(error.message, pattern);
  }
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  await assert.rejects(askDirector({ store, ai: opinionAi({ ...BASE, verdict: "approve" }), target: { kind: "book" }, save: true }), /"score"/);
  assert.ok(!store.files.has("evaluations/director/book.md"), "nothing was saved");
});

test("the reason for a withheld approval is written in the book's language", async () => {
  const italian = await ask({ ...BASE, verdict: "approve", score: 5 }, seedBookFiles({ chapters: 1, language: "it" }));
  assert.equal(italian.opinion.verdict, "revise");
  assert.match(italian.opinion.decisions[0], /punteggio di approvazione/i);
});

test("the final review of the whole book applies the same rule", async () => {
  const ai = scripted((request) => request.json?.name === "director_opinion" ? reply({ ...BASE, verdict: "approve", score: 5 }) : undefined, { reviewVerdict: () => "approve" });
  const { state, store, events: emitted } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(state.finalDone, true);
  const opinion = parseMarkdown(store.files.get("evaluations/director/book.md"));
  assert.equal(opinion.frontmatter.verdict, "revise");
  assert.equal(opinion.frontmatter.score, 5);
  assert.ok(emitted.some((event) => event.type === "insight" && /Director's final judgement: 5\/10/.test(event.title) && event.tone === "warning"));
});

// ─── The simulated readers ──────────────────────────────────────────────────

const isReader = (request) => request.json?.name === "reader_evaluation";
const FULL = { generalImpression: "Engaging.", strengths: ["Atmosphere"], weaknesses: ["Pacing"], mostEffectiveMoment: "The confrontation.", mainProblem: "The middle drags.", prioritySuggestion: "Tighten the middle.", score: 7 };
const readerFiles = (store) => [...store.files.keys()].filter((path) => path.startsWith("evaluations/readers/chapters/"));

test("a reader whose reply stays incomplete after the retry is skipped, and the chapter goes on without readers when none answered", async () => {
  for (const incomplete of [{ generalImpression: "Fine." }, { score: 3 }, { score: 3, generalImpression: "  " }, { generalImpression: "Fine.", score: "n/a" }]) {
    const ai = scripted((request) => isReader(request) ? reply(incomplete) : undefined, { reviewVerdict: () => "approve" });
    const { state, events: emitted, store } = await run(ai, WITH_READERS(1));
    assert.equal(state.status, "completed", `${JSON.stringify(incomplete)}: ${state.lastError?.message}`);
    const readers = ai.calls.filter(isReader);
    assert.equal(readers.length, 2, "the first reply and its retry");
    assert.match(readers[1].user, /previous reply to this request was rejected because/);
    assert.ok(insights(emitted, /skipped/i).length >= 1, "the skip is reported");
    assert.match(insights(emitted, /skipped/i)[0].title, /General Reader/);
    assert.equal(insights(emitted, /skipped/i)[0].tone, "warning");
    assert.ok(insights(emitted, /no simulated reader answered/i).length === 1, "and so is the absence of any reader");
    assert.equal(readerFiles(store).length, 0, "no evaluation was saved for a reply that was not one");
    assert.equal(ai.calls.filter((call) => call.label === "reader-evaluation-summary").length, 0, "no panel summary of nothing");
    assert.equal(state.plan.chapters[0].status, "done");
    assert.equal(state.stats.failures, 0);
  }
});

test("a reader that answers on the retry is not skipped", async () => {
  const ai = scripted((request, seen) => isReader(request) ? reply(seen === 0 ? { score: 4 } : FULL) : undefined, { reviewVerdict: () => "approve" });
  const { state, events: emitted, store } = await run(ai, WITH_READERS(1));
  assert.equal(state.status, "completed");
  assert.equal(insights(emitted, /skipped/i).length, 0);
  assert.equal(readerFiles(store).length, 1);
  assert.equal(parseMarkdown(store.files.get(readerFiles(store)[0])).frontmatter.score, 7);
});

test("the review goes on with the readers who answered", async () => {
  const ai = scripted((request) => request.label === "reader-evaluation:standard-emotional" ? reply({ generalImpression: "Moving." }) : undefined, { reviewVerdict: () => "approve" });
  const { state, events: emitted, store } = await run(ai, WITH_READERS(2));
  assert.equal(state.status, "completed");
  assert.deepEqual(readerFiles(store), ["evaluations/readers/chapters/001-chapter-title-1/standard-general.md"]);
  assert.equal(insights(emitted, /skipped/i).length, 1);
  assert.match(insights(emitted, /skipped/i)[0].title, /Emotional Reader/);
  assert.equal(insights(emitted, /no simulated reader answered/i).length, 0, "one reader did answer");
  assert.equal(ai.calls.filter((call) => call.label === "reader-evaluation-summary").length, 1);
  const summary = parseMarkdown(store.files.get("evaluations/readers/summaries/chapters/001-chapter-title-1.md"));
  assert.equal(summary.frontmatter.readerCount, 1);
  const director = ai.calls.find((call) => call.label === "autopilot:director-review:1");
  assert.match(director.user, /General Reader/);
  assert.doesNotMatch(director.user, /Emotional Reader \(weight/);
});

test("a reader's score out of 100 is scaled to 0-10", async () => {
  const ai = scripted((request) => isReader(request) ? reply({ ...FULL, score: 85 }) : undefined, { reviewVerdict: () => "approve" });
  const { store } = await run(ai, WITH_READERS(1));
  assert.equal(parseMarkdown(store.files.get(readerFiles(store)[0])).frontmatter.score, 8.5);
});

test("a reader that cannot be reached is not 'skipped': the run still stops on a failing provider", async () => {
  const ai = scripted((request) => isReader(request) ? new AiProviderError("HTTP 503 — overloaded", 503, true, { transient: true }) : undefined);
  const { state } = await run(ai, WITH_READERS(1));
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /503/);
});

const PLAN_READERS = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, readersOnPlan: true, maxReaders: 1 } };
const isPlanReader = (request) => request.json?.name === "plan_reaction";

test("a reader of the plan whose reply stays incomplete is skipped too, and the plan review goes on", async () => {
  for (const incomplete of [{ reaction: "I would read it." }, { interest: 7 }, { interest: 7, reaction: "" }]) {
    const ai = scripted((request) => isPlanReader(request) ? reply(incomplete) : undefined);
    const { state, events: emitted } = await run(ai, PLAN_READERS);
    assert.equal(state.status, "completed", `${JSON.stringify(incomplete)}: ${state.lastError?.message}`);
    assert.equal(ai.calls.filter(isPlanReader).length, 2, "tried and retried, not asked again and again");
    assert.deepEqual(state.plan.skippedReaders, ["standard-general"]);
    assert.deepEqual(state.plan.readerReactions, []);
    assert.ok(insights(emitted, /skipped/i).length >= 1);
    assert.equal(labelled(ai, "autopilot:plan-review").length, 1);
  }
  const full = scripted((request) => isPlanReader(request) ? reply({ interest: 85, reaction: "I would read it.", concerns: [], wishes: [] }) : undefined);
  const answered = await run(full, PLAN_READERS);
  assert.equal(answered.state.plan.readerReactions[0].interest, 9, "85 of 100 is 8.5, rounded like every plan interest");
  assert.equal(answered.state.plan.skippedReaders, undefined);
});

test("the skipped readers of a plan survive a revision of the plan and a reload of the state", async () => {
  const ai = scripted((request, seen) => {
    if (isPlanReader(request)) return reply({ reaction: "Hmm." });
    if (request.label === "autopilot:plan-review" && seen === 0) return planReview({ verdict: "revise", score: 5, changes: [{ chapterNumber: 1, instruction: "Raise the stakes." }] });
    return undefined;
  });
  const { state, store } = await run(ai, PLAN_READERS);
  assert.equal(state.status, "completed");
  assert.equal(ai.calls.filter(isPlanReader).length, 2, "the revised plan is not shown to the skipped reader again");
  assert.deepEqual(state.plan.skippedReaders, ["standard-general"]);
  assert.deepEqual(engine.parseAutopilotState(store.files.get("autopilot/state.json")).plan.skippedReaders, ["standard-general"]);
});

test("the messages about skipped readers and withheld approvals are written in the book's language", async () => {
  const files = seedBookFiles({ chapters: 1, language: "it" });
  const ai = scripted((request, seen) => {
    if (isReader(request)) return reply({ generalImpression: "Bene." });
    if (request.label === "autopilot:director-review:1" && seen === 0) return review(request, { verdict: "approve", score: 5 });
    return undefined;
  }, { reviewVerdict: () => "approve" });
  const { state, events: emitted, store } = await run(ai, WITH_READERS(1), files);
  assert.equal(state.status, "completed");
  assert.ok(insights(emitted, /saltato: la risposta è rimasta incompleta/).length === 1);
  assert.ok(insights(emitted, /Nessun lettore simulato ha risposto/).length === 1);
  const withheld = insights(emitted, /punteggio di approvazione/)[0];
  assert.match(withheld.title, /Il direttore ha approvato con 5\/10, sotto il punteggio di approvazione \(7\/10\)/);
  assert.match(store.files.get(CHAPTER_OPINION), /L'approvazione è sospesa|sotto il punteggio di approvazione/);
});
