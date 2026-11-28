import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIEF,
  TWO_CALL_TASKS,
  createAutopilotState,
  estimateAutopilotRun,
  estimateContextFromState,
  estimateModelsFromConfig,
  estimateProgressFromState,
  measuredSpeed,
  type AiIntegrationConfig,
  type AiRuntimeConfig,
  type AutopilotActivity,
  type AutopilotBrief,
  type AutopilotOptions,
  type AutopilotPlan,
  type AutopilotState,
  type PlannedChapter,
} from "narrarium-engine";
import { REST_WARNING_CODES, estimateRest, groupWarnings, restProblems, restScenesPerChapter, type EstimateSources } from "@/autopilot/runEstimate";
import { activityOf } from "./helpers/autopilotBand";
import { chapter, planOf, scene } from "./helpers/autopilotFixtures";

const CLOUD: AiIntegrationConfig = {
  id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", apiKey: "sk-secret",
  chatModels: [{ id: "m1", name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
};
const CONFIG: AiRuntimeConfig = { aiIntegrations: [CLOUD], defaultWritingIntegrationId: "cloud", costCurrency: "EUR" };

const IDEA = "A keeper who counts the ships that never arrive.";

type Patch = { brief?: Partial<AutopilotBrief>; plan?: Partial<AutopilotPlan>; options?: Partial<AutopilotOptions> };

/** The chapters of a plan: the first `done` approved, the others planned (and with `scenes` scenes each when the plan has planned them). */
function chaptersOf(count: number, done = 0, scenes = 0): PlannedChapter[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const status = number <= done ? "done" : "planned";
    return chapter(number, status, { title: `Title ${number}`, summary: `Summary ${number}`, scenes: Array.from({ length: scenes }, (_unused, offset) => scene(offset + 1, status === "done" ? "reviewed" : "planned")) });
  });
}

/** A plan that waits for the author, as the engine leaves it after the director approved it. */
function stateOf(chapters: PlannedChapter[], patch: Patch = {}): AutopilotState {
  const base = createAutopilotState(new Date("2026-11-20T10:00:00.000Z"), { ...DEFAULT_BRIEF, idea: IDEA, ...patch.brief });
  return {
    ...base,
    status: "paused",
    phase: "plan",
    concept: { ...base.concept, done: true, generated: true, logline: "A keeper counts what never comes." },
    options: { ...base.options, ...patch.options },
    plan: { ...planOf(chapters), approved: true, awaitingAuthor: true, ...patch.plan },
    version: 7,
  };
}

function sourcesOf(patch: Partial<EstimateSources> = {}): EstimateSources {
  return {
    book: { read: true, directorRounds: 2, directorFile: true, context: {}, designWritten: false, outline: { entries: 12, lastChapter: 12, words: 0 } },
    language: "en", currency: "EUR", ai: CONFIG, aiFrom: "browser", activities: [], state: null, chapters: null, canonEntries: 0,
    ...patch,
  };
}

/** What the engine says when it is asked with what a plan that waits for the author gives: its chapters, its scenes, its options and where it is. */
function engineSays(sources: EstimateSources, state: AutopilotState, brief: Partial<AutopilotBrief>, extra: Record<string, unknown> = {}) {
  const speeds = measuredSpeed(sources.activities, { ignoreTasks: TWO_CALL_TASKS });
  return estimateAutopilotRun({
    brief: { ...state.brief, ...brief },
    outline: sources.book.outline,
    options: state.options,
    maxReviewRounds: sources.book.directorRounds,
    language: sources.language,
    currency: sources.currency,
    models: estimateModelsFromConfig(sources.ai, speeds),
    readerPanelSize: sources.book.readerPanelSize,
    progress: { ...estimateProgressFromState(state), conceptDone: true },
    context: { ...sources.book.context, ...estimateContextFromState(state) },
    ...extra,
  });
}

/** A step of 10 seconds that wrote 1 000 tokens: 100 tokens a second. */
function stepOf(task: AutopilotActivity["task"], at: number): AutopilotActivity {
  const start = Date.parse("2026-11-20T10:00:00.000Z") + at * 60_000;
  return activityOf(task, { model: "writer-1", usage: { inputTokens: 3000, outputTokens: 1000, cachedInputTokens: 0 }, startedAt: new Date(start).toISOString(), endedAt: new Date(start + 10_000).toISOString() });
}

describe("the scenes of the rest of a plan", () => {
  it("counts the scenes the plan has planned for the chapters left, and the middle of the range for the chapters with none yet", () => {
    expect(restScenesPerChapter(stateOf(chaptersOf(10, 0, 5)))).toBe(4);
    expect(restScenesPerChapter(stateOf(chaptersOf(10, 0, 3)))).toBe(3);
  });

  it("is the planner's range, 2 to 4, and the middle of it when the plan has none", () => {
    expect(restScenesPerChapter(stateOf(chaptersOf(12)))).toBe(3);
    expect(restScenesPerChapter(stateOf(chaptersOf(12, 0, 9)))).toBe(4);
    expect(restScenesPerChapter(stateOf(chaptersOf(12, 0, 1)))).toBe(2);
  });

  it("counts a mix of planned and unplanned chapters, rounding half a scene up", () => {
    const mixed = [...chaptersOf(2, 0, 5), ...chaptersOf(2, 0, 0).map((entry, index) => ({ ...entry, number: index + 3 }))];
    expect(restScenesPerChapter(stateOf(mixed))).toBe(4);
    const odd = [...chaptersOf(1, 0, 4), ...chaptersOf(1, 0, 3).map((entry) => ({ ...entry, number: 2 }))];
    expect(restScenesPerChapter(stateOf(odd))).toBe(4);
  });

  it("looks only at the chapters that are left: the scenes of a chapter that is done say nothing of the ones to write", () => {
    const chapters = [...chaptersOf(6, 6, 9), ...chaptersOf(6, 0, 0).map((entry, index) => ({ ...entry, number: index + 7 }))];
    expect(restScenesPerChapter(stateOf(chapters))).toBe(3);
  });

  it("is undefined when the plan has no chapter left, or no plan", () => {
    expect(restScenesPerChapter(stateOf([]))).toBeUndefined();
    expect(restScenesPerChapter(stateOf(chaptersOf(4, 4, 3)))).toBeUndefined();
    expect(restScenesPerChapter({ plan: null })).toBeUndefined();
  });

  it("does not change the state it reads", () => {
    const state = stateOf(chaptersOf(10, 2, 5));
    const before = JSON.stringify(state);
    restScenesPerChapter(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("the estimate of the rest of a plan", () => {
  it("is the engine's estimate, called with the chapters and the scenes of the plan and with the options the state has", () => {
    const state = stateOf(chaptersOf(14, 0, 4), { options: { maxReaders: 3, specialists: false } });
    const sources = sourcesOf({ state, book: { read: true, directorRounds: 3, directorFile: true, context: { designWords: 400, ghostwriterWords: 220 }, designWritten: true, readerPanelSize: 6 } });
    const { estimate } = estimateRest(sources, state);
    expect(estimate).toEqual(engineSays(sources, state, {}, { scenesPerChapter: 4 }));
    expect(estimate.chapters).toBe(14);
    expect(estimate.words).toBe(14 * 4 * 1400);
  });

  it("counts the chapters of the plan and not the brief's, whether the plan is longer or shorter", () => {
    // No outline: the chapters are the plan's own.
    const noOutline = () => sourcesOf({ book: { read: true, directorRounds: 2, directorFile: true, context: {}, designWritten: false } });
    expect(estimateRest(noOutline(), stateOf(chaptersOf(14), {})).estimate.chapters).toBe(14);
    expect(estimateRest(noOutline(), stateOf(chaptersOf(8), {})).estimate.chapters).toBe(8);
  });

  it("counts only what is left to write: the chapters that are done are not paid for again", () => {
    const fresh = estimateRest(sourcesOf(), stateOf(chaptersOf(14, 0))).estimate;
    const halfway = estimateRest(sourcesOf(), stateOf(chaptersOf(14, 5))).estimate;
    expect(halfway.chapters).toBe(14);
    expect(halfway.chaptersToWrite).toBe(9);
    expect(halfway.words).toBe(9 * 3 * 1400);
    expect(halfway.calls.max).toBeLessThan(fresh.calls.max);
    expect(halfway.outputTokens.max).toBeLessThan(fresh.outputTokens.max);
  });

  it("asks for no concept and for no plan of a plan the director approved, and counts the plan made again when it is not approved", () => {
    const approved = estimateRest(sourcesOf(), stateOf(chaptersOf(12))).estimate;
    expect(approved.steps.concept.calls.max).toBe(0);
    expect(approved.steps.plan.calls.max).toBe(0);
    expect(approved.steps["plan-review"].calls.max).toBe(0);
    const reopened = estimateRest(sourcesOf(), stateOf(chaptersOf(12), { plan: { approved: false, awaitingAuthor: false, revisionNotes: ["Chapter 3: make it darker."] } })).estimate;
    expect(reopened.steps.concept.calls.max).toBe(0);
    expect(reopened.steps.plan.calls.max).toBeGreaterThan(0);
    expect(reopened.steps["plan-review"].calls.max).toBeGreaterThan(0);
    expect(reopened.calls.max).toBeGreaterThan(approved.calls.max);
  });

  it("counts the readers, the specialists and the words the run has in its own options, not the defaults of a new book", () => {
    const light = estimateRest(sourcesOf(), stateOf(chaptersOf(12), { options: { readers: false, specialists: false } })).estimate;
    const full = estimateRest(sourcesOf(), stateOf(chaptersOf(12))).estimate;
    expect(light.steps.reader.calls.max).toBe(0);
    expect(light.steps.specialists.calls.max).toBe(0);
    expect(full.steps.reader.calls.max).toBeGreaterThan(0);
    expect(light.calls.max).toBeLessThan(full.calls.max);
    const short = estimateRest(sourcesOf(), stateOf(chaptersOf(12), { brief: { wordsPerScene: 700 } })).estimate;
    expect(short.words).toBe(12 * 3 * 700);
  });

  it("uses the rounds of review the director of the book allows", () => {
    const one = estimateRest(sourcesOf({ book: { ...sourcesOf().book, directorRounds: 1 } }), stateOf(chaptersOf(12))).estimate;
    const three = estimateRest(sourcesOf({ book: { ...sourcesOf().book, directorRounds: 3 } }), stateOf(chaptersOf(12))).estimate;
    expect(three.calls.max).toBeGreaterThan(one.calls.max);
    expect(three.calls.min).toBe(one.calls.min);
  });

  it("counts a call for each chapter the author wrote that has no summary yet", () => {
    const chapters = chaptersOf(10, 2).map((entry) => (entry.number <= 2 ? ({ ...entry, imported: true, summary: "" } as PlannedChapter) : entry));
    const { estimate } = estimateRest(sourcesOf({ book: { read: true, directorRounds: 2, directorFile: true, context: {}, designWritten: false } }), stateOf(chapters));
    expect(estimate.steps["summarize-imported"].calls.max).toBe(2);
    expect(estimate.chaptersToWrite).toBe(8);
  });

  it("takes the chapters that were removed out of the book: a plan of eleven with one removed is eleven, and the outline that still ends at twelve does not extend it", () => {
    const eleven = chaptersOf(12).filter((entry) => entry.number !== 5);
    const state = stateOf(eleven, { plan: { removedChapters: [5] } });
    const book = { read: true, directorRounds: 2, directorFile: true, context: {}, designWritten: false, outline: { entries: 11, lastChapter: 12, words: 600 } };
    const { estimate } = estimateRest(sourcesOf({ book }), state);
    expect(estimate.chapters).toBe(11);
    expect(estimate.chaptersToWrite).toBe(11);
    expect(estimate.steps.plan.calls.max).toBe(0);
  });

  it("still lets the author's outline make the book longer than its plan: the chapters the plan lacks are planned and written", () => {
    const state = stateOf(chaptersOf(11), {});
    const book = { read: true, directorRounds: 2, directorFile: true, context: {}, designWritten: false, outline: { entries: 12, lastChapter: 12, words: 700 } };
    const { estimate } = estimateRest(sourcesOf({ book }), state);
    expect(estimate.chapters).toBe(12);
    expect(estimate.steps.plan.calls.max).toBeGreaterThan(0);
  });

  it("measures the time with the speed the book's own steps showed, and leaves it unestimated until a model has one", () => {
    const state = stateOf(chaptersOf(12));
    expect(estimateRest(sourcesOf(), state).estimate.minutes).toBeNull();
    const measured = estimateRest(sourcesOf({ activities: [stepOf("plan", 0), stepOf("plan-review", 1), stepOf("concept", 2)] }), state);
    expect(measured.estimate.minutes).not.toBeNull();
    expect(measured.basis.measuredModels).toEqual(["writer-1"]);
    expect(measured.basis.hasRun).toBe(true);
  });

  it("is a pure function: the state is not changed and the same inputs give the same answer", () => {
    const state = stateOf(chaptersOf(12, 3, 4));
    const sources = sourcesOf({ state });
    const before = JSON.stringify(state);
    const first = estimateRest(sources, state);
    const second = estimateRest(sources, state);
    expect(JSON.stringify(state)).toBe(before);
    expect(second).toEqual(first);
  });

  it("is made in memory and at once, for a plan of five thousand chapters", () => {
    const state = stateOf(chaptersOf(5000, 100, 3), {});
    const sources = sourcesOf({ state });
    const started = performance.now();
    let result = estimateRest(sources, state);
    for (let index = 0; index < 19; index += 1) result = estimateRest(sources, state);
    expect((performance.now() - started) / 20).toBeLessThan(50);
    expect(result.estimate.chapters).toBe(5000);
    expect(Number.isFinite(result.estimate.calls.max)).toBe(true);
  });
});

describe("the problems that matter when a plan waits for the author", () => {
  const withModel = (model: Record<string, unknown>, extra: Partial<AiRuntimeConfig> = {}): AiRuntimeConfig => ({
    aiIntegrations: [{ ...CLOUD, chatModels: [{ id: "m1", capabilities: ["default"], supportsToolCalls: true, ...model }] as AiIntegrationConfig["chatModels"] }],
    defaultWritingIntegrationId: "cloud",
    ...extra,
  });
  const small = withModel({ name: "small-8k", maxInputTokens: 6000, maxOutputTokens: 500, supportsReasoning: true });
  const warningsOf = (ai: AiRuntimeConfig | null, state = stateOf(chaptersOf(12))) => estimateRest(sourcesOf({ ai }), state).estimate.warnings;

  it("are the three that stop a run or cut it short: no model, a window that is too small and a reply that does not fit", () => {
    expect([...REST_WARNING_CODES]).toEqual(["noModel", "smallWindow", "smallOutput"]);
  });

  it("leave out what the figures already say (no price, no speed) and what is about something else (reasoning, the outline)", () => {
    const raw = warningsOf(small);
    expect(groupWarnings(raw).map((group) => group.code)).toEqual(expect.arrayContaining(["smallWindow", "smallOutput", "noPrice", "noSpeed", "reasoningModel"]));
    const codes = restProblems(raw).map((problem) => problem.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((code) => (REST_WARNING_CODES as readonly string[]).includes(code))).toBe(true);
    expect(codes).toEqual(expect.arrayContaining(["smallWindow", "smallOutput"]));
  });

  it("are said once for a model, with every role it is asked for: one small model for every role is one problem of its window and one of its replies, not one for each capability", () => {
    const raw = warningsOf(small);
    const windows = raw.filter((warning) => warning.code === "smallWindow");
    const replies = raw.filter((warning) => warning.code === "smallOutput");
    expect(windows.length).toBeGreaterThan(2);
    expect(replies.length).toBeGreaterThan(1);
    const problems = restProblems(raw);
    const window = problems.filter((problem) => problem.code === "smallWindow");
    const reply = problems.filter((problem) => problem.code === "smallOutput");
    expect(window).toHaveLength(1);
    expect(reply).toHaveLength(1);
    expect(window[0]).toMatchObject({ code: "smallWindow", model: "small-8k", window: 6000, severity: "error" });
    expect(window[0].capabilities).toEqual(windows.map((warning) => (warning as { capability: string }).capability));
    // The numbers are the worst of the roles it was said for.
    expect((window[0] as { prompt: number }).prompt).toBe(Math.max(...windows.map((warning) => (warning as { typicalPrompt: number }).typicalPrompt)));
    expect(reply[0]).toMatchObject({ code: "smallOutput", model: "small-8k", limit: 500, severity: "warning" });
    expect((reply[0] as { reply: number }).reply).toBe(Math.max(...replies.map((warning) => (warning as { typicalReply: number }).typicalReply)));
  });

  it("are one for each model: a second small model that is asked for the director is a problem of its own", () => {
    const config: AiRuntimeConfig = {
      aiIntegrations: [
        { ...CLOUD, chatModels: [{ id: "m1", name: "small-8k", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 12_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] },
        { ...CLOUD, id: "tiny", name: "Tiny", chatModels: [{ id: "t1", name: "tiny-4k", capabilities: ["director"], supportsToolCalls: true, maxInputTokens: 4000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] },
      ],
      taskRouting: { director: { primary: { integrationId: "tiny", model: "tiny-4k" }, fallbacks: [] } },
      defaultWritingIntegrationId: "cloud",
    };
    const problems = restProblems(warningsOf(config));
    const windows = problems.filter((problem) => problem.code === "smallWindow") as Array<{ model: string; capabilities: string[] }>;
    expect(windows.map((problem) => problem.model).sort()).toEqual(["small-8k", "tiny-4k"]);
    expect(windows.find((problem) => problem.model === "tiny-4k")!.capabilities).toEqual(["director"]);
    expect(windows.find((problem) => problem.model === "small-8k")!.capabilities).not.toContain("director");
  });

  it("are a window that does not fit, which is an error, or one that fits with little to spare, which is a warning", () => {
    const tight = withModel({ name: "mid-20k", maxInputTokens: 20_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } });
    const found = restProblems(warningsOf(tight)).filter((problem) => problem.code === "smallWindow");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", model: "mid-20k", window: 20_000, capabilities: ["director"] });
    const error = restProblems(warningsOf(small)).find((problem) => problem.code === "smallWindow");
    expect(error?.severity).toBe("error");
  });

  it("judge a model that declares no window by the default one, and say that it is the default", () => {
    const base = sourcesOf();
    const huge = { ...base, book: { ...base.book, context: { directorWords: 120_000 } } };
    const undeclared = withModel({ name: "no-window", maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } });
    const found = restProblems(estimateRest({ ...huge, ai: undeclared }, stateOf(chaptersOf(12))).estimate.warnings).filter((problem) => problem.code === "smallWindow");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatchObject({ severity: "error", model: "no-window", window: 128_000, windowDefault: true });
    const declared = withModel({ name: "no-window", maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } });
    const same = restProblems(estimateRest({ ...huge, ai: declared }, stateOf(chaptersOf(12))).estimate.warnings).filter((problem) => problem.code === "smallWindow");
    expect(same[0]).toMatchObject({ window: 128_000, windowDefault: false });
    expect(restProblems(warningsOf(undeclared)), "a prompt that fits the default window says nothing").toEqual([]);
  });

  it("are a problem for every role when the browser has no model, said once, with the errors first", () => {
    const kept = restProblems(warningsOf(null));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ code: "noModel", severity: "error" });
    expect(kept[0].capabilities.length).toBeGreaterThan(3);
  });

  it("are none for a model that fits, whatever else the estimate has to say", () => {
    expect(restProblems(warningsOf(CONFIG))).toEqual([]);
  });

  it("keep what stops the run before what only cuts it short", () => {
    const kept = restProblems(warningsOf(small));
    const rank = (severity: string) => ["error", "warning", "info"].indexOf(severity);
    expect(kept.map((problem) => rank(problem.severity))).toEqual([...kept.map((problem) => rank(problem.severity))].sort((left, right) => left - right));
    expect(kept[0].severity).toBe("error");
  });
});
