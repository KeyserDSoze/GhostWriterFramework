import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The locked decisions of a book (`bible/decisions.md`) bind the autopilot: every request carries them as the author's instructions, and a step whose result touches what
// one covers is not committed: it is repeated once with the reason, and then the run stops and says so. Open decisions and open questions bind nobody.

const { AutopilotSession, captureDecision, parseAutopilotState, setDecisionStatus, writeOutlineBrief, BIBLE_DECISIONS_FILE } = engine;

const STATE = "autopilot/state.json";
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-28T09:00:00.000Z");
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const NOW = new Date("2026-11-28T08:00:00.000Z");

async function describedBook(decisions) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }), ...(decisions ? { [BIBLE_DECISIONS_FILE]: decisions } : {}) });
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

async function run(store, ai, start) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { events, state: stateOf(store) };
}

const DESIGN = { design: { chapters: 4 }, options: { readersOnPlan: false, pauseAfterPlan: false } };
const withDecision = (input, lock = true) => {
  const captured = captureDecision(null, { decision: "The sea is never named.", reason: "The author's choice of voice.", ...input }, NOW);
  return lock ? setDecisionStatus(captured.content, "d-001", "locked") : captured.content;
};

test("the locked decisions and the open questions are in every request of the design run as the author's instructions; the open decisions are not", async () => {
  const locked = withDecision({ avoid: ["the Atlantic"] });
  const store = await describedBook(locked);
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, DESIGN);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.design.outcome, "target");
  assert.ok(ai.calls.length >= 3);
  for (const call of ai.calls) assert.match(call.user + call.system, /LOCKED DECISIONS[\s\S]*d-001: The sea is never named\. \(why: The author's choice of voice\.\)[\s\S]*Never write: «the Atlantic»/, call.label);

  const open = await describedBook(withDecision({}, false));
  const openAi = createFakeAutopilotAi();
  await run(open, openAi, DESIGN);
  for (const call of openAi.calls) assert.doesNotMatch(call.user + call.system, /LOCKED DECISIONS|d-001/, "an open decision binds nobody");
});

test("a result that touches what a locked decision covers is not committed: the step is repeated once, and when it comes back with the same, the run stops and says which decision", async () => {
  // Decision d-001 is about chapter 2's entry: the design run writes every entry, so it is held.
  const store = await describedBook(withDecision({ chapters: [2] }));
  const ai = createFakeAutopilotAi();
  const { state, events } = await run(store, ai, DESIGN);
  assert.notEqual(state.status, "running");
  assert.match(state.lastError?.message ?? "", /locked decision of the author and was not applied/);
  assert.match(state.lastError?.message ?? "", /entry of chapter 2[\s\S]*locked decision d-001[\s\S]*The sea is never named/);
  assert.equal(store.files.has("outline/chapters/002.md") && /Chapter Title 2/.test(store.files.get("outline/chapters/002.md")), false, "nothing of the held step was committed");
  const designCalls = ai.calls.filter((call) => call.json?.name === "chapter_design");
  assert.ok(designCalls.length >= 2, "the step was repeated once");
  assert.match(designCalls.at(-1).user, /rejected because: The result goes against a locked decision/);
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.status === "failed"));
});

test("a locked decision that covers nothing the run writes lets it through, and the author's unlock lets the held step run again", async () => {
  const store = await describedBook(withDecision({ chapters: [2] }));
  const held = await run(store, createFakeAutopilotAi(), DESIGN);
  assert.match(held.state.lastError?.message ?? "", /locked decision/);
  // The author opens the decision again in the Bible: the autopilot goes on and designs the book.
  store.files.set(BIBLE_DECISIONS_FILE, setDecisionStatus(store.files.get(BIBLE_DECISIONS_FILE), "d-001", "open"));
  const again = await run(store, createFakeAutopilotAi(), { design: undefined, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(again.state.status, "paused", again.state.lastError?.message);
  assert.equal(again.state.design.outcome, "target");
  assert.ok(store.files.has("outline/chapters/002.md"));
});

test("the director's question about the story is an open question of the book, and it is closed with the author's answer once they have answered in the autopilot", async () => {
  const store = await describedBook();
  const critical = { verdict: "approve", score: 9, summary: "Good but broken.", strengths: [], changes: [], guidance: [], critical: [{ chapterNumber: 3, issue: "Orrin cannot know the wall cracked before chapter 5." }], counterProposal: "c" };
  const ai = createFakeAutopilotAi({ designReview: () => critical });
  const first = await run(store, ai, { design: { chapters: 6, review: { maxRounds: 2 } }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(first.state.status, "waiting-author", first.state.lastError?.message);
  const { value } = engine.readBibleDecisions(store.files.get(BIBLE_DECISIONS_FILE));
  assert.equal(value.questions.length, 1);
  assert.equal(value.questions[0].status, "open");
  assert.equal(value.questions[0].by, "director");
  assert.equal(value.questions[0].ref, first.state.question.id);
  assert.match(value.questions[0].question, /critical inconsistency/);
  assert.equal(engine.decisionsBlock(value).includes("OPEN QUESTIONS"), true, "the agents are told it is not theirs to settle");

  const second = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  await second.answer({ questionId: first.state.question.id, answer: "Let Orrin learn it in chapter 2.", accept: false });
  await second.start({});
  await second.waitForIdle();
  const closed = engine.readBibleDecisions(store.files.get(BIBLE_DECISIONS_FILE)).value;
  assert.deepEqual(closed.questions.map((question) => [question.status, question.answer]), [["answered", "Let Orrin learn it in chapter 2."]]);
  assert.equal(closed.questions.length, 1, "asked once, never twice");
});
