import { redactSecrets } from "../ai/redact.js";
import { AiProviderError, AiReplyRejectedError, type AiPort, type AiProgress, type AiRequest, type AiResponse, type AiUsage } from "../ai/types.js";
import { activeReaders, isThinDocument, loadDirectorProfile, loadEvaluationStyle, loadReaderPanel, readBody } from "../book/context.js";
import { OutlineCache, OutlineReader } from "../book/outline.js";
import { AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_STATE_FILE, STORY_DESIGN_FILE } from "../book/paths.js";
import { SnapshotCache, loadBookSnapshot, type BookSnapshot } from "../book/snapshot.js";
import { BookConflictError, isBookConflictError, normalizeChanges, type BookFileChange, type BookStore } from "../book/store.js";
import type { DirectorProfile } from "../profiles/director.js";
import type { EvaluationStyle } from "../profiles/evaluation-style.js";
import type { ReaderPersonaProfile } from "../profiles/readers.js";
import { abortError, isAbortError, sleep } from "../util/abort.js";
import { randomId } from "../util/hash.js";
import { StructuredReplyError } from "../util/json.js";
import { currentRequest, unescapePromptDataDeep } from "../prompt/trust.js";
import { isItalian, languageCode, tail, truncate } from "../util/text.js";
import { autopilotErrorFields } from "./errors.js";
import { applyFrozenDecision, frozenAnswerAction, isFrozenQuestion, settleFrozenChanges } from "./frozen.js";
import { outlinePlanStatus } from "./outline-check.js";
import { advanceState, effectiveTargetChapters, extensionNote, nextStep, phaseOf, type PlanNote, type PlannerContext, type TaskDescriptor } from "./planner.js";
import { profileProblems, profileProblemsMessage, profileProblemsTitle } from "./profile-check.js";
import {
  MAX_INTERVENTIONS,
  MAX_REVISION_NOTES,
  capConstraints,
  createAutopilotState,
  effectivePublish,
  hostDefaultPublish,
  inspectAutopilotState,
  normalizeBrief,
  normalizeOptions,
  normalizeRuleText,
  normalizeRunLimits,
  parseActivityLog,
  pendingNotes,
  serializeActivityLog,
  serializeAutopilotState,
  summarizeAutopilotState,
} from "./state.js";
import { TASK_EXECUTORS, type TaskContext } from "./tasks.js";
import {
  LIVE_AUTOPILOT_OPTIONS,
  type AutopilotActivity,
  type AutopilotEventBody,
  type AutopilotLastErrorCode,
  type AutopilotLimitsSummary,
  type AutopilotMessageCode,
  type AutopilotOptions,
  type AutopilotPausePending,
  type AutopilotPublishMode,
  type AutopilotRetryInfo,
  type AutopilotRunLimits,
  type AutopilotState,
  type AutopilotStateSummary,
  type AuthorIntervention,
  type InterventionInput,
  type PendingFrozenReview,
  type QuestionAnswer,
  type StartOptions,
} from "./types.js";

/**
 * What a host gives the run. Which of the two `after…` hooks are called, and when, is decided by the engine from where the book is
 * published (`options.publishEvery`, else the host's `defaultPublish`, else `options.syncAfterChapter`: see `effectivePublish`),
 * so a host only says how to publish: `afterCommit` is called after every saved step when the book is published after every step,
 * `afterChapter` when a chapter is closed and the book is published after every chapter or every step, and neither when it is not
 * published. A publish that fails is reported (`sync` event) and never stops the run.
 */
export interface AutopilotHooks {
  /** Before every step, e.g. fast-forward the working copy from GitHub (server). */
  beforeStep?(signal: AbortSignal): Promise<void>;
  /** After every committed step, when the book is published after every step: e.g. push to GitHub (server). */
  afterCommit?(info: { task: TaskDescriptor; message: string; paths: string[] }): Promise<void>;
  /** After a chapter is approved, when the book is published after every chapter or every step: e.g. publish the local commits to GitHub (browser). */
  afterChapter?(info: { chapterNumber: number; title: string }): Promise<void>;
}

export interface AutopilotRunConfig {
  bookId: string;
  store: BookStore;
  ai: AiPort;
  host: "browser" | "server";
  hostLabel: string;
  /** Stable identity of the host, recorded with the runner. */
  hostId?: string;
  now?: () => Date;
  hooks?: AutopilotHooks;
  /**
   * Where the host publishes when the author has not chosen (`options.publishEvery`). Without it a server host publishes after every
   * step, as it always did, and a browser host as `options.syncAfterChapter` says.
   */
  defaultPublish?: AutopilotPublishMode;
  emit: (event: AutopilotEventBody) => void;
  /**
   * Base delay before the automatic retry of a failed step (ms, default 4000). Transient provider errors are retried up
   * to three times, after about 1×, 3× and 9× this delay (and never sooner than the provider's Retry-After); every
   * delay scales with it, the waits of «Retry later» (`options.longRetry`) too, so 0 makes them all instant.
   */
  retryDelayMs?: number;
  /** Source of the retry jitter, in [0, 1) (default `Math.random`). */
  random?: () => number;
  /**
   * Longest silence (ms) of `autopilot/state.json` while the run is alive: after it the run saves a fresh `runner.heartbeatAt`,
   * so that another host does not take a long step for a dead run. 0 switches it off. Default 300 000 (5 minutes).
   */
  persistHeartbeatMs?: number;
}

/** The longest a step may go without the run writing its state: a quarter of the 20 minutes after which another host takes the run for dead. */
export const DEFAULT_PERSIST_HEARTBEAT_MS = 300_000;

/** Times a step's commit is tried again, without repeating the step, because the author saved to the state file in the meantime. */
const COMMIT_ATTEMPTS = 5;

export interface StoredAutopilot {
  state: AutopilotState | null;
  stateHash: string | null;
  activities: AutopilotActivity[];
  activityHash: string | null;
  /**
   * Set when `autopilot/state.json` exists but cannot be read (`state` is then null, `stateHash` is the file's hash).
   * An absent or blank file is not this: there is nothing in it to lose.
   */
  corrupt?: { path: string; reason: string };
}

export async function readStoredAutopilot(store: BookStore): Promise<StoredAutopilot> {
  const [stateFile, activityFile] = await Promise.all([store.read(AUTOPILOT_STATE_FILE), store.read(AUTOPILOT_ACTIVITY_FILE)]);
  const reading = inspectAutopilotState(stateFile?.content);
  return {
    state: reading.state,
    stateHash: stateFile?.hash ?? null,
    activities: parseActivityLog(activityFile?.content),
    activityHash: activityFile?.hash ?? null,
    ...(reading.unreadable ? { corrupt: { path: AUTOPILOT_STATE_FILE, reason: reading.unreadable } } : {}),
  };
}

/**
 * `autopilot/state.json` exists but cannot be read, for example because a merge left conflict markers in it. It holds
 * the author's rules, the plan, the interventions and the budget counter, so the autopilot never replaces it.
 */
export class AutopilotStateCorruptError extends Error {
  readonly code = "state_corrupt";
  readonly path: string;
  readonly reason: string;

  constructor(problem: { path: string; reason: string }) {
    super(`The autopilot state file ${problem.path} exists but cannot be read (${problem.reason}), so the autopilot leaves it untouched. Restore the file from the book's history, or reset the autopilot, which deletes the file so it can start over.`);
    this.name = "AutopilotStateCorruptError";
    this.path = problem.path;
    this.reason = problem.reason;
  }
}

/** Call before writing the state: an unreadable file is never overwritten. */
export function assertStoredStateReadable(stored: StoredAutopilot): void {
  if (stored.corrupt) throw new AutopilotStateCorruptError(stored.corrupt);
}

export function stampState(state: AutopilotState, now: Date): AutopilotState {
  return { ...state, version: state.version + 1, updatedAt: now.toISOString() };
}

export function stateChange(state: AutopilotState, expectedHash: string | null): BookFileChange {
  return { path: AUTOPILOT_STATE_FILE, content: serializeAutopilotState(state), expectedHash };
}

export function activityChange(activities: AutopilotActivity[], expectedHash: string | null): BookFileChange {
  return { path: AUTOPILOT_ACTIVITY_FILE, content: serializeActivityLog(activities), expectedHash };
}

/**
 * What a "rewrite" does to the state besides making its text a rule: the chapters already written are revised, or, when
 * nothing is written yet, the plan is reopened with the author's note.
 */
function applyRewrite(next: AutopilotState, text: string, at: string): void {
  const written = next.plan?.chapters.some((chapter) => chapter.scenes.some((scene) => scene.status !== "planned"));
  if (written) {
    const current = next.revision;
    if (current && current.targets === null) {
      // The author's instruction is about the whole book: a revision that looked only at some chapters (the impact of a change) now looks at all.
      const { afterChapter: _after, onlyChapter: _only, ...open } = current;
      next.revision = { ...open, instruction: `${current.instruction}\n${text}` };
    } else {
      // Chapters already rewritten by a revision in progress are still reviewed again at the end.
      const revised = [...(current?.revisedChapters ?? []), ...(current?.targets ?? []).slice(0, current?.cursor ?? 0).map((target) => target.chapterNumber)];
      const revisedChapters = [...new Set(revised)].sort((left, right) => left - right);
      next.revision = { id: randomId("revision"), instruction: text, createdAt: at, targets: null, cursor: 0, ...(revisedChapters.length ? { revisedChapters } : {}) };
    }
    next.finalDone = false;
    delete next.finalReview;
  } else if (next.plan) {
    // A new note concerns the whole book: the batches an earlier revision still had to regenerate are no longer the only ones.
    const { revisionBatches: _batches, ...plan } = next.plan;
    next.plan = { ...plan, approved: false, awaitingAuthor: false, revisionNotes: [...next.plan.revisionNotes, text].slice(-MAX_REVISION_NOTES) };
  }
}

/** Pure application of an author intervention to the state. A rule (`from_now`, `rewrite`) over `MAX_RULE_CHARACTERS` is refused. */
export function applyIntervention(state: AutopilotState, input: InterventionInput, now: Date, during: string): AutopilotState {
  const text = input.text.trim();
  if (!text) throw new Error("The intervention is empty.");
  if (input.scope !== "next_step") normalizeRuleText(text);
  const next = structuredClone(state);
  const at = now.toISOString();
  const entry: AuthorIntervention = {
    id: randomId("intervention"),
    scope: input.scope,
    text,
    createdAt: at,
    during,
    status: input.scope === "next_step" ? "pending" : "applied",
    ...(input.scope === "next_step" ? {} : { appliedAt: at, appliedBy: "rules" }),
  };
  if (input.scope !== "next_step" && !next.constraints.includes(text)) next.constraints = capConstraints([...next.constraints, text]);
  if (input.scope === "rewrite") applyRewrite(next, text, at);
  next.interventions = [...next.interventions, entry].slice(-MAX_INTERVENTIONS);
  return next;
}

/**
 * Pure application of the author's answer to the director's question. An answer to a question about a change of a frozen chapter (or of
 * the outline of a written one) records the decision it chooses (`frozenAnswerAction`) in `pendingReviews`: the session carries out at
 * once what needs no model, the next run the rest.
 */
export function applyAnswer(state: AutopilotState, answer: QuestionAnswer, now: Date): AutopilotState {
  if (!state.question || state.question.id !== answer.questionId) throw new Error("This question is no longer open.");
  const asked = state.question;
  if (isFrozenQuestion(asked)) {
    const { action, note } = frozenAnswerAction(asked, answer);
    return applyFrozenDecision(state, { kind: asked.frozen.kind, number: asked.frozen.number, action, fingerprint: asked.frozen.fingerprint, ...(note ? { note } : {}), ...(answer.asRule ? { asRule: true } : {}) }, now.toISOString(), randomId("review"));
  }
  const text = answer.answer.trim();
  const at = now.toISOString();
  // A rule is checked before anything is changed: one that is too long leaves the question open.
  const rule = !answer.accept && text && answer.asRule ? normalizeRuleText(`Answer to the director's question «${truncate(state.question.question, 160)}»: ${text}`) : null;
  const next = structuredClone(state);
  const question = next.question!;
  next.question = null;
  if (rule) {
    if (!next.constraints.includes(rule)) next.constraints = capConstraints([...next.constraints, rule]);
    next.interventions = [...next.interventions, { id: randomId("intervention"), scope: "from_now" as const, text: rule, createdAt: at, during: question.question, status: "applied" as const, appliedAt: at, appliedBy: "rules" }].slice(-MAX_INTERVENTIONS);
  } else if (!answer.accept && text) {
    next.interventions = [...next.interventions, {
      id: randomId("intervention"),
      scope: "next_step" as const,
      text: `Answer to the director's question «${question.question}»: ${text}`,
      createdAt: at,
      during: question.question,
      status: "pending" as const,
    }].slice(-MAX_INTERVENTIONS);
  }
  if (next.status === "waiting-author") next.status = "paused";
  next.message = null;
  return next;
}

/** The options the author can change while a run goes on, without the rest: the run does not write them, and the rest can only change when nobody runs. */
function withoutLiveOptions(options: AutopilotState["options"]): unknown {
  const kept: Record<string, unknown> = { ...options };
  for (const key of LIVE_AUTOPILOT_OPTIONS) delete kept[key];
  return kept;
}

/** The state without what only the author changes and what every write changes: what is left must be the same before and after. */
function withoutAuthorParts(state: AutopilotState): unknown {
  const { version: _version, updatedAt: _updatedAt, interventions: _interventions, constraints: _constraints, revision: _revision, finalDone: _finalDone, finalReview: _finalReview, pendingReviews: _pendingReviews, options, plan, runner, ...rest } = state;
  return {
    ...rest,
    options: withoutLiveOptions(options),
    plan: plan ? (({ approved: _approved, awaitingAuthor: _awaitingAuthor, revisionNotes: _notes, revisionBatches: _batches, ...others }) => others)(plan) : plan,
    runner: runner ? (({ heartbeatAt: _heartbeatAt, ...others }) => others)(runner) : runner,
  };
}

/**
 * What the author saved in the state file while a step ran, carried into the state that step produced. `base` is the state
 * as the run last read it, `stored` the file as it is now and `working` the run's own. The author owns the interventions,
 * the rules, what a rewrite changes and the settings that can change during a run (`LIVE_AUTOPILOT_OPTIONS`: where the book is
 * published, whether to pause after every chapter, what to do with frozen chapters, «Retry later»): they are merged (interventions by id, rules by text, the effects of a new
 * rewrite land on `working`, as they did when they were handed over in memory, a setting by its value as the author left it), and
 * the run wins on everything else. `foreign` says that `stored` differs from `base` in something the author does not own or the run
 * does not write by itself (its own heartbeat): that is a conflict.
 */
export function reconcileAuthorChanges(working: AutopilotState, base: AutopilotState, stored: AutopilotState): { state: AutopilotState; foreign: boolean } {
  const foreign = JSON.stringify(withoutAuthorParts(base)) !== JSON.stringify(withoutAuthorParts(stored));
  const known = new Set(working.interventions.map((entry) => entry.id));
  const added = stored.interventions.filter((entry) => !known.has(entry.id));
  const rulesChanged = stored.constraints.length !== base.constraints.length || stored.constraints.some((rule, index) => rule !== base.constraints[index]);
  const optionsChanged = LIVE_AUTOPILOT_OPTIONS.filter((key) => JSON.stringify(stored.options[key]) !== JSON.stringify(base.options[key]));
  const reviewsChanged = JSON.stringify(base.pendingReviews ?? []) !== JSON.stringify(stored.pendingReviews ?? []);
  if (!added.length && !rulesChanged && !optionsChanged.length && !reviewsChanged) return { state: working, foreign };
  const merged = structuredClone(working);
  if (reviewsChanged) {
    const reviews = mergePendingReviews(working.pendingReviews ?? [], base.pendingReviews ?? [], stored.pendingReviews ?? []);
    if (reviews.length) merged.pendingReviews = reviews;
    else delete merged.pendingReviews;
  }
  if (rulesChanged) {
    // The author's list as it is now, and the rules the run itself added to its own copy.
    const before = new Set(base.constraints);
    const now = new Set(stored.constraints);
    merged.constraints = capConstraints([...stored.constraints, ...working.constraints.filter((rule) => !before.has(rule) && !now.has(rule))]);
  }
  if (optionsChanged.length) {
    const options: Record<string, unknown> = { ...merged.options };
    for (const key of optionsChanged) {
      if (stored.options[key] === undefined) delete options[key];
      else options[key] = stored.options[key];
    }
    merged.options = options as unknown as AutopilotState["options"];
  }
  merged.interventions = [...merged.interventions, ...added].slice(-MAX_INTERVENTIONS);
  for (const entry of added) if (entry.scope === "rewrite") applyRewrite(merged, entry.text, entry.createdAt);
  return { state: merged, foreign };
}

/**
 * The decisions about changes, merged: the run's own (it starts and finishes them), the ones the author recorded meanwhile (an author's
 * decision replaces one that waited for the same change of the same chapter), without the ones the author took back (unless the run has
 * already started carrying it out).
 */
function mergePendingReviews(working: PendingFrozenReview[], base: PendingFrozenReview[], stored: PendingFrozenReview[]): PendingFrozenReview[] {
  const before = new Set(base.map((entry) => entry.id));
  const now = new Set(stored.map((entry) => entry.id));
  const own = new Set(working.map((entry) => entry.id));
  const added = stored.filter((entry) => !before.has(entry.id) && !own.has(entry.id));
  const kept = working.filter((entry) => entry.started || ((now.has(entry.id) || !before.has(entry.id)) && !added.some((other) => other.kind === entry.kind && other.number === entry.number)));
  return [...kept, ...added];
}

/**
 * When the author raises the number of chapters of a finished plan, extend it instead of stopping. `targetChapters` is the number the
 * book is planned to (`effectiveTargetChapters`: the brief's, or the last chapter of the author's outline when it asks for more).
 */
export function extendPlanIfNeeded(state: AutopilotState, targetChapters = effectiveTargetChapters(state)): AutopilotState {
  const plan = state.plan;
  if (!plan?.approved || plan.chapters.length >= targetChapters) return state;
  if (!plan.chapters.every((chapter) => chapter.status === "done")) return state;
  // The book is not complete any more: nobody has judged it as it is going to be.
  const { finalReview: _finalReview, ...reopened } = state;
  return {
    ...reopened,
    finalDone: false,
    plan: {
      ...plan,
      approved: false,
      rounds: 0,
      readersDone: true,
      revisionNotes: [extensionNote(targetChapters)],
    },
  };
}

/** An error as text for the state, the activity log and the events: never with a credential in it. */
function describeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Errors raised by the book store itself (not by the AI or by the book's content), recorded by `transientStore`. */
const storeFailures = new WeakSet<object>();
/** Replies cut while the model only reasoned that the runner gave a second try, with a larger output limit. */
const boostedRetries = new WeakSet<object>();

/**
 * Closed list: errors that declare themselves retryable (`retryable: true`, as `AiProviderError` does) and the
 * failures of the book store itself (a working copy being refreshed, a full disk: transient, like a network failure)
 * repeat the step. A reply cut by the output limit never does (the same request ends the same way and is billed
 * again), except once when the model had only reasoned and the run raised its limit; nor does an unclassified error
 * (configuration, state). Hosts can mark their own transient failures with the same flag.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof StructuredReplyError) return true;
  if (!error || typeof error !== "object") return false;
  if (storeFailures.has(error) || boostedRetries.has(error)) return true;
  const flags = error as { retryable?: unknown; truncated?: unknown };
  return flags.retryable === true && flags.truncated !== true;
}

/**
 * The store as a run sees it. What it throws, other than a conflict (own rule) or an abort, is a store failure and
 * counts as retryable; the error itself is passed on unchanged, and a host that flagged it `retryable: false` is obeyed.
 */
function transientStore(store: BookStore): BookStore {
  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object" && !isBookConflictError(error) && !isAbortError(error) && (error as { retryable?: unknown }).retryable !== false) storeFailures.add(error);
      throw error;
    }
  };
  return {
    list: () => guard(() => store.list()),
    read: (path) => guard(() => store.read(path)),
    commit: (changes, message) => guard(() => store.commit(changes, message)),
  };
}

/** Retries of a transient provider failure (rate limit, overload, network): each waits three times as long as the last. */
const MAX_TRANSIENT_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 4000;
/** What a reply cut while the model only reasoned gets its output limit multiplied by, for the rest of the run. */
const OUTPUT_BOOST = 3;
/** The shortest time between two `task-progress` events of a step that answers with a structured value (the client reports up to four times a second; the stream of the server is not flooded). */
const STRUCTURED_PROGRESS_INTERVAL_MS = 1000;

/**
 * How a failed step may be repeated: a provider failure up to three times with a growing wait; a rejected reply or a
 * failure from elsewhere (the book store, a host) once; a reply cut while only reasoning once, with a larger limit.
 */
function retryKindOf(error: unknown): "boost" | "transient" | "rejected" | "other" | null {
  if (!isRetryableError(error)) return null;
  if (error && typeof error === "object" && boostedRetries.has(error)) return "boost";
  if (error instanceof AiReplyRejectedError || error instanceof StructuredReplyError) return "rejected";
  return error instanceof AiProviderError ? "transient" : "other";
}

const TIME_DEPENDENT_STATUSES = new Set([408, 429, 502, 503, 504]);
const TIME_DEPENDENT_WORDS = /time[ds]? ?out|network|connection|fetch failed|econn|enotfound|eai_again|socket|overload|rate[ _-]?limit|too many requests|temporar|unavailable|try again/i;

/**
 * Whether a provider failure depends on the moment (rate limit, overload, network), so that the same message again
 * means nothing yet: what the engine's client marks `transient`, and the same by status or by wording for other AI ports.
 */
function dependsOnTheMoment(error: unknown): boolean {
  if (!(error instanceof AiProviderError)) return false;
  if (error.transient === true) return true;
  if (typeof error.status === "number") return TIME_DEPENDENT_STATUSES.has(error.status);
  return TIME_DEPENDENT_WORDS.test(error.message);
}

/** What a failed step is owed: the retry it gets, if any, and how far the retries of its kind have got. */
interface RetryPlan {
  kind: "boost" | "transient" | "rejected" | "other";
  /** What the failure says (redacted), remembered to tell the same failure twice in a row. */
  message: string;
  /** Whether the retry is granted: the failure is not one that repeats, and the retries of its kind are not used up. */
  granted: boolean;
  /** The retry this failure belongs to: the one that follows it, or the last one made when none does. */
  attempt: number;
  /** How many retries this kind of failure gets. */
  retries: number;
}

/**
 * The retry a failure gets, from what the run has used so far (`transient` retries of a provider failure, `other` retries of anything else,
 * and the last failure's words). Pure: the run applies it, and the same plan is what the failed activity and `lastError` say.
 * `null` for a failure that is never retried.
 */
function planRetry(error: unknown, used: { transient: number; other: number; lastFailure: string }): RetryPlan | null {
  const kind = retryKindOf(error);
  if (!kind) return null;
  const message = describeError(error);
  if (kind === "boost") return { kind, message, granted: true, attempt: 1, retries: 1 };
  const repeated = used.lastFailure === message && !dependsOnTheMoment(error);
  const made = kind === "transient" ? used.transient : used.other;
  const retries = kind === "transient" ? MAX_TRANSIENT_RETRIES : 1;
  const granted = !repeated && made < retries;
  return { kind, message, granted, attempt: granted ? made + 1 : made, retries };
}

function formatWait(milliseconds: number): string {
  return milliseconds >= 1000 ? `${Math.round(milliseconds / 1000)} s` : `${milliseconds} ms`;
}

/** What a failure is owed by each level of retries: the quick one (`planRetry`'s kind; `null` for a failure never retried) and «Retry later». */
export interface RetryClass {
  short: "boost" | "transient" | "rejected" | "other" | null;
  /** Whether, once its quick retries are used up, the failure may wait for «Retry later» (`options.longRetry`) and be tried again. */
  long: boolean;
}

/** The statuses of a provider failure that may wait for «Retry later»: the ones that ask to come back later (408, 429) and the failures of the server (5xx). */
const longRetryStatus = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599);

/**
 * How a failure may be retried. The quick level is `planRetry`'s. «Retry later» is only for a transient failure of the provider: a status that asks
 * to come back later or a failure of its server (408, 429, 5xx), or no status at all (the endpoint cannot be reached, a timeout, a stream lost or
 * ended too early, an empty reply). Never a reply that was rejected, an error that is not retryable (400, 401, 403, 404, 422, Tools only, a prompt
 * no window holds, a reply cut by its limit, a runaway stream, the routing budget), another status (409 included), a failure of the book store or of
 * a host, a conflict, the lease, the budget, a pause of the author, or anything nobody classified: a closed list. Pure.
 */
export function classifyRetry(error: unknown): RetryClass {
  const short = retryKindOf(error);
  const long = short === "transient" && error instanceof AiProviderError && error.truncated !== true && (typeof error.status !== "number" || longRetryStatus(error.status));
  return { short, long };
}

/** A wait as the author reads it, in the language of the book: "15 minutes", "1 hour 30 minutes", «2 ore e 5 minuti», "45 seconds"; under a second, in ms. */
function waitWords(milliseconds: number, italian: boolean): string {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1000) return `${ms} ms`;
  const unit = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (ms < 59_500) {
    const seconds = Math.round(ms / 1000);
    return italian ? unit(seconds, "secondo", "secondi") : unit(seconds, "second", "seconds");
  }
  const total = Math.round(ms / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts = [
    days ? (italian ? unit(days, "giorno", "giorni") : unit(days, "day", "days")) : "",
    hours ? (italian ? unit(hours, "ora", "ore") : unit(hours, "hour", "hours")) : "",
    minutes ? (italian ? unit(minutes, "minuto", "minuti") : unit(minutes, "minute", "minutes")) : "",
  ].filter(Boolean);
  const last = parts.pop() ?? "";
  if (!parts.length) return last;
  return italian ? `${parts.join(", ")} e ${last}` : `${parts.join(" ")} ${last}`;
}

/** «ripartenza 2 di 3» / "restart 2 of 3", or without a limit. */
function restartWords(italian: boolean, cycle: number, cycles: number | null): string {
  if (cycles === null) return italian ? `ripartenza ${cycle}, senza limite` : `restart ${cycle}, no limit`;
  return italian ? `ripartenza ${cycle} di ${cycles}` : `restart ${cycle} of ${cycles}`;
}

function longRetryWaitTitle(italian: boolean, waitMs: number, cycle: number, cycles: number | null): string {
  return italian
    ? `Il passo è fallito dopo i tentativi ravvicinati: riprovo tra ${waitWords(waitMs, true)} (${restartWords(true, cycle, cycles)})`
    : `The step failed after the quick retries: retrying in ${waitWords(waitMs, false)} (${restartWords(false, cycle, cycles)})`;
}

const restarts = (italian: boolean, count: number) => (italian ? `${count} ${count === 1 ? "ripartenza" : "ripartenze"}` : `${count} ${count === 1 ? "restart" : "restarts"}`);

/** Why the run stopped when the cycles of «Retry later» are used up: how many restarts were made, and the failure. */
function longRetryExhaustedMessage(italian: boolean, cycles: number, failure: string): string {
  return italian ? `Il passo è fallito ancora dopo ${restarts(true, cycles)} (Riprova più tardi): ${failure}` : `The step failed again after ${restarts(false, cycles)} (Retry later): ${failure}`;
}

/** Why the run stopped when the author turned «Retry later» off while the run waited for it, and the failure it waited to try again. */
function longRetryOffMessage(italian: boolean, failure: string): string {
  return italian ? `«Riprova più tardi» è stato spento mentre il passo aspettava di essere riprovato: ${failure}` : `"Retry later" was turned off while the step waited to be tried again: ${failure}`;
}

function retrySkippedTitle(italian: boolean, waitMs: number): string {
  return italian ? `Attesa saltata: riprovo subito (${waitWords(waitMs, true)} prima del previsto).` : `Wait skipped: retrying now (${waitWords(waitMs, false)} early).`;
}

/** Whether the budget of the options (money, tokens) is used up by these statistics: what the run checks before every step. */
function budgetUsedUp(options: AutopilotOptions, stats: AutopilotState["stats"]): boolean {
  if (options.budgetLimit > 0 && stats.cost >= options.budgetLimit) return true;
  return (options.budgetTokens ?? 0) > 0 && stats.inputTokens + stats.outputTokens >= (options.budgetTokens ?? 0);
}

/** How a wait before a retry ended: its time passed, «Retry now» ended it, a pause (or a stop, or the lease lost) ended it, or «Retry later» was turned off. */
type RetryWaitOutcome = "elapsed" | "skipped" | "stopped" | "off";
/** The reasons a wait is aborted with, other than a pause. */
const WAIT_SKIPPED = "retry-now";
const WAIT_TURNED_OFF = "long-retry-off";

const RETRY_NOTE_MAX = 500;

/** What the retried request is told about a rejected reply: the reason, never the reply. At most 500 characters. */
export function retryNoteFor(error: unknown): string | null {
  if (!(error instanceof AiReplyRejectedError) && !(error instanceof StructuredReplyError)) return null;
  const head = "The previous reply to this request was rejected because: ";
  const foot = " Repeat the task following every instruction and the requested format.";
  const reason = describeError(error).replace(/\s+/g, " ").trim().slice(0, RETRY_NOTE_MAX - head.length - foot.length);
  return `${head}${reason}${foot}`;
}

/** AI usage of one step, including attempts whose reply was rejected. */
interface StepSpend {
  calls: number;
  usage: AiUsage;
  cost: number;
  model?: string;
  provider?: string;
  currency?: string;
  /** Calls whose tokens were estimated, and calls whose cost is not a measured one. */
  usageUnknown: number;
  costUnknown: number;
}

function newSpend(): StepSpend {
  return { calls: 0, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, cost: 0, usageUnknown: 0, costUnknown: 0 };
}

function recordSpend(spend: StepSpend, source: { usage?: AiUsage; usageKnown?: boolean; cost?: number; costKnown?: boolean; model?: string; provider?: string; currency?: string }): void {
  spend.calls += 1;
  if (source.usageKnown === false) spend.usageUnknown += 1;
  if (source.costKnown === false) spend.costUnknown += 1;
  spend.model = source.model ?? spend.model;
  spend.provider = source.provider ?? spend.provider;
  spend.currency = source.currency ?? spend.currency;
  if (source.usage) {
    spend.usage.inputTokens += source.usage.inputTokens;
    spend.usage.outputTokens += source.usage.outputTokens;
    spend.usage.cachedInputTokens += source.usage.cachedInputTokens;
  }
  spend.cost += source.cost ?? 0;
}

function spentSomething(spend: StepSpend): boolean {
  return spend.calls > 0 || spend.cost > 0 || spend.usage.inputTokens > 0 || spend.usage.outputTokens > 0;
}

function withSpend(stats: AutopilotState["stats"], spend: StepSpend): AutopilotState["stats"] {
  return {
    ...stats,
    aiCalls: stats.aiCalls + spend.calls,
    inputTokens: stats.inputTokens + spend.usage.inputTokens,
    outputTokens: stats.outputTokens + spend.usage.outputTokens,
    cost: stats.cost + spend.cost,
    currency: spend.currency ?? stats.currency,
    ...(spend.usageUnknown ? { usageUnknownCalls: (stats.usageUnknownCalls ?? 0) + spend.usageUnknown } : {}),
    ...(spend.costUnknown ? { costUnknownCalls: (stats.costUnknownCalls ?? 0) + spend.costUnknown } : {}),
  };
}

function taskKey(task: TaskDescriptor): string {
  return [task.kind, task.chapterNumber ?? "", task.sceneNumber ?? "", task.reader ?? "", ...(task.chapterSlug ? [task.chapterSlug] : [])].join(":");
}

/**
 * Steps one run may take before it is stopped as a runaway. It grows with the book, because a long book legitimately
 * takes many more steps (a run that is not making progress is caught separately, whatever this number is).
 */
export function runStepCeiling(state: Pick<AutopilotState, "brief" | "plan">): number {
  return 500 + 80 * Math.max(state.brief.targetChapters, state.plan?.chapters.length ?? 0);
}

/**
 * Whether a step is part of a chapter that is in progress: the chapter has its scenes planned and is not closed. A pause at the end
 * of the chapter goes on to the end of such a chapter; the concept, the plan, the summaries of the author's chapters, the first step
 * of a chapter that has not started and the final judgement belong to none, so for them it is a pause after the step.
 */
function chapterInProgress(state: AutopilotState, task: TaskDescriptor): boolean {
  if (task.chapterNumber === undefined) return false;
  const status = state.plan?.chapters.find((chapter) => chapter.number === task.chapterNumber)?.status;
  return status === "writing" || status === "review";
}

function chapterPauseMessage(italian: boolean, chapter: number): string {
  return italian ? `Capitolo ${chapter} completato: in pausa, come hai chiesto.` : `Chapter ${chapter} completed: paused, as you asked.`;
}

function stepLimitMessage(italian: boolean, steps: number): string {
  if (italian) return steps === 1 ? "Passo eseguito come richiesto: in pausa." : `${steps} passi eseguiti come richiesto: in pausa.`;
  return steps === 1 ? "Step done as requested: paused." : `${steps} steps done as requested: paused.`;
}

function chapterLimitMessage(italian: boolean, chapters: number): string {
  if (italian) return chapters === 1 ? "1 capitolo completato in questa sessione." : `${chapters} capitoli completati in questa sessione.`;
  return chapters === 1 ? "1 chapter completed in this session." : `${chapters} chapters completed in this session.`;
}

interface StepContext {
  planner: PlannerContext;
  director: DirectorProfile;
  panel: ReaderPersonaProfile[];
  evaluationStyle: EvaluationStyle | null;
  outline: OutlineReader;
}

const TAKEN_OVER = "Another runner took over this book: this run stops.";

/** One autopilot run: loops over steps until it completes, pauses, or fails. */
export class AutopilotRun {
  readonly runId = randomId("run");
  private readonly controller = new AbortController();
  private stepController: AbortController | null = null;
  /** A pause now or after the step was asked for: the run stops as soon as the step in flight is saved (or abandoned, for now). */
  private stopRequested = false;
  /** A pause at the end of the chapter was asked for: the run goes on until the chapter in progress is closed and published. */
  private chapterStopRequested = false;
  /** The step in flight, or waiting to be retried, is part of a chapter in progress: a pause at the end of the chapter does not cut its wait. */
  private inChapter = false;
  private interrupted = false;
  /** Another run is recorded as the owner of the book: this one saves nothing more and ends. */
  private leaseLost = false;
  private readonly queue: InterventionInput[] = [];
  private readonly cache = new SnapshotCache();
  /** The entries of the outline the run has read, by path and hash: a file is read again only when it changed. */
  private readonly outlineCache = new OutlineCache();
  private readonly store: BookStore;
  private readonly now: () => Date;
  /** Steps this run saved, and chapters it closed: what the limits of the run count. A step that failed or was abandoned is not one. */
  private stepsThisRun = 0;
  private chaptersThisRun = 0;
  /** The limits of this run, as `StartOptions.limits` gave them. They are not saved. */
  private limits: AutopilotRunLimits = {};
  /** The chapter the step saved last closed, until another step is saved: a pause at the end of the chapter asked right then says which. */
  private closedChapter: number | null = null;
  /** Why the run ended, when a client can say it in its language (`run-ended`'s `code`). */
  private endCode: AutopilotMessageCode | undefined;
  private readonly defaultPublish: AutopilotPublishMode | undefined;
  private current: AutopilotActivity | null = null;
  /** Output limit multiplier per kind of step, raised after a reply cut while the model only reasoned; kept for the run, never saved. */
  private readonly outputBoosts = new Map<string, number>();
  /** The wait between two tries of a failed step, ended early by a pause. */
  private waiting: AbortController | null = null;
  /** While the run waits to try a failed step again: when, and which retry. Told in the summary, never saved. */
  private retry: AutopilotRetryInfo | null = null;
  /** The state the wait in progress was told with: what «Retry now» tells again, without the wait. */
  private waitState: AutopilotState | null = null;
  /** The language of the book as the last step read it: the run's own words are said in it. */
  private language = "";
  /** The options of the newest state the run has seen (by `version`): what the author changed while a step ran or failed, or while the run waits. */
  private freshOptions: { version: number; options: AutopilotOptions } | null = null;
  /** The last heartbeat the run saved: the summaries it tells say it when it is newer than the one of the state they are made from. */
  private savedHeartbeatAt: string | null = null;
  /** The run already said that the money budget cannot apply to a model without a price. */
  private budgetWarned = false;
  /** What the planner reported during this run, so that each finding is said once however many steps it takes. */
  private readonly reported = new Set<string>();
  private readonly persistHeartbeatMs: number;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInFlight: Promise<void> | null = null;
  /** The run is writing the state itself (a step, a failure): no heartbeat is started, and none is left in flight. */
  private holds = 0;
  /** The run is closing or over: no more heartbeats. */
  private closed = false;
  /** The state as the run last read or wrote it: what the author's changes are measured against. */
  private known: AutopilotState | null = null;
  /** How many chapters had a change waiting for the author before the last step (`summary.frozenChanges`); `null` until the run looked. */
  private frozenWaitingCount: number | null = null;

  constructor(private readonly config: AutopilotRunConfig) {
    this.now = config.now ?? (() => new Date());
    this.store = transientStore(config.store);
    this.defaultPublish = hostDefaultPublish(config.host, config.defaultPublish);
    this.persistHeartbeatMs = typeof config.persistHeartbeatMs === "number" && Number.isFinite(config.persistHeartbeatMs) ? config.persistHeartbeatMs : DEFAULT_PERSIST_HEARTBEAT_MS;
  }

  get activity(): AutopilotActivity | null {
    return this.current;
  }

  /** Stop now: the AI request in flight is abandoned (the provider may still bill it). */
  stop(): void {
    this.stopRequested = true;
    this.controller.abort(abortError("Paused by the author."));
  }

  /** Finish and save the current step, then pause. A wait before a retry ends at once. */
  stopAfterStep(): void {
    this.stopRequested = true;
    this.waiting?.abort();
  }

  /**
   * Finish and save the current step and go on to the end of the chapter in progress (its closing and its publishing included),
   * then pause. With no chapter in progress (the concept, the plan, the first step of a chapter that has not started, the final
   * judgement) it is `stopAfterStep`, and so is a wait before a retry of such a step (after the final judgement the book is complete,
   * and the run says so); the wait before the retry of a step of the chapter goes on, because the chapter still has to be finished.
   */
  stopAfterChapter(): void {
    this.chapterStopRequested = true;
    if (!this.inChapter) this.waiting?.abort();
  }

  /**
   * Take back a pause that is waiting (`stopAfterStep`, `stopAfterChapter`): `true` when there was one. A `stop` that already
   * happened cannot be undone, nor can a pause of a run that is closing.
   */
  cancelPause(): boolean {
    if (this.closed || this.controller.signal.aborted) return false;
    const waiting = this.stopRequested || this.chapterStopRequested;
    this.stopRequested = false;
    this.chapterStopRequested = false;
    return waiting;
  }

  /**
   * «Retry now»: end the wait before the next attempt of a failed step (a quick retry, or a cycle of «Retry later»), so that the attempt starts
   * at once. `true` when the run was waiting, `false` (and nothing happens) otherwise. It uses up nothing more, and gives nothing back: the retry,
   * or the cycle, the wait belonged to stays counted. Told with a `retrySkipped` insight (with the `waitMs` that was left) and, at once, a
   * `state` event without `retry`. It is not a pause: one asked for before or after it works as always.
   */
  retryNow(): boolean {
    const { waiting, retry, waitState } = this;
    if (!waiting || !retry || !waitState || waiting.signal.aborted || this.closed) return false;
    const left = Math.max(0, Date.parse(retry.at) - this.now().getTime());
    this.retry = null;
    waiting.abort(WAIT_SKIPPED);
    const longTerm = retry.longTerm ? { cycle: retry.longTerm.cycle, cycles: retry.longTerm.cycles } : {};
    this.emit({ type: "insight", tone: "info", code: "retrySkipped", title: retrySkippedTitle(isItalian(this.language), left), waitMs: left, ...longTerm });
    this.emit({ type: "state", state: this.summarize(waitState) });
    return true;
  }

  /**
   * The author saved the options while the run goes on (`AutopilotSession.updateOptions` says it with the state it saved): what the run decides
   * from now on reads them, and «Retry later» turned off ends a wait for it (the run stops with the failure it waited to try again). A wait in
   * progress is neither shorter nor longer for new minutes or cycles: they count from the next cycle.
   */
  optionsChanged(state: AutopilotState): void {
    this.noteOptions(state);
  }

  /** Remember the options of a state the run read or wrote, when it is the newest it has seen. */
  private noteOptions(state: AutopilotState | null | undefined): void {
    if (!state || (this.freshOptions && this.freshOptions.version > state.version)) return;
    this.freshOptions = { version: state.version, options: state.options };
    if (this.retry?.longTerm && !state.options.longRetry) this.waiting?.abort(WAIT_TURNED_OFF);
  }

  /** The options as the newest state the run has seen says them: the author may have changed them while the step ran, failed, or waited. */
  private latestOptions(state: AutopilotState): AutopilotOptions {
    return this.freshOptions && this.freshOptions.version >= state.version ? this.freshOptions.options : state.options;
  }

  /** The pause that waits for the run to reach it; `null` when none does (a stop that happened is not waiting). */
  get pausePending(): AutopilotPausePending | null {
    if (this.closed || this.controller.signal.aborted) return null;
    if (this.stopRequested) return "after-step";
    return this.chapterStopRequested ? "after-chapter" : null;
  }

  /** The limit of chapters of this run: the stricter of the one the run was started with and the saved option `chaptersPerRun` (0 = none). */
  private chaptersLimit(chaptersPerRun: number): number {
    const limits = [this.limits.chapters ?? 0, chaptersPerRun].filter((limit) => limit > 0);
    return limits.length ? Math.min(...limits) : 0;
  }

  /**
   * What the run knows that the state file does not: the pause that waits, the limits of the run with how far it got, and the retry it is
   * waiting for (only while it is). A run that is over has none of them.
   */
  runtime(): { pausePending: AutopilotPausePending | null; limits: AutopilotLimitsSummary | null; retry?: AutopilotRetryInfo; frozenChanges?: number } {
    // What the run found of the changes is a fact of the book, not of the run: it is said after the run too.
    const frozen = this.frozenWaitingCount === null ? {} : { frozenChanges: this.frozenWaitingCount };
    if (this.closed) return { pausePending: null, limits: null, ...frozen };
    const steps = this.limits.steps ?? 0;
    const chapters = this.chaptersLimit(this.known?.options.chaptersPerRun ?? 0);
    return {
      pausePending: this.pausePending,
      limits: steps || chapters ? { ...(steps ? { steps } : {}), ...(chapters ? { chapters } : {}), stepsDone: this.stepsThisRun, chaptersDone: this.chaptersThisRun } : null,
      ...(this.retry ? { retry: this.retry } : {}),
      ...frozen,
    };
  }

  /** How many chapters had a change waiting for the author before the last step; `null` until the run looked. */
  get frozenWaiting(): number | null {
    return this.frozenWaitingCount;
  }

  /** The summary of a state as this run says it: with the pause that waits, its limits, where the book is published, and the newest heartbeat it saved. */
  private summarize(state: AutopilotState): AutopilotStateSummary {
    const summary = summarizeAutopilotState(state, { ...this.runtime(), defaultPublish: this.defaultPublish });
    const beat = this.savedHeartbeatAt;
    if (!beat || summary.runner?.runId !== this.runId || !(Date.parse(beat) > Date.parse(summary.runner.heartbeatAt))) return summary;
    return { ...summary, runner: { ...summary.runner, heartbeatAt: beat } };
  }

  /** Queue an intervention in memory (a session saves it at once instead); with `interrupt` the running step is abandoned and repeated with it. */
  intervene(input: InterventionInput): void {
    if (!input.text.trim()) throw new Error("The intervention is empty.");
    if (input.scope !== "next_step") normalizeRuleText(input.text);
    this.queue.push(input);
    if (input.interrupt) this.interrupt();
  }

  /** Abandon the step in flight: it is repeated on the latest saved state, which already holds the intervention that asked for it. */
  interrupt(): void {
    if (!this.stepController) return;
    this.interrupted = true;
    this.stepController.abort(abortError("Interrupted by an author intervention."));
  }

  private emit(event: AutopilotEventBody): void {
    try {
      this.config.emit(event);
    } catch {
      // Listeners must never break the run.
    }
  }

  private async stepContext(snapshot: BookSnapshot, state: AutopilotState): Promise<StepContext> {
    const language = languageCode(snapshot.book.language);
    this.language = language;
    const outline = OutlineReader.of(this.store, snapshot, this.outlineCache);
    const [director, panel, design, evaluationStyle, lastChapter] = await Promise.all([
      loadDirectorProfile(this.store, language),
      loadReaderPanel(this.store, snapshot),
      readBody(this.store, STORY_DESIGN_FILE, 20000),
      loadEvaluationStyle(this.store),
      // Only the entries above the brief's number of chapters are read: an outline can only make the book longer.
      outline.lastAuthorChapter(state.brief.targetChapters),
    ]);
    const readers = activeReaders(panel, director, state.options.maxReaders).map((reader) => ({ slug: reader.slug, name: reader.name }));
    return {
      planner: { snapshot, director, readers, language, storyDesignThin: isThinDocument(design), report: (note) => this.announce(note), outline: { lastChapter } },
      director,
      panel,
      evaluationStyle,
      outline,
    };
  }

  private announce(note: PlanNote): void {
    if (this.reported.has(note.key)) return;
    this.reported.add(note.key);
    this.emit({ type: "insight", tone: note.tone, title: note.title, ...(note.detail ? { detail: note.detail } : {}), ...(note.code ? { code: note.code } : {}), ...(note.chapterNumber !== undefined ? { chapterNumber: note.chapterNumber } : {}) });
  }

  /**
   * Waits before a retry, and says how the wait ended (`RetryWaitOutcome`): `stopped` when a pause ended it (or came before it; a pause at the end
   * of the chapter does not, for a step of the chapter), `skipped` for «Retry now», `off` when «Retry later» was turned off during a wait of it.
   * While it waits the summary says when the next attempt is (`retry`, with a `state` event), and it says so no more once the wait is over.
   */
  private async waitBeforeRetry(milliseconds: number, state: AutopilotState, retry: Omit<AutopilotRetryInfo, "at">): Promise<RetryWaitOutcome> {
    if (this.stopRequested || this.controller.signal.aborted || (this.chapterStopRequested && !this.inChapter)) return "stopped";
    const waiting = new AbortController();
    const onStop = () => waiting.abort();
    this.controller.signal.addEventListener("abort", onStop, { once: true });
    this.waiting = waiting;
    this.waitState = state;
    this.retry = { at: new Date(this.now().getTime() + Math.max(0, milliseconds)).toISOString(), attempt: retry.attempt, retries: retry.retries, ...(retry.longTerm ? { longTerm: retry.longTerm } : {}) };
    this.emit({ type: "state", state: this.summarize(state) });
    try {
      await sleep(milliseconds, waiting.signal);
    } catch {
      // Ended early: the reason says by what.
    } finally {
      this.waiting = null;
      this.retry = null;
      this.waitState = null;
      this.controller.signal.removeEventListener("abort", onStop);
    }
    // What ended the wait in the same moment as its time is what counts (a «Retry now» told already, a pause asked).
    if (!waiting.signal.aborted) return "elapsed";
    const reason: unknown = waiting.signal.reason;
    return reason === WAIT_SKIPPED ? "skipped" : reason === WAIT_TURNED_OFF ? "off" : "stopped";
  }

  private drainQueue(state: AutopilotState, during: string): AutopilotState {
    let next = state;
    while (this.queue.length) next = applyIntervention(next, this.queue.shift()!, this.now(), during);
    return next;
  }

  /** The next heartbeat is due after `persistHeartbeatMs` without a write of the state file: every write of the run starts the wait again. */
  private armHeartbeat(): void {
    this.disarmHeartbeat();
    if (!(this.persistHeartbeatMs > 0) || this.closed || this.leaseLost || this.holds > 0) return;
    const timer = setTimeout(() => {
      this.heartbeatTimer = null;
      const beat: Promise<void> = this.persistHeartbeat().finally(() => {
        if (this.heartbeatInFlight === beat) this.heartbeatInFlight = null;
        this.armHeartbeat();
      });
      this.heartbeatInFlight = beat;
    }, this.persistHeartbeatMs);
    (timer as { unref?: () => void }).unref?.();
    this.heartbeatTimer = timer;
  }

  private disarmHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** The run is about to write the state itself: no heartbeat starts, and one that is being written is waited for. */
  private async holdHeartbeat(): Promise<void> {
    this.holds += 1;
    this.disarmHeartbeat();
    await this.heartbeatInFlight;
  }

  private releaseHeartbeat(): void {
    this.holds = Math.max(0, this.holds - 1);
    this.armHeartbeat();
  }

  /**
   * Save a fresh `runner.heartbeatAt` while a long step runs, so that another host does not take the run for dead. It is a
   * compare-and-swap write of the file as it is now (nothing the author saved is lost) that never touches the step: a
   * conflict or a failing store is ignored until the next heartbeat; another runner's id in the file is the lease lost.
   */
  private async persistHeartbeat(): Promise<void> {
    try {
      const stored = await readStoredAutopilot(this.store);
      if (this.holds > 0 || this.closed || this.leaseLost || stored.corrupt || !stored.state) return;
      if (this.lostLease(stored)) {
        this.loseLease();
        this.stepController?.abort(abortError(TAKEN_OVER));
        this.waiting?.abort();
        return;
      }
      // What the author changed elsewhere (another tab, the server's own routes) reaches a run that waits: «Retry later» turned off ends its wait.
      this.noteOptions(stored.state);
      // Nobody owns the book (somebody paused it): the run's own end is still recorded, but a heartbeat must not bring the lease back.
      if (!stored.state.runner) return;
      const at = this.now();
      const next = stampState({ ...stored.state, runner: { ...stored.state.runner, heartbeatAt: at.toISOString() } }, at);
      await this.store.commit([stateChange(next, stored.stateHash)], "Autopilot: heartbeat");
      this.savedHeartbeatAt = next.runner?.heartbeatAt ?? null;
      this.noteOptions(next);
    } catch {
      // A conflict, or a store that cannot be written right now: the next heartbeat tries again and the run goes on.
    }
  }

  async execute(start: StartOptions = {}): Promise<AutopilotState> {
    const { store } = this;
    this.limits = normalizeRunLimits(start.limits) ?? {};
    const stored = await readStoredAutopilot(store);
    assertStoredStateReadable(stored);
    let state = stored.state ?? createAutopilotState(this.now(), start.brief, start.options);
    const startedAt = this.now().toISOString();
    state = extendPlanIfNeeded({
      ...state,
      brief: normalizeBrief(start.brief ?? {}, state.brief),
      options: normalizeOptions(start.options ?? {}, state.options),
      plan: state.plan ? { ...state.plan, awaitingAuthor: false } : null,
      status: "running",
      message: null,
      lastError: null,
      runner: { host: this.config.host, label: this.config.hostLabel, ...(this.config.hostId ? { hostId: this.config.hostId } : {}), runId: this.runId, startedAt, heartbeatAt: startedAt },
    });
    state = stampState(this.drainQueue(state, "start"), this.now());
    await store.commit([stateChange(state, stored.stateHash)], "Autopilot: started");
    this.known = state;
    this.emit({ type: "run-started", runId: this.runId, host: this.config.host });
    this.emit({ type: "state", state: this.summarize(state) });
    this.armHeartbeat();
    try {
      return await this.runSteps(state);
    } catch (error) {
      // Nothing more can be saved (for example the state file became unreadable): the listeners still learn that the run is over.
      this.emit({ type: "run-ended", runId: this.runId, status: "error", message: describeError(error) });
      throw error;
    } finally {
      this.closed = true;
      this.disarmHeartbeat();
    }
  }

  /** The steps of the run, until it completes, pauses, fails, or another runner takes the book. */
  private async runSteps(initial: AutopilotState): Promise<AutopilotState> {
    const { store } = this;
    let state = initial;
    let conflictRetries = 0;
    /** Retries used since the last success: provider failures (up to three) and everything else (one). */
    let transientRetries = 0;
    let otherRetries = 0;
    /** What the previous failure said: the same words again from a failure that does not depend on the moment mean it will not pass. */
    let lastFailure = "";
    /** Cycles of «Retry later» begun since the last success (`options.longRetry`). */
    let longCycles = 0;
    /**
     * The steps that ended in a wait of «Retry later», and where the steps since the last success or the last such wait begin: they are not
     * counted against the ceiling of a run, which catches a run that loops, because their waits bound them (and the cycles are the author's).
     */
    let waitedSteps = 0;
    let groupStart = 0;
    let lastSuccessKey = "";
    let successRepeats = 0;
    /** Reason the previous attempt of a step was rejected, told to the same request of the retry. */
    let retry: { key: string; label: string; note: string } | null = null;
    for (let steps = 0; ; steps += 1) {
      // A heartbeat that found another runner's id may have done so between two steps: nothing more is written.
      if (this.leaseLost) break;
      if (this.stopRequested) {
        state = await this.finish(state, "paused", null);
        break;
      }
      if (steps - waitedSteps > runStepCeiling(state)) {
        state = await this.finish({ ...state, lastError: { message: "Too many steps in one run.", at: this.now().toISOString(), errorKind: "limit" } }, "error", "Too many steps in one run.");
        break;
      }
      let task: TaskDescriptor | null = null;
      const spend = newSpend();
      let lastLabel: string | undefined;
      const stepController = new AbortController();
      this.stepController = stepController;
      const onRunAbort = () => stepController.abort(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", onRunAbort, { once: true });
      // A stop that already happened is never heard by a listener added afterwards: pass it on, or the step would run and be billed.
      if (this.controller.signal.aborted) onRunAbort();
      try {
        const latest = await readStoredAutopilot(store);
        assertStoredStateReadable(latest);
        if (this.lostLease(latest)) {
          this.loseLease();
          break;
        }
        if (latest.state) {
          state = { ...latest.state, status: "running", runner: state.runner };
          this.known = latest.state;
          this.noteOptions(latest.state);
        }
        await this.config.hooks?.beforeStep?.(stepController.signal);
        const snapshot = await loadBookSnapshot(store, this.cache);
        const context = await this.stepContext(snapshot, state);
        // An outline the author made longer than the book extends it, as raising the number of chapters does at the start of a run.
        const outlineTarget = effectiveTargetChapters(state, context.planner.outline);
        if (outlineTarget > effectiveTargetChapters(state)) state = extendPlanIfNeeded(state, outlineTarget);
        state = advanceState(state, context.planner);
        // Before a chapter is started: an entry of the outline the author changed or deleted since the plan followed it.
        const outlineStatus = await outlinePlanStatus(context.outline, state, context.planner.language);
        for (const note of outlineStatus.notes) this.announce(note);
        context.planner.outline = { lastChapter: context.planner.outline?.lastChapter ?? 0, changed: outlineStatus.changed };
        // The author changed a frozen chapter, or the outline of a written one: asked, reviewed or said, as `frozenEdits` says, before the step.
        const at = this.now().toISOString();
        const settled = settleFrozenChanges(state, { snapshot, outlineWritten: outlineStatus.written, language: context.planner.language, now: at });
        for (const note of settled.notes) this.announce(note);
        this.frozenWaitingCount = settled.waiting;
        context.planner.frozen = { outlineWritten: outlineStatus.written, now: at };
        // A decision about a change may start now (the chapter goes back to review, before the plan). Advancing is idempotent: it is done
        // again only when there is something new for it.
        if (settled.state !== state || settled.state.pendingReviews?.some((entry) => !entry.started)) state = advanceState(settled.state, context.planner);
        let step = nextStep(state, context.planner);
        if (this.queue.length) {
          // Interventions recorded during the previous step steer the choice of this one.
          state = advanceState(this.drainQueue(state, step.kind === "task" ? step.task.title : step.message), context.planner);
          step = nextStep(state, context.planner);
        }
        if (step.kind === "stop") {
          state = await this.finish(state, step.status, step.message);
          break;
        }
        const italian = isItalian(context.planner.language);
        // A pause at the end of the chapter asked when the next step is not part of a chapter that is in progress (the run is between two chapters, or in the plan): there is no chapter to finish, so the run pauses here, before spending anything.
        if (this.chapterStopRequested && !chapterInProgress(state, step.task)) {
          const closed = this.closedChapter;
          state = await this.finish(state, "paused", closed === null ? null : chapterPauseMessage(italian, closed), closed === null ? undefined : "chapterPause");
          break;
        }
        // The steps this run was limited to are done. The planner has had its say first, so a limit never takes the place of a reason to stop the book has (the plan waits for the author, the book is complete).
        if (this.limits.steps && this.stepsThisRun >= this.limits.steps) {
          state = await this.finish(state, "paused", stepLimitMessage(italian, this.limits.steps), "stepLimit");
          break;
        }
        // A profile the autopilot cannot read as it is written (a typo in director.md, a ghostwriter with broken YAML) is the author's to correct: nothing is spent, and no file is replaced by the defaults.
        const problems = await profileProblems({ store, snapshot, state, director: context.director, panel: context.panel, task: step.task, evaluationStyle: context.evaluationStyle });
        if (problems.length) {
          this.emit({ type: "insight", tone: "warning", code: "profileProblems", title: profileProblemsTitle(problems, context.planner.language), detail: problems.join("\n") });
          state = await this.finish(state, "waiting-author", profileProblemsMessage(problems, context.planner.language));
          break;
        }
        if (state.options.budgetLimit > 0 && state.stats.cost >= state.options.budgetLimit) {
          state = await this.finish(state, "paused", italian ? "Budget raggiunto: alza il limite per continuare." : "Budget reached: raise the limit to continue.");
          break;
        }
        if ((state.options.budgetTokens ?? 0) > 0 && state.stats.inputTokens + state.stats.outputTokens >= (state.options.budgetTokens ?? 0)) {
          state = await this.finish(state, "paused", italian ? "Budget di token raggiunto: alza il limite per continuare." : "Token budget reached: raise the limit to continue.");
          break;
        }
        task = step.task;
        this.inChapter = chapterInProgress(state, task);
        const boostKey = step.task.kind;
        const key = taskKey(task);
        if (key === lastSuccessKey && successRepeats >= 2) throw new Error(`The autopilot is not making progress on "${task.title}".`);
        const correction = retry?.key === key ? retry : null;
        retry = null;
        const notes = task.acceptsNotes ? pendingNotes(state) : [];
        const startedAt = this.now();
        const activity: AutopilotActivity = {
          id: randomId("activity"),
          runId: this.runId,
          task: task.kind,
          phase: task.phase,
          title: task.title,
          reason: task.reason,
          next: task.next,
          chapterNumber: task.chapterNumber,
          sceneNumber: task.sceneNumber,
          reader: task.readerName ?? task.reader,
          status: "running",
          startedAt: startedAt.toISOString(),
          host: this.config.host,
          interventionIds: notes.map((note) => note.id),
        };
        this.current = activity;
        this.emit({ type: "task-started", activity });
        let lastProgress = 0;
        let lastStructuredProgress: number | undefined;
        const ai = async (request: Omit<AiRequest, "signal">): Promise<AiResponse> => {
          lastLabel = request.label;
          const onText = request.json ? undefined : (text: string) => {
            const at = Date.now();
            if (text.length > 0 && at - lastProgress < 350) return;
            lastProgress = at;
            this.emit({ type: "task-progress", activityId: activity.id, characters: text.length, preview: tail(text, 700) });
          };
          // A structured reply has no text to show: the client reports how much has arrived (up to four times a second), and one report a second is said, as numbers only.
          const onProgress = request.json ? (progress: AiProgress) => {
            const at = this.now().getTime();
            if (lastStructuredProgress !== undefined && at - lastStructuredProgress < STRUCTURED_PROGRESS_INTERVAL_MS) return;
            lastStructuredProgress = at;
            this.emit({ type: "task-progress", activityId: activity.id, characters: progress.characters, bytes: progress.bytes, preview: "" });
          } : undefined;
          const user = correction?.label === request.label ? `${request.user}\n\n${currentRequest(correction.note)}` : request.user;
          let response: AiResponse;
          const boost = this.outputBoosts.get(boostKey) ?? 1;
          try {
            response = await this.config.ai.complete({ ...request, user, signal: stepController.signal, onText: request.onText ?? onText, ...(onProgress ? { onProgress: request.onProgress ?? onProgress } : {}), ...(boost > 1 ? { outputBoost: boost } : {}) });
          } catch (error) {
            // A failed attempt may still have been billed: count what the provider reported.
            if (error instanceof AiProviderError && (error.usage || error.cost !== undefined || error.model)) recordSpend(spend, error);
            // A model that spent its whole limit reasoning gets one more try with a larger one, and the same for the steps after it.
            if (error instanceof AiProviderError && error.truncated && error.reasoningOnly && !error.limitReached && boost < OUTPUT_BOOST) {
              this.outputBoosts.set(boostKey, OUTPUT_BOOST);
              boostedRetries.add(error);
            }
            throw error;
          }
          recordSpend(spend, response);
          if (response.costKnown === false && response.cost === undefined && state.options.budgetLimit > 0 && !this.budgetWarned) {
            this.budgetWarned = true;
            const model = response.model ?? "?";
            this.emit({ type: "insight", activityId: activity.id, tone: "warning", code: "budgetNotApplicable", title: italian ? `Il budget in denaro non è applicabile: il modello ${model} non ha prezzo.` : `The money budget does not apply: the model ${model} has no price.`, detail: italian ? "Imposta un budget in token: vale per ogni modello." : "Set a token budget instead: it works for every model." });
          }
          if (response.truncated) {
            throw new AiProviderError(`${[response.provider, response.model].filter(Boolean).join(" ") || "The model"}: the reply was cut by the output token limit. Nothing was applied.`, undefined, false, { truncated: true });
          }
          // The model repeats what it read, and what it read was escaped: the book gets the text as written.
          return response.json === undefined ? response : { ...response, json: unescapePromptDataDeep(response.json) };
        };
        const working = structuredClone(state);
        const taskContext: TaskContext = {
          bookId: this.config.bookId,
          store,
          state: working,
          snapshot,
          director: context.director,
          readerPanel: context.panel,
          language: context.planner.language,
          task,
          notes,
          now: this.now,
          signal: stepController.signal,
          rejectedBefore: Boolean(correction),
          ai,
          insight: (tone, title, detail, extra) => this.emit({
            type: "insight",
            activityId: activity.id,
            tone,
            title,
            ...(detail ? { detail } : {}),
            ...(extra?.code ? { code: extra.code } : {}),
            ...(extra?.chapterNumber !== undefined ? { chapterNumber: extra.chapterNumber } : {}),
            ...(extra?.ghostwriter ? { ghostwriter: extra.ghostwriter } : {}),
          }),
          evaluationStyle: context.evaluationStyle,
          outline: context.outline,
        };
        const result = await TASK_EXECUTORS[task.kind](taskContext);
        const finishedAt = this.now();
        const applied = new Set(notes.map((note) => note.id));
        const changes = normalizeChanges(result.changes);
        const done: AutopilotActivity = {
          ...activity,
          status: "succeeded",
          endedAt: finishedAt.toISOString(),
          summary: result.summary,
          changedPaths: changes.map((change) => change.path),
          model: spend.model,
          provider: spend.provider,
          usage: spend.usage,
          cost: spend.cost || undefined,
        };
        let next: AutopilotState = {
          ...working,
          interventions: working.interventions.map((entry) => applied.has(entry.id) ? { ...entry, status: "applied" as const, appliedAt: finishedAt.toISOString(), appliedBy: activity.id } : entry),
          // The time of the step that is saved, from its start to its end (a clock that went back counts for nothing). The count is born with the
          // first step it counts, and the moment that step began is the moment the count began: said once, never moved, and not made up for a count that was born without it.
          // A count born on a book that had already saved steps says that it is partial.
          stats: {
            ...withSpend(working.stats, spend),
            tasks: working.stats.tasks + 1,
            workedMs: (working.stats.workedMs ?? 0) + Math.max(0, Math.round(finishedAt.getTime() - startedAt.getTime())),
            ...(working.stats.workedMs === undefined && working.stats.workedMsSince === undefined ? { workedMsSince: startedAt.toISOString(), ...(working.stats.tasks > 0 ? { workedMsPartial: true as const } : {}) } : {}),
          },
          runner: state.runner ? { ...state.runner, heartbeatAt: finishedAt.toISOString() } : null,
          lastError: null,
        };
        next = this.drainQueue(next, task.title);
        next = stampState({ ...next, phase: phaseOf(next) }, finishedAt);
        const message = `Autopilot: ${task.title}`;
        await this.holdHeartbeat();
        try {
          state = await this.commitStep(changes, activityChange([...latest.activities, done], latest.activityHash), next, latest, message);
        } finally {
          this.releaseHeartbeat();
        }
        this.known = state;
        this.noteOptions(state);
        this.current = null;
        conflictRetries = 0;
        transientRetries = 0;
        otherRetries = 0;
        lastFailure = "";
        longCycles = 0;
        groupStart = steps + 1;
        successRepeats = key === lastSuccessKey ? successRepeats + 1 : 0;
        lastSuccessKey = key;
        // The counts of the run include this step before anybody is told about it.
        this.stepsThisRun += 1;
        if (task.kind === "consolidate") this.chaptersThisRun += 1;
        this.closedChapter = task.kind === "consolidate" ? task.chapterNumber ?? null : null;
        this.emit({ type: "task-finished", activity: done });
        this.emit({ type: "state", state: this.summarize(state) });
        // Where the book is published is read from the state this step saved, which holds what the author changed while it ran: a change takes hold at the end of the step that is running.
        const publish = effectivePublish(state.options, this.defaultPublish);
        if (publish === "step") {
          await this.config.hooks?.afterCommit?.({ task, message, paths: done.changedPaths ?? [] }).catch((error) => {
            this.emit({ type: "sync", activityId: done.id, tone: "warning", code: "syncFailed", title: italian ? "Sincronizzazione dopo il passo non riuscita." : "Sync after the step failed.", detail: describeError(error) });
          });
        }
        if (task.kind === "consolidate") {
          const chapter = state.plan?.chapters.find((entry) => entry.number === task!.chapterNumber);
          if (chapter && publish !== "off" && this.config.hooks?.afterChapter) {
            await this.config.hooks.afterChapter({ chapterNumber: chapter.number, title: chapter.title }).catch((error) => {
              this.emit({ type: "sync", activityId: done.id, tone: "warning", code: "publishFailed", title: italian ? "Pubblicazione del capitolo non riuscita." : "Publishing the chapter failed.", detail: describeError(error) });
            });
          }
          // The chapter is closed and published: the pause the author asked for at its end happens now. What was asked just now is what is said, before the option that pauses after every chapter.
          if (this.chapterStopRequested) {
            state = await this.finish(state, "paused", chapterPauseMessage(italian, task.chapterNumber ?? 0), "chapterPause");
            break;
          }
          if (state.options.pauseAfterEachChapter || context.director.autonomy === "ask-always") {
            state = await this.finish(state, "paused", italian ? `Capitolo ${task.chapterNumber} approvato: rileggilo e riprendi.` : `Chapter ${task.chapterNumber} approved: read it and resume.`);
            break;
          }
          const chaptersLimit = this.chaptersLimit(state.options.chaptersPerRun);
          if (chaptersLimit > 0 && this.chaptersThisRun >= chaptersLimit) {
            state = await this.finish(state, "paused", chapterLimitMessage(italian, this.chaptersThisRun), "chapterLimit");
            break;
          }
        }
      } catch (error) {
        const activity = this.current;
        this.current = null;
        const runAborted = this.controller.signal.aborted;
        const interrupted = this.interrupted && isAbortError(error) && !runAborted;
        this.interrupted = false;
        // What the failure is owed is known before it is saved, so that its activity says how far the retries of its kind have got. A step the author cancelled is no failure.
        const plan = isAbortError(error) ? null : planRetry(error, { transient: transientRetries, other: otherRetries, lastFailure });
        const failure = isAbortError(error) ? {} : autopilotErrorFields(error, plan ? { attempt: plan.attempt, retries: plan.retries } : undefined);
        if (activity) {
          const spent = spentSomething(spend);
          const failed: AutopilotActivity = {
            ...activity,
            status: isAbortError(error) ? "cancelled" : "failed",
            endedAt: this.now().toISOString(),
            error: describeError(error),
            ...failure,
            ...(spent ? { model: spend.model, provider: spend.provider, usage: spend.usage, cost: spend.cost || undefined } : {}),
          };
          this.emit({ type: "task-finished", activity: failed });
          const saved = await this.persistFailure(failed, spent ? spend : null).catch(() => null);
          if (spent) state = { ...state, stats: saved?.stats ?? withSpend(state.stats, spend) };
        }
        if (this.leaseLost) break;
        if (interrupted) continue;
        if (runAborted || isAbortError(error)) {
          state = await this.finish(state, "paused", null);
          break;
        }
        if (isBookConflictError(error) && conflictRetries < 2) {
          conflictRetries += 1;
          this.emit({ type: "insight", tone: "warning", code: "conflictRetry", title: "The book changed during the step: repeating it on the latest version.", detail: describeError(error) });
          continue;
        }
        if (plan) {
          lastFailure = plan.message;
          if (plan.granted) {
            const base = this.config.retryDelayMs ?? BASE_RETRY_DELAY_MS;
            const scale = base / BASE_RETRY_DELAY_MS;
            let waitMs = Math.round(base);
            let title = "The step failed: retrying once.";
            if (plan.kind === "boost") {
              waitMs = 0;
              title = `The model used all its output tokens while reasoning: retrying once with a ${OUTPUT_BOOST}× larger limit.`;
            } else if (plan.kind === "transient") {
              transientRetries += 1;
              const jitter = 0.75 + (this.config.random ?? Math.random)() * 0.5;
              const retryAfter = error instanceof AiProviderError && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
              waitMs = Math.round(Math.max(BASE_RETRY_DELAY_MS * 3 ** (plan.attempt - 1) * jitter * scale, retryAfter * scale));
              title = `The step failed: retry ${plan.attempt} of ${MAX_TRANSIENT_RETRIES} in ${formatWait(waitMs)}.`;
            } else {
              otherRetries += 1;
            }
            const note = retryNoteFor(error);
            if (task && note && lastLabel) retry = { key: taskKey(task), label: lastLabel, note };
            this.emit({ type: "insight", tone: "warning", code: "failureRetry", title, detail: plan.message, attempt: plan.attempt, retries: plan.retries, waitMs });
            const outcome = await this.waitBeforeRetry(waitMs, state, { attempt: plan.attempt, retries: plan.retries });
            if (outcome === "stopped") {
              state = await this.finish(state, "paused", null);
              break;
            }
            // The attempt starts now: nothing waits any more («Retry now» said it already).
            if (outcome === "elapsed") this.emit({ type: "state", state: this.summarize(state) });
            continue;
          }
        }
        const italian = isItalian(this.language);
        let ended: { message: string; code: AutopilotLastErrorCode } | null = null;
        // «Retry later»: the quick retries of a transient provider failure are used up. With the policy on (as the author left it, also while the
        // step failed), the run waits and tries the step again, as the book is then, with all its quick retries; the cycles start from zero
        // again after a step that works. The budget, the limits, a pause and the lease are checked before every step, as they always are.
        if (plan && classifyRetry(error).long) {
          const policy = this.latestOptions(state).longRetry;
          const cycles = policy ? (policy.cycles === "unlimited" ? null : policy.cycles) : null;
          if (policy && cycles !== null && longCycles >= cycles) {
            this.emit({ type: "insight", tone: "critical", code: "longRetryExhausted", title: italian ? `Il passo è fallito ancora dopo ${restarts(true, longCycles)}: la corsa si ferma.` : `The step failed again after ${restarts(false, longCycles)}: the run stops.`, detail: plan.message, cycle: longCycles, cycles });
            ended = { message: longRetryExhaustedMessage(italian, longCycles, describeError(error)), code: "longRetryExhausted" };
          } else if (policy && budgetUsedUp(this.latestOptions(state), state.stats)) {
            // Nothing is waited for a run that cannot spend: it pauses for the budget before the next step, as it always does.
            transientRetries = 0;
            lastFailure = "";
            continue;
          } else if (policy) {
            longCycles += 1;
            const waitMs = Math.round(policy.everyMinutes * 60_000 * ((this.config.retryDelayMs ?? BASE_RETRY_DELAY_MS) / BASE_RETRY_DELAY_MS));
            this.emit({ type: "insight", tone: "warning", code: "longRetryWait", title: longRetryWaitTitle(italian, waitMs, longCycles, cycles), detail: plan.message, waitMs, cycle: longCycles, cycles });
            const outcome = await this.waitBeforeRetry(waitMs, state, { attempt: plan.attempt, retries: plan.retries, longTerm: { cycle: longCycles, cycles } });
            if (outcome === "stopped") {
              state = await this.finish(state, "paused", null);
              break;
            }
            if (outcome === "off") ended = { message: longRetryOffMessage(italian, describeError(error)), code: "longRetryOff" };
            else {
              if (outcome === "elapsed") this.emit({ type: "state", state: this.summarize(state) });
              transientRetries = 0;
              lastFailure = "";
              waitedSteps += steps + 1 - groupStart;
              groupStart = steps + 1;
              continue;
            }
          }
        }
        state = await this.finish({
          ...state,
          stats: { ...state.stats, failures: state.stats.failures + 1 },
          // The code the run ends with when «Retry later» stopped it is also in the state, for a page that opens after the run and for another device.
          lastError: { message: describeError(error), at: this.now().toISOString(), task: task?.kind, ...(activity ? { activityId: activity.id } : {}), ...failure, ...(ended ? { code: ended.code } : {}) },
        }, "error", ended?.message ?? describeError(error), ended?.code);
        break;
      } finally {
        this.controller.signal.removeEventListener("abort", onRunAbort);
        this.stepController = null;
        this.inChapter = false;
        // An interrupt that came when the step was already over must not make a later abort look like one.
        this.interrupted = false;
      }
    }
    if (this.leaseLost) state = { ...state, status: "paused", message: TAKEN_OVER, runner: null };
    const code: AutopilotMessageCode | undefined = this.leaseLost ? "takenOver" : this.endCode;
    this.emit({ type: "run-ended", runId: this.runId, status: state.status, message: state.message, ...(code ? { code } : {}) });
    return state;
  }

  /**
   * Save a finished step. The state file is read again first. What the author saved to it while the step ran (interventions,
   * rules) is carried into the state this step writes, and the run's own heartbeat needs no carrying: the step is neither
   * repeated nor is an AI call with it. When anything else changed, or another runner owns the book, it is a conflict, as it
   * always was, and the step is repeated on the latest state. A commit that fails only because the author saved again in the
   * meantime is tried again on that state; one rejected for another file is not (the step has to be repeated).
   */
  private async commitStep(changes: BookFileChange[], activity: BookFileChange, next: AutopilotState, latest: StoredAutopilot, message: string): Promise<AutopilotState> {
    const conflict = (reason: string) => new BookConflictError(reason, AUTOPILOT_STATE_FILE);
    let rejected: unknown = null;
    let expected: string | null | undefined;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
      const fresh = await readStoredAutopilot(this.store);
      assertStoredStateReadable(fresh);
      if (this.lostLease(fresh)) {
        this.loseLease();
        throw rejected ?? conflict("Another runner owns the book now.");
      }
      if (fresh.activityHash !== latest.activityHash) throw rejected ?? conflict("The activity log changed during the step.");
      if (rejected && fresh.stateHash === expected) throw rejected;
      let candidate = next;
      if (fresh.stateHash !== latest.stateHash) {
        if (!latest.state || !fresh.state) throw rejected ?? conflict("The autopilot state changed during the step.");
        const merged = reconcileAuthorChanges(next, latest.state, fresh.state);
        if (merged.foreign) throw rejected ?? conflict("The autopilot state changed during the step.");
        candidate = { ...merged.state, version: fresh.state.version + 1, phase: phaseOf(merged.state) };
      }
      expected = fresh.stateHash;
      try {
        await this.store.commit(normalizeChanges([...changes, stateChange(candidate, fresh.stateHash), activity]), message);
        return candidate;
      } catch (error) {
        if (!isBookConflictError(error)) throw error;
        rejected = error;
      }
    }
    throw rejected;
  }

  /** Another run is recorded as the owner of the book. A stored runner of `null` means nobody owns it: this run may still record its end. */
  private lostLease(stored: StoredAutopilot): boolean {
    const owner = stored.state?.runner?.runId;
    return Boolean(owner) && owner !== this.runId;
  }

  /** From now on this run writes nothing: the book belongs to another runner. */
  private loseLease(): void {
    if (this.leaseLost) return;
    this.leaseLost = true;
    this.emit({ type: "insight", tone: "warning", code: "takenOver", title: TAKEN_OVER });
  }

  /**
   * Save a failed or cancelled step. What its AI calls cost is added to the state's statistics
   * in the same commit, so the budget limit never under-counts rejected replies.
   */
  private async persistFailure(activity: AutopilotActivity, spend: StepSpend | null): Promise<AutopilotState | null> {
    await this.holdHeartbeat();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stored = await readStoredAutopilot(this.store);
        assertStoredStateReadable(stored);
        if (this.lostLease(stored)) {
          this.loseLease();
          return null;
        }
        this.noteOptions(stored.state);
        const changes = [activityChange([...stored.activities, activity], stored.activityHash)];
        const next = spend && stored.state ? stampState({ ...stored.state, stats: withSpend(stored.state.stats, spend) }, this.now()) : null;
        if (next) changes.push(stateChange(next, stored.stateHash));
        try {
          await this.store.commit(changes, `Autopilot: ${activity.title} (${activity.status})`);
          this.noteOptions(next);
          return next;
        } catch (error) {
          if (!isBookConflictError(error)) throw error;
        }
      }
      return null;
    } finally {
      this.releaseHeartbeat();
    }
  }

  /**
   * Close the run with a final status, persisted together with any queued intervention and with what the author saved since the run last read the state.
   * `code` is the reason a client can say in its language (`run-ended`'s `code`), when there is one.
   */
  private async finish(state: AutopilotState, status: AutopilotState["status"], message: string | null, code?: AutopilotMessageCode): Promise<AutopilotState> {
    this.endCode = code;
    this.closed = true;
    this.disarmHeartbeat();
    await this.heartbeatInFlight;
    const ended: AutopilotState = { ...state, status: state.question ? "waiting-author" : status, message, runner: null, phase: phaseOf(state) };
    let final = ended;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let stored: StoredAutopilot;
      try {
        stored = await readStoredAutopilot(this.store);
      } catch (error) {
        this.emit({ type: "insight", tone: "warning", code: "finalStateFailed", title: "Could not save the final autopilot state.", detail: describeError(error) });
        return final;
      }
      assertStoredStateReadable(stored);
      if (this.lostLease(stored)) {
        this.loseLease();
        return state;
      }
      const closing = stored.state && this.known ? reconcileAuthorChanges(ended, this.known, stored.state).state : ended;
      final = stampState(this.drainQueue({ ...closing, phase: phaseOf(closing) }, message ?? status), this.now());
      try {
        await this.store.commit([stateChange(final, stored.stateHash)], `Autopilot: ${final.status}`);
        this.emit({ type: "state", state: this.summarize(final) });
        return final;
      } catch (error) {
        if (!isBookConflictError(error)) {
          this.emit({ type: "insight", tone: "warning", code: "finalStateFailed", title: "Could not save the final autopilot state.", detail: describeError(error) });
          return final;
        }
      }
    }
    return final;
  }
}
