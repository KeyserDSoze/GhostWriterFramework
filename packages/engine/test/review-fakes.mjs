import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The fakes of the tests of the review policy and of the reviews of the book: a director who votes as a script says, sessions, runs and finished books.

const { AutopilotSession, defaultDirector, parseAutopilotState, serializeDirector } = engine;

export const STATE = "autopilot/state.json";
export const FAST = { readers: false, readersOnPlan: false, specialists: true, pauseAfterPlan: false };
export const clock = () => new Date("2026-01-01T00:00:00.000Z");
export const brief = (targetChapters) => ({ idea: "x", targetChapters, scenesPerChapter: 1, wordsPerScene: 300 });
export const folder = (number) => `chapters/00${number}-chapter-title-${number}`;
export const scene = (number) => `${folder(number)}/001-scene-1-title.md`;

export const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
export const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);
export const ended = (events) => events.filter((event) => event.type === "run-ended").at(-1);
export const reply = (json) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" });
export const scores = (state) => state.plan.chapters.map((chapter) => chapter.score);

/**
 * The fake AI, with a director who votes each chapter as `chapters[n]` says, one entry for each of its reviews in the order they are asked ([verdict, score, accept];
 * `accept`, true for a `revise` unless it says otherwise, accepts the first finding, so that a scene is repaired), the last entry repeated once the list is over, and
 * who judges the whole book with the scores of `books`, one for each judgement (the last repeated). `decided` and `judged` keep what was asked.
 */
export function votingAi({ chapters = {}, books = [6], readers = 7 } = {}) {
  const base = createFakeAutopilotAi();
  const decided = [];
  const judged = [];
  return {
    calls: base.calls,
    decided,
    judged,
    async complete(request) {
      const review = /^autopilot:director-review:(\d+)$/.exec(request.label);
      if (review) {
        base.calls.push(request);
        const chapter = Number(review[1]);
        const turn = decided.filter((entry) => entry.chapter === chapter).length;
        const list = chapters[chapter] ?? [["approve", 8]];
        const [verdict, score, accept = verdict === "revise"] = list[Math.min(turn, list.length - 1)];
        const ids = [...request.user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
        decided.push({ chapter, round: Number(/review round (\d+)/.exec(request.user)[1]), verdict, score, user: request.user });
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
      if (request.label === "director:book") {
        base.calls.push(request);
        const score = books[Math.min(judged.length, books.length - 1)];
        judged.push({ score, user: request.user });
        return reply({ verdict: "approve", score, summary: "The book as a whole.", strengths: ["Atmosphere"], concerns: [], decisions: [], nextSteps: [], questionsForAuthor: [] });
      }
      if (request.label.startsWith("reader-evaluation:") && request.json?.name === "reader_evaluation") {
        base.calls.push(request);
        return reply({ generalImpression: "Engaging.", strengths: ["Atmosphere"], weaknesses: ["Pacing"], mostEffectiveMoment: "The confrontation.", mainProblem: "The middle drags.", prioritySuggestion: "Tighten the middle.", score: readers });
      }
      return base.complete(request);
    },
  };
}

export function newSession(store, ai) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

export async function run(store, ai, start = {}) {
  const { session, events } = newSession(store, ai);
  await session.start(start);
  await session.waitForIdle();
  return { session, events, state: stateOf(store) };
}

/** A finished book whose chapters closed with `votes` (the director's last vote of each; under 7 after the two rounds of the default director), judged `book`. */
export async function finishedBook(ai, chapters, options = FAST) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters }), "director.md": serializeDirector(defaultDirector("en")) });
  const { state } = await run(store, ai, { brief: brief(chapters), options });
  assert.equal(state.status, "completed", state.lastError?.message);
  return store;
}

/** Two rounds of the default director that leave a chapter at `score` (a `revise` at the last round closes it anyway, with that vote). */
export const stuckAt = (score) => [["revise", score - 0.5], ["revise", score]];
