import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// Phase 4 of #108: the words of every review of a design kept with its round: what the director and each reader said, the devil's advocate, the changes asked.

const { AutopilotSession, DESIGN_ROUND_TEXT_LIMITS, normalizeAutopilotState, parseAutopilotState, roundTexts, serializeAutopilotState, serializeOutlineChapter, writeOutlineBrief } = engine;

const STATE = "autopilot/state.json";
const clock = () => new Date("2026-11-28T08:00:00.000Z");
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));

async function run(store, ai, start) {
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  await session.start(start);
  await session.waitForIdle();
  return { session, state: stateOf(store) };
}

test("the words of a review are kept with its round, cut to their limits, and read back as they were", () => {
  const texts = roundTexts({
    summary: "  The reveal costs Mira nothing.  ",
    counterProposal: "Reveal the wall in chapter 3, through Orrin.",
    changes: ["Chapter 2: make the reveal cost Mira her trust.", "", 42],
    critical: [],
    readers: [{ slug: "tess", name: "Tess", score: 7.26, text: "I would read it.", counterProposal: "Open on the flood." }, { slug: "", name: "Nobody", score: 5, text: "x" }, { slug: "omar", name: "Omar", score: "n/a", text: "y" }],
  });
  assert.deepEqual(texts, {
    summary: "The reveal costs Mira nothing.",
    counterProposal: "Reveal the wall in chapter 3, through Orrin.",
    changes: ["Chapter 2: make the reveal cost Mira her trust.", "42"],
    readers: [{ slug: "tess", name: "Tess", score: 7.3, text: "I would read it.", counterProposal: "Open on the flood." }],
  });
  assert.equal(roundTexts({}), undefined);
  const long = roundTexts({ summary: "x".repeat(5000), changes: Array.from({ length: 40 }, (_, index) => `change ${index}`) });
  assert.equal(long.summary.length, DESIGN_ROUND_TEXT_LIMITS.summary);
  assert.equal(long.changes.length, DESIGN_ROUND_TEXT_LIMITS.items);
  assert.equal(engine.counterProposalOf(["More of the harbor", "Counter-proposal: Open on the flood."]), "Open on the flood.");
  assert.equal(engine.counterProposalOf(["Controproposta: Apri sulla piena."]), "Apri sulla piena.");
  assert.equal(engine.counterProposalOf(["More"]), undefined);
});

test("a design run keeps the director's words, the devil's advocate, the changes asked and every reader's reaction with each review", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: "The Glass Harbor" }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const reviews = [
    { verdict: "revise", score: 7, summary: "The reveal costs Mira nothing.", strengths: [], changes: [{ chapterNumber: 2, instruction: "Make the reveal cost Mira her trust." }], guidance: [], critical: [{ chapterNumber: 1, issue: "Orrin cannot know yet." }], counterProposal: "Reveal the wall in chapter 3." },
    { verdict: "approve", score: 8.5, summary: "Now the reveal hurts.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "Open on the flood itself." },
  ];
  const ai = createFakeAutopilotAi({ designReview: (round) => reviews[Math.min(round, reviews.length) - 1] });
  const { state } = await run(store, ai, { design: { chapters: 2, review: { readerRounds: 1 } }, options: { readersOnPlan: true, maxReaders: 1, pauseAfterPlan: false } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  const [first, second] = state.design.rounds;
  assert.deepEqual(first.texts, {
    summary: "The reveal costs Mira nothing.",
    counterProposal: "Reveal the wall in chapter 3.",
    changes: ["Chapter 2: Make the reveal cost Mira her trust."],
    critical: ["Critical — Chapter 1: Orrin cannot know yet."],
    readers: [{ slug: first.texts.readers[0].slug, name: first.texts.readers[0].name, score: 7, text: "I would read it.", counterProposal: "Open on the flood that has not happened yet." }],
  });
  assert.equal(second.texts.summary, "Now the reveal hurts.");
  assert.equal(second.texts.counterProposal, "Open on the flood itself.");
  assert.deepEqual(normalizeAutopilotState(JSON.parse(serializeAutopilotState(state))).design.rounds, state.design.rounds);
});

test("Review and complete keeps the director's words, the chapters sent back and the readings with each review", async () => {
  const files = seedBookFiles({ chapters: 0, title: "The Glass Harbor" });
  files["outline/chapters/001.md"] = serializeOutlineChapter({ number: 1, title: "One", body: "Mira finds the crack.", origin: "author" });
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi({ completionReview: (round) => round === 1 ? { verdict: "revise", score: 6, summary: "One proposal misses.", findings: [], redo: [{ chapterNumber: 1, instruction: "The setting is the lighthouse." }] } : { verdict: "approve", score: 8, summary: "Now it fits.", findings: [], redo: [] } });
  const { state } = await run(store, ai, { design: { mode: "complete" }, options: { readersOnPlan: true, maxReaders: 1, pauseAfterPlan: false } });
  const [first, second] = state.design.rounds;
  assert.equal(first.texts.summary, "One proposal misses.");
  assert.deepEqual(first.texts.changes, ["Chapter 1: The setting is the lighthouse."]);
  assert.equal(first.texts.readers[0].text, "I would read it, if the middle moved faster.");
  assert.equal(second.texts.summary, "Now it fits.");
});

