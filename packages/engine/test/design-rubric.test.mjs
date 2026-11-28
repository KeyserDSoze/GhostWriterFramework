import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, fakeRubric, seedBookFiles } from "../dist/testing/index.js";

// The rubric of a design: twelve criteria that the director, the simulated readers and the review of every chapter score the same way. A reply is read strictly (a criterion
// that is missing, twice, unknown, without a score or with a text over its limits rejects the reply, which is asked again), what is judged keeps its scores round after round,
// and what falls short is what a round rewrites. A design run that does not ask for it is the one of every engine before.

const {
  AutopilotDesignError,
  AutopilotSession,
  DESIGN_CRITERIA,
  DESIGN_CRITERION_INFO,
  DESIGN_ITEMS_MAX,
  DESIGN_ITEM_CHARACTERS,
  DESIGN_REASON_CHARACTERS,
  DESIGN_RUBRIC_HISTORY_MAX,
  DESIGN_RUBRIC_SUBJECTS_MAX,
  DESIGN_WEAK_SCORE,
  designCriterionLabel,
  designCriterionOf,
  designFlow,
  designRubricProperty,
  designRubricRule,
  normalizeAutopilotState,
  normalizeDesignStart,
  normalizeRubrics,
  parseAutopilotState,
  readDesignRubric,
  recordRubric,
  rubricLine,
  rubricOverall,
  rubricProposals,
  rubricRow,
  rubricTrend,
  serializeAutopilotState,
  weakCriteria,
  writeOutlineBrief,
} = engine;

const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-28T09:00:00.000Z");
const STATE = "autopilot/state.json";
const subject = { subject: "The review", mode: "all" };

const rejected = (value, input = subject) => {
  try {
    readDesignRubric(value, input);
  } catch (error) {
    assert.equal(error.name, "AiReplyRejectedError", error.message);
    return error.message;
  }
  assert.fail("the rubric was not rejected");
};

test("the rubric has twelve criteria, each with a label in English and in Italian, in a fixed order", () => {
  assert.deepEqual(DESIGN_CRITERIA, ["originality", "engagement", "coherence", "pace", "tension", "characters", "emotion", "dialogue", "twists", "credibility", "subplots", "ending"]);
  assert.equal(DESIGN_CRITERIA.length, 12);
  for (const criterion of DESIGN_CRITERIA) {
    assert.ok(DESIGN_CRITERION_INFO[criterion].ask.length > 20, criterion);
    assert.notEqual(designCriterionLabel(criterion, "en"), designCriterionLabel(criterion, "it"), criterion);
  }
  assert.equal(designCriterionLabel("twists", "it"), "Efficacia dei colpi di scena");
  assert.equal(designCriterionLabel("dialogue"), "Planned dialogue and interactions");
});

test("a criterion is named by its id, by its label in either language, or by a usual alias, whatever the case and the accents", () => {
  assert.equal(designCriterionOf("coherence"), "coherence");
  assert.equal(designCriterionOf("Narrative coherence"), "coherence");
  assert.equal(designCriterionOf("COERENZA NARRATIVA"), "coherence");
  assert.equal(designCriterionOf("Originalità"), "originality");
  assert.equal(designCriterionOf("character depth"), "characters");
  assert.equal(designCriterionOf("Emotional impact"), "emotion");
  assert.equal(designCriterionOf("Dialoghi e interazioni previsti"), "dialogue");
  assert.equal(designCriterionOf("Satisfaction of the ending"), "ending");
  assert.equal(designCriterionOf("subplot quality"), "subplots");
  assert.equal(designCriterionOf("humour"), null);
  assert.equal(designCriterionOf(7), null);
  assert.equal(designCriterionOf(undefined), null);
});

test("the schema asks for every criterion with its score, its reason, its issues and its proposals; the criteria that may be left out say so", () => {
  const all = designRubricProperty("all");
  assert.equal(all.type, "array");
  assert.deepEqual(all.items.properties.criterion.enum, [...DESIGN_CRITERIA]);
  assert.deepEqual(all.items.required, ["criterion", "score", "reason", "issues", "proposals"]);
  assert.equal("applicable" in all.items.properties, false);
  const some = designRubricProperty("applicable");
  assert.deepEqual(some.items.required, ["criterion", "applicable", "score", "reason", "issues", "proposals"]);
  assert.match(some.items.properties.applicable.description, /score 0/);
  const rule = designRubricRule("all");
  assert.match(rule[0], /score every one of these twelve criteria/);
  assert.equal(rule.filter((line) => line.startsWith("- ")).length, 12);
  assert.match(designRubricRule("applicable")[0], /marked applicable: false, with score 0 \(at least 4 must apply\)/);
});

test("a rubric is read criterion by criterion, in the order of the twelve, whatever the order it came in", () => {
  const scores = readDesignRubric([...fakeRubric({ pace: 5, ending: 9 })].reverse(), subject);
  assert.deepEqual(scores.map((entry) => entry.criterion), [...DESIGN_CRITERIA]);
  assert.equal(scores.find((entry) => entry.criterion === "pace").score, 5);
  assert.deepEqual(scores.find((entry) => entry.criterion === "pace").proposals, ["Strengthen the pace."]);
  assert.deepEqual(scores.find((entry) => entry.criterion === "ending").issues, []);
  assert.equal(readDesignRubric(fakeRubric({ pace: "7,5" }), subject).find((entry) => entry.criterion === "pace").score, 7.5, "a score as text with a decimal comma");
  assert.equal(readDesignRubric(fakeRubric({ pace: 6.04 }), subject).find((entry) => entry.criterion === "pace").score, 6);
});

test("a rubric that is not whole is rejected with what is wrong, never read as much as it can be, and the message never quotes the reply", () => {
  assert.match(rejected(undefined), /^The review was rejected: the field "rubric" must be a list of the twelve criteria/);
  assert.match(rejected("secret-token"), /must be a list/);
  assert.doesNotMatch(rejected("secret-token"), /secret-token/);
  assert.match(rejected(fakeRubric().slice(0, 10)), /the criteria «subplots», «ending» are missing/);
  assert.match(rejected(fakeRubric().slice(0, 11)), /the criteria? «ending» is missing/);
  assert.match(rejected([...fakeRubric(), { ...fakeRubric()[0] }]), /«originality» is scored twice/);
  assert.match(rejected([...fakeRubric(), { criterion: "humour", score: 7, reason: "x", issues: [], proposals: [] }]), /rubric item 13 names no criterion of the twelve/);
  assert.match(rejected(fakeRubric({ pace: 11 })), /the score of «pace» is not a number from 1 to 10/);
  assert.match(rejected(fakeRubric({ pace: 0 })), /the score of «pace» is not a number from 1 to 10/);
  assert.match(rejected(fakeRubric({ pace: Number.NaN })), /the score of «pace»/);
  assert.match(rejected(fakeRubric().map((entry) => (entry.criterion === "pace" ? { ...entry, score: "high" } : entry))), /the score of «pace»/);
  assert.match(rejected(fakeRubric().map((entry) => (entry.criterion === "tension" ? { ...entry, reason: "  " } : entry))), /«tension» has no reason/);
  assert.match(rejected(fakeRubric().map((entry) => (entry.criterion === "tension" ? { ...entry, issues: "bad" } : entry))), /the issues of «tension» must be a list of texts/);
  assert.match(rejected(fakeRubric().map((entry) => (entry.criterion === "tension" ? { ...entry, proposals: [3] } : entry))), /the proposals of «tension» must be a list of texts/);
  const message = rejected(fakeRubric(99).slice(0, 9));
  assert.match(message, /; and 4 more\./, "many problems are counted");
  assert.match(message, /Return the twelve criteria once each, scored from 1 to 10\.$/);
});

test("a text over its limit rejects the reply, to be returned shorter and whole: nothing is cut", () => {
  const long = (key, value) => fakeRubric().map((entry) => (entry.criterion === "pace" ? { ...entry, [key]: value } : entry));
  assert.match(rejected(long("reason", "x".repeat(DESIGN_REASON_CHARACTERS + 1))), new RegExp(`the reason of «pace» is ${DESIGN_REASON_CHARACTERS + 1} characters long, over the ${DESIGN_REASON_CHARACTERS} allowed: return it shorter, whole`));
  assert.match(rejected(long("issues", ["ok", "y".repeat(DESIGN_ITEM_CHARACTERS + 1)])), /an entry of the issues of «pace» is 351 characters long, over the 350 allowed: return it shorter, whole/);
  assert.match(rejected(long("proposals", Array.from({ length: DESIGN_ITEMS_MAX + 1 }, (_, index) => `Do ${index}.`))), /«pace» has 6 proposals, over the 5 allowed/);
  // At the limit, it is whole.
  const exact = readDesignRubric(long("reason", "x".repeat(DESIGN_REASON_CHARACTERS)), subject).find((entry) => entry.criterion === "pace");
  assert.equal(exact.reason.length, DESIGN_REASON_CHARACTERS);
  const lists = readDesignRubric(long("issues", ["a".repeat(DESIGN_ITEM_CHARACTERS), " ", "b"]), subject).find((entry) => entry.criterion === "pace");
  assert.deepEqual(lists.issues, ["a".repeat(DESIGN_ITEM_CHARACTERS), "b"], "an empty entry is no entry; the rest is kept as it is");
});

test("a judge of a chapter or a pitch may leave out the criteria that do not apply, as long as four apply; the judge of the whole design may not", () => {
  const some = { subject: "The review of chapter 3", mode: "applicable" };
  const apply = (...criteria) => fakeRubric(7, { applicable: true }).map((entry) => (criteria.includes(entry.criterion) ? { ...entry, applicable: false, score: 0, reason: "There is none." } : entry));
  const scores = readDesignRubric(apply("twists", "ending", "subplots"), some);
  assert.deepEqual(scores.filter((entry) => entry.score === null).map((entry) => entry.criterion), ["twists", "subplots", "ending"]);
  assert.equal(scores.find((entry) => entry.criterion === "twists").reason, "There is none.");
  assert.equal(rubricOverall(scores), 7);
  assert.deepEqual(readDesignRubric(fakeRubric(7).map((entry) => (entry.criterion === "twists" ? { ...entry, score: 0, reason: "None." } : entry)), some).find((entry) => entry.criterion === "twists").score, null, "a score of 0 says the same");
  assert.match(rejected(apply("originality", "engagement", "coherence", "pace", "tension", "characters", "emotion", "dialogue", "twists"), some), /only 3 criteria are scored: at least 4 must apply/);
  assert.match(rejected(apply("twists"), subject), /the score of «twists» is not a number from 1 to 10/, "the whole design is scored on all twelve");
});

test("the overall is the mean of what applies, the weak points are what is under seven, the lowest first, and a revision takes their proposals", () => {
  const scores = readDesignRubric(fakeRubric({ originality: 9, pace: 4, tension: 6, ending: 6.5, coherence: 8 }), subject);
  assert.equal(rubricOverall(scores), Math.round(((9 + 4 + 6 + 6.5 + 8 + 7.5 * 7) / 12) * 10) / 10);
  assert.equal(rubricOverall([]), null);
  assert.equal(rubricOverall([{ criterion: "pace", score: null, reason: "", issues: [], proposals: [] }]), null);
  assert.equal(DESIGN_WEAK_SCORE, 7);
  assert.deepEqual(weakCriteria(scores).map((entry) => entry.criterion), ["pace", "tension", "ending"]);
  assert.deepEqual(weakCriteria(scores, 5).map((entry) => entry.criterion), ["pace"]);
  assert.deepEqual(rubricProposals(scores), ["pace (4) — Strengthen the pace.", "tension (6) — Strengthen the tension.", "ending (6.5) — Strengthen the ending."]);
  assert.deepEqual(rubricProposals(scores, 2).length, 2);
  const bare = scores.map((entry) => (entry.criterion === "pace" ? { ...entry, proposals: [], issues: [] } : entry));
  assert.equal(rubricProposals(bare)[0], "pace (4) — A fair pace.", "the reason stands in when the judge proposed nothing");
  assert.equal(rubricLine(scores), "originality 9, engagement 7.5, coherence 8, pace 4!, tension 6!, characters 7.5, emotion 7.5, dialogue 7.5, twists 7.5, credibility 7.5, subplots 7.5, ending 6.5!");
  assert.deepEqual(rubricRow(scores), [9, 7.5, 8, 4, 6, 7.5, 7.5, 7.5, 7.5, 7.5, 7.5, 6.5]);
});

test("a subject keeps its latest scoring and the way its scores went; a chapter keeps the text of its weak points only; the history and the subjects are bounded", () => {
  const at = (round) => ({ round, at: `2026-11-28T0${round}:00:00.000Z` });
  let rubrics = recordRubric(undefined, "design", readDesignRubric(fakeRubric({ pace: 5 }), subject), at(1), { whole: true });
  assert.equal(rubrics.design.latest.length, 12);
  assert.deepEqual(rubrics.design.history.map((entry) => [entry.round, entry.overall]), [[1, rubricOverall(readDesignRubric(fakeRubric({ pace: 5 }), subject))]]);
  rubrics = recordRubric(rubrics, "design", readDesignRubric(fakeRubric({ pace: 8 }), subject), at(2), { whole: true });
  assert.equal(rubrics.design.history.length, 2);
  assert.equal(rubricTrend(rubrics.design), 0.2, "up a fifth of a point");
  assert.equal(rubricTrend(undefined), null);
  assert.equal(rubricTrend({ latest: [], history: [rubrics.design.history[0]] }), null, "one review has no trend");
  rubrics = recordRubric(rubrics, "chapter:4", readDesignRubric(fakeRubric({ twists: 3, pace: 6 }), subject), at(2), { whole: false });
  assert.deepEqual(rubrics["chapter:4"].latest.map((entry) => entry.criterion), ["twists", "pace"], "the weak points, the lowest first");
  assert.equal(rubrics["chapter:4"].history[0].scores.length, 12, "but the twelve scores are in its history");
  // Bounds.
  let long;
  for (let index = 0; index < DESIGN_RUBRIC_HISTORY_MAX + 5; index += 1) long = recordRubric(long, "design", readDesignRubric(fakeRubric(5 + (index % 5)), subject), { round: index + 1, at: `2026-11-28T00:${String(index).padStart(2, "0")}:00.000Z` }, { whole: true });
  assert.equal(long.design.history.length, DESIGN_RUBRIC_HISTORY_MAX);
  assert.equal(long.design.history.at(-1).round, DESIGN_RUBRIC_HISTORY_MAX + 5);
  let many;
  const one = readDesignRubric(fakeRubric(), subject);
  for (let index = 0; index < DESIGN_RUBRIC_SUBJECTS_MAX + 3; index += 1) many = recordRubric(many, `chapter:${index + 1}`, one, { round: 1, at: new Date(Date.UTC(2026, 10, 28, 0, 0, index)).toISOString() }, { whole: false });
  assert.equal(Object.keys(many).length, DESIGN_RUBRIC_SUBJECTS_MAX);
  assert.equal("chapter:1" in many, false, "the oldest are dropped");
  assert.equal(`chapter:${DESIGN_RUBRIC_SUBJECTS_MAX + 3}` in many, true);
});

test("the rubrics of a state file are read back whole, and what is not whole is dropped, never half-read", () => {
  const good = recordRubric(undefined, "reader:ana", readDesignRubric(fakeRubric({ pace: 5 }), subject), { round: 1, at: "2026-11-28T09:00:00.000Z" }, { whole: true });
  assert.deepEqual(normalizeRubrics(JSON.parse(JSON.stringify(good))), good);
  assert.equal(normalizeRubrics(undefined), undefined);
  assert.equal(normalizeRubrics({ "not a key": good["reader:ana"], "chapter:x": good["reader:ana"] }), undefined, "only the keys a design makes");
  const damaged = JSON.parse(JSON.stringify(good));
  damaged["reader:ana"].history[0].scores = [1, 2, 3];
  assert.equal(normalizeRubrics(damaged), undefined, "a row of scores that is not twelve");
  const badScore = JSON.parse(JSON.stringify(good));
  badScore["reader:ana"].history[0].scores[2] = "high";
  assert.equal(normalizeRubrics(badScore), undefined);
  const nulls = JSON.parse(JSON.stringify(good));
  nulls["reader:ana"].history[0].scores[2] = null;
  assert.equal(normalizeRubrics(nulls)["reader:ana"].history[0].scores[2], null, "a criterion that did not apply");
  const text = JSON.parse(JSON.stringify(good));
  text["reader:ana"].latest.push({ criterion: "pace", score: 4, reason: "twice" }, { criterion: "humour", score: 4 }, { criterion: "ending", score: 99 });
  assert.deepEqual(normalizeRubrics(text)["reader:ana"].latest.map((entry) => entry.criterion), DESIGN_CRITERIA.slice(), "a repeated, unknown or impossible entry is left out");
});

test("a design run asks for the rubric only when its workflow says so, and a start that asks for something else is refused", () => {
  assert.deepEqual(normalizeDesignStart({ workflow: { rubric: true } }), { workflow: { rubric: true } });
  assert.deepEqual(normalizeDesignStart({ chapters: 8, workflow: { rubric: false } }), { chapters: 8, workflow: {} });
  assert.deepEqual(normalizeDesignStart({ workflow: null }), { workflow: null });
  for (const bad of [{ workflow: true }, { workflow: [] }, { workflow: { rubric: "yes" } }, { workflow: { rubrics: true } }, { workflows: {} }]) {
    assert.throws(() => normalizeDesignStart(bad), (error) => error instanceof AutopilotDesignError && error.code === "invalid_request", JSON.stringify(bad));
  }
  assert.deepEqual(designFlow(undefined), { rubric: false, chapterReview: false });
  assert.deepEqual(designFlow({ workflow: { rubric: true } }), { rubric: true, chapterReview: false });
});

async function describedBook(extra = {}) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }), ...extra });
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

async function run(store, ai, start) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { events, state: parseAutopilotState(store.files.get(STATE)) };
}

const WORKFLOW = { design: { chapters: 4, workflow: { rubric: true } }, options: { readersOnPlan: true, maxReaders: 2, pauseAfterPlan: false } };

test("with the rubric on, the director and every reader score the twelve criteria, and the design keeps them with how they went", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({ designRubric: (who, round) => (who === "design" ? { pace: round === 1 ? 5 : 8, twists: 6 } : who.startsWith("reader:") ? 8 : 7) });
  const { state, events } = await run(store, ai, WORKFLOW);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.design.workflow.rubric, true);
  const calls = ai.calls.filter((call) => call.json?.name === "design_review" || call.json?.name === "design_reaction");
  assert.equal(calls.length, 3, "two readers and the director");
  for (const call of calls) {
    assert.deepEqual(call.json.parameters.properties.rubric.items.properties.criterion.enum, [...DESIGN_CRITERIA]);
    assert.ok(call.json.parameters.required.includes("rubric"));
    assert.match(call.user, /RUBRIC: score every one of these twelve criteria/);
    assert.match(call.user, /- twists: are the twists prepared by clues/);
  }
  const rubric = state.design.rubric;
  assert.deepEqual(Object.keys(rubric).sort(), ["design", ...Object.keys(rubric).filter((key) => key.startsWith("reader:"))].sort());
  assert.equal(Object.keys(rubric).filter((key) => key.startsWith("reader:")).length, 2);
  assert.equal(rubric.design.latest.length, 12);
  assert.deepEqual(rubric.design.latest.filter((entry) => entry.score < 7).map((entry) => entry.criterion), ["pace", "twists"]);
  assert.equal(state.design.rounds[0].rubric, rubricOverall(rubric.design.latest));
  assert.equal(rubric.design.history.length, 1);
  for (const reader of Object.keys(rubric).filter((key) => key.startsWith("reader:"))) assert.equal(rubricOverall(rubric[reader].latest), 8);
  // The director sees what the readers scored.
  assert.match(calls.at(-1).user, /Rubric: originality 8, engagement 8,/);
  assert.equal(events.filter((event) => event.type === "insight" && event.code === "designReady").length, 1);
});

test("a rubric that is not asked for is not in the replies: the design run of an engine before is the same", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, { design: { chapters: 4 }, options: { readersOnPlan: true, maxReaders: 2, pauseAfterPlan: false } });
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.design.workflow, undefined);
  assert.equal(state.design.rubric, undefined);
  assert.equal(state.design.rounds[0].rubric, undefined);
  for (const call of ai.calls) {
    assert.equal(call.json?.parameters.properties.rubric, undefined, call.label);
    assert.doesNotMatch(call.user, /RUBRIC:/);
  }
});

test("the weak criteria of the director's rubric are what a revision is asked to rewrite, and the way the scores went is kept round after round", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({
    designRubric: (who, round) => (who === "design" ? { pace: round === 1 ? 4 : 8, ending: round === 1 ? 6 : 8, tension: round === 1 ? 5 : 8, twists: round === 1 ? 6.5 : 8, credibility: round === 1 ? 3 : 8 } : 8),
    designReview: (round) => (round === 1
      ? { verdict: "revise", score: 6, summary: "Not yet.", strengths: [], changes: [{ chapterNumber: 2, instruction: "Raise the stakes." }], guidance: [], critical: [], counterProposal: "x" }
      : { verdict: "approve", score: 9, summary: "Now.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "y" }),
  });
  const { state } = await run(store, ai, { design: { chapters: 4, workflow: { rubric: true } }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  const redesign = ai.calls.filter((call) => call.json?.name === "chapter_design").at(-1);
  assert.match(redesign.user, /Revise the design of chapters 1-4 applying the director's changes:\n- Chapter 2: Raise the stakes\.\n- Weak criterion — credibility \(3\) — Strengthen the credibility\.\n- Weak criterion — pace \(4\) — Strengthen the pace\.\n- Weak criterion — tension \(5\) — Strengthen the tension\.\n- Weak criterion — ending \(6\) — Strengthen the ending\./);
  assert.doesNotMatch(redesign.user, /twists \(6\.5\)/, "the four weakest only");
  const history = state.design.rubric.design.history;
  assert.deepEqual(history.map((entry) => entry.round), [1, 2]);
  assert.ok(history[1].overall > history[0].overall);
  assert.equal(rubricTrend(state.design.rubric.design) > 0, true);
  assert.deepEqual(state.design.rounds.map((round) => round.rubric), history.map((entry) => entry.overall));
  assert.deepEqual(state.design.rubric.design.latest.filter((entry) => entry.score < 7), [], "the latest scoring is the last review's");
});

test("a reply without a whole rubric is asked again with the reason, and a reader whose rubric stays incomplete is skipped", async () => {
  const store = await describedBook();
  const broken = (request) => {
    if (request.json?.name !== "design_reaction") return undefined;
    return { interest: 7, reaction: "Fine.", concerns: [], wishes: [], weakSpots: [], counterProposal: "More.", rubric: fakeRubric().slice(0, 9) };
  };
  const ai = createFakeAutopilotAi({ answer: broken });
  const { state, events } = await run(store, ai, WORKFLOW);
  assert.equal(state.status, "paused", state.lastError?.message);
  const reactions = ai.calls.filter((call) => call.json?.name === "design_reaction");
  assert.equal(reactions.length, 4, "each of the two readers asked twice");
  assert.match(reactions[1].user, /The previous reply to this request was rejected because: The reader's reaction was rejected: the criteria «credibility», «subplots», «ending» are missing/);
  assert.equal(state.plan.readerReactions.length, 0);
  assert.equal(state.plan.skippedReaders.length, 2);
  assert.equal(events.filter((event) => event.type === "insight" && /skipped/.test(event.title)).length, 2);
  assert.equal(Object.keys(state.design.rubric).some((key) => key.startsWith("reader:")), false, "a rubric that was not whole is not kept");
  assert.ok(state.design.rubric.design, "the director's is");
});

test("a design run that is saved and read again keeps its workflow and its rubric", async () => {
  const store = await describedBook();
  const { state } = await run(store, createFakeAutopilotAi(), WORKFLOW);
  const again = normalizeAutopilotState(JSON.parse(serializeAutopilotState(state)));
  assert.deepEqual(again.design.workflow, { rubric: true });
  assert.deepEqual(again.design.rubric, state.design.rubric);
  assert.deepEqual(again.design.rounds.map((round) => round.rubric), state.design.rounds.map((round) => round.rubric));
  // A new design begun on top keeps what was learned about the old one, and its workflow unless the start changes it.
  const second = await run(store, createFakeAutopilotAi(), { design: { chapters: 4 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.deepEqual(second.state.design.workflow, { rubric: true });
  assert.ok(second.state.design.rubric.design.history.length >= 2, "the evolution goes on");
  const off = await run(store, createFakeAutopilotAi(), { design: { chapters: 4, workflow: null }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(off.state.design.workflow, undefined);
});
