import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, fakeRubric, seedBookFiles } from "../dist/testing/index.js";

// The alternatives of a design run: before the book is designed the Brainstormer proposes several pitches from the idea, the readers and the director judge each on the rubric, one
// is chosen with its reason (by the director, or by the author when the design asks for it), and the concept is made of it.

const {
  AutopilotDesignError,
  AutopilotSession,
  DESIGN_ALTERNATIVES_MAX,
  DESIGN_ALTERNATIVES_MIN,
  chooseDesignPitch,
  chosenPitchBlock,
  designFlow,
  nextPitchStep,
  normalizeAlternatives,
  normalizeAutopilotState,
  normalizeDesignStart,
  normalizeWorkflow,
  parseAutopilotState,
  readDesignPitches,
  readPitchEvaluations,
  serializeAutopilotState,
  summarizeAutopilotState,
  writeOutlineBrief,
} = engine;

const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-28T09:00:00.000Z");
const STATE = "autopilot/state.json";

const LOGLINES = [
  "A glassmaker's daughter finds the ledger that proves the sea wall was never mended.",
  "Every window of a town of mirrors reflects a street that does not exist.",
  "Three estranged sisters row across a drowned city to bury their mother.",
  "A cartographer draws the coast in glass and the coast begins to obey.",
  "The tide stops coming in and the harbor discovers what it stands on.",
  "A lighthouse is pledged for a loan that falls due at the spring tide.",
];
const pitch = (n, extra = {}) => ({ title: `Title ${n}`, logline: LOGLINES[n - 1], premise: `Premise ${n}.`, protagonist: `Protagonist ${n}.`, stakes: `Stakes ${n}.`, twist: `Twist ${n}.`, tone: `Tone ${n}.`, difference: `Difference ${n}.`, ...extra });

test("the workflow asks for none, or from two to six alternatives, and says who chooses; anything else is refused", () => {
  assert.equal(DESIGN_ALTERNATIVES_MIN, 2);
  assert.equal(DESIGN_ALTERNATIVES_MAX, 6);
  assert.deepEqual(normalizeDesignStart({ workflow: { alternatives: 3 } }), { workflow: { alternatives: 3 } });
  assert.deepEqual(normalizeDesignStart({ workflow: { alternatives: 4, pitchChoice: "author" } }), { workflow: { alternatives: 4, pitchChoice: "author" } });
  assert.deepEqual(normalizeDesignStart({ workflow: { alternatives: 4, pitchChoice: "director" } }), { workflow: { alternatives: 4 } }, "the director is the default");
  assert.deepEqual(normalizeDesignStart({ workflow: { alternatives: 0 } }), { workflow: {} }, "none");
  for (const bad of [{ alternatives: 1 }, { alternatives: 7 }, { alternatives: 2.5 }, { alternatives: "3" }, { alternatives: -1 }, { pitchChoice: "reader" }, { pitchChoice: true }]) {
    assert.throws(() => normalizeDesignStart({ workflow: bad }), (error) => error instanceof AutopilotDesignError && error.code === "invalid_request", JSON.stringify(bad));
  }
  assert.deepEqual(normalizeWorkflow({ alternatives: 3, pitchChoice: "author" }), { alternatives: 3, pitchChoice: "author" });
  assert.deepEqual(normalizeWorkflow({ alternatives: 1, pitchChoice: "author" }), undefined, "a file with a number that is not one is read as none");
  assert.deepEqual(normalizeWorkflow({ pitchChoice: "author" }), undefined, "the choice means something only with pitches");
  assert.deepEqual(designFlow({ workflow: { alternatives: 3, pitchChoice: "author" } }), { rubric: false, chapterReview: false, alternatives: 3, pitchChoice: "author" });
  assert.deepEqual(designFlow({ workflow: { alternatives: 3 } }), { rubric: false, chapterReview: false, alternatives: 3, pitchChoice: "director" });
  assert.deepEqual(designFlow({ workflow: { alternatives: 3 }, reviewing: { startedAt: "x" } }), { rubric: true, chapterReview: true, alternatives: 0, pitchChoice: "director" }, "a review on request proposes nothing");
});

test("the pitches of a reply are exactly as many as asked, whole, within their limits, and no two the same book; the rest is rejected with the reason", () => {
  const good = [1, 2, 3].map((n) => pitch(n));
  const read = readDesignPitches(good, 3);
  assert.deepEqual(read.map((entry) => entry.id), ["p1", "p2", "p3"]);
  assert.equal(read[1].title, "Title 2");
  assert.equal(read[1].difference, "Difference 2.");
  const rejected = (value, count = 3) => {
    try {
      readDesignPitches(value, count);
    } catch (error) {
      assert.equal(error.name, "AiReplyRejectedError", error.message);
      return error.message;
    }
    return assert.fail("not rejected");
  };
  assert.match(rejected(good.slice(0, 2)), /^The pitches were rejected: 2 pitches were returned, but exactly 3 were asked\.$/);
  assert.match(rejected(undefined), /0 pitches were returned/);
  assert.match(rejected([...good.slice(0, 2), pitch(3, { twist: " " })]), /pitch 3 has no twist/);
  assert.match(rejected([...good.slice(0, 2), pitch(3, { premise: "x".repeat(901) })]), /the premise of pitch 3 is 901 characters long, over the 900 allowed: return it shorter, whole/);
  assert.match(rejected([...good.slice(0, 2), pitch(3, { logline: "y".repeat(301) })]), /the logline of pitch 3 is 301 characters long, over the 300 allowed/);
  assert.match(rejected([good[0], pitch(2, { title: "TITLE 1" }), good[2]]), /pitches 1 and 2 are the same book: propose different ones/);
  assert.match(rejected([good[0], pitch(2, { logline: good[0].logline }), good[2]]), /pitches 1 and 2 are the same book/);
  assert.match(rejected([good[0], pitch(2, { logline: `${good[0].logline} Plus a word.` }), good[2]]), /same book/, "a logline that holds the other is the same book");
  assert.doesNotMatch(rejected([...Array(3)].map(() => ({}))), /same book/, "pitches with nothing are not compared");
  assert.equal(readDesignPitches([pitch(1), pitch(2)], 2).length, 2);
});

test("a judgement of the pitches has one entry for each pitch, a note within its limit and a rubric read strictly", () => {
  const entry = (id, extra = {}) => ({ id, note: `Note of ${id}.`, rubric: fakeRubric(7, { applicable: true }), ...extra });
  const read = readPitchEvaluations([entry("p2"), entry("P1")], ["p1", "p2"], "The reader's reaction");
  assert.deepEqual([...read.keys()], ["p1", "p2"]);
  assert.equal(read.get("p1").scores.length, 12);
  assert.equal(read.get("p1").note, "Note of P1.");
  const rejected = (value) => {
    try {
      readPitchEvaluations(value, ["p1", "p2"], "The reader's reaction");
    } catch (error) {
      return error.message;
    }
    return assert.fail("not rejected");
  };
  assert.match(rejected([entry("p1")]), /^The reader's reaction was rejected: pitch p2 is not judged\. Return one judgement for each of the pitches p1, p2\.$/);
  assert.match(rejected([entry("p1"), entry("p1"), entry("p2")]), /pitch p1 is judged 2 times/);
  assert.match(rejected([entry("p1"), entry("p2", { note: " " })]), /the note of pitch p2 is missing/);
  assert.match(rejected([entry("p1"), entry("p2", { note: "n".repeat(401) })]), /the note of pitch p2 is 401 characters long, over the 400 allowed: return it shorter, whole/);
  assert.match(rejected([entry("p1"), entry("p2", { rubric: fakeRubric(7, { applicable: true }).slice(0, 8) })]), /The reader's reaction \(pitch p2\) was rejected: the criteria «twists», «credibility», «subplots», «ending» are missing|are missing/);
});

test("the alternatives of a state file are read back whole, and what is not whole is dropped", () => {
  const whole = {
    pitches: [1, 2].map((n) => ({ id: `p${n}`, ...pitch(n) })),
    evaluations: { p1: [{ by: "director", name: "The Director", overall: 7.5, scores: Array(12).fill(7.5), note: "Fine." }] },
    recommended: { id: "p2", reason: "Stronger." },
    selected: { id: "p2", by: "author", reason: "Mine.", at: "2026-11-28T09:00:00.000Z" },
  };
  assert.deepEqual(normalizeAlternatives(JSON.parse(JSON.stringify(whole))), whole);
  assert.equal(normalizeAlternatives(undefined), undefined);
  assert.equal(normalizeAlternatives({ pitches: [] }), undefined);
  const broken = JSON.parse(JSON.stringify(whole));
  broken.pitches[1].twist = "";
  broken.pitches.push({ id: "p1", ...pitch(9) }, { id: "x", ...pitch(8) });
  broken.evaluations.p9 = whole.evaluations.p1;
  broken.evaluations.p1.push({ by: "reader", name: "R", overall: 99, scores: Array(12).fill(5), note: "x" }, { by: "reader", scores: [1, 2], note: "x" });
  const read = normalizeAlternatives(broken);
  assert.deepEqual(read.pitches.map((entry) => entry.id), ["p1"], "a pitch that is not whole, repeated or with a strange id is dropped");
  assert.deepEqual(Object.keys(read.evaluations), ["p1"]);
  assert.equal(read.evaluations.p1.length, 1);
  assert.equal(read.recommended, undefined, "a recommendation that names a pitch that is not there");
  assert.equal(read.selected, undefined);
});

test("the pitch that was chosen is told to the concept, with the titles of the others", () => {
  const alternatives = { pitches: [1, 2, 3].map((n) => ({ id: `p${n}`, ...pitch(n) })), evaluations: {}, selected: { id: "p2", by: "director", reason: "A stronger turn.", at: "x" } };
  const block = chosenPitchBlock({ alternatives });
  assert.match(block, /^THE CHOSEN PITCH \(the director chose it: A stronger turn\.\)\. Develop the book from this pitch, in its own direction:\nPitch p2: «Title 2»\nLogline: Every window of a town of mirrors/);
  assert.match(block, /PITCHES NOT CHOSEN \(for contrast[^)]*\): «Title 1», «Title 3»\.$/);
  assert.match(chosenPitchBlock({ alternatives: { ...alternatives, selected: { id: "p1", by: "author", reason: "", at: "x" } } }), /^THE CHOSEN PITCH \(the author chose it\)\./);
  assert.equal(chosenPitchBlock({ alternatives: { ...alternatives, selected: undefined } }), "");
  assert.equal(chosenPitchBlock(undefined), "");
});

test("the planner proposes the pitches, has them judged, waits for the author when the design asks for the author's choice, and then goes on", () => {
  const design = (extra = {}, alternatives) => ({ design: { startedAt: "x", chapters: 4, rounds: [], workflow: { alternatives: 3, ...extra }, ...(alternatives ? { alternatives } : {}) } });
  const pitches = [1, 2, 3].map((n) => ({ id: `p${n}`, ...pitch(n) }));
  assert.equal(nextPitchStep({ design: { startedAt: "x", chapters: 4, rounds: [] } }), null, "none asked for");
  assert.equal(nextPitchStep({}), null);
  assert.equal(nextPitchStep(design()), "pitches");
  assert.equal(nextPitchStep(design({}, { pitches, evaluations: {} })), "review");
  assert.equal(nextPitchStep(design({}, { pitches, evaluations: {}, recommended: { id: "p1", reason: "x" } })), "review", "the director chooses: a recommendation without a choice is judged again");
  assert.equal(nextPitchStep(design({ pitchChoice: "author" }, { pitches, evaluations: {}, recommended: { id: "p1", reason: "x" } })), "choose");
  assert.equal(nextPitchStep(design({ pitchChoice: "author" }, { pitches, evaluations: {}, recommended: { id: "p1", reason: "x" }, selected: { id: "p3", by: "author", reason: "", at: "x" } })), null);
  const state = { concept: { done: false }, ...design({ pitchChoice: "author" }, { pitches, evaluations: {}, recommended: { id: "p1", reason: "x" } }) };
  const chosen = chooseDesignPitch(state, { id: "P3", reason: " My pick. " }, "2026-11-28T10:00:00.000Z");
  assert.deepEqual(chosen.design.alternatives.selected, { id: "p3", by: "author", reason: "My pick.", at: "2026-11-28T10:00:00.000Z" });
  assert.equal(state.design.alternatives.selected, undefined, "the state it was given is not changed");
  assert.equal(nextPitchStep(chosen), null);
  const refused = (input, current = state, code) => assert.throws(() => chooseDesignPitch(current, input, "x"), (error) => error instanceof AutopilotDesignError && error.code === code, JSON.stringify(input));
  refused({ id: "p9" }, state, "unknown_pitch");
  refused({ id: 3 }, state, "unknown_pitch");
  refused({ id: "p1" }, { concept: { done: false }, design: { startedAt: "x", chapters: 4, rounds: [] } }, "no_pitches");
  refused({ id: "p1" }, { concept: { done: false } }, "no_pitches");
  refused({ id: "p1" }, { ...state, concept: { done: true } }, "pitch_locked");
});

async function describedBook() {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: "The Glass Harbor" }));
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
const START = (workflow, options = {}) => ({ design: { chapters: 4, workflow }, options: { readersOnPlan: true, maxReaders: 2, pauseAfterPlan: false, ...options } });

test("with alternatives, the Brainstormer proposes the pitches, the readers and the director judge them on the rubric, the director chooses one with its reason, and the concept is made of it", async () => {
  const store = await describedBook();
  await store.commit([{ path: "brainstormer.md", content: "---\nname: Ada\npersona: A daring co-author.\nboldness: 9\n---\n\nStart from the twist.", expectedHash: null }], "profile");
  const ai = createFakeAutopilotAi({ pitchRubric: (id, by) => (by === "director" ? { p1: 8.5, p2: 7, p3: 7.5 }[id] : { p1: 7, p2: 8, p3: 6 }[id]) });
  const { state, events } = await run(store, ai, START({ alternatives: 3 }));
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.deepEqual(names(ai).slice(0, 7), ["design_pitches", "design_pitch_reaction", "design_pitch_reaction", "design_pitch_choice", "design_concept", "chapter_design", "design_reaction"]);
  // The Brainstormer proposes, in its voice.
  const [proposal] = ai.calls;
  assert.match(proposal.system, /Brainstormer: Ada\. A daring co-author\./);
  assert.match(proposal.system, /Now propose alternative pitches for the book: each one develops the author's idea, and none contradicts it\./);
  assert.match(proposal.user, /Propose exactly 3 alternative pitches for this novel, from the author's description\./);
  assert.match(proposal.user, /AUTHOR'S IDEA:\nA harbor town built on glass hides a lie/);
  assert.deepEqual(proposal.json.parameters.properties.pitches.items.required, ["title", "logline", "premise", "protagonist", "stakes", "twist", "tone", "difference"]);
  // What was kept.
  const alternatives = state.design.alternatives;
  assert.deepEqual(alternatives.pitches.map((entry) => [entry.id, entry.title]), [["p1", "The Tide Ledger"], ["p2", "A Harbor of Mirrors"], ["p3", "The Lighthouse Debt"]]);
  assert.deepEqual(alternatives.evaluations.p1.map((entry) => [entry.by, entry.overall]), [[alternatives.evaluations.p1[0].by, 7], [alternatives.evaluations.p1[1].by, 7], ["director", 8.5]]);
  assert.equal(alternatives.evaluations.p2.at(-1).overall, 7);
  assert.equal(alternatives.evaluations.p3[0].overall, 6);
  assert.equal(alternatives.evaluations.p1[0].scores.length, 12);
  assert.deepEqual(alternatives.recommended, { id: "p1", reason: "It is the book this author's idea promises, with a stronger turn." });
  assert.deepEqual(alternatives.selected, { id: "p1", by: "director", reason: "It is the book this author's idea promises, with a stronger turn.", at: "2026-11-28T09:00:00.000Z" });
  assert.deepEqual(Object.keys(state.design.rubric).filter((key) => key.startsWith("pitch:")).sort(), ["pitch:p1", "pitch:p2", "pitch:p3"]);
  assert.equal(state.design.rubric["pitch:p1"].latest.length, 12, "the director's rubric of each pitch is kept whole");
  // The readers read all the pitches; the director reads what they thought.
  const [first, , directorCall] = [ai.calls[1], ai.calls[2], ai.calls[3]];
  assert.match(first.user, /THE PITCHES:\nPitch p1: «The Tide Ledger»\nLogline: A glassmaker's daughter/);
  assert.match(first.user, /RUBRIC: score these twelve criteria/);
  assert.match(first.system, /Judge each pitch as this reader would/);
  assert.match(directorCall.user, /WHAT THE SIMULATED READERS THOUGHT[^\n]*:\nPitch p1: [^|]+7\/10 — Pitch p1 is familiar\. \| [^|]+7\/10/);
  assert.match(directorCall.user, /You choose the pitch the book is designed from: say why/);
  assert.deepEqual(directorCall.json.parameters.required, ["pitches", "recommended", "reason"]);
  // The concept is made of the pitch chosen.
  const concept = ai.calls.find((call) => call.json?.name === "design_concept");
  assert.match(concept.user, /THE CHOSEN PITCH \(the director chose it: It is the book this author's idea promises, with a stronger turn\.\)\. Develop the book from this pitch, in its own direction:\nPitch p1: «The Tide Ledger»/);
  assert.match(concept.user, /PITCHES NOT CHOSEN[^\n]*«A Harbor of Mirrors», «The Lighthouse Debt»\./);
  // What the run said.
  const proposed = events.filter((event) => event.type === "insight" && event.code === "designPitches");
  assert.equal(proposed.length, 1);
  assert.match(proposed[0].title, /^3 alternative pitches proposed by the Brainstormer$/);
  assert.match(proposed[0].detail, /p1: «The Tide Ledger» — A glassmaker's daughter/);
  const chosen = events.filter((event) => event.type === "insight" && event.code === "designPitchChosen");
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].title, "Pitch chosen by the director: «The Tide Ledger»");
  assert.equal(chosen[0].tone, "ok");
});

test("without readers on the plan only the director judges, and a design without alternatives has none of these steps", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, START({ alternatives: 2 }, { readersOnPlan: false }));
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.deepEqual(names(ai).slice(0, 3), ["design_pitches", "design_pitch_choice", "design_concept"]);
  assert.deepEqual(state.design.alternatives.evaluations.p1.map((entry) => entry.by), ["director"]);
  assert.equal(state.design.alternatives.selected.id, "p2", "the fake's director recommends the highest of its scores");
  const plain = createFakeAutopilotAi();
  const { state: plainState } = await run(await describedBook(), plain, START(undefined, { readersOnPlan: false }));
  assert.equal(plainState.design.alternatives, undefined);
  assert.equal(names(plain).includes("design_pitches"), false);
  assert.doesNotMatch(plain.calls.find((call) => call.json?.name === "design_concept").user, /THE CHOSEN PITCH/);
});

test("when the design asks for the author's choice the run waits with the director's recommendation, the author chooses another, and the concept is made of that one", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi();
  const made = makeSession(store, ai);
  await made.session.start(START({ alternatives: 3, pitchChoice: "author" }, { readersOnPlan: false }));
  await made.session.waitForIdle();
  let state = made.state();
  assert.equal(state.status, "waiting-author");
  assert.equal(state.message, "Choose the pitch the book is designed from.");
  assert.deepEqual(names(ai), ["design_pitches", "design_pitch_choice"], "nothing is designed before the author chooses");
  assert.equal(state.design.alternatives.recommended.id, "p3");
  assert.equal(state.design.alternatives.selected, undefined);
  assert.equal(made.events.filter((event) => event.type === "run-ended").at(-1).code, "designPitchChoice");
  // The summary says what the run waits for, so that a client does not take a stop without a question for a profile that must be corrected.
  assert.equal(state.question, null);
  assert.equal(summarizeAutopilotState(state).design.choosePitch, true);
  const recommended = made.events.find((event) => event.type === "insight" && event.code === "designPitchChoice");
  assert.equal(recommended.title, "The director recommends the pitch «The Lighthouse Debt»: the choice is yours");
  assert.match(ai.calls[1].user, /The author will choose among the pitches: recommend the one you would choose/);
  // The author chooses.
  await assert.rejects(made.session.chooseDesignPitch({ id: "p9" }), (error) => error instanceof AutopilotDesignError && error.code === "unknown_pitch");
  const chosen = await made.session.chooseDesignPitch({ id: "p1", reason: "It is the one I had in mind." });
  assert.deepEqual(chosen.design.alternatives.selected, { id: "p1", by: "author", reason: "It is the one I had in mind.", at: "2026-11-28T09:00:00.000Z" });
  assert.equal(made.state().design.alternatives.selected.id, "p1", "saved at once");
  assert.equal(summarizeAutopilotState(made.state()).design.choosePitch, undefined, "chosen: nothing is waited for");
  assert.deepEqual(names(ai), ["design_pitches", "design_pitch_choice"], "choosing does not start anything");
  await made.session.start(START({ alternatives: 3, pitchChoice: "author" }, { readersOnPlan: false }));
  await made.session.waitForIdle();
  state = made.state();
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.design.alternatives.selected.by, "author");
  assert.deepEqual(names(ai).slice(2, 4), ["design_concept", "chapter_design"]);
  assert.match(ai.calls[2].user, /THE CHOSEN PITCH \(the author chose it: It is the one I had in mind\.\)\. Develop the book from this pitch, in its own direction:\nPitch p1: «The Tide Ledger»/);
  assert.equal(names(ai).filter((name) => name === "design_pitches").length, 1, "the pitches are not proposed again");
  // The book is designed from it: another pitch cannot be chosen any more.
  await assert.rejects(made.session.chooseDesignPitch({ id: "p2" }), (error) => error instanceof AutopilotDesignError && error.code === "pitch_locked");
});

test("a pitch cannot be chosen while the autopilot runs, or for a book that proposed none", async () => {
  const store = await describedBook();
  const made = makeSession(store, createFakeAutopilotAi({ delayMs: 20 }));
  await assert.rejects(made.session.chooseDesignPitch({ id: "p1" }), (error) => error instanceof AutopilotDesignError && error.code === "no_pitches");
  const started = made.session.start(START({ alternatives: 2 }, { readersOnPlan: false }));
  await started;
  await assert.rejects(made.session.chooseDesignPitch({ id: "p1" }), /already running/);
  await made.session.waitForIdle();
});

test("a reply with the wrong number of pitches, or a judgement that is not whole, is asked again with the reason, and the director's recommendation must name a pitch", async () => {
  const store = await describedBook();
  let asked = 0;
  const ai = createFakeAutopilotAi({
    answer: (request) => {
      if (request.json?.name !== "design_pitches") return undefined;
      asked += 1;
      return asked === 1 ? { pitches: [pitch(1), pitch(2)] } : undefined;
    },
  });
  const { state } = await run(store, ai, START({ alternatives: 3 }, { readersOnPlan: false }));
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(names(ai).filter((name) => name === "design_pitches").length, 2);
  assert.match(ai.calls[1].user, /The previous reply to this request was rejected because: The pitches were rejected: 2 pitches were returned, but exactly 3 were asked\./);
  assert.equal(state.design.alternatives.pitches.length, 3);
  const unknown = await run(await describedBook(), createFakeAutopilotAi({ pitchRecommend: () => "p9" }), START({ alternatives: 3 }, { readersOnPlan: false }));
  assert.equal(unknown.state.status, "error");
  assert.match(unknown.state.lastError.message, /The director's judgement of the pitches was rejected: «p9» is not a pitch\. Recommend one of p1, p2, p3\./);
  assert.equal(unknown.state.design.alternatives.recommended, undefined, "nothing of a judgement that was not whole is kept");
  assert.equal(unknown.state.design.rubric, undefined);
});

test("a reader whose reaction stays incomplete is left out and told, and the director goes on", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({
    answer: (request) => (request.json?.name === "design_pitch_reaction" ? { pitches: [{ id: "p1", note: "x", rubric: fakeRubric(7, { applicable: true }) }] } : undefined),
  });
  const { state, events } = await run(store, ai, START({ alternatives: 2 }));
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(names(ai).filter((name) => name === "design_pitch_reaction").length, 3, "the first reader asked twice, the step repeated, and the second skipped at once");
  assert.deepEqual(state.design.alternatives.evaluations.p1.map((entry) => entry.by), ["director"]);
  assert.equal(events.filter((event) => event.type === "insight" && /skipped/.test(event.title)).length, 2);
  assert.ok(state.design.alternatives.selected);
});

test("the alternatives are kept when the state is saved and read again, and a design begun again on a book designed from a pitch keeps them", async () => {
  const store = await describedBook();
  const { state } = await run(store, createFakeAutopilotAi(), START({ alternatives: 3 }, { readersOnPlan: false }));
  const again = normalizeAutopilotState(JSON.parse(serializeAutopilotState(state)));
  assert.deepEqual(again.design.alternatives, state.design.alternatives);
  assert.deepEqual(again.design.workflow, { alternatives: 3 });
  const second = await run(store, createFakeAutopilotAi(), { design: { chapters: 4 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.deepEqual(second.state.design.alternatives, state.design.alternatives, "the book was designed from that pitch");
});
