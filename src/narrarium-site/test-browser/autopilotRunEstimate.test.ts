import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_PRESETS,
  DEFAULT_BRIEF,
  DEFAULT_OPTIONS,
  ESTIMATE_TYPICAL,
  TWO_CALL_TASKS,
  createAutopilotState,
  estimateAutopilotRun,
  estimateContextFromState,
  estimateModelsFromConfig,
  estimateProgressFromChapters,
  estimateProgressFromState,
  matchAutopilotPreset,
  measuredSpeed,
  type AiIntegrationConfig,
  type AiRuntimeConfig,
  type AutopilotActivity,
  type AutopilotState,
  type PlannedChapter,
  type ServerAiStatus,
} from "narrarium-engine";
import { applyPreset, callsByRole, configFromServerStatus, estimateRun, groupWarnings, measuredTokensPerWord, presetOfForm, type EstimateSources, type SetupFormValues } from "@/autopilot/runEstimate";
import { activityOf } from "./helpers/autopilotBand";
import { longPlan, planOf } from "./helpers/autopilotFixtures";

const CLOUD: AiIntegrationConfig = {
  id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", apiKey: "sk-secret",
  chatModels: [{ id: "m1", name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 128_000, maxOutputTokens: 16_000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
};
const CONFIG: AiRuntimeConfig = { aiIntegrations: [CLOUD], defaultWritingIntegrationId: "cloud", costCurrency: "EUR" };
const LOCAL: AiIntegrationConfig = { id: "home", name: "Home", provider: "openai", endpoint: "http://127.0.0.1:8080/v1", apiKey: "", chatModels: [{ id: "l1", name: "llama-local", capabilities: ["default"], supportsToolCalls: true }] };

const FORM: SetupFormValues = { brief: { ...DEFAULT_BRIEF, idea: "A keeper who counts the ships that never arrive.", synopsis: "" }, options: { ...DEFAULT_OPTIONS } };

/** A step of 10 seconds that wrote 1 000 tokens: 100 tokens a second. */
function stepOf(task: AutopilotActivity["task"], at: number, patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  const start = Date.parse("2026-11-20T10:00:00.000Z") + at * 60_000;
  return activityOf(task, { model: "writer-1", usage: { inputTokens: 3000, outputTokens: 1000, cachedInputTokens: 0 }, startedAt: new Date(start).toISOString(), endedAt: new Date(start + 10_000).toISOString(), ...patch });
}

function sourcesOf(patch: Partial<EstimateSources> = {}): EstimateSources {
  return {
    book: { read: true, directorRounds: 2, directorFile: true, context: {}, designWritten: false },
    language: "en", currency: "EUR", ai: CONFIG, aiFrom: "browser", activities: [], state: null, chapters: null, canonEntries: 0,
    ...patch,
  };
}

/** What the engine says when it is asked with the same inputs the form and the book give. */
function engineSays(sources: EstimateSources, form: SetupFormValues, extra: Record<string, unknown> = {}) {
  const speeds = measuredSpeed(sources.activities, { ignoreTasks: TWO_CALL_TASKS });
  return estimateAutopilotRun({
    brief: form.brief, options: form.options, maxReviewRounds: sources.book.directorRounds, language: sources.language, currency: sources.currency,
    models: estimateModelsFromConfig(sources.ai, speeds), readerPanelSize: sources.book.readerPanelSize,
    ...extra,
  });
}

describe("the sizes of the form", () => {
  const touched = { ...FORM, brief: { ...FORM.brief, genre: "mystery", audience: "adults", synopsis: "Chapter one…", targetChapters: 99 }, options: { ...FORM.options, pauseAfterPlan: false, pauseAfterEachChapter: true, budgetLimit: 7, budgetTokens: 5000, chaptersPerRun: 3, fillOutline: false, publishEvery: "chapter" as const, frozenEdits: "auto" as const } };

  it.each(AUTOPILOT_PRESETS)("puts the seven numbers of «$id» into the form, and touches nothing else: not the idea, the pauses, the budgets or the way the book is published", (preset) => {
    const next = applyPreset(touched, preset.id);
    expect(next.brief).toEqual({ ...touched.brief, ...preset.brief });
    expect(next.options).toEqual({ ...touched.options, ...preset.options });
    expect(Object.keys(preset.brief).length + Object.keys(preset.options).length).toBe(7);
  });

  it("does not change the form it is given", () => {
    const before = JSON.stringify(touched);
    applyPreset(touched, "story");
    expect(JSON.stringify(touched)).toBe(before);
  });

  it("knows the preset a form is, with the engine's own rule, and Custom (null) as soon as one of the seven numbers leaves it", () => {
    for (const preset of AUTOPILOT_PRESETS) {
      const form = applyPreset(touched, preset.id);
      expect(presetOfForm(form)).toBe(preset.id);
      expect(presetOfForm(form)).toBe(matchAutopilotPreset({ brief: form.brief, options: form.options }));
      expect(presetOfForm({ ...form, brief: { ...form.brief, targetChapters: form.brief.targetChapters + 1 } })).toBeNull();
      expect(presetOfForm({ ...form, brief: { ...form.brief, wordsPerScene: form.brief.wordsPerScene + 100 } })).toBeNull();
      expect(presetOfForm({ ...form, options: { ...form.options, maxReaders: form.options.maxReaders + 1 } })).toBeNull();
      expect(presetOfForm({ ...form, options: { ...form.options, specialists: !form.options.specialists } })).toBeNull();
      // What changes no number of the run keeps the preset.
      expect(presetOfForm({ ...form, brief: { ...form.brief, idea: "Another idea" }, options: { ...form.options, budgetLimit: 1, pauseAfterPlan: !form.options.pauseAfterPlan } })).toBe(preset.id);
    }
  });

  it("starts a new book as the novella: the numbers a book starts with are the ones of that preset", () => {
    expect(presetOfForm({ brief: DEFAULT_BRIEF, options: DEFAULT_OPTIONS })).toBe("novella");
  });
});

describe("the estimate of the form", () => {
  it.each(AUTOPILOT_PRESETS)("is, for «$id», the estimate of the engine called with the inputs of the form and of the book", (preset) => {
    const activities = [stepOf("write", 0), stepOf("plan", 1)];
    const sources = sourcesOf({ activities, book: { read: true, directorRounds: 3, directorFile: true, context: { designWords: 400, ghostwriterWords: 220 }, designWritten: true, readerPanelSize: 6, outline: { entries: 2, lastChapter: 2, words: 90 } } });
    const form = applyPreset(FORM, preset.id);
    const { estimate } = estimateRun(sources, form);
    const expected = engineSays(sources, form, {
      outline: { entries: 2, lastChapter: 2, words: 90 },
      progress: { conceptDone: true },
      context: { designWords: 400, ghostwriterWords: 220 },
    });
    expect(estimate).toEqual(expected);
  });

  it("uses the rounds the director of the book has, and not the ones a preset recommends: a preset never writes director.md", () => {
    const novel = applyPreset(FORM, "novel-draft");
    const one = estimateRun(sourcesOf({ book: { ...sourcesOf().book, directorRounds: 1 } }), novel).estimate;
    const three = estimateRun(sourcesOf({ book: { ...sourcesOf().book, directorRounds: 3 } }), novel).estimate;
    expect(three.calls.max).toBeGreaterThan(one.calls.max);
    expect(three.calls.min).toBe(one.calls.min);
  });

  it("is made with typical sizes, and says what the engine says, for a book whose files could not be read", () => {
    const sources = sourcesOf({ book: { read: false, directorFile: false, context: {}, designWritten: false } });
    expect(estimateRun(sources, FORM).estimate).toEqual(engineSays(sources, FORM));
  });

  it("counts only what is left of a book that is started, from its state", () => {
    const state: AutopilotState = { ...createAutopilotState(new Date("2026-11-20T10:00:00Z")), plan: planOf(longPlan(12, 4)), concept: { ...createAutopilotState(new Date()).concept, done: true } };
    const sources = sourcesOf({ state });
    const form = { ...FORM, brief: { ...FORM.brief, targetChapters: 12 } };
    const { estimate } = estimateRun(sources, form);
    expect(estimate.chaptersToWrite).toBe(8);
    expect(estimate).toEqual(engineSays(sources, form, { progress: estimateProgressFromState(state), context: estimateContextFromState(state) }));
    const fresh = estimateRun(sourcesOf(), form).estimate;
    expect(estimate.calls.max).toBeLessThan(fresh.calls.max);
  });

  it("counts only the new chapters when the settings ask for more than a finished book has", () => {
    const chapters: PlannedChapter[] = longPlan(12, 12);
    const state: AutopilotState = { ...createAutopilotState(new Date("2026-11-20T10:00:00Z")), status: "completed", plan: planOf(chapters), finalDone: true, concept: { ...createAutopilotState(new Date()).concept, done: true } };
    const form = { ...FORM, brief: { ...FORM.brief, targetChapters: 16 } };
    const { estimate } = estimateRun(sourcesOf({ state }), form);
    expect(estimate.chapters).toBe(16);
    expect(estimate.chaptersToWrite).toBe(4);
    expect(estimateRun(sourcesOf({ state }), { ...form, brief: { ...form.brief, targetChapters: 12 } }).estimate.chaptersToWrite).toBe(0);
  });

  it("reads the chapters of a book that never started: the ones with prose are done, and each one with no summary costs a call before the plan", () => {
    const chapters = [{ paragraphs: [{}, {}], summary: "It begins." }, { paragraphs: [{}] }, { paragraphs: [{}], summary: "" }, { paragraphs: [] }];
    const sources = sourcesOf({ chapters });
    const { estimate } = estimateRun(sources, FORM);
    expect(estimateProgressFromChapters(chapters)).toEqual({ chaptersDone: 3, withoutSummary: 2 });
    expect(estimate).toEqual(engineSays(sources, FORM, { progress: estimateProgressFromChapters(chapters) }));
    expect(estimate.steps["summarize-imported"].calls.min).toBe(2);
  });

  it("has no concept step for a book that has a plan, whatever the flag of its state says: the planner does not plan before the concept", () => {
    const state: AutopilotState = { ...createAutopilotState(new Date("2026-11-20T10:00:00Z")), plan: planOf(longPlan(12, 4)) };
    expect(state.concept.done).toBe(false);
    expect(estimateRun(sourcesOf({ state }), { ...FORM, brief: { ...FORM.brief, targetChapters: 12 } }).estimate.steps.concept.calls.max).toBe(0);
  });

  it("has no concept step for a book whose story design the author wrote, or whose state says it is done", () => {
    const withConcept = estimateRun(sourcesOf(), FORM).estimate;
    const written = estimateRun(sourcesOf({ book: { ...sourcesOf().book, designWritten: true } }), FORM).estimate;
    expect(withConcept.steps.concept.calls.min).toBe(1);
    expect(written.steps.concept.calls.min).toBe(0);
  });

  it("gives the engine the outline of the author, which can make the book longer than the brief says", () => {
    const sources = sourcesOf({ book: { ...sourcesOf().book, outline: { entries: 20, lastChapter: 20, words: 1200 } } });
    const { estimate } = estimateRun(sources, FORM);
    expect(estimate.chapters).toBe(20);
    expect(estimate.warnings.map((warning) => warning.code)).toContain("outlineLongerThanBrief");
  });

  it("counts the canon from the entries the book has, at the size the engine gives its typical manifest of ten, and leaves the typical manifest to a book that has none yet", () => {
    const sources = sourcesOf({ canonEntries: 40 });
    const { estimate } = estimateRun(sources, FORM);
    expect(estimate).toEqual(engineSays(sources, FORM, { context: { canonWords: Math.round((40 * ESTIMATE_TYPICAL.canonWords) / 10) } }));
    expect(estimate.inputTokens.max).toBeGreaterThan(estimateRun(sourcesOf({ canonEntries: 1 }), FORM).estimate.inputTokens.max);
    expect(estimateRun(sourcesOf({ canonEntries: 0 }), FORM).estimate).toEqual(engineSays(sourcesOf(), FORM));
  });

  it("knows the minutes only from the speed the book measured, and says which models it learned it from", () => {
    const none = estimateRun(sourcesOf(), FORM);
    expect(none.estimate.minutes).toBeNull();
    expect(none.estimate.unmeasured.length).toBeGreaterThan(0);
    expect(none.basis.measuredModels).toEqual([]);
    const measured = estimateRun(sourcesOf({ activities: [stepOf("plan", 0), stepOf("scenes", 1), stepOf("director-review", 2)] }), FORM);
    expect(measured.estimate.minutes).not.toBeNull();
    expect(measured.basis.measuredModels).toEqual(["writer-1"]);
    expect(measured.basis.hasRun).toBe(true);
    // The step that makes two calls records the model of the last one: it is no sample of the speed of the writer.
    const only = estimateRun(sourcesOf({ activities: [stepOf("write", 0), stepOf("repair", 1)] }), FORM);
    expect(only.estimate.minutes).toBeNull();
  });

  it("knows no cost for a model with no price, and never zero", () => {
    const { estimate } = estimateRun(sourcesOf({ ai: { aiIntegrations: [LOCAL], defaultWritingIntegrationId: "home" } }), FORM);
    expect(estimate.cost).toBeNull();
    expect(estimate.unpriced.length).toBeGreaterThan(0);
    expect(estimate.calls.max).toBeGreaterThan(0);
    expect(estimate.inputTokens.max).toBeGreaterThan(0);
  });

  it("passes the tokens a word the book measured, once it has written some", () => {
    const writes = [0, 1, 2, 3].map((at) => stepOf("write", at, { summary: "1000 words — The keeper climbs.", usage: { inputTokens: 4000, outputTokens: 1500, cachedInputTokens: 0 } }));
    const measured = estimateRun(sourcesOf({ activities: writes }), FORM);
    expect(measured.basis.tokensPerWord).toEqual({ value: 1.5, samples: 4 });
    const guessed = estimateRun(sourcesOf(), FORM);
    expect(measured.estimate.outputTokens.max).toBeLessThan(guessed.estimate.outputTokens.max);
    expect(measured.estimate).toEqual(engineSays(sourcesOf({ activities: writes }), FORM, { tokensPerWord: 1.5 }));
  });
});

describe("the tokens a word a book measured", () => {
  const write = (at: number, words: number, outputTokens: number, patch: Partial<AutopilotActivity> = {}) => stepOf("write", at, { summary: `${words} words — The keeper climbs.`, usage: { inputTokens: 4000, outputTokens, cachedInputTokens: 0 }, ...patch });

  it("is the median of the scenes the book wrote, as the tokens of each over its words", () => {
    expect(measuredTokensPerWord([write(0, 1000, 1400), write(1, 1000, 1500), write(2, 1000, 3000)])).toEqual({ value: 1.5, samples: 3 });
    expect(measuredTokensPerWord([write(0, 1000, 1400), write(1, 1000, 1500), write(2, 1000, 1600), write(3, 500, 1100)])?.value).toBeCloseTo(1.55, 5);
  });

  it("needs three scenes to say anything: one is an accident", () => {
    expect(measuredTokensPerWord([])).toBeNull();
    expect(measuredTokensPerWord([write(0, 1000, 1500), write(1, 1000, 1500)])).toBeNull();
  });

  it("leaves out the steps that tell nothing: not written, not a scene, no tokens, no words said, a scene of a few words", () => {
    const good = [write(0, 1000, 1500), write(1, 1000, 1500), write(2, 1000, 1500)];
    const noise = [
      write(3, 1000, 9000, { status: "failed" }),
      stepOf("plan", 4, { summary: "1000 words — not a scene", usage: { inputTokens: 1, outputTokens: 9000, cachedInputTokens: 0 } }),
      write(5, 1000, 0),
      stepOf("write", 6, { summary: "A scene", usage: { inputTokens: 1, outputTokens: 900, cachedInputTokens: 0 } }),
      write(7, 20, 900),
      stepOf("write", 8, { summary: "1000 words — x", usage: undefined }),
    ];
    expect(measuredTokensPerWord([...good, ...noise])).toEqual({ value: 1.5, samples: 3 });
  });

  it("reads the latest scenes: a book that changed its model is measured on the new one", () => {
    const old = Array.from({ length: 30 }, (_, at) => write(at, 1000, 3000));
    const now = Array.from({ length: 20 }, (_, at) => write(100 + at, 1000, 1200));
    expect(measuredTokensPerWord([...old, ...now])).toEqual({ value: 1.2, samples: 20 });
  });
});

describe("the models of a book that runs on the personal server", () => {
  const status = (patch: Partial<ServerAiStatus> = {}): ServerAiStatus => ({
    configured: true, updatedAt: "2026-11-20T10:00:00.000Z", routedTasks: ["autopilot"],
    integrations: [
      { id: "cloud", name: "Cloud", provider: "openai", endpoint: "https://api.example.test/v1", hasApiKey: true, models: [{ name: "writer-1", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 64_000, maxOutputTokens: 8000 }] },
      { id: "home", name: "Home", provider: "openai", endpoint: "http://127.0.0.1:8080/v1", hasApiKey: false, models: [{ name: "llama-local", capabilities: ["autopilot", "director"], supportsToolCalls: true, supportsReasoning: true }] },
    ],
    taskRouting: { autopilot: { primary: { integrationId: "home", model: "llama-local" }, fallbacks: [{ integrationId: "cloud", model: "writer-1" }] } },
    toolsOnly: true,
    ...patch,
  });
  const browser: AiRuntimeConfig = { ...CONFIG, taskRouting: { autopilot: { primary: { integrationId: "cloud", model: "writer-1" }, fallbacks: [] } } };

  it("are the server's models and routes: its configuration can differ from the browser's", () => {
    const config = configFromServerStatus(status(), browser);
    const models = estimateModelsFromConfig(config);
    expect(models.autopilot?.model).toBe("llama-local");
    expect(models.director?.model).toBe("llama-local");
    expect(models.autopilot?.supportsReasoning).toBe(true);
    expect(models["simple-tasks"]?.model).toBe("writer-1");
    // What the browser would have used is not what runs.
    expect(estimateModelsFromConfig(browser).autopilot?.model).toBe("writer-1");
  });

  it("have the window and the limit the server says, and the price this browser knows for the same integration and model: the server's view carries none", () => {
    const models = estimateModelsFromConfig(configFromServerStatus(status(), browser));
    expect(models["simple-tasks"]).toMatchObject({ model: "writer-1", maxInputTokens: 64_000, maxOutputTokens: 8000, pricing: { inputPerMTok: 2, outputPerMTok: 8 } });
    // The model the browser does not have is not priced: it is not made up.
    expect(models.autopilot?.pricing).toBeUndefined();
  });

  it("do not take a price from a model of the same name in another integration", () => {
    const other: AiRuntimeConfig = { aiIntegrations: [{ ...CLOUD, id: "elsewhere" }], defaultWritingIntegrationId: "elsewhere" };
    expect(estimateModelsFromConfig(configFromServerStatus(status(), other))["simple-tasks"]?.pricing).toBeUndefined();
  });

  it("carry no key and no secret of the browser's configuration", () => {
    const config = configFromServerStatus(status(), browser);
    expect(JSON.stringify(config)).not.toContain("sk-secret");
    expect(config.aiIntegrations.every((integration) => integration.apiKey === "")).toBe(true);
  });

  it("are none when the server has no AI configuration: the run would stop at its first step", () => {
    const config = configFromServerStatus({ configured: false, integrations: [], routedTasks: [], updatedAt: null }, browser);
    expect(estimateModelsFromConfig(config)).toEqual({});
    const { estimate } = estimateRun(sourcesOf({ ai: config, aiFrom: "server" }), FORM);
    expect(estimate.warnings.filter((warning) => warning.code === "noModel").map((warning) => warning.severity)).toEqual(new Array(6).fill("error"));
  });

  it("read a server that says nothing of its routes as one with none, and one whose routes name a model it does not have as without that route", () => {
    const quiet = configFromServerStatus(status({ taskRouting: undefined, routedTasks: [] }), browser);
    expect(estimateModelsFromConfig(quiet).autopilot?.model).toBeDefined();
    const broken = configFromServerStatus(status({ taskRouting: { autopilot: { primary: { integrationId: "gone", model: "nope" }, fallbacks: [] } } }), browser);
    expect(estimateModelsFromConfig(broken).autopilot).toBeUndefined();
  });
});

describe("the warnings, grouped the way an author reads them", () => {
  it("says once that no model is set, for every role that lacks one", () => {
    const { estimate } = estimateRun(sourcesOf({ ai: null }), FORM);
    const groups = groupWarnings(estimate.warnings);
    const missing = groups.filter((group) => group.code === "noModel");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ severity: "error", capabilities: ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"] });
  });

  it("says once, for a model that serves every role, that it has no price, no speed or that it reasons", () => {
    const model = { id: "l1", name: "thinker", capabilities: ["default"], supportsToolCalls: true, supportsReasoning: true };
    const config: AiRuntimeConfig = { aiIntegrations: [{ ...LOCAL, chatModels: [model] }], defaultWritingIntegrationId: "home" };
    const { estimate } = estimateRun(sourcesOf({ ai: config }), FORM);
    const groups = groupWarnings(estimate.warnings);
    for (const code of ["noPrice", "noSpeed", "reasoningModel"]) {
      const found = groups.filter((group) => group.code === code);
      expect(found, code).toHaveLength(1);
      expect(found[0]).toMatchObject({ model: "thinker", capabilities: ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"] });
    }
  });

  it("separates the models: two models with no price are two lines", () => {
    const config: AiRuntimeConfig = {
      aiIntegrations: [{ ...LOCAL, chatModels: [{ id: "a", name: "alpha", capabilities: ["default", "autopilot"] }, { id: "b", name: "beta", capabilities: ["director", "review"] }] }],
      defaultWritingIntegrationId: "home",
      taskRouting: { director: { primary: { integrationId: "home", model: "beta" }, fallbacks: [] }, review: { primary: { integrationId: "home", model: "beta" }, fallbacks: [] } },
    };
    const groups = groupWarnings(estimateRun(sourcesOf({ ai: config }), FORM).estimate.warnings).filter((group) => group.code === "noPrice");
    expect(groups.map((group) => ("model" in group ? group.model : "")).sort()).toEqual(["alpha", "beta"]);
  });

  it("keeps each window, each limit and the outline as the engine says them, with the engine's own words", () => {
    const small = { id: "s", name: "small-8k", capabilities: ["default"], supportsToolCalls: true, maxInputTokens: 8000, maxOutputTokens: 2000, pricing: { inputPerMTok: 1, outputPerMTok: 1 } };
    const config: AiRuntimeConfig = { aiIntegrations: [{ ...LOCAL, chatModels: [small] }], defaultWritingIntegrationId: "home" };
    const { estimate } = estimateRun(sourcesOf({ ai: config, book: { ...sourcesOf().book, outline: { entries: 20, lastChapter: 20, words: 900 } } }), FORM);
    const groups = groupWarnings(estimate.warnings);
    const windows = groups.filter((group) => group.code === "smallWindow");
    expect(windows.length).toBeGreaterThan(0);
    for (const group of windows) expect(group).toMatchObject({ severity: "error", text: expect.stringContaining("small-8k") });
    expect(groups.some((group) => group.code === "smallOutput")).toBe(true);
    expect(groups.find((group) => group.code === "outlineLongerThanBrief")).toMatchObject({ severity: "info", text: estimate.warnings.find((warning) => warning.code === "outlineLongerThanBrief")?.text });
  });

  it("puts what stops the run before what only changes a figure, and that before what is only a note", () => {
    const config: AiRuntimeConfig = { aiIntegrations: [{ ...LOCAL, chatModels: [{ id: "s", name: "small", capabilities: ["default"], supportsReasoning: true, maxInputTokens: 8000 }] }], defaultWritingIntegrationId: "home" };
    const groups = groupWarnings(estimateRun(sourcesOf({ ai: config }), FORM).estimate.warnings);
    const order = { error: 0, warning: 1, info: 2 } as const;
    expect(groups.map((group) => order[group.severity])).toEqual([...groups.map((group) => order[group.severity])].sort((a, b) => a - b));
    expect(groups[0].severity).toBe("error");
  });
});

describe("the calls by role", () => {
  it("are five rows, readers and their summary in one, and add up to the total of the run", () => {
    const { estimate } = estimateRun(sourcesOf(), FORM);
    const roles = callsByRole(estimate);
    expect(roles.map((role) => role.role)).toEqual(["writer", "director", "readers", "specialists", "summaries"]);
    expect(roles.reduce((sum, role) => sum + role.calls.min, 0)).toBe(estimate.calls.min);
    expect(roles.reduce((sum, role) => sum + role.calls.max, 0)).toBe(estimate.calls.max);
    const readers = roles.find((role) => role.role === "readers")!;
    expect(readers.calls.max).toBe(estimate.capabilities["reader-evaluation"].calls.max + estimate.capabilities["reader-evaluation-summary"].calls.max);
  });

  it("leave out a role that makes no call, and say which model each one asks and which has none", () => {
    const form = { ...FORM, options: { ...FORM.options, readers: false, readersOnPlan: false, specialists: false } };
    const roles = callsByRole(estimateRun(sourcesOf(), form).estimate);
    expect(roles.map((role) => role.role)).toEqual(["writer", "director", "summaries"]);
    expect(roles[0].models).toEqual(["writer-1"]);
    const none = callsByRole(estimateRun(sourcesOf({ ai: null }), form).estimate);
    expect(none.every((role) => role.models.length === 0)).toBe(true);
  });
});

describe("what the estimate does not need", () => {
  it("is in memory and fast, also for a book of five thousand chapters", () => {
    const form = { ...FORM, brief: { ...FORM.brief, targetChapters: 5000 } };
    const started = performance.now();
    for (let index = 0; index < 20; index += 1) estimateRun(sourcesOf(), form);
    expect((performance.now() - started) / 20).toBeLessThan(50);
  });

  it("does not change what it is given", () => {
    const sources = sourcesOf({ activities: [stepOf("plan", 0)], book: { ...sourcesOf().book, outline: { entries: 1, lastChapter: 1, words: 10 } } });
    const before = JSON.stringify({ sources, FORM });
    estimateRun(sources, FORM);
    expect(JSON.stringify({ sources, FORM })).toBe(before);
  });
});
