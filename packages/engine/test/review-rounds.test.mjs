import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, outlineEntryFiles, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, SYNC_MAX_FILE_BYTES, createAutopilotState, defaultDirector, parseAutopilotState, serializeAutopilotState, serializeDirector } = engine;

const STATE = "autopilot/state.json";
const READERS = { readers: true, maxReaders: 2, readersOnPlan: false, specialists: true, pauseAfterPlan: false };
const brief = (targetChapters) => ({ idea: "x", targetChapters, scenesPerChapter: 1, wordsPerScene: 300 });
const THREE = { brief: brief(3), options: READERS };
const ONE = { brief: brief(1), options: READERS };
/** A director who can judge a chapter three times, as the profile allows at most. */
const filesWith = (maxReviewRounds = 3, chapters = 7) => ({ ...seedBookFiles({ chapters }), "director.md": serializeDirector({ ...defaultDirector("en"), maxReviewRounds }) });

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const roundsOf = (state) => state.plan.chapters.map((chapter) => chapter.rounds);

function reply(json) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
}

const readerReply = (score) => reply({ generalImpression: "Engaging.", strengths: ["Atmosphere"], weaknesses: ["Pacing"], mostEffectiveMoment: "The confrontation.", mainProblem: "The middle drags.", prioritySuggestion: "Tighten the middle.", score });

/**
 * The fake AI with a director who judges every chapter as `script[chapter]` says, one entry for each of its reviews in the order they are
 * asked ([verdict, score, accept]: with `accept` the first finding is accepted, and every other one rejected), and readers who score as
 * `readers[chapter][slug]` says. `decided` keeps what the director said, as the model said it, to compare with what the plan saved.
 */
function scriptedAi(script, readers = {}) {
  const base = createFakeAutopilotAi();
  const decided = [];
  return {
    calls: base.calls,
    decided,
    async complete(request) {
      const judged = /^autopilot:director-review:(\d+)$/.exec(request.label);
      if (judged) {
        base.calls.push(request);
        const chapter = Number(judged[1]);
        const turn = decided.filter((entry) => entry.chapter === chapter).length;
        const [verdict, score, accept] = script[chapter][turn];
        const ids = [...request.user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
        const accepted = accept && ids.length ? 1 : 0;
        decided.push({ chapter, round: Number(/review round (\d+)/.exec(request.user)[1]), verdict, score, accepted, rejected: ids.length - accepted });
        return reply({
          verdict,
          score,
          summary: "Judged.",
          strengths: [],
          decisions: ids.map((id, index) => ({ findingId: id, action: accept && index === 0 ? "accept" : "reject", rationale: "Because.", remediation: accept && index === 0 ? "Open with Mira already running." : "", sceneNumber: 1 })),
          extraFixes: [],
          guidance: [],
        });
      }
      if (request.label.startsWith("reader-evaluation:") && request.json?.name === "reader_evaluation") {
        base.calls.push(request);
        const chapter = Number(/TARGET: chapter — Chapter Title (\d+)/.exec(request.user)?.[1]);
        return readerReply(readers[chapter]?.[request.label.slice("reader-evaluation:".length)] ?? 7);
      }
      return base.complete(request);
    },
  };
}

async function run(ai, start, files = filesWith(3, start.brief?.targetChapters ?? 7)) {
  const store = new MemoryBookStore(files);
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, store, session };
}

/** Chapter 1 is approved at once, chapter 2 after a round of fixes, chapter 3 after two. */
const SCRIPT = {
  1: [["approve", 8, false]],
  2: [["revise", 6, true], ["approve", 8, false]],
  3: [["revise", 5, true], ["revise", 6.5, true], ["approve", 8.5, false]],
};
const READER_SCORES = {
  1: { "standard-general": 6, "standard-emotional": 7 },
  2: { "standard-general": 8, "standard-emotional": 9 },
  3: { "standard-general": 5, "standard-emotional": 4 },
};
const READER_MEANS = { 1: 6.5, 2: 8.5, 3: 4.5 };

/**
 * What the plan must say about a chapter whose review ran once, with the readers in its first round: from what the director decided. Every
 * score of these scripts meets the director's approval score, so the verdict the model gave is the one the plan acts on.
 */
const expectedFor = (ai, chapter) => ai.decided.filter((entry) => entry.chapter === chapter).map((entry, index) => ({
  director: entry.score,
  ...(index === 0 ? { readers: READER_MEANS[chapter] } : {}),
  verdict: entry.verdict,
  accepted: entry.accepted,
  rejected: entry.rejected,
}));

// ─── A compact history of the rounds of every chapter ───────────────────────

test("a book of three chapters with one to three rounds each: every round that closed is in the plan, with the votes of the director and of the readers", async () => {
  const ai = scriptedAi(SCRIPT, READER_SCORES);
  const { state } = await run(ai, THREE);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(roundsOf(state).map((rounds) => rounds?.length), [1, 2, 3], "one entry for every round");
  assert.deepEqual(roundsOf(state), [1, 2, 3].map((chapter) => expectedFor(ai, chapter)), "the votes are the ones the director and the readers gave");
  assert.deepEqual(roundsOf(state)[2].map((round) => round.director), [5, 6.5, 8.5]);
  assert.deepEqual(roundsOf(state)[1].map((round) => round.accepted), [1, 0], "the fix of the first round, none in the second");
  assert.ok(roundsOf(state)[0][0].rejected >= 1, "what the director turned down is counted too");
  assert.deepEqual(roundsOf(state).map((rounds) => rounds.map((round) => "readers" in round)), [[true], [true, false], [true, false, false]], "the readers read the chapter once, in its first round: they are not asked again, and are not in the rounds that follow");
  for (const rounds of roundsOf(state)) for (const round of rounds) {
    assert.deepEqual(Object.keys(round).filter((key) => !["director", "readers", "verdict", "accepted", "rejected"].includes(key)), [], "nothing but the four numbers and the verdict");
    assert.ok(round.verdict === "approve" || round.verdict === "revise", JSON.stringify(round));
    for (const [key, value] of Object.entries(round)) if (key !== "verdict") assert.ok(typeof value === "number" && value >= 0, JSON.stringify(round));
    assert.ok(Number.isInteger(round.accepted) && Number.isInteger(round.rejected));
    assert.ok(round.director >= 0 && round.director <= 10 && Math.round(round.director * 10) === round.director * 10, "a vote of 0-10 with one decimal at most");
  }
  assert.equal(state.review, null, "the chapter was closed: the review in progress is gone");
  assert.ok(state.plan.chapters.every((chapter) => chapter.status === "done"));
});

test("the history agrees with the review cycle in the state while it runs, which is the one in progress and is left as it is", async () => {
  const ai = scriptedAi(SCRIPT, READER_SCORES);
  const store = new MemoryBookStore(filesWith(3, 3));
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  let paused = false;
  session.subscribe((event) => {
    if (!paused && event.type === "task-finished" && event.activity.task === "director-review" && event.activity.chapterNumber === 2) {
      paused = true;
      session.pause("after-step");
    }
  });
  await session.start(THREE);
  await session.waitForIdle();
  const middle = stateOf(store);
  assert.equal(middle.status, "paused", middle.lastError?.message);
  assert.deepEqual(roundsOf(middle).map((rounds) => rounds?.length), [1, 1, undefined], "chapter 1 is closed, chapter 2 has the round the director just judged, chapter 3 has none yet");
  assert.equal(middle.review.chapterNumber, 2, "the state of the review in progress is what it was");
  assert.equal(middle.review.round, 1);
  assert.equal(middle.review.directorDone, true);
  assert.deepEqual(middle.review.history.map((entry) => [entry.round, entry.score, entry.accepted, entry.rejected]), [[1, 6, 1, ai.decided[1].rejected]]);
  assert.deepEqual(middle.plan.chapters[1].rounds, [{ director: 6, readers: 8.5, verdict: "revise", accepted: 1, rejected: ai.decided[1].rejected }], "the compact record says the same as the history of the review");
  assert.equal("rounds" in middle.plan.chapters[2], false, "a chapter that was not reviewed has none");

  await session.start();
  await session.waitForIdle();
  const done = stateOf(store);
  assert.equal(done.status, "completed", done.lastError?.message);
  assert.deepEqual(roundsOf(done), [1, 2, 3].map((chapter) => expectedFor(ai, chapter)), "what the first run saved is still there, and nothing was recorded twice");
});

test("the history survives the closing of the chapters and every resume: a run cut into steps of one, each in a new session, ends with the very same rounds", async () => {
  const whole = scriptedAi(SCRIPT, READER_SCORES);
  const uninterrupted = (await run(whole, THREE)).state;
  assert.equal(uninterrupted.status, "completed");
  assert.deepEqual(roundsOf(uninterrupted), [1, 2, 3].map((chapter) => expectedFor(whole, chapter)), "the rounds of the run that was not interrupted are the ones the director gave");

  const ai = scriptedAi(SCRIPT, READER_SCORES);
  const store = new MemoryBookStore(filesWith(3, 3));
  let state = null;
  let runs = 0;
  for (; runs < 400; runs += 1) {
    const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: runs % 2 ? "other" : "test", retryDelayMs: 0 });
    await session.start(runs === 0 ? { ...THREE, limits: { steps: 1 } } : { limits: { steps: 1 } });
    await session.waitForIdle();
    state = stateOf(store);
    if (state.status === "completed") break;
    assert.notEqual(state.status, "error", state.lastError?.message);
  }
  assert.equal(state.status, "completed");
  assert.ok(runs >= 30, `${runs} runs of one step each`);
  assert.deepEqual(roundsOf(state), [1, 2, 3].map((chapter) => expectedFor(ai, chapter)), "no round lost by a resume, none counted twice");
  assert.deepEqual(roundsOf(state), roundsOf(uninterrupted));
  assert.deepEqual(ai.decided, whole.decided, "and the director was asked exactly as many times");
});

test("a chapter that is rewritten adds the rounds of its new review to the ones it has, and the readers, who do not read it again, are not in them", async () => {
  const ai = scriptedAi({ 1: [["approve", 8, false], ["revise", 5, true], ["approve", 9, false]] }, { 1: { "standard-general": 6, "standard-emotional": 8 } });
  const { state, session, store } = await run(ai, ONE);
  assert.equal(state.status, "completed");
  assert.deepEqual(state.plan.chapters[0].rounds, [{ director: 8, readers: 7, verdict: "approve", accepted: 0, rejected: ai.decided[0].rejected }]);

  await session.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  await session.start();
  await session.waitForIdle();
  const rewritten = stateOf(store);
  assert.equal(rewritten.status, "completed", rewritten.lastError?.message);
  assert.deepEqual(rewritten.plan.chapters[0].rounds, [
    { director: 8, readers: 7, verdict: "approve", accepted: 0, rejected: ai.decided[0].rejected },
    { director: 5, verdict: "revise", accepted: 1, rejected: ai.decided[1].rejected },
    { director: 9, verdict: "approve", accepted: 0, rejected: ai.decided[2].rejected },
  ], "the first review is still there, and the rewrite's two rounds follow it");
});

test("a chapter never keeps more than thirty rounds: the oldest leave first", async () => {
  // Ten rounds to a review (the most the review policy gives), four reviews: forty rounds judged, the newest thirty kept.
  const votes = Array.from({ length: 40 }, (_, index) => ["revise", Math.round((1 + index * 0.2) * 10) / 10, true]);
  const ai = scriptedAi({ 1: votes });
  const { session, store } = await run(ai, { ...ONE, options: { ...READERS, review: { maxRounds: 10 } } });
  assert.deepEqual(stateOf(store).plan.chapters[0].rounds.map((round) => round.director), votes.slice(0, 10).map(([, score]) => score));
  for (const text of ["Make Orrin kinder.", "Make the harbor colder.", "Make Mira braver."]) {
    await session.intervene({ scope: "rewrite", text });
    await session.start();
    await session.waitForIdle();
    assert.equal(stateOf(store).status, "completed", stateOf(store).lastError?.message);
  }
  const rounds = stateOf(store).plan.chapters[0].rounds;
  assert.equal(engine.MAX_CHAPTER_ROUNDS, 30);
  assert.equal(ai.decided.length, 40, "forty rounds were judged");
  assert.equal(rounds.length, 30, "and thirty are kept");
  assert.deepEqual(rounds.map((round) => round.director), votes.slice(10).map(([, score]) => score), "the newest, in the order they happened");
});

test("the rounds of a chapter go on being there when the author raises the number of chapters of the finished book, even for chapters that no longer keep their closing synopsis", async () => {
  const everyone = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [index + 1, [["approve", 7 + (index % 3), false]]]));
  const ai = scriptedAi(everyone(7));
  const options = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
  const { state, session, store } = await run(ai, { brief: brief(6), options });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.plan.chapters[0].storySoFarAtClose, undefined, "chapter 1 no longer keeps the synopsis it saved when it closed");
  const before = roundsOf(state);
  assert.ok(before.every((rounds) => rounds.length === 1));

  for (const [path, content] of Object.entries(outlineEntryFiles(7))) if (!store.files.has(path)) store.files.set(path, content);
  await session.start({ brief: { idea: "x" } });
  await session.waitForIdle();
  const extended = stateOf(store);
  assert.equal(extended.status, "completed", extended.lastError?.message);
  assert.equal(extended.plan.chapters.length, 7);
  assert.deepEqual(roundsOf(extended).slice(0, 6), before, "the six chapters that were written keep what they have");
  assert.deepEqual(extended.plan.chapters[6].rounds, [{ director: 7 + (6 % 3), verdict: "approve", accepted: 0, rejected: 0 }], "and the new one has its own");
});

// ─── Old plans, odd plans ───────────────────────────────────────────────────

const CHAPTER = { number: 1, title: "One", slug: "001-one", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [] };
const planWith = (chapters) => ({ ...createAutopilotState(new Date(0)), plan: { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } });
const readRounds = (rounds) => parseAutopilotState(JSON.stringify(planWith([{ ...CHAPTER, rounds }]))).plan.chapters[0];

test("a plan saved before the rounds existed is read as it was: chapters with no rounds, and no empty list made up", () => {
  const parsed = parseAutopilotState(JSON.stringify(planWith([CHAPTER, { ...CHAPTER, number: 2, status: "planned" }])));
  assert.deepEqual(parsed.plan.chapters.map((chapter) => "rounds" in chapter), [false, false]);
  for (const rounds of [[], null, "no", {}, 7, [null, 5, "x", []], [{}], [{ verdict: "approve" }]]) assert.equal("rounds" in readRounds(rounds), false, JSON.stringify(rounds));
});

test("the rounds are read as compact data: at most thirty, a vote of 0-10 with one decimal at most, whole counters, and only those four numbers and the verdict", () => {
  const many = Array.from({ length: 34 }, (_, index) => ({ director: (index % 10) + 1, accepted: index, rejected: 1 }));
  assert.deepEqual(readRounds(many).rounds.map((round) => round.accepted), Array.from({ length: 30 }, (_, index) => index + 4), "the thirty newest");
  assert.deepEqual(readRounds([{ director: 7.26, readers: 6.04, accepted: 2.6, rejected: -3 }]).rounds, [{ director: 7.3, readers: 6, accepted: 3, rejected: 0 }]);
  assert.deepEqual(readRounds([{ director: 12, readers: -1 }]).rounds, [{ director: 10, readers: 0 }], "the votes are limited to 0-10");
  assert.deepEqual(readRounds([{ director: "8", accepted: "2" }]).rounds, [{ director: 8, accepted: 2 }], "a number written as text is a number");
  assert.deepEqual(readRounds([{ director: 7, verdict: "approve", note: "x".repeat(5000), accepted: 1 }]).rounds, [{ director: 7, verdict: "approve", accepted: 1 }], "nothing else is kept: the verdict is, the note is not");
  assert.deepEqual(readRounds([null, { director: "good", accepted: "many" }, { director: 6 }, 3, { readers: 7 }]).rounds, [{ director: 6 }, { readers: 7 }], "what holds no number is no round");
  assert.deepEqual(readRounds([{ accepted: 1 }, { rejected: 2 }]).rounds, [{ accepted: 1 }, { rejected: 2 }], "every field is optional");
  const kept = readRounds(Array.from({ length: 60 }, () => ({ director: 5, accepted: 1, rejected: 1 }))).rounds;
  assert.equal(kept.length, 30);
  let current = planWith([{ ...CHAPTER, rounds: [{ director: 6, readers: 7, accepted: 1, rejected: 2 }, { director: 8, accepted: 0, rejected: 3 }] }]);
  for (let pass = 0; pass < 3; pass += 1) current = parseAutopilotState(serializeAutopilotState(current));
  assert.deepEqual(current.plan.chapters[0].rounds, [{ director: 6, readers: 7, accepted: 1, rejected: 2 }, { director: 8, accepted: 0, rejected: 3 }], "they survive every save");
});

// ─── Scale ──────────────────────────────────────────────────────────────────

test("the state file puts every round on one line and leaves everything else as it was indented, whatever the text of the book says", () => {
  const state = planWith([{
    ...CHAPTER,
    title: "A \"rounds\": [ { \"director\": 9 } ] title",
    summary: "{\n  \"director\": 5\n}",
    scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0, words: 3 }],
    rounds: [{ director: 6.5, readers: 7, accepted: 1, rejected: 2 }, { director: 8, accepted: 0, rejected: 1 }, { director: 10, readers: 0, accepted: 12, rejected: 0 }],
  }]);
  state.review = { chapterNumber: 2, round: 1, readersPending: [], readerScores: [], readersSummaryDone: false, findings: [], specialistsDone: false, directorDone: true, decisions: [], repairQueue: [], previousFixes: [], history: [{ round: 1, verdict: "revise", score: 6, accepted: 1, rejected: 0 }] };
  const text = serializeAutopilotState(state);
  const indented = JSON.stringify(state, null, 2);
  assert.deepEqual(JSON.parse(text), JSON.parse(indented), "it is the same JSON");
  const lines = text.split("\n");
  const round = lines.filter((line) => /^ +\{ "director"/.test(line) || /^ +\{ "(readers|accepted|rejected)"/.test(line));
  assert.deepEqual(round.map((line) => line.trim()), [
    "{ \"director\": 6.5, \"readers\": 7, \"accepted\": 1, \"rejected\": 2 },",
    "{ \"director\": 8, \"accepted\": 0, \"rejected\": 1 },",
    "{ \"director\": 10, \"readers\": 0, \"accepted\": 12, \"rejected\": 0 }",
  ], "one round to a line, in the order the engine writes them");
  assert.ok(text.includes("\"history\": [\n      {\n        \"round\": 1,"), "the history of a review in progress keeps its indentation: it is not a round");
  assert.ok(text.includes("\"scenes\": [\n          {\n            \"number\": 1,"), "so do the scenes");
  assert.ok(text.includes("\"title\": \"A \\\"rounds\\\": [ { \\\"director\\\": 9 } ] title\""), "text that looks like a round is text");
  assert.ok(text.includes("\"summary\": \"{\\n  \\\"director\\\": 5\\n}\""));
  assert.deepEqual(parseAutopilotState(text).plan.chapters[0].rounds, state.plan.chapters[0].rounds);
  assert.equal(serializeAutopilotState(planWith([CHAPTER])), JSON.stringify(planWith([CHAPTER]), null, 2) + "\n", "a state without rounds is written exactly as it always was");
});

// ─── Scale ──────────────────────────────────────────────────────────────────

/** A chapter of a big book as the plan keeps it: a short summary, no scenes (a long book's plan is compact). */
function chapterOfABigBook(number, rounds) {
  return {
    number,
    title: `The Harbor At Night ${number}`,
    slug: `${String(number).padStart(4, "0")}-the-harbor-at-night-${number}`,
    summary: `In chapter ${number} the council changes what Mira believes about the wall and about her father's silence.`,
    goal: "Mira learns what the keeper hid.",
    pov: ["Mira Vale"],
    keyEvents: [`Event ${number}`],
    reveals: [],
    status: "done",
    score: 8,
    scenes: [],
    ...(rounds ? { rounds } : {}),
  };
}

const bigState = (count, withRounds) => {
  const rounds = [{ director: 6.5, readers: 7.5, accepted: 4, rejected: 3 }, { director: 7.5, accepted: 2, rejected: 5 }, { director: 8.5, accepted: 0, rejected: 6 }];
  const state = planWith(Array.from({ length: count }, (_, index) => chapterOfABigBook(index + 1, withRounds ? rounds : undefined)));
  state.brief = { ...state.brief, targetChapters: count };
  return state;
};

test("a book of 5000 chapters with three rounds each keeps state.json far below what the server accepts, and a round costs a few dozen bytes", () => {
  const without = serializeAutopilotState(bigState(5000, false)).length;
  const withRounds = serializeAutopilotState(bigState(5000, true));
  const added = withRounds.length - without;
  const perChapter = added / 5000;
  const perRound = perChapter / 3;
  assert.ok(withRounds.length < SYNC_MAX_FILE_BYTES / 2, `${(withRounds.length / 1024 / 1024).toFixed(2)} MiB for 5000 chapters: it must be below half of ${SYNC_MAX_FILE_BYTES / 1024 / 1024} MiB`);
  assert.ok(perRound < 110, `a round costs ${perRound.toFixed(1)} bytes in the file`);
  assert.ok(added < 5000 * 3 * 110, `${(added / 1024).toFixed(0)} KiB for the rounds of 5000 chapters`);
  assert.equal(parseAutopilotState(withRounds).plan.chapters.length, 5000);
  assert.deepEqual(parseAutopilotState(withRounds).plan.chapters[4999].rounds.map((round) => round.director), [6.5, 7.5, 8.5]);
  // Eight rounds is the most a chapter keeps: the cost of the worst case still fits in what the server accepts.
  const full = bigState(5000, false);
  for (const chapter of full.plan.chapters) chapter.rounds = Array.from({ length: 8 }, () => ({ director: 8.5, readers: 7.5, accepted: 4, rejected: 3 }));
  const worst = serializeAutopilotState(full).length;
  assert.ok(worst < SYNC_MAX_FILE_BYTES, `${(worst / 1024 / 1024).toFixed(2)} MiB with eight rounds in every chapter`);
});

test("reading and writing the state takes time proportional to the chapters, rounds or not, and the rounds do not make a step slower for being many", () => {
  const best = (count, withRounds) => {
    const state = bigState(count, withRounds);
    let fastest = Number.POSITIVE_INFINITY;
    for (let pass = 0; pass < 5; pass += 1) {
      const started = performance.now();
      parseAutopilotState(serializeAutopilotState(state));
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  best(1000, true);
  const small = best(3000, true);
  const large = best(12_000, true);
  assert.ok(large < small * 10, `four times the chapters took ${(large / small).toFixed(1)} times as long (${small.toFixed(1)} ms, ${large.toFixed(1)} ms)`);
  const plain = best(6000, false);
  const rounded = best(6000, true);
  assert.ok(rounded < plain * 5, `three rounds in every chapter took ${(rounded / plain).toFixed(1)} times as long as none (${plain.toFixed(1)} ms, ${rounded.toFixed(1)} ms)`);
});

test("a long book whose chapters are all judged twice keeps its steps as quick at the end as at the start", async () => {
  const chapters = 40;
  const script = Object.fromEntries(Array.from({ length: chapters }, (_, index) => [index + 1, [["revise", 6, true], ["approve", 8, false]]]));
  const ai = scriptedAi(script);
  const store = new MemoryBookStore(filesWith(2, chapters));
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  const finished = [];
  session.subscribe((event) => {
    if (event.type === "task-finished" && event.activity.status === "succeeded") finished.push(performance.now());
  });
  const started = performance.now();
  await session.start({ brief: brief(chapters), options: { readers: false, readersOnPlan: false, specialists: true, pauseAfterPlan: false } });
  await session.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.ok(state.plan.chapters.every((chapter) => chapter.rounds?.length === 2));
  const gaps = finished.map((at, index) => at - (index ? finished[index - 1] : started));
  const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const first = mean(gaps.slice(20, 120));
  const last = mean(gaps.slice(-100));
  assert.ok(gaps.length > 300, `${gaps.length} steps`);
  assert.ok(last < Math.max(first * 6, 20), `the last steps took ${last.toFixed(2)} ms, the first ${first.toFixed(2)} ms`);
  assert.ok(mean(gaps) < 150, `an average step took ${mean(gaps).toFixed(1)} ms`);
  assert.ok(store.files.get(STATE).length < 40 * 3 * 1024, "and the state stays lean");
});
