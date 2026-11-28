import {
  DEFAULT_BRIEF,
  DEFAULT_OPTIONS,
  ESTIMATE_TYPICAL,
  TWO_CALL_TASKS,
  estimateAutopilotRun,
  estimateContextFromState,
  estimateModelsFromConfig,
  estimateProgressFromChapters,
  estimateProgressFromState,
  measuredSpeed,
  type AiChatModelConfig,
  type AiIntegrationConfig,
  type AiRouteTarget,
  type AiRuntimeConfig,
  type AiTaskRoute,
  type AutopilotActivity,
  type AutopilotBrief,
  type AutopilotOptions,
  type AutopilotState,
  type DesignWorkflow,
  type EstimateCapability,
  type EstimateContext,
  type EstimateDesign,
  type EstimateProgress,
  type EstimateResult,
  type EstimateWarning,
  type ReviewPolicy,
  type ServerAiStatus,
} from "narrarium-engine";
import type { EstimateBook } from "@/autopilot/runEstimateBook";

/**
 * The brief and the options as the author has them in the form, saved or not. The chapters are the Scaletta's (`outline`), and the scenes a chapter has are the
 * planner's: `scenesPerChapter` is only the hint the estimate takes (its middle when it is missing).
 */
export interface SetupFormValues {
  brief: AutopilotBrief;
  options: AutopilotOptions;
  scenesPerChapter?: number;
}

// ─── What was measured on the book ───────────────────────────────────────────

export interface MeasuredTokens {
  /** Tokens a word the models wrote, as the median of the latest scenes. */
  value: number;
  samples: number;
}

/** Scenes the factor is measured on, and how few tell something. */
const TOKEN_SAMPLES = 20;
const TOKEN_MIN_SAMPLES = 3;
/** A scene shorter than this is mostly the call that summarizes it. */
const TOKEN_MIN_WORDS = 100;
/** The write step says how long the scene is in its summary: `640 words — …`, whatever the language of the book. */
const WORDS_OF_SCENE = /^\s*(\d+)\s+words\b/;

function momentOf(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

/**
 * The tokens a word costs on this book, from the scenes it wrote: the tokens a step of writing spent over the words of the scene it says it wrote, the median of the latest ones.
 * A step of writing is the scene and then its summary, so the figure is a little high (a summary is a few dozen words): the estimate leans to the prudent side, as it does anyway.
 * It tells nothing from fewer than three scenes, and `null` is what says so.
 */
export function measuredTokensPerWord(activities: readonly Partial<AutopilotActivity>[] | null | undefined): MeasuredTokens | null {
  if (!Array.isArray(activities)) return null;
  const samples: Array<{ ended: number; ratio: number }> = [];
  for (const entry of activities) {
    if (!entry || entry.task !== "write" || entry.status !== "succeeded") continue;
    const written = entry.usage?.outputTokens;
    const words = typeof entry.summary === "string" ? Number(WORDS_OF_SCENE.exec(entry.summary)?.[1]) : Number.NaN;
    if (typeof written !== "number" || !Number.isFinite(written) || written <= 0 || !Number.isFinite(words) || words < TOKEN_MIN_WORDS) continue;
    samples.push({ ended: momentOf(entry.endedAt ?? entry.startedAt), ratio: written / words });
  }
  const latest = samples.map((sample, order) => ({ ...sample, order })).sort((left, right) => left.ended - right.ended || left.order - right.order).slice(-TOKEN_SAMPLES);
  if (latest.length < TOKEN_MIN_SAMPLES) return null;
  const ratios = latest.map((sample) => sample.ratio).sort((left, right) => left - right);
  const middle = ratios.length >> 1;
  return { value: ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2, samples: latest.length };
}

// ─── The models of a book that runs on the personal server ───────────────────

function targetOf(target: { integrationId: string; model: string; thinking?: AiRouteTarget["thinking"] }): AiRouteTarget {
  return { integrationId: target.integrationId, model: target.model, ...(target.thinking ? { thinking: target.thinking } : {}) };
}

/**
 * The AI configuration of the personal server as the estimate reads it: its integrations, its models with the window and the limits it declares, and its routes. The server tells
 * the web app a safe view of it (`GET /api/v1/ai`: no key, no price), so what the price of a model is comes from this browser, for the same integration and the same model name (and
 * from nowhere else: a model the browser does not know has no price, and the cost of the run is not known). Nothing of the browser's configuration is copied that the estimate does
 * not read, and no key.
 */
export function configFromServerStatus(status: ServerAiStatus, known: AiRuntimeConfig | null): AiRuntimeConfig {
  const mine = new Map((known?.aiIntegrations ?? []).map((integration) => [integration.id, integration]));
  const aiIntegrations: AiIntegrationConfig[] = (Array.isArray(status.integrations) ? status.integrations : []).map((integration) => {
    const same = mine.get(integration.id);
    const chatModels: AiChatModelConfig[] = (integration.models ?? []).map((model) => {
      const counterpart = same?.chatModels?.find((candidate) => candidate.name === model.name);
      return {
        id: model.name,
        name: model.name,
        capabilities: model.capabilities ?? [],
        ...(model.supportsToolCalls !== undefined ? { supportsToolCalls: model.supportsToolCalls } : {}),
        ...(model.supportsReasoning !== undefined ? { supportsReasoning: model.supportsReasoning } : {}),
        ...(model.maxInputTokens ? { maxInputTokens: model.maxInputTokens } : {}),
        ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
        ...(counterpart?.pricing ? { pricing: counterpart.pricing } : {}),
        ...(counterpart?.underlyingModel ? { underlyingModel: counterpart.underlyingModel } : {}),
      };
    });
    return {
      id: integration.id,
      name: integration.name,
      provider: integration.provider,
      ...(integration.endpoint ? { endpoint: integration.endpoint } : {}),
      apiKey: "",
      ...(integration.thinking ? { thinking: integration.thinking } : {}),
      ...(same?.pricing ? { pricing: same.pricing } : {}),
      chatModels,
    };
  });
  const taskRouting: Record<string, AiTaskRoute> = {};
  for (const [task, route] of Object.entries(status.taskRouting ?? {})) {
    if (!route) continue;
    taskRouting[task] = { ...(route.primary ? { primary: targetOf(route.primary) } : {}), fallbacks: (route.fallbacks ?? []).map(targetOf) };
  }
  const has = (id: string | undefined) => Boolean(id && aiIntegrations.some((integration) => integration.id === id));
  return {
    aiIntegrations,
    taskRouting,
    ...(has(known?.defaultWritingIntegrationId) ? { defaultWritingIntegrationId: known?.defaultWritingIntegrationId } : {}),
    ...(has(known?.defaultReviewIntegrationId) ? { defaultReviewIntegrationId: known?.defaultReviewIntegrationId } : {}),
    ...(status.toolsOnly !== undefined ? { toolsOnly: status.toolsOnly } : {}),
  };
}

// ─── The estimate of the form ────────────────────────────────────────────────

/** Where the models of the estimate come from: this browser (which makes the calls), the personal server (which does), or this browser standing in for a server that could not be asked. */
export type ModelsFrom = "browser" | "server" | "browser-for-server";

export interface EstimateSources {
  book: EstimateBook;
  /** The language of the book, as `book.md` says. */
  language?: string;
  currency?: string;
  /** The configuration of the models that will run the book. `null`: there is none. */
  ai: AiRuntimeConfig | null;
  aiFrom: ModelsFrom;
  /** The log of the steps the book ran (the last 200). */
  activities: readonly AutopilotActivity[];
  /** The autopilot of the book, once it was configured or started. */
  state: AutopilotState | null;
  /** The chapters of the book, for one the autopilot has not planned yet. */
  chapters: ReadonlyArray<{ summary?: string | null; paragraphs?: ReadonlyArray<unknown> | null }> | null;
  /** The entries of the canon the book has (the characters, the places, the factions, the items and the timeline). */
  canonEntries: number;
  /** The share of the input of each model that its provider served from its cache in the calls this browser recorded (`cacheHitRates`), by the name of the model: what the best case counts on. Absent: none was measured. */
  cacheRates?: Readonly<Record<string, number>>;
}

export interface EstimateBasis {
  /** The book ran steps: the log has some. */
  hasRun: boolean;
  /** The models whose speed was measured on this book, and the steps that tell it. */
  measuredModels: string[];
  speedSamples: number;
  /** The tokens a word the book measured, when it has written enough. */
  tokensPerWord?: MeasuredTokens;
  /** The estimate counts what is left of a book the autopilot planned. */
  fromState: boolean;
  /**
   * What the best case counts on from the models' prompt caches, for the models that are asked: the share each was measured to serve from its cache (in per cent), and whether the fixed start of the
   * requests is counted at the cached price too. Absent when nothing is counted on a cache.
   */
  caching?: { measured: Array<{ model: string; percent: number }>; structural: boolean };
}

export interface RunEstimate {
  estimate: EstimateResult;
  basis: EstimateBasis;
}

function progressOf(sources: EstimateSources): EstimateProgress {
  const { state, chapters, book } = sources;
  const planned = Boolean(state?.plan?.chapters?.length);
  const progress: EstimateProgress = planned ? estimateProgressFromState(state) : chapters ? estimateProgressFromChapters(chapters) : {};
  // The concept is done when the state says so, when there is a plan (the planner does not plan before the concept), and when the author wrote the story design (it skips it then).
  return planned || state?.concept?.done === true || book.designWritten ? { ...progress, conceptDone: true } : progress;
}

/** What a canon of `entries` weighs: the engine's typical manifest is about ten entries. */
function canonWordsOf(entries: number): number {
  return Math.round((entries * ESTIMATE_TYPICAL.canonWords) / 10);
}

/**
 * The estimate of a run, with the form as it is now and everything known of the book: the engine's own estimate, called with the models of the book (and the speed they were
 * measured at on it), its director's rounds, its outline, where it is (a book that started counts only what is left, one that grows only the new chapters), the sizes of its files
 * and the readers of its panel. It reads nothing and changes nothing, and it is fast enough to be made at every pause in the typing, for a book of any length.
 */
export function estimateRun(sources: EstimateSources, form: SetupFormValues, override?: { progress?: EstimateProgress; design?: EstimateDesign }): RunEstimate {
  const speeds = measuredSpeed(sources.activities, { ignoreTasks: TWO_CALL_TASKS });
  const tokens = measuredTokensPerWord(sources.activities);
  const models = estimateModelsFromConfig(sources.ai, speeds, sources.cacheRates);
  const context: EstimateContext = {
    ...sources.book.context,
    ...(sources.state ? estimateContextFromState(sources.state) : {}),
    ...(sources.canonEntries > 0 ? { canonWords: canonWordsOf(sources.canonEntries) } : {}),
  };
  const estimate = estimateAutopilotRun({
    brief: form.brief,
    ...(form.scenesPerChapter !== undefined ? { scenesPerChapter: form.scenesPerChapter } : {}),
    options: form.options,
    maxReviewRounds: sources.book.directorRounds,
    language: sources.language,
    currency: sources.currency,
    models,
    outline: sources.book.outline,
    progress: override?.progress ?? progressOf(sources),
    context,
    readerPanelSize: sources.book.readerPanelSize,
    ...(tokens ? { tokensPerWord: tokens.value } : {}),
    ...(override?.design ? { design: override.design } : {}),
  });
  const measured = [...new Set(Object.values(models).flatMap((model) => (model && speeds.has(model.model) ? [model.model] : [])))];
  const caching = cachingOf(estimate, models);
  return {
    estimate,
    basis: {
      hasRun: sources.activities.length > 0,
      measuredModels: measured,
      speedSamples: measured.reduce((total, model) => total + (speeds.get(model)?.samples ?? 0), 0),
      ...(tokens ? { tokensPerWord: tokens } : {}),
      fromState: Boolean(sources.state?.plan?.chapters?.length),
      ...(caching ? { caching } : {}),
    },
  };
}

/** What the estimate counts on from the prompt caches of the models it asks: the measured shares, and whether it counts the fixed start of the requests. `undefined` when it counts on none. */
function cachingOf(estimate: EstimateResult, models: ReturnType<typeof estimateModelsFromConfig>): EstimateBasis["caching"] {
  const measured = new Map<string, number>();
  let structural = false;
  for (const capability of Object.keys(estimate.capabilities) as EstimateCapability[]) {
    const result = estimate.capabilities[capability];
    if (!result.model || result.calls.max === 0) continue;
    if (result.cacheBasis === "measured") measured.set(result.model, Math.round((models[capability]?.cacheHitRate ?? 0) * 100));
    else if (result.cacheBasis === "structural" && result.cachedInputTokens.min > 0) structural = true;
  }
  return measured.size || structural ? { measured: [...measured].map(([model, percent]) => ({ model, percent })), structural } : undefined;
}

// ─── The rest of a plan that waits for the author ────────────────────────────

/** The warnings that matter when a plan waits for the author: the ones that stop the run (no model, a window too small) or cut a reply short. What the figures already say, or is about something else, is the full preview's. */
export const REST_WARNING_CODES = ["noModel", "smallWindow", "smallOutput"] as const;

/**
 * A problem of the models, said once for what it is about and not once for every capability the engine counted it for: a model whose window is too small for every role is one problem,
 * with its roles and the worst of its numbers (the largest prompt, the longest reply).
 */
export type RestProblem =
  | { code: "noModel"; severity: "error"; capabilities: EstimateCapability[] }
  | { code: "smallWindow"; severity: "error" | "warning"; model: string; window: number; /** The model declares no window: it is the default one (`modelWindow`). */ windowDefault: boolean; prompt: number; capabilities: EstimateCapability[] }
  | { code: "smallOutput"; severity: "warning"; model: string; limit: number; reply: number; capabilities: EstimateCapability[] };

const RANK: Record<EstimateWarning["severity"], number> = { error: 0, warning: 1, info: 2 };

/** The problems of the models in the warnings of an estimate, in the order of their gravity (what stops the run first). */
export function restProblems(warnings: readonly EstimateWarning[]): RestProblem[] {
  const found: RestProblem[] = [];
  const known = new Map<string, RestProblem>();
  for (const warning of warnings) {
    if (warning.code === "noModel") {
      const same = known.get("noModel");
      if (same) same.capabilities.push(warning.capability);
      else {
        const problem: RestProblem = { code: "noModel", severity: "error", capabilities: [warning.capability] };
        known.set("noModel", problem);
        found.push(problem);
      }
    } else if (warning.code === "smallWindow") {
      const key = `smallWindow\n${warning.model}\n${warning.window}\n${warning.windowDefault === true}`;
      const same = known.get(key);
      if (same?.code === "smallWindow") {
        same.capabilities.push(warning.capability);
        same.prompt = Math.max(same.prompt, warning.typicalPrompt);
        if (warning.severity === "error") same.severity = "error";
      } else {
        const problem: RestProblem = { code: "smallWindow", severity: warning.severity === "error" ? "error" : "warning", model: warning.model, window: warning.window, windowDefault: warning.windowDefault === true, prompt: warning.typicalPrompt, capabilities: [warning.capability] };
        known.set(key, problem);
        found.push(problem);
      }
    } else if (warning.code === "smallOutput") {
      const key = `smallOutput\n${warning.model}\n${warning.maxOutputTokens}`;
      const same = known.get(key);
      if (same?.code === "smallOutput") {
        same.capabilities.push(warning.capability);
        same.reply = Math.max(same.reply, warning.typicalReply);
      } else {
        const problem: RestProblem = { code: "smallOutput", severity: "warning", model: warning.model, limit: warning.maxOutputTokens, reply: warning.typicalReply, capabilities: [warning.capability] };
        known.set(key, problem);
        found.push(problem);
      }
    }
  }
  return found.map((problem, order) => ({ problem, order })).sort((left, right) => RANK[left.problem.severity] - RANK[right.problem.severity] || left.order - right.order).map(({ problem }) => problem);
}

/**
 * The scenes a chapter of the rest of a plan is expected to have: the scenes the plan planned for the chapters left (their average, rounded, in the planner's range of
 * 2 to 4), and the middle of the range for a chapter the plan has not planned yet. `undefined` when the plan has no chapter left to count.
 */
export function restScenesPerChapter(state: Pick<AutopilotState, "plan">): number | undefined {
  const left = (state.plan?.chapters ?? []).filter((entry) => entry.status !== "done");
  if (left.length === 0) return undefined;
  const scenes = left.reduce((total, entry) => total + (entry.scenes.length > 0 ? entry.scenes.length : 3), 0) / left.length;
  return Math.min(4, Math.max(2, Math.round(scenes)));
}

/**
 * What the rest of the run will cost, for a plan that waits for the author: the estimate of the setup form's preview, with its models, its director, its outline and its files, but for
 * the plan as it is (its chapters and its scenes, only the chapters that are left, the options the run has) and not for the numbers of a form. A chapter the author's outline lost
 * before it was written is not one of the book: the outline's last chapter counts it, so it is taken off, as the engine does for the length of the book.
 */
export function estimateRest(sources: EstimateSources, state: AutopilotState): RunEstimate {
  const removed = state.plan?.removedChapters?.length ?? 0;
  const outline = sources.book.outline;
  // The chapters of the book are the Scaletta's, and the plan's when the Scaletta has fewer (a plan made from a book with no entries): a chapter the author's
  // outline lost before it was written is taken off, as the engine does for the length of the book.
  const planned = state.plan?.chapters.length ?? 0;
  const lastChapter = Math.max(Math.max(0, (outline?.lastChapter ?? 0) - removed), planned);
  const book = { ...sources.book, outline: { entries: outline?.entries ?? 0, lastChapter, words: outline?.words ?? 0 } };
  return estimateRun({ ...sources, book, state, chapters: null }, { brief: state.brief, options: state.options, scenesPerChapter: restScenesPerChapter(state) });
}

// ─── A review of the finished book ───────────────────────────────────────────

/**
 * What a round of a review of the finished book will cost (`reviewBook`): the chapters under the target reviewed again (only reviewed: nothing is written, `reviewOnly`), each with
 * up to `maxRounds` rounds and the readers in the first `readerRounds` (0: they do not read again), then the director's judgement of the whole book. The estimate of the setup form,
 * with the models, the files and the log of the book, for the plan as it is. A review of several rounds costs about this for each round.
 */
export function estimateReview(
  sources: EstimateSources,
  state: AutopilotState,
  input: {
    chapters: number;
    maxRounds: number;
    readerRounds: number;
    scenesPerChapter?: number;
    /** The review's targets for the readers, when it has them (`ReviewBookInput`): the readers then read the chapters at their end too, whatever `readerRounds` says. */
    readers?: Pick<ReviewPolicy, "readersTarget" | "readerTargets" | "readersExcluded">;
    /** Of the chapters, how many only need the vote of their readers (the director is content with them): in the least they cost their reading alone. */
    checkOnly?: number;
  },
): RunEstimate {
  const planned = state.plan?.chapters.length ?? 0;
  const chapters = Math.max(0, Math.min(planned, input.chapters));
  const book = { ...sources.book, outline: { entries: sources.book.outline?.entries ?? planned, lastChapter: planned, words: sources.book.outline?.words ?? 0 } };
  const aimed = Boolean(input.readers && (input.readers.readersTarget !== undefined || Object.keys(input.readers.readerTargets ?? {}).length > 0));
  const options = {
    ...state.options,
    // With targets the readers read at the end of a chapter's review even when they do not read at its start (the estimate counts the start too: a little over in that case).
    readers: state.options.readers && (input.readerRounds > 0 || aimed),
    review: { maxRounds: input.maxRounds, readerRounds: Math.max(1, input.readerRounds), ...(aimed ? input.readers : {}) },
  };
  const progress: EstimateProgress = { chaptersDone: planned - chapters, planned, conceptDone: true, finalDone: false, reviewOnly: true, ...(aimed && input.checkOnly ? { checkOnly: Math.min(chapters, input.checkOnly) } : {}) };
  return estimateRun({ ...sources, book, state, chapters: null }, { brief: state.brief, options, ...(input.scenesPerChapter ? { scenesPerChapter: input.scenesPerChapter } : {}) }, { progress });
}

/** The figures of an estimate that can be told apart from another: the calls, the cost (when every call is priced) and the time (when every model is measured). */
export type EstimateFigures = Pick<EstimateResult, "calls" | "cost" | "minutes">;

/**
 * What the targets for the readers add to an estimate: the estimate with them less the one without, range by range (the cost and the time only when both have them).
 * `null` when they add no call (readers that do not read, or nothing left to read).
 */
export function estimateDelta(withTargets: EstimateResult, without: EstimateResult): EstimateFigures | null {
  const range = (left: { min: number; max: number }, right: { min: number; max: number }) => ({ min: Math.max(0, left.min - right.min), max: Math.max(0, left.max - right.max) });
  const calls = range(withTargets.calls, without.calls);
  if (calls.max === 0) return null;
  return {
    calls,
    cost: withTargets.cost && without.cost ? { ...withTargets.cost, ...range(withTargets.cost, without.cost) } : null,
    minutes: withTargets.minutes && without.minutes ? range(withTargets.minutes, without.minutes) : null,
  };
}

/** The same form with the targets for the readers taken out of its review policy: what the run costs without them. */
export function withoutReaderTargets(options: AutopilotOptions): AutopilotOptions {
  if (!options.review) return options;
  const { readersTarget: _target, readerTargets: _each, readersExcluded: _left, ...review } = options.review;
  return { ...options, review: Object.keys(review).length ? review : undefined };
}

/**
 * What a design run will cost (`StartOptions.design`): the concept when it is not done, the design of every chapter not written in batches, its reviews and the readers' readings
 * for the rounds of its policy, nothing written. `chapters` is the length the design asks for (the Synopsis gets the entries it lacks); with `mode: "complete"` («Review and
 * complete») it is the author's chapters it reviews, with no concept and no plan.
 */
export function estimateDesign(sources: EstimateSources, state: AutopilotState | null, input: { chapters: number; maxRounds: number; readerRounds: number; readers: boolean; workflow?: DesignWorkflow; mode?: "complete" }): RunEstimate {
  const entries = sources.book.outline?.entries ?? 0;
  const lastChapter = input.mode === "complete" ? sources.book.outline?.lastChapter ?? input.chapters : Math.max(sources.book.outline?.lastChapter ?? 0, input.chapters);
  const book = { ...sources.book, outline: { entries, lastChapter, words: sources.book.outline?.words ?? 0 } };
  const options = { ...(state?.options ?? {}), readersOnPlan: input.readers };
  const progress: EstimateProgress = { conceptDone: state?.concept?.done === true || sources.book.designWritten === true };
  const design = { maxRounds: input.maxRounds, readerRounds: input.readerRounds, ...(input.workflow ? { workflow: input.workflow } : {}), ...(input.mode === "complete" ? { mode: "complete" as const, chapters: input.chapters } : {}) };
  return estimateRun({ ...sources, book, state, chapters: null }, { brief: state?.brief ?? DEFAULT_BRIEF, options: { ...DEFAULT_OPTIONS, ...options } }, { progress, design });
}

// ─── What an author reads ────────────────────────────────────────────────────

export type RoleId = "writer" | "director" | "readers" | "specialists" | "summaries";

/** The five parts of the work an author knows by name, and the capabilities of the router behind each: the readers read and then summarize. */
export const ROLES: ReadonlyArray<{ role: RoleId; capabilities: readonly EstimateCapability[] }> = [
  { role: "writer", capabilities: ["autopilot"] },
  { role: "director", capabilities: ["director"] },
  { role: "readers", capabilities: ["reader-evaluation", "reader-evaluation-summary"] },
  { role: "specialists", capabilities: ["review"] },
  { role: "summaries", capabilities: ["simple-tasks"] },
];

export function roleOf(capability: EstimateCapability): RoleId {
  return ROLES.find((entry) => entry.capabilities.includes(capability))?.role ?? "writer";
}

export interface RoleCalls {
  role: RoleId;
  calls: { min: number; max: number };
  /** The models asked, by the name the configuration gives them. */
  models: string[];
  /** A capability of the role that makes calls has no model. */
  missing: boolean;
}

/** The calls of the run by role, without the roles that make none. Their sum is the total. */
export function callsByRole(estimate: EstimateResult): RoleCalls[] {
  return ROLES.map(({ role, capabilities }) => {
    const entries = capabilities.map((capability) => estimate.capabilities[capability]).filter((entry) => entry.calls.max > 0);
    return {
      role,
      calls: { min: entries.reduce((total, entry) => total + entry.calls.min, 0), max: entries.reduce((total, entry) => total + entry.calls.max, 0) },
      models: [...new Set(entries.flatMap((entry) => (entry.model ? [entry.model] : [])))],
      missing: entries.some((entry) => entry.model === null),
    };
  }).filter((entry) => entry.calls.max > 0);
}

/**
 * A warning of the estimate as an author reads it. The notes that repeat for every role of one model (no price, no speed, it reasons) are one line for the model, and every role
 * that has no model is one line; the others (a window, a limit) are the engine's own, with its own words.
 */
export type WarningGroup =
  | { code: "noModel"; severity: "error"; capabilities: EstimateCapability[] }
  | { code: "noPrice" | "noSpeed" | "reasoningModel"; severity: EstimateWarning["severity"]; model: string; capabilities: EstimateCapability[] }
  | { code: "smallWindow" | "smallOutput"; severity: EstimateWarning["severity"]; capability: EstimateCapability; model: string; text: string }
  /** A code this page does not know (an engine newer than the page): its own words, with its own gravity. */
  | { code: "other"; severity: EstimateWarning["severity"]; text: string };

const GRAVITY: Record<EstimateWarning["severity"], number> = { error: 0, warning: 1, info: 2 };

export function groupWarnings(warnings: readonly EstimateWarning[]): WarningGroup[] {
  const groups: WarningGroup[] = [];
  const shared = new Map<string, Extract<WarningGroup, { capabilities: EstimateCapability[] }>>();
  for (const warning of warnings) {
    switch (warning.code) {
      case "noModel": {
        const found = shared.get("noModel");
        if (found) found.capabilities.push(warning.capability);
        else {
          const group: WarningGroup = { code: "noModel", severity: "error", capabilities: [warning.capability] };
          shared.set("noModel", group);
          groups.push(group);
        }
        break;
      }
      case "noPrice":
      case "noSpeed":
      case "reasoningModel": {
        const key = `${warning.code}\n${warning.model}`;
        const found = shared.get(key);
        if (found) found.capabilities.push(warning.capability);
        else {
          const group: WarningGroup = { code: warning.code, severity: warning.severity, model: warning.model, capabilities: [warning.capability] };
          shared.set(key, group);
          groups.push(group);
        }
        break;
      }
      case "smallWindow":
      case "smallOutput":
        groups.push({ code: warning.code, severity: warning.severity, capability: warning.capability, model: warning.model, text: warning.text });
        break;
      default: {
        const unknown = warning as { severity?: EstimateWarning["severity"]; text?: unknown };
        const severity = unknown.severity === "error" || unknown.severity === "warning" ? unknown.severity : "info";
        if (typeof unknown.text === "string" && unknown.text) groups.push({ code: "other", severity, text: unknown.text });
      }
    }
  }
  return groups.map((group, order) => ({ group, order })).sort((left, right) => GRAVITY[left.group.severity] - GRAVITY[right.group.severity] || left.order - right.order).map(({ group }) => group);
}
