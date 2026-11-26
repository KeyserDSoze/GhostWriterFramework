import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The design run of the autopilot (`StartOptions.design`): from the description of a book, the concept, the design of every chapter in the Synopsis, the ledger of
// the secrets and the world, reviewed by the readers and the director under the design's policy, and a stop when the director approves it. No prose, ever: the
// writing autopilot begins only when the author starts it.

const { AutopilotSession, AutopilotDesignError, designPlateau, normalizeDesignStart, estimateAutopilotRun, parseAutopilotState, readOutlineChapter, readSecretLedger, parseMarkdown, writeOutlineBrief, serializeOutlineChapter, normalizeAutopilotState, serializeAutopilotState } = engine;

const STATE = "autopilot/state.json";
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-26T09:00:00.000Z");
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);
const ended = (events) => events.filter((event) => event.type === "run-ended").at(-1);
const PROSE = /^chapters\/[^/]+\/(?!chapter\.md$)[^/]+\.md$/;

async function describedBook(extra = {}) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }), ...extra });
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

function session(store, ai) {
  const events = [];
  const created = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  created.subscribe((event) => events.push(event));
  return { session: created, events };
}

async function run(store, ai, start) {
  const made = session(store, ai);
  await made.session.start(start);
  await made.session.waitForIdle();
  return { ...made, state: stateOf(store) };
}

/** The fake AI with a director whose reviews of the design follow a script (the last repeated), and the requests of each step kept. */
function scriptedAi(reviews = [], options = {}) {
  const asked = [];
  const ai = createFakeAutopilotAi({
    ...options,
    designReview: (round, user) => {
      asked.push({ round, user });
      return reviews[Math.min(round - 1, reviews.length - 1)] ?? { verdict: "approve", score: 8, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "Something else." };
    },
  });
  return { ai, asked };
}

const labels = (ai) => ai.calls.map((call) => call.label.replace(/:[^:]*$/, (tail) => (/^:\d+$/.test(tail) || /^:[a-z-]+$/.test(tail) ? tail : "")));

test("a book with only a description is designed: entries with their design, the world, the secrets with their ledger and reveal, the run stops at the director's approval, and no prose is written", async () => {
  const store = await describedBook();
  const { ai } = scriptedAi();
  const { state, events } = await run(store, ai, { design: { chapters: 8 }, options: { readersOnPlan: true, maxReaders: 2, pauseAfterPlan: false } });
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(ended(events).code, "designReady");
  assert.equal(state.message, "The design of the book is ready: 8 chapters. Approve it, or start the autopilot to write.");
  assert.equal(state.design.outcome, "target");
  assert.equal(state.design.chapters, 8);
  assert.deepEqual(state.design.rounds.map((round) => [round.round, round.score, round.verdict, round.readers]), [[1, 8, "approve", 7]]);
  assert.equal(state.plan.approved, true);
  assert.equal(state.plan.awaitingAuthor, true);
  assert.equal(state.options.pauseAfterPlan, false, "the author's setting is given back when the design ends");
  // The steps of a design, and none of a run that writes.
  const kinds = ai.calls.map((call) => call.json?.name ?? "prose");
  assert.deepEqual(kinds, ["design_concept", "chapter_design", "chapter_design", "design_reaction", "design_reaction", "design_review"]);
  assert.match(ai.calls[1].user, /numbered 1 to 6/);
  assert.match(ai.calls[2].user, /numbered 7 to 8/);
  const files = [...store.files.keys()];
  assert.deepEqual(files.filter((path) => PROSE.test(path)), [], "no scene is written");
  assert.equal(files.filter((path) => /^chapters\/[^/]+\/chapter\.md$/.test(path)).length, 8, "the approval makes the folders of the chapters, as a plan's does");
  // The Synopsis: every entry the autopilot's, with its design.
  for (let number = 1; number <= 8; number += 1) {
    const path = `outline/chapters/00${number}.md`;
    const { entry } = await readOutlineChapter(path, number, store.files.get(path));
    assert.equal(entry.intact, true, path);
    assert.equal(entry.title, `Chapter Title ${number}`);
    assert.equal(entry.body, `Summary of chapter ${number}.`, "the events are in the design, not repeated in the text");
    assert.equal(entry.design.goal, `Goal of chapter ${number}.`);
    assert.deepEqual(entry.design.scenes, [`Scene A of chapter ${number}`, `Scene B of chapter ${number}`]);
  }
  // The world and the secrets.
  assert.match(store.files.get("bible/themes.md"), /themes:\n  - truth\n  - inheritance\ntone: Melancholic, tense/);
  assert.match(store.files.get("bible/world.md"), /rules:\n  - Glass is the only trade that matters/);
  assert.match(store.files.get("items/the-tide-ledger.md"), /significance: It proves the lie\./);
  assert.match(store.files.get("characters/mira-vale.md"), /relationships:\n  - "Orrin Hale: her late father's partner, whom she distrusts"/);
  const secret = parseMarkdown(store.files.get("secrets/the-wall-is-failing.md")).frontmatter;
  assert.equal(secret.reveal_in, "chapter:002-chapter-title-2");
  const { ledger } = readSecretLedger(secret);
  assert.deepEqual(ledger.clues, [{ chapter: 1, note: "Salt water in the cellar." }]);
  assert.deepEqual(ledger.learnedBy, [{ character: "character:mira-vale", chapter: 2 }]);
  assert.deepEqual(ledger.consequences, ["The town turns on the council"]);
  // What the run said.
  const ready = insights(events, "designReady");
  assert.equal(ready.length, 1);
  assert.equal(ready[0].figures.designOutcome, "target");
  assert.equal(ready[0].figures.chapters, 8);
  assert.equal(insights(events, "designChecks").length, 0, "the fake's design holds together");
  assert.equal(state.design.ledgers["secrets/the-wall-is-failing.md"].length, 16);
  // The reader of a design must contest it; the director plays devil's advocate.
  assert.match(ai.calls[3].system, /you must make at least one concrete counter-proposal/);
  assert.match(ai.calls[5].user, /Play devil's advocate before you decide/);
  assert.match(ai.calls[5].user, /DESIGN CHECKS \(found without a model\): nothing\./);
  assert.equal(state.plan.readerReactions[0].wishes.at(-1), "Counter-proposal: Open on the flood that has not happened yet.");
});

test("the design's policy: an approval under the target is a revision, the batches of the chapters it names are designed again, the readers read again in the rounds it says", async () => {
  const store = await describedBook();
  const { ai, asked } = scriptedAi([
    { verdict: "approve", score: 8, summary: "Close.", strengths: [], changes: [{ chapterNumber: 2, instruction: "Make the reveal cost Mira something." }], guidance: [], critical: [], counterProposal: "x" },
    { verdict: "approve", score: 9, summary: "Now.", strengths: [], changes: [], guidance: ["Keep the cost personal."], critical: [], counterProposal: "y" },
  ]);
  const { state, events } = await run(store, ai, { design: { chapters: 8, review: { targetScore: 8.5, maxRounds: 4, readerRounds: 2 } }, options: { readersOnPlan: true, maxReaders: 2, pauseAfterPlan: false } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.deepEqual(state.design.rounds.map((round) => [round.score, round.verdict]), [[8, "revise"], [9, "approve"]]);
  assert.deepEqual(state.design.review, { targetScore: 8.5, maxRounds: 4, readerRounds: 2 });
  assert.match(asked[0].user, /review 1 of at most 4/);
  assert.match(asked[0].user, /deserves 8\.5\/10 or more/);
  const kinds = ai.calls.map((call) => call.json?.name);
  assert.equal(kinds.filter((kind) => kind === "chapter_design").length, 3, "two batches, then only the batch of chapter 2 again");
  assert.match(ai.calls.filter((call) => call.json?.name === "chapter_design")[2].user, /Revise the design of chapters 1-6 applying the director's changes:\n- Chapter 2: Make the reveal cost Mira something\./);
  assert.equal(kinds.filter((kind) => kind === "design_reaction").length, 4, "two readers before each of the first two reviews");
  const round = insights(events, "designRound");
  assert.equal(round.length, 1);
  assert.deepEqual(round[0].figures, { round: 1, rounds: 4, score: 8, target: 8.5, critical: 0, findings: 0 });
  assert.ok(state.directorNotes.includes("Keep the cost personal."));
});

test("a critical inconsistency is never approved by a score: it sends the design back, is asked to the author after the last round, once, and then the design ends with it as guidance", async () => {
  const store = await describedBook();
  const critical = { verdict: "approve", score: 9, summary: "Good but broken.", strengths: [], changes: [], guidance: [], critical: [{ chapterNumber: 3, issue: "Orrin cannot know the wall cracked before chapter 5." }], counterProposal: "z" };
  const { ai } = scriptedAi([critical]);
  const first = await run(store, ai, { design: { chapters: 6, review: { maxRounds: 2 } }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(first.state.status, "waiting-author", first.state.lastError?.message);
  assert.equal(first.state.plan.approved, false);
  assert.equal(first.state.design.escalated, true);
  assert.equal(first.state.question.kind, "director");
  assert.match(first.state.question.question, /The design has a critical inconsistency the director could not resolve in the rounds allowed/);
  assert.equal(first.state.question.context, "Critical — Chapter 3: Orrin cannot know the wall cracked before chapter 5.");
  assert.deepEqual(first.state.question.options, ["Fix them as you see best", "Keep the design as it is: the writing will take them into account"]);
  assert.deepEqual(first.state.design.rounds.map((round) => [round.verdict, round.critical]), [["revise", 1], ["revise", 1]]);
  assert.equal(insights(first.events, "designEscalated").length, 1);
  // The author answers, and starts the run again: the design is made again with the answer, and the next review ends it, with the inconsistency as guidance.
  const second = session(store, ai);
  await second.session.answer({ questionId: first.state.question.id, answer: "Let Orrin learn it in chapter 2.", accept: false });
  await second.session.start({});
  await second.session.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.design.outcome, "rounds");
  assert.equal(state.plan.approved, true);
  const designs = ai.calls.filter((call) => call.json?.name === "chapter_design");
  assert.match(designs.at(-1).user, /Let Orrin learn it in chapter 2\./, "the answer reaches the design");
  assert.ok(state.directorNotes.some((note) => note.includes("Orrin cannot know the wall cracked")), "what is left becomes guidance for the writing");
  assert.equal(insights(second.events, "designReady")[0].tone, "warning");
  assert.equal(ai.calls.filter((call) => call.json?.name === "scene_plan").length, 0);
});

test("a plateau ends the design: two reviews in a row that do not raise its vote", async () => {
  const store = await describedBook();
  const revise = (score) => ({ verdict: "revise", score, summary: "More.", strengths: [], changes: [{ chapterNumber: 1, instruction: `Push harder (${score}).` }], guidance: [], critical: [], counterProposal: "c" });
  const { ai } = scriptedAi([revise(7), revise(6.5), revise(6.8), revise(9)]);
  const { state, events } = await run(store, ai, { design: { chapters: 4, review: { maxRounds: 8 } }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.design.outcome, "plateau", state.lastError?.message);
  assert.deepEqual(state.design.rounds.map((round) => round.score), [7, 6.5, 6.8]);
  assert.match(insights(events, "designReady")[0].title, /the rounds stopped improving it/);
});

test("the money cap stops a design like any run, a start after it goes on with the design, and a design resumed after a restart never writes", async () => {
  const store = await describedBook();
  const { ai } = scriptedAi();
  // Every structured call of the fake costs 0.001: the cap stops the design after its second call.
  const capped = await run(store, ai, { design: { chapters: 8 }, options: { readersOnPlan: false, pauseAfterPlan: false, budgetLimit: 0.002 } });
  assert.equal(capped.state.status, "paused");
  assert.equal(capped.state.limitReached.kind, "money");
  assert.equal(capped.state.design.endedAt, undefined, "the design goes on");
  assert.equal(capped.state.options.pauseAfterPlan, true, "an engine that does not know designs would stop at the plan");
  // The state of a design survives a reading by the engine as it is.
  assert.deepEqual(normalizeAutopilotState(JSON.parse(serializeAutopilotState(capped.state))).design, capped.state.design);
  // A new session, as after a restart, raises the cap and starts with nothing said of the design: it goes on, and stops when the design is ready.
  const { ai: later } = scriptedAi();
  const resumed = await run(store, later, { options: { budgetLimit: 0 }, afterRestart: true });
  assert.equal(resumed.state.design.outcome, "target", resumed.state.lastError?.message);
  assert.equal(ended(resumed.events).code, "designReady");
  assert.equal(later.calls.filter((call) => !["chapter_design", "design_review"].includes(call.json?.name)).length, 0, "the concept was done: only the design of the chapters and its review");
  assert.deepEqual([...store.files.keys()].filter((path) => PROSE.test(path)), []);
});

test("once the design is ready a start writes the book; a design is refused once chapters are written, and for a book with no description", async () => {
  const store = await describedBook();
  const { ai } = scriptedAi();
  await run(store, ai, { design: { chapters: 2 }, options: { readersOnPlan: false, pauseAfterPlan: false, readers: false, specialists: false } });
  const writing = await run(store, ai, { limits: { chapters: 1 } });
  assert.notEqual(writing.state.status, "error", writing.state.lastError?.message);
  assert.ok([...store.files.keys()].some((path) => PROSE.test(path)), "the writing autopilot writes");
  assert.equal(writing.state.design.outcome, "target", "the design is kept for what it says");
  await assert.rejects(run(store, ai, { design: true }), (error) => error instanceof AutopilotDesignError && error.code === "design_written" && /already written chapter 1/.test(error.message));
  const bare = new MemoryBookStore(seedBookFiles({ chapters: 0 }));
  await assert.rejects(run(bare, ai, { design: { chapters: 3 } }), (error) => error instanceof AutopilotDesignError && error.code === "design_no_description");
  assert.equal(bare.files.has(STATE), false, "nothing is written");
});

test("`design: false` ends a design that goes on, and the run goes on as a run that writes", async () => {
  const store = await describedBook();
  const { ai } = scriptedAi();
  const first = await run(store, ai, { design: { chapters: 3 }, options: { readersOnPlan: false, pauseAfterPlan: false }, limits: { steps: 1 } });
  assert.equal(first.state.design.endedAt, undefined);
  const second = await run(store, ai, { design: false, limits: { steps: 3 } });
  assert.equal(second.state.design.outcome, "author");
  assert.equal(second.state.options.pauseAfterPlan, false, "the author's setting is back");
  assert.ok(ai.calls.some((call) => call.json?.name === "chapter_plan"), "the plan of a run that writes");
});

test("the author's entries and the author's ledgers bind the design: they are never rewritten, and the author is told", async () => {
  const mine = serializeOutlineChapter({ number: 2, title: "My Storm", body: "The storm breaks the wall, as I want it.", origin: "author" });
  const store = await describedBook({ "outline/chapters/002.md": mine });
  const { ai } = scriptedAi();
  // The concept, then a pause: the author rewrites the ledger of the secret it made.
  await run(store, ai, { design: { chapters: 4 }, options: { readersOnPlan: false, pauseAfterPlan: false }, limits: { steps: 1 } });
  const path = "secrets/the-wall-is-failing.md";
  const document = parseMarkdown(store.files.get(path));
  const edited = engine.renderMarkdown({ ...document.frontmatter, clues: [{ chapter: 1, note: "The author's own clue." }] }, document.body);
  await store.commit([{ path, content: edited, expectedHash: (await store.read(path)).hash }], "author");
  const { state, events } = await run(store, ai, {});
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.equal(store.files.get("outline/chapters/002.md"), mine, "the author's entry is as the author wrote it");
  const ledger = readSecretLedger(parseMarkdown(store.files.get(path)).frontmatter).ledger;
  assert.deepEqual(ledger.clues, [{ chapter: 1, note: "The author's own clue." }], "the author's ledger is kept");
  const told = insights(events, "designAuthorEntries").map((event) => event.title);
  assert.ok(told.includes("The entry 2 of the Synopsis is yours: the design follows it and does not rewrite it"), told.join("\n"));
  assert.ok(told.includes("The ledger of «The Wall Is Failing» is yours: the design does not rewrite it"), told.join("\n"));
  assert.match(ai.calls.find((call) => call.json?.name === "chapter_design").user, /AUTHOR'S OUTLINE, CHAPTERS 1-4 \(binding\):[\s\S]*My Storm/);
});

test("the checks of the design reach the director and the author: what does not hold together is a finding, never a blocker", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({});
  const base = ai.complete.bind(ai);
  // A design whose reveal has no clue before it and names a stranger.
  ai.complete = async (request) => {
    const answer = await base(request);
    if (request.json?.name !== "chapter_design") return answer;
    const json = structuredClone(answer.json);
    for (const chapter of json.chapters) chapter.design.characters.push("Tobias Grey");
    for (const secret of json.secrets) secret.clues = [];
    return { ...answer, json, text: JSON.stringify(json) };
  };
  const made = session(store, ai);
  await made.session.start({ design: { chapters: 2 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  await made.session.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  const checks = insights(made.events, "designChecks");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].tone, "info");
  assert.match(checks[0].detail, /The secret «The Wall Is Failing» is revealed in chapter 2 with no clue before it/);
  assert.match(checks[0].detail, /Chapter 1 names «Tobias Grey», who is not among the characters of the canon\./);
  const review = ai.calls.find((call) => call.json?.name === "design_review");
  assert.match(review.user, /DESIGN CHECKS \(found without a model\):\n- The secret «The Wall Is Failing» is revealed in chapter 2 with no clue before it/);
  assert.equal(state.design.rounds[0].findings, 3);
});

test("the estimate of a design: the concept, the batches of the design and its reviews, the readers' readings, and nothing written", () => {
  const model = { model: "m", maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 4 }, tokensPerSecond: 20 };
  const models = Object.fromEntries(["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"].map((capability) => [capability, model]));
  const design = estimateAutopilotRun({ design: { maxRounds: 3, readerRounds: 2 }, outline: { lastChapter: 12 }, options: { readersOnPlan: true, maxReaders: 2 }, models });
  assert.equal(design.chaptersToWrite, 0);
  assert.equal(design.words, 0);
  assert.deepEqual(design.steps.concept.calls, { min: 1, max: 1 });
  assert.deepEqual(design.steps.plan.calls, { min: 2, max: 6 }, "two batches of six, designed again in each of the two revisions");
  assert.deepEqual(design.steps["plan-review"].calls, { min: 1, max: 3 });
  assert.deepEqual(design.steps["plan-reader"].calls, { min: 2, max: 4 }, "two readers, before the first two reviews at most");
  for (const kind of ["scenes", "write", "reader", "specialists", "director-review", "consolidate", "final"]) assert.equal(design.steps[kind].calls.max, 0, kind);
  assert.ok(design.cost.max > design.cost.min);
  assert.match(design.assumptions[0], /^The design covers 12 chapters, 6 a call, with no prose/);
  const plan = estimateAutopilotRun({ outline: { lastChapter: 12 }, options: { readersOnPlan: true, maxReaders: 2 }, models });
  assert.ok(design.steps.plan.outputTokens.min > plan.steps.plan.outputTokens.min, "a design says more of each chapter than a plan");
  assert.deepEqual(estimateAutopilotRun({ design: true, outline: { lastChapter: 6 } }).steps["plan-review"].calls, { min: 1, max: 3 }, "three reviews when the policy says nothing");
});

test("a design goes only to a personal server that announces autopilot-design: an older one would start a run that writes", async () => {
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_DESIGN, "autopilot-design");
  assert.equal(engine.serverSupportsDesign({ features: ["autopilot-design"] }), true);
  for (const odd of [null, undefined, {}, { features: "autopilot-design" }, ["autopilot"]]) assert.equal(engine.serverSupportsDesign(odd), false, JSON.stringify(odd));
  const serverWith = (features) => {
    const log = [];
    const fetch = async (input, init = {}) => {
      const url = new URL(input);
      log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body) });
      if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.20", engineVersion: "0.1.24", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
      return Response.json({ bookId: "b", state: null, summary: null, activities: [], live: null, running: true, host: "server" });
    };
    return { log, client: new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch }) };
  };
  const old = serverWith(["autopilot", "autopilot-outline-brief"]);
  const error = await old.client.startAutopilot("b", { design: { chapters: 8 } }).then(() => null, (failure) => failure);
  assert.equal(error?.code, "feature_unavailable");
  assert.equal(error.status, 501);
  assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info"], "nothing is sent but the question of the features");
  await old.client.startAutopilot("b", { design: false });
  assert.equal(old.log.at(-1).path, "/api/v1/books/b/autopilot/start", "ending a design is safe anywhere");
  const current = serverWith(["autopilot", "autopilot-outline-brief", "autopilot-design"]);
  await current.client.startAutopilot("b", { design: { chapters: 8, review: { maxRounds: 4 } } });
  assert.deepEqual(current.log.at(-1).body, { design: { chapters: 8, review: { maxRounds: 4 } } });
});

test("a plateau: the last two reviews raised neither the best vote before them", () => {
  const rounds = (...scores) => ({ rounds: scores.map((score) => ({ score })) });
  assert.equal(designPlateau(rounds(6, 7)), false, "two reviews are not enough to tell");
  assert.equal(designPlateau(rounds(6, 7, 8)), false);
  assert.equal(designPlateau(rounds(7, 6, 6.5)), true);
  assert.equal(designPlateau(rounds(6, 7, 7, 7)), true);
  assert.equal(designPlateau(rounds(6, 7, 6, 7.5)), false, "a new best ends the plateau");
});

test("what a start says of a design is checked: true, false, the chapters and the policy, and nothing else", () => {
  assert.deepEqual(normalizeDesignStart(true), {});
  assert.equal(normalizeDesignStart(false), false);
  assert.equal(normalizeDesignStart(undefined), undefined);
  assert.deepEqual(normalizeDesignStart({ chapters: 8, review: { targetScore: 8.5, maxRounds: 4 } }), { chapters: 8, review: { targetScore: 8.5, maxRounds: 4 } });
  for (const wrong of ["yes", [], { chapters: 0 }, { chapters: 1.5 }, { chapters: 501 }, { chapter: 8 }, { review: 3 }, { review: { campaignMaxRounds: 2 } }]) {
    assert.throws(() => normalizeDesignStart(wrong), (error) => error instanceof AutopilotDesignError && error.code === "invalid_request", JSON.stringify(wrong));
  }
});
