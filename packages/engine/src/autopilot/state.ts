import { asArray, asBoolean, asInteger, asNumber, asOneOf, asRecord, asString, asStringList } from "../util/json.js";
import { countWords } from "../util/text.js";
import { AUTOPILOT_PUBLISH_MODES } from "./types.js";
import type {
  AutopilotActivity,
  AutopilotBrief,
  AutopilotLimitsSummary,
  AutopilotOptions,
  AutopilotPausePending,
  AutopilotPhase,
  AutopilotPlan,
  AutopilotProgress,
  AutopilotPublishMode,
  AutopilotRunLimits,
  AutopilotState,
  AutopilotStateSummary,
  AutopilotStatus,
  AutopilotTaskKind,
  AuthorIntervention,
  ChapterReview,
  ConceptSecret,
  DirectorQuestion,
  PlannedChapter,
  PlannedScene,
  RevisionRequest,
} from "./types.js";

export const MAX_ACTIVITIES = 200;
export const MAX_INTERVENTIONS = 100;
export const MAX_DIRECTOR_NOTES = 12;
export const MAX_CONSTRAINTS = 80;
/** A rule goes into every request the autopilot makes: longer text is refused, never cut. */
export const MAX_RULE_CHARACTERS = 800;
export const MAX_REVISION_NOTES = 40;
/**
 * Upper bound for any chapter number or chapter count read from a file or a reply. It only guards against typos and
 * garbage: a book has no maximum length, and nothing below this value is ever clamped.
 */
export const MAX_BOOK_CHAPTERS = 100_000;

/** A capped list keeps its newest entries: the author's latest rules matter most. */
function newestList(value: unknown, max: number): string[] {
  return asStringList(value, Number.MAX_SAFE_INTEGER).slice(-max);
}

/** Permanent author rules, newest kept when the cap is reached. */
export function capConstraints(constraints: string[]): string[] {
  return newestList(constraints, MAX_CONSTRAINTS);
}

export type AutopilotRuleErrorCode = "rule_empty" | "rule_too_long" | "rule_not_found" | "rule_changed" | "rule_duplicate";

/** A rule that cannot be saved as asked. The message says why; `code` lets a host say it in the author's language. */
export class AutopilotRuleError extends Error {
  constructor(readonly code: AutopilotRuleErrorCode, message: string, readonly limit?: number) {
    super(message);
    this.name = "AutopilotRuleError";
  }
}

/** The text of a rule without the spaces around it. An empty rule, or one over `MAX_RULE_CHARACTERS`, is refused. */
export function normalizeRuleText(text: string): string {
  const rule = (text ?? "").trim();
  if (!rule) throw new AutopilotRuleError("rule_empty", "The rule is empty.");
  if (rule.length > MAX_RULE_CHARACTERS) {
    throw new AutopilotRuleError("rule_too_long", `The rule is ${rule.length} characters long: a rule is at most ${MAX_RULE_CHARACTERS} characters, because it goes into every request. Shorten it or split it into several rules.`, MAX_RULE_CHARACTERS);
  }
  return rule;
}

export const DEFAULT_BRIEF: AutopilotBrief = {
  idea: "",
  synopsis: "",
  targetChapters: 12,
  scenesPerChapter: 3,
  wordsPerScene: 1400,
  genre: "",
  audience: "",
};

export const DEFAULT_OPTIONS: AutopilotOptions = {
  readers: true,
  maxReaders: 5,
  readersOnPlan: true,
  specialists: true,
  pauseAfterPlan: true,
  pauseAfterEachChapter: false,
  chaptersPerRun: 0,
  budgetLimit: 0,
  budgetTokens: 0,
  syncAfterChapter: true,
};

const STATUSES: AutopilotStatus[] = ["idle", "running", "paused", "waiting-author", "error", "completed"];
const PHASES: AutopilotPhase[] = ["concept", "plan", "write", "review", "final", "completed"];

export function normalizeBrief(value: unknown, base: AutopilotBrief = DEFAULT_BRIEF): AutopilotBrief {
  const source = asRecord(value);
  return {
    idea: asString(source.idea, base.idea),
    synopsis: asString(source.synopsis, base.synopsis),
    targetChapters: asInteger(source.targetChapters, base.targetChapters, 1, MAX_BOOK_CHAPTERS),
    scenesPerChapter: asInteger(source.scenesPerChapter, base.scenesPerChapter, 1, 20),
    wordsPerScene: asInteger(source.wordsPerScene, base.wordsPerScene, 200, 8000),
    genre: asString(source.genre, base.genre),
    audience: asString(source.audience, base.audience),
  };
}

/** The way of publishing a value names, read like every word of the options is (any case, spaces around); `undefined` for anything else. */
function publishModeOf(value: unknown): AutopilotPublishMode | undefined {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (AUTOPILOT_PUBLISH_MODES as readonly string[]).includes(text) ? text as AutopilotPublishMode : undefined;
}

/**
 * Where the book is published now: the author's choice (`options.publishEvery`), else the host's default, else what the older option
 * `syncAfterChapter` says (every chapter when it is on, never when it is off). A value nobody knows is no choice.
 */
export function effectivePublish(options: Partial<Pick<AutopilotOptions, "publishEvery" | "syncAfterChapter">> | null | undefined, defaultPublish?: AutopilotPublishMode): AutopilotPublishMode {
  return publishModeOf(options?.publishEvery) ?? publishModeOf(defaultPublish) ?? (options?.syncAfterChapter ? "chapter" : "off");
}

/**
 * The default of a host that did not say where it publishes: a server publishes after every step, as its hook has always been called
 * (and as `syncAfterChapter` documents: "the server publishes after every step"); a browser has none, so the option `syncAfterChapter`
 * decides, as it always did.
 */
export function hostDefaultPublish(host: "browser" | "server", defaultPublish?: AutopilotPublishMode): AutopilotPublishMode | undefined {
  return publishModeOf(defaultPublish) ?? (host === "server" ? "step" : undefined);
}

/** The limits of a run as the engine takes them: only a whole number above zero is a limit; anything else (also `null`, a string, `0`) is none. `undefined` when there is no limit at all. */
export function normalizeRunLimits(value: unknown): AutopilotRunLimits | undefined {
  const source = asRecord(value);
  const limit = (entry: unknown): number | undefined => (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0 ? entry : undefined);
  const steps = limit(source.steps);
  const chapters = limit(source.chapters);
  return steps || chapters ? { ...(steps ? { steps } : {}), ...(chapters ? { chapters } : {}) } : undefined;
}

export function normalizeOptions(value: unknown, base: AutopilotOptions = DEFAULT_OPTIONS): AutopilotOptions {
  const source = asRecord(value);
  // `null` takes the author's choice back, so that the host decides again; a value nobody knows leaves it as it was.
  const publishEvery = source.publishEvery === null ? undefined : publishModeOf(source.publishEvery) ?? base.publishEvery;
  return {
    readers: asBoolean(source.readers, base.readers),
    maxReaders: asInteger(source.maxReaders, base.maxReaders, 1, 20),
    readersOnPlan: asBoolean(source.readersOnPlan, base.readersOnPlan),
    specialists: asBoolean(source.specialists, base.specialists),
    pauseAfterPlan: asBoolean(source.pauseAfterPlan, base.pauseAfterPlan),
    pauseAfterEachChapter: asBoolean(source.pauseAfterEachChapter, base.pauseAfterEachChapter),
    chaptersPerRun: asInteger(source.chaptersPerRun, base.chaptersPerRun, 0, MAX_BOOK_CHAPTERS),
    budgetLimit: asNumber(source.budgetLimit, base.budgetLimit, 0, 1_000_000),
    budgetTokens: asInteger(source.budgetTokens, base.budgetTokens ?? 0, 0, Number.MAX_SAFE_INTEGER),
    syncAfterChapter: asBoolean(source.syncAfterChapter, base.syncAfterChapter),
    ...(publishEvery ? { publishEvery } : {}),
  };
}

function normalizeScene(value: unknown, index: number): PlannedScene {
  const source = asRecord(value);
  return {
    number: asInteger(source.number, index + 1, 1, 999),
    title: asString(source.title) || `Scene ${index + 1}`,
    goal: asString(source.goal),
    beats: asStringList(source.beats, 20),
    pov: asString(source.pov) || undefined,
    location: asString(source.location) || undefined,
    characters: asStringList(source.characters, 20),
    summary: asString(source.summary) || undefined,
    status: asOneOf(source.status, ["planned", "written", "reviewed"] as const, "planned"),
    slug: asString(source.slug) || undefined,
    path: asString(source.path) || undefined,
    words: typeof source.words === "number" ? source.words : undefined,
    revisions: asInteger(source.revisions, 0, 0, 999),
  };
}

function normalizeChapter(value: unknown, index: number): PlannedChapter {
  const source = asRecord(value);
  const number = asInteger(source.number, index + 1, 1, MAX_BOOK_CHAPTERS);
  return {
    number,
    title: asString(source.title) || `Chapter ${number}`,
    slug: asString(source.slug),
    summary: asString(source.summary),
    goal: asString(source.goal),
    pov: asStringList(source.pov, 10),
    keyEvents: asStringList(source.keyEvents, 20),
    reveals: asStringList(source.reveals, 20),
    status: asOneOf(source.status, ["planned", "writing", "review", "done"] as const, "planned"),
    imported: source.imported === true ? true : undefined,
    skipReaders: source.skipReaders === true ? true : undefined,
    scenes: asArray(source.scenes).map(normalizeScene),
    score: typeof source.score === "number" ? source.score : undefined,
    storySoFarAtClose: asString(source.storySoFarAtClose) || undefined,
  };
}

function normalizePlan(value: unknown): AutopilotPlan | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  const revisionBatches = [...new Set(asArray(source.revisionBatches).map((entry) => asInteger(entry, 0, 0, MAX_BOOK_CHAPTERS)).filter((entry) => entry > 0))].sort((left, right) => left - right);
  const skippedReaders = asStringList(source.skippedReaders, 40);
  return {
    chapters: asArray(source.chapters).map(normalizeChapter).sort((left, right) => left.number - right.number),
    approved: asBoolean(source.approved, false),
    rounds: asInteger(source.rounds, 0, 0, 99),
    revisionNotes: newestList(source.revisionNotes, MAX_REVISION_NOTES),
    ...(revisionBatches.length ? { revisionBatches } : {}),
    readerReactions: asArray(source.readerReactions).map((entry) => {
      const reaction = asRecord(entry);
      return {
        slug: asString(reaction.slug),
        name: asString(reaction.name),
        interest: asNumber(reaction.interest, 5, 1, 10),
        reaction: asString(reaction.reaction),
        concerns: asStringList(reaction.concerns, 12),
        wishes: asStringList(reaction.wishes, 12),
      };
    }).filter((reaction) => reaction.slug),
    readersDone: asBoolean(source.readersDone, false),
    ...(skippedReaders.length ? { skippedReaders } : {}),
    awaitingAuthor: asBoolean(source.awaitingAuthor, false),
  };
}

function normalizeSecrets(value: unknown): ConceptSecret[] {
  return asArray(value).map((entry) => {
    const secret = asRecord(entry);
    const revealChapter = asInteger(secret.revealChapter, 0, 0, MAX_BOOK_CHAPTERS);
    return { slug: asString(secret.slug), title: asString(secret.title), revealChapter: revealChapter || undefined };
  }).filter((secret) => secret.slug);
}

function normalizeReview(value: unknown): ChapterReview | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  return {
    chapterNumber: asInteger(source.chapterNumber, 1, 1, MAX_BOOK_CHAPTERS),
    round: asInteger(source.round, 1, 1, 99),
    readersPending: asStringList(source.readersPending, 40),
    readerScores: asArray(source.readerScores).map((entry) => {
      const score = asRecord(entry);
      return {
        slug: asString(score.slug),
        name: asString(score.name),
        score: asNumber(score.score, 5, 1, 10),
        mainProblem: asString(score.mainProblem),
        prioritySuggestion: asString(score.prioritySuggestion),
        path: asString(score.path),
      };
    }).filter((score) => score.slug),
    readersSummaryDone: asBoolean(source.readersSummaryDone, false),
    findings: asArray(source.findings).map((entry, index) => {
      const finding = asRecord(entry);
      const sceneNumber = asInteger(finding.sceneNumber, 0, 0, 999);
      return {
        id: asString(finding.id) || `F${index + 1}`,
        source: asOneOf(finding.source, ["specialist", "reader"] as const, "specialist"),
        category: asString(finding.category) || "general",
        severity: asOneOf(finding.severity, ["critical", "major", "minor"] as const, "minor"),
        sceneNumber: sceneNumber || undefined,
        evidence: asString(finding.evidence) || undefined,
        anchored: asBoolean(finding.anchored, false),
        problem: asString(finding.problem),
        remediation: asString(finding.remediation),
        reader: asString(finding.reader) || undefined,
      };
    }),
    specialistsDone: asBoolean(source.specialistsDone, false),
    directorDone: asBoolean(source.directorDone, false),
    verdict: source.verdict === "approve" || source.verdict === "revise" ? source.verdict : undefined,
    score: typeof source.score === "number" ? source.score : undefined,
    summary: asString(source.summary) || undefined,
    decisions: asArray(source.decisions).map((entry) => {
      const decision = asRecord(entry);
      const sceneNumber = asInteger(decision.sceneNumber, 0, 0, 999);
      return {
        findingId: asString(decision.findingId),
        action: asOneOf(decision.action, ["accept", "reject"] as const, "reject"),
        rationale: asString(decision.rationale),
        remediation: asString(decision.remediation),
        sceneNumber: sceneNumber || undefined,
      };
    }),
    repairQueue: asArray(source.repairQueue).map((entry) => asInteger(entry, 0, 0, 999)).filter((entry) => entry > 0),
    previousFixes: asStringList(source.previousFixes, 40),
    history: asArray(source.history).map((entry) => {
      const item = asRecord(entry);
      return {
        round: asInteger(item.round, 1, 1, 99),
        verdict: item.verdict === "approve" ? "approve" as const : "revise" as const,
        score: asNumber(item.score, 0, 0, 10),
        accepted: asInteger(item.accepted, 0, 0, 999),
        rejected: asInteger(item.rejected, 0, 0, 999),
      };
    }),
  };
}

function normalizeQuestion(value: unknown): DirectorQuestion | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  const question = asString(source.question);
  if (!question) return null;
  const chapterNumber = asInteger(source.chapterNumber, 0, 0, MAX_BOOK_CHAPTERS);
  return {
    id: asString(source.id) || `question-${Date.now()}`,
    kind: asOneOf(source.kind, ["plan-approval", "chapter-approval", "round-limit", "director"] as const, "director"),
    question,
    context: asString(source.context),
    options: asStringList(source.options, 6),
    chapterNumber: chapterNumber || undefined,
    askedAt: asString(source.askedAt) || new Date(0).toISOString(),
  };
}

function normalizeRevision(value: unknown): RevisionRequest | null {
  if (!value || typeof value !== "object") return null;
  const source = asRecord(value);
  const instruction = asString(source.instruction);
  if (!instruction) return null;
  const revisedChapters = [...new Set(asArray(source.revisedChapters).map((entry) => asInteger(entry, 0, 0, MAX_BOOK_CHAPTERS)).filter((entry) => entry > 0))].sort((left, right) => left - right);
  return {
    id: asString(source.id) || `revision-${Date.now()}`,
    instruction,
    createdAt: asString(source.createdAt) || new Date(0).toISOString(),
    targets: Array.isArray(source.targets)
      ? source.targets.map((entry) => {
        const target = asRecord(entry);
        return { chapterNumber: asInteger(target.chapterNumber, 1, 1, MAX_BOOK_CHAPTERS), sceneNumber: asInteger(target.sceneNumber, 1, 1, 999), instruction: asString(target.instruction) };
      })
      : null,
    cursor: asInteger(source.cursor, 0, 0, 1_000_000),
    ...(revisedChapters.length ? { revisedChapters } : {}),
  };
}

function normalizeInterventions(value: unknown): AuthorIntervention[] {
  return asArray(value).map((entry) => {
    const source = asRecord(entry);
    return {
      id: asString(source.id),
      scope: asOneOf(source.scope, ["next_step", "from_now", "rewrite"] as const, "next_step"),
      text: asString(source.text),
      createdAt: asString(source.createdAt),
      during: asString(source.during),
      status: asOneOf(source.status, ["pending", "applied"] as const, "applied"),
      appliedAt: asString(source.appliedAt) || undefined,
      appliedBy: asString(source.appliedBy) || undefined,
    };
  }).filter((entry) => entry.id && entry.text).slice(-MAX_INTERVENTIONS);
}

export function createAutopilotState(now: Date, brief?: Partial<AutopilotBrief>, options?: Partial<AutopilotOptions>): AutopilotState {
  const at = now.toISOString();
  return {
    schemaVersion: 1,
    status: "idle",
    phase: "concept",
    brief: normalizeBrief(brief ?? {}),
    options: normalizeOptions(options ?? {}),
    concept: { done: false, generated: false, secrets: [] },
    plan: null,
    review: null,
    revision: null,
    finalDone: false,
    constraints: [],
    interventions: [],
    directorNotes: [],
    question: null,
    runner: null,
    stats: { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0 },
    message: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
    version: 0,
  };
}

/** Tolerant reader for `autopilot/state.json`, including hand edits and older files. */
export function normalizeAutopilotState(value: unknown, now = new Date()): AutopilotState {
  const source = asRecord(value);
  const base = createAutopilotState(now);
  const stats = asRecord(source.stats);
  const usageUnknownCalls = asInteger(stats.usageUnknownCalls, 0, 0, Number.MAX_SAFE_INTEGER);
  const costUnknownCalls = asInteger(stats.costUnknownCalls, 0, 0, Number.MAX_SAFE_INTEGER);
  const concept = asRecord(source.concept);
  const lastError = asRecord(source.lastError);
  const runner = asRecord(source.runner);
  return {
    schemaVersion: 1,
    status: asOneOf(source.status, STATUSES, "idle"),
    phase: asOneOf(source.phase, PHASES, "concept"),
    brief: normalizeBrief(source.brief),
    options: normalizeOptions(source.options),
    concept: { done: asBoolean(concept.done, false), generated: asBoolean(concept.generated, false), secrets: normalizeSecrets(concept.secrets) },
    plan: normalizePlan(source.plan),
    review: normalizeReview(source.review),
    revision: normalizeRevision(source.revision),
    finalDone: asBoolean(source.finalDone, false),
    constraints: newestList(source.constraints, MAX_CONSTRAINTS),
    interventions: normalizeInterventions(source.interventions),
    directorNotes: newestList(source.directorNotes, MAX_DIRECTOR_NOTES),
    question: normalizeQuestion(source.question),
    runner: asString(runner.runId)
      ? {
        host: runner.host === "server" ? "server" : "browser",
        label: asString(runner.label),
        ...(asString(runner.hostId) ? { hostId: asString(runner.hostId) } : {}),
        runId: asString(runner.runId),
        startedAt: asString(runner.startedAt),
        heartbeatAt: asString(runner.heartbeatAt),
      }
      : null,
    stats: {
      tasks: asInteger(stats.tasks, 0, 0, Number.MAX_SAFE_INTEGER),
      aiCalls: asInteger(stats.aiCalls, 0, 0, Number.MAX_SAFE_INTEGER),
      inputTokens: asInteger(stats.inputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      outputTokens: asInteger(stats.outputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      cost: asNumber(stats.cost, 0, 0, Number.MAX_SAFE_INTEGER),
      currency: asString(stats.currency) || undefined,
      failures: asInteger(stats.failures, 0, 0, Number.MAX_SAFE_INTEGER),
      ...(usageUnknownCalls ? { usageUnknownCalls } : {}),
      ...(costUnknownCalls ? { costUnknownCalls } : {}),
    },
    message: asString(source.message) || null,
    lastError: asString(lastError.message)
      ? { message: asString(lastError.message), at: asString(lastError.at), task: (asString(lastError.task) || undefined) as AutopilotTaskKind | undefined }
      : null,
    createdAt: asString(source.createdAt) || base.createdAt,
    updatedAt: asString(source.updatedAt) || base.updatedAt,
    version: asInteger(source.version, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function parseAutopilotState(raw: string | null | undefined, now = new Date()): AutopilotState | null {
  if (!raw?.trim()) return null;
  try {
    return normalizeAutopilotState(JSON.parse(raw), now);
  } catch {
    return null;
  }
}

/**
 * Like `parseAutopilotState`, but it tells a file that is absent or blank (nothing to protect) from one that exists
 * with content that is not a JSON object, for example a merge's conflict markers: `unreadable` then says why, and
 * the file must not be overwritten.
 */
export function inspectAutopilotState(raw: string | null | undefined, now = new Date()): { state: AutopilotState | null; unreadable?: string } {
  if (!raw?.trim()) return { state: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const conflicted = /^<{7}(?: |$)/m.test(raw) && /^>{7}(?: |$)/m.test(raw);
    return { state: null, unreadable: conflicted ? "it contains unresolved merge conflict markers" : "it is not valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: null, unreadable: "it does not hold a JSON object" };
  try {
    return { state: normalizeAutopilotState(value, now) };
  } catch {
    return { state: null, unreadable: "its content could not be interpreted" };
  }
}

export function serializeAutopilotState(state: AutopilotState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseActivityLog(raw: string | null | undefined): AutopilotActivity[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { activities?: unknown };
    return asArray(parsed.activities)
      .filter((entry): entry is AutopilotActivity => Boolean(entry && typeof entry === "object" && typeof (entry as AutopilotActivity).id === "string"))
      .slice(-MAX_ACTIVITIES);
  } catch {
    return [];
  }
}

export function serializeActivityLog(activities: AutopilotActivity[]): string {
  return `${JSON.stringify({ schemaVersion: 1, activities: activities.slice(-MAX_ACTIVITIES) }, null, 2)}\n`;
}

/** A state saved as `running` by a runner that no longer exists is shown and resumed as paused. */
export function recoverInterruptedState(state: AutopilotState, message: string): AutopilotState {
  if (state.status !== "running") return state;
  return { ...state, status: "paused", runner: null, message };
}

export function autopilotProgress(state: AutopilotState | null): AutopilotProgress {
  const chapters = state?.plan?.chapters ?? [];
  const scenes = chapters.flatMap((chapter) => chapter.scenes);
  return {
    chapters: chapters.length,
    chaptersDone: chapters.filter((chapter) => chapter.status === "done").length,
    scenes: scenes.length,
    scenesWritten: scenes.filter((scene) => scene.status !== "planned").length,
    words: scenes.reduce((total, scene) => total + (scene.words ?? 0), 0),
  };
}

/** What only a live session knows, for the summary of a state: the pause that waits, the limits of the run, and the default of the host. */
export interface AutopilotSummaryContext {
  pausePending?: AutopilotPausePending | null;
  limits?: AutopilotLimitsSummary | null;
  /** Where the host publishes when the author has not chosen (see `hostDefaultPublish`). */
  defaultPublish?: AutopilotPublishMode;
}

/**
 * The summary of a state, as the `state` events carry it. Made from the file alone it has no `pausePending` and no `limits`
 * (nothing there tells them); a live session adds them, `null` when nothing waits and no limit applies.
 */
export function summarizeAutopilotState(state: AutopilotState, context: AutopilotSummaryContext = {}): AutopilotStateSummary {
  return {
    status: state.status,
    phase: state.phase,
    message: state.message,
    progress: autopilotProgress(state),
    question: state.question,
    lastError: state.lastError,
    runner: state.runner,
    stats: state.stats,
    pendingNotes: state.interventions.filter((entry) => entry.scope === "next_step" && entry.status === "pending").length,
    constraints: state.constraints.length,
    updatedAt: state.updatedAt,
    ...(context.pausePending === undefined ? {} : { pausePending: context.pausePending }),
    ...(context.limits === undefined ? {} : { limits: context.limits }),
    publish: effectivePublish(state.options, context.defaultPublish),
  };
}

export function pendingNotes(state: AutopilotState): AuthorIntervention[] {
  return state.interventions.filter((entry) => entry.scope === "next_step" && entry.status === "pending");
}

export function wordsOf(text: string): number {
  return countWords(text);
}
