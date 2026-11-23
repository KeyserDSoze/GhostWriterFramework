// Shared by the tests of the estimate: the six models of the pipeline, the kind of call a label names, and a scripted AI (built on the
// engine's own `createFakeAutopilotAi`) that makes the reviews of a real run come out exactly as a test says: how many rounds each chapter takes,
// which scenes the director has repaired in each, and whether the director asks for changes to the plan.

import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

export const CAPABILITIES = ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"];

export const KINDS = ["concept", "summarize-imported", "plan", "plan-reader", "plan-review", "scenes", "write", "scene-summary", "reader", "readers-summary", "specialists", "director-review", "repair", "consolidate", "final"];

/** A model that is read, priced and measured: nothing to warn about. */
export const MODEL = { model: "writer-model", maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 10 }, tokensPerSecond: 20 };

/** The same model for every capability of the pipeline. */
export const uniform = (model = MODEL) => Object.fromEntries(CAPABILITIES.map((capability) => [capability, model]));

/** The kind of call a label of the real pipeline names (the labels are the ones `createFakeAutopilotAi` records). */
export function kindOfLabel(label) {
  if (label === "reader-evaluation-summary") return "readers-summary";
  if (label.startsWith("reader-evaluation:")) return "reader";
  if (label.startsWith("director:")) return "final";
  if (label.startsWith("autopilot:plan-reader:")) return "plan-reader";
  if (label.startsWith("autopilot:plan-review")) return "plan-review";
  if (label === "autopilot:plan") return "plan";
  if (label.startsWith("autopilot:scene-summary:")) return "scene-summary";
  const named = /^autopilot:(concept|summarize-imported|scenes|write|specialists|director-review|repair|consolidate)(?::|$)/.exec(label);
  if (named) return named[1];
  throw new Error(`A call the estimate knows no kind for: ${label}`);
}

export function countByKind(calls) {
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (const call of calls) counts[kindOfLabel(call.label)] += 1;
  return counts;
}

// Words that weigh what the words of a book weigh when a prompt is counted at four characters a token: five letters and a space, six characters.
const VOCABULARY = ["harbor", "light", "glass", "walked", "slowly", "toward", "silent", "boats", "while", "carried", "memory", "across", "stone", "steps", "of", "the", "and", "she", "wind", "salt", "old", "town", "lantern", "hushed", "through", "morning", "fog"];

/** The names of the canon that the prose of a scene quotes: three characters, two places and a faction, as the text of a scene does. */
const NAMES = ["Mira Vale", "Orrin Hale", "Tess Arden", "Glass Harbor", "The Lantern Wall", "The Council"];

/** `count` words that weigh what prose weighs: six characters a word, the space included. */
export function words(count, seed = 0) {
  const output = [];
  for (let index = 0; index < count; index += 1) output.push(VOCABULARY[(index * 7 + seed) % VOCABULARY.length]);
  return output.join(" ");
}

/** `count` words of a scene: the same, with the name of something of the canon every forty words, as a scene has. */
export function prose(count, seed = 0) {
  const output = [];
  let name = seed;
  while (output.length < count) {
    const index = output.length;
    if (index % 40 === 20) output.push(...NAMES[name++ % NAMES.length].split(" "));
    else output.push(VOCABULARY[(index * 7 + seed) % VOCABULARY.length]);
  }
  return output.slice(0, count).join(" ");
}

/** The files of a book that is just begun, as the interface makes one: the director and the ghostwriter are the defaults, whose size the estimate takes as typical. */
export function bookFiles({ language = "en", maxReviewRounds = 2 } = {}) {
  return {
    ...seedBookFiles({ language }),
    "director.md": engine.serializeDirector({ ...engine.defaultDirector(language), maxReviewRounds }),
    "ghostwriters/default.md": engine.serializeGhostwriter(engine.defaultGhostwriter(language)),
  };
}

const reply = (json) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" });
const proseReply = (text) => ({ text, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" });

/**
 * The fake AI with the reviews of a book scripted.
 *  - `rounds`: for every chapter (`default` for the others), the scenes the director has repaired in each round, in order; an empty list approves the
 *    chapter in that round. `[[]]` is a chapter approved at once; `[[1], []]` one repair in the first round and an approval in the second.
 *  - `planVerdicts`: what the director says of the plan, review by review (`revise` asks for changes; the third review is always an approval).
 *  - `realistic`: every reply is as long as the estimate takes a reply to be (see `ESTIMATE_TYPICAL`), so that the prompts of a run weigh what they
 *    are supposed to weigh. The default replies of the fake are a few words long.
 * It keeps the calls it received (`calls`) and the replies it gave (`replies`, in the same order).
 */
export function scriptedAi({ scenes = 2, words: sceneWords = 220, rounds = {}, planVerdicts = [], realistic = false, findings = 5 } = {}) {
  const base = createFakeAutopilotAi({ scenes, words: sceneWords });
  const calls = base.calls;
  const replies = [];
  let planReviews = 0;
  const scenesOf = (index) => ((index - 1) % scenes) + 1;
  const sizes = engine.ESTIMATE_TYPICAL ?? {};
  const typical = (name, fallback) => sizes[name] ?? fallback;
  const entry = (label, count) => ({ name: label, description: words(count), atmosphere: "Cold light", mission: "To endure" });
  const answer = (request) => {
    const name = request.json?.name;
    const chapterOf = (prefix) => Number(new RegExp(`^${prefix}:(\\d+)`).exec(request.label)?.[1] ?? 0);
    if (name === "plan_review") {
      const verdict = planVerdicts[planReviews++] ?? "approve";
      const text = (count, seed = 0) => (realistic ? words(count, seed) : undefined);
      const revise = verdict === "revise";
      return reply(revise
        ? { verdict, score: 5, summary: text(40) ?? "The plan needs work.", strengths: realistic ? [words(10), words(10, 1)] : ["Clear stakes"], changes: [{ instruction: text(25) ?? "Sharpen the stakes.", chapterNumber: 0 }], guidance: realistic ? [words(15), words(15, 2)] : ["Keep every chapter ending on a turn."] }
        : { verdict, score: 8, summary: text(40) ?? "A solid plan.", strengths: realistic ? [words(10), words(10, 1)] : ["Clear stakes"], changes: [], guidance: realistic ? [words(15), words(15, 2)] : ["Keep every chapter ending on a turn."] });
    }
    if (name === "chapter_findings") {
      return reply({
        summary: "Findings.",
        findings: Array.from({ length: findings }, (_, index) => ({ sceneNumber: scenesOf(index + 1), category: "pacing", severity: "major", evidence: `evidence ${index + 1}`, problem: realistic ? words(typical("findingWords", 55) - 15, index) : `Problem ${index + 1}.`, remediation: "Start in motion." })),
      });
    }
    if (name === "director_review") {
      const chapter = chapterOf("autopilot:director-review");
      const round = Number(/review round (\d+)/.exec(request.user)[1]);
      const repaired = (rounds[chapter] ?? rounds.default ?? [[]])[round - 1] ?? [];
      const ids = [...request.user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
      const taken = new Set();
      const decisions = ids.map((id) => {
        const finding = /^[SR]\d+-(\d+)$/.exec(id);
        const scene = finding ? scenesOf(Number(finding[1])) : 0;
        const accept = repaired.includes(scene) && !taken.has(scene);
        if (accept) taken.add(scene);
        return { findingId: id, action: accept ? "accept" : "reject", rationale: realistic ? words(typical("decisionWords", 20) - 2, scene) : "Because.", remediation: accept ? (realistic ? words(20, scene) : "Start in motion.") : "", sceneNumber: scene || 1 };
      });
      // A scene the director has repaired that no finding of the specialists names (the book has none, or they named others) is a fix of the director's own.
      const extraFixes = repaired.filter((scene) => !taken.has(scene)).slice(0, 5).map((scene) => ({ sceneNumber: scene, rationale: realistic ? words(14, scene) : "Because.", remediation: realistic ? words(20, scene) : "Start in motion." }));
      return reply({
        verdict: repaired.length ? "revise" : "approve",
        score: repaired.length ? 5 : 8,
        summary: realistic ? words(40) : "Judged.",
        strengths: realistic ? [words(10)] : ["Voice"],
        decisions,
        extraFixes,
        guidance: realistic ? (round === 1 ? [words(25, chapter)] : []) : ["Keep Orrin calm."],
      });
    }
    if (!realistic) return null;
    if (!request.json && (request.label.startsWith("autopilot:write:") || request.label.startsWith("autopilot:repair:"))) return proseReply(prose(sceneWords, chapterOf("autopilot:(?:write|repair)")));
    const described = typical("canonEntryWords", 45) - 3;
    if (name === "book_concept") {
      return reply({
        logline: "A glassmaker's daughter must expose the harbor's oldest lie.",
        premise: words(40),
        themes: ["truth"],
        tone: "Melancholic",
        conflict: words(25),
        storyDesign: `# Story Design\n\n${words(typical("designWords", 700) - 3)}`,
        context: `# World\n\n${words(typical("worldWords", 250) - 2)}`,
        characters: ["Mira Vale", "Orrin Hale", "Tess Arden", "Corin Bell", "Wen Sato"].map((label, index) => ({ ...entry(label, described), roleTier: index ? "supporting" : "main", storyRole: index ? "ally" : "protagonist", desire: "Truth", fear: "Silence", arc: "Grows", voice: "Short sentences" })),
        locations: ["Glass Harbor", "The Lantern Wall", "Salt Market"].map((label) => entry(label, described)),
        factions: [entry("The Council", described)],
        secrets: ["The Wall Is Failing", "The Keeper Is Dead", "The Ledger Lies"].map((title, index) => ({ title, truth: words(20), holders: ["Orrin Hale"], stakes: "The town floods", revealChapter: index + 2 })),
      });
    }
    if (name === "chapter_plan") {
      const range = /numbered (\d+) to (\d+)/.exec(request.user) ?? /chapters (\d+)-(\d+)/.exec(request.user);
      const first = range ? Number(range[1]) : 1;
      const count = range ? Number(range[2]) - first + 1 : 2;
      return reply({
        chapters: Array.from({ length: count }, (_, index) => ({
          number: first + index,
          title: `Chapter Title ${first + index}`,
          summary: words(typical("chapterWords", 130) - 80, index),
          goal: words(20, index),
          pov: ["Mira Vale"],
          keyEvents: [words(12, 1), words(12, 2), words(12, 3), words(12, 4)],
          reveals: [],
        })),
      });
    }
    if (name === "scene_plan") {
      return reply({
        scenes: Array.from({ length: scenes }, (_, index) => ({
          title: `Scene ${index + 1} Title`,
          goal: words(20, index),
          beats: [words(12, 1), words(12, 2), words(12, 3), words(12, 4)],
          pov: "Mira Vale",
          location: "Glass Harbor",
          characters: ["Mira Vale", "Orrin Hale", "Tess Arden"],
          summary: words(25, index),
        })),
      });
    }
    if (name === "chapter_consolidation") {
      const chapter = chapterOf("autopilot:consolidate");
      const story = Math.min(typical("storyWordsTarget", 900), typical("storyWordsPerChapter", 75) * chapter);
      return reply({ summary: words(60), recap: Array.from({ length: scenes }, (_, index) => `- Scene ${index + 1}: ${words(22, index)}`).join("\n"), stateChanges: { open_loops_add: [words(14), words(14, 1)], timeline_add: [words(12)] }, storySoFar: words(story) });
    }
    if (name === "scene_summary") return reply({ summary: words(typical("summaryWords", 35)) });
    if (name === "chapter_summary") return reply({ summary: words(typical("importedSummaryWords", 60)) });
    if (name === "plan_reaction") {
      return reply({ interest: 7, reaction: words(typical("planReactionWords", 100) - 40), concerns: [words(20), words(15)], wishes: [words(5)] });
    }
    if (name === "reader_evaluation") {
      return reply({ generalImpression: words(40), strengths: [words(20)], weaknesses: [words(20)], mostEffectiveMoment: words(25), mainProblem: words(20), prioritySuggestion: words(25), score: 7 });
    }
    if (name === "reader_evaluation_summary") {
      return reply({ consensus: [words(50)], disagreements: [], recurringStrengths: [words(20)], recurringProblems: [words(20)], prioritySuggestions: [words(25)], isolatedObservations: [], revisionPriorities: [words(25), words(25, 1), words(25, 2)], overallScore: 7 });
    }
    if (name === "director_opinion") {
      return reply({ verdict: "approve", score: 8, summary: words(60), strengths: [words(10), words(10, 1), words(10, 2)], concerns: [1, 2, 3, 4].map((index) => ({ severity: "minor", issue: words(15, index), suggestion: words(20, index) })), decisions: [1, 2, 3, 4].map((index) => words(15, index)), nextSteps: [1, 2, 3].map((index) => words(12, index)), questionsForAuthor: [] });
    }
    return null;
  };
  return {
    calls,
    replies,
    async complete(request) {
      const scripted = answer(request);
      let response;
      if (scripted) {
        calls.push(request);
        response = scripted;
      } else {
        response = await base.complete(request);
      }
      replies.push(response);
      return response;
    },
  };
}

/** A whole book, written by the autopilot with `ai` from a seeded repository; resolves with the store, the saved state and the calls. */
export async function runBook({ brief, options = {}, ai, maxReviewRounds = 2, language = "en", files, start }) {
  const store = new MemoryBookStore(files ?? bookFiles({ language, maxReviewRounds }));
  const session = new engine.AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start(start ?? { brief: { idea: "A harbor town built on glass hides a lie.", ...brief }, options: { pauseAfterPlan: false, ...options } });
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  return { store, state: snapshot.state, activities: snapshot.activities, calls: ai.calls, session };
}
