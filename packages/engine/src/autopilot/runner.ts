import { redactSecrets } from "../ai/redact.js";
import { AiProviderError, AiReplyRejectedError, type AiPort, type AiRequest, type AiResponse, type AiUsage } from "../ai/types.js";
import { activeReaders, isThinDocument, loadDirectorProfile, loadReaderPanel, readBody } from "../book/context.js";
import { AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_STATE_FILE, STORY_DESIGN_FILE } from "../book/paths.js";
import { SnapshotCache, loadBookSnapshot, type BookSnapshot } from "../book/snapshot.js";
import { BookConflictError, isBookConflictError, normalizeChanges, type BookFileChange, type BookStore } from "../book/store.js";
import type { DirectorProfile } from "../profiles/director.js";
import type { ReaderPersonaProfile } from "../profiles/readers.js";
import { abortError, isAbortError, sleep } from "../util/abort.js";
import { randomId } from "../util/hash.js";
import { StructuredReplyError } from "../util/json.js";
import { currentRequest, unescapePromptDataDeep } from "../prompt/trust.js";
import { isItalian, languageCode, tail, truncate } from "../util/text.js";
import { advanceState, extensionNote, nextStep, phaseOf, type PlanNote, type PlannerContext, type TaskDescriptor } from "./planner.js";
import { profileProblems, profileProblemsMessage, profileProblemsTitle } from "./profile-check.js";
import {
  MAX_INTERVENTIONS,
  MAX_REVISION_NOTES,
  capConstraints,
  createAutopilotState,
  inspectAutopilotState,
  normalizeBrief,
  normalizeOptions,
  normalizeRuleText,
  parseActivityLog,
  pendingNotes,
  serializeActivityLog,
  serializeAutopilotState,
  summarizeAutopilotState,
} from "./state.js";
import { TASK_EXECUTORS, type TaskContext } from "./tasks.js";
import type {
  AutopilotActivity,
  AutopilotEventBody,
  AutopilotState,
  AuthorIntervention,
  InterventionInput,
  QuestionAnswer,
  StartOptions,
} from "./types.js";

export interface AutopilotHooks {
  /** Before every step, e.g. fast-forward the working copy from GitHub (server). */
  beforeStep?(signal: AbortSignal): Promise<void>;
  /** After every committed step, e.g. push to GitHub (server). */
  afterCommit?(info: { task: TaskDescriptor; message: string; paths: string[] }): Promise<void>;
  /** After a chapter is approved, e.g. publish the local commits to GitHub (browser). */
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
  emit: (event: AutopilotEventBody) => void;
  /**
   * Base delay before the automatic retry of a failed step (ms, default 4000). Transient provider errors are retried up
   * to three times, after about 1×, 3× and 9× this delay (and never sooner than the provider's Retry-After); every
   * delay scales with it, so 0 makes them all instant.
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
      next.revision = { ...current, instruction: `${current.instruction}\n${text}` };
    } else {
      // Chapters already rewritten by a revision in progress are still reviewed again at the end.
      const revised = [...(current?.revisedChapters ?? []), ...(current?.targets ?? []).slice(0, current?.cursor ?? 0).map((target) => target.chapterNumber)];
      const revisedChapters = [...new Set(revised)].sort((left, right) => left - right);
      next.revision = { id: randomId("revision"), instruction: text, createdAt: at, targets: null, cursor: 0, ...(revisedChapters.length ? { revisedChapters } : {}) };
    }
    next.finalDone = false;
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

/** Pure application of the author's answer to the director's question. */
export function applyAnswer(state: AutopilotState, answer: QuestionAnswer, now: Date): AutopilotState {
  if (!state.question || state.question.id !== answer.questionId) throw new Error("This question is no longer open.");
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

/** The state without what only the author changes and what every write changes: what is left must be the same before and after. */
function withoutAuthorParts(state: AutopilotState): unknown {
  const { version: _version, updatedAt: _updatedAt, interventions: _interventions, constraints: _constraints, revision: _revision, finalDone: _finalDone, plan, runner, ...rest } = state;
  return {
    ...rest,
    plan: plan ? (({ approved: _approved, awaitingAuthor: _awaitingAuthor, revisionNotes: _notes, revisionBatches: _batches, ...others }) => others)(plan) : plan,
    runner: runner ? (({ heartbeatAt: _heartbeatAt, ...others }) => others)(runner) : runner,
  };
}

/**
 * What the author saved in the state file while a step ran, carried into the state that step produced. `base` is the state
 * as the run last read it, `stored` the file as it is now and `working` the run's own. The author owns the interventions,
 * the rules and what a rewrite changes: they are merged (interventions by id, rules by text, the effects of a new rewrite land
 * on `working`, as they did when they were handed over in memory), and the run wins on everything else. `foreign` says that
 * `stored` differs from `base` in something the author does not own or the run does not write by itself (its own heartbeat):
 * that is a conflict.
 */
export function reconcileAuthorChanges(working: AutopilotState, base: AutopilotState, stored: AutopilotState): { state: AutopilotState; foreign: boolean } {
  const foreign = JSON.stringify(withoutAuthorParts(base)) !== JSON.stringify(withoutAuthorParts(stored));
  const known = new Set(working.interventions.map((entry) => entry.id));
  const added = stored.interventions.filter((entry) => !known.has(entry.id));
  const rulesChanged = stored.constraints.length !== base.constraints.length || stored.constraints.some((rule, index) => rule !== base.constraints[index]);
  if (!added.length && !rulesChanged) return { state: working, foreign };
  const merged = structuredClone(working);
  if (rulesChanged) {
    // The author's list as it is now, and the rules the run itself added to its own copy.
    const before = new Set(base.constraints);
    const now = new Set(stored.constraints);
    merged.constraints = capConstraints([...stored.constraints, ...working.constraints.filter((rule) => !before.has(rule) && !now.has(rule))]);
  }
  merged.interventions = [...merged.interventions, ...added].slice(-MAX_INTERVENTIONS);
  for (const entry of added) if (entry.scope === "rewrite") applyRewrite(merged, entry.text, entry.createdAt);
  return { state: merged, foreign };
}

/** When the author raises the number of chapters of a finished plan, extend it instead of stopping. */
export function extendPlanIfNeeded(state: AutopilotState): AutopilotState {
  const plan = state.plan;
  if (!plan?.approved || plan.chapters.length >= state.brief.targetChapters) return state;
  if (!plan.chapters.every((chapter) => chapter.status === "done")) return state;
  return {
    ...state,
    finalDone: false,
    plan: {
      ...plan,
      approved: false,
      rounds: 0,
      readersDone: true,
      revisionNotes: [extensionNote(state.brief.targetChapters)],
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

function formatWait(milliseconds: number): string {
  return milliseconds >= 1000 ? `${Math.round(milliseconds / 1000)} s` : `${milliseconds} ms`;
}

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

interface StepContext {
  planner: PlannerContext;
  director: DirectorProfile;
  panel: ReaderPersonaProfile[];
}

const TAKEN_OVER = "Another runner took over this book: this run stops.";

/** One autopilot run: loops over steps until it completes, pauses, or fails. */
export class AutopilotRun {
  readonly runId = randomId("run");
  private readonly controller = new AbortController();
  private stepController: AbortController | null = null;
  private stopRequested = false;
  private interrupted = false;
  /** Another run is recorded as the owner of the book: this one saves nothing more and ends. */
  private leaseLost = false;
  private readonly queue: InterventionInput[] = [];
  private readonly cache = new SnapshotCache();
  private readonly store: BookStore;
  private readonly now: () => Date;
  private chaptersThisRun = 0;
  private current: AutopilotActivity | null = null;
  /** Output limit multiplier per kind of step, raised after a reply cut while the model only reasoned; kept for the run, never saved. */
  private readonly outputBoosts = new Map<string, number>();
  /** The wait between two tries of a failed step, ended early by a pause. */
  private waiting: AbortController | null = null;
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

  constructor(private readonly config: AutopilotRunConfig) {
    this.now = config.now ?? (() => new Date());
    this.store = transientStore(config.store);
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
    const [director, panel, design] = await Promise.all([
      loadDirectorProfile(this.store, language),
      loadReaderPanel(this.store, snapshot),
      readBody(this.store, STORY_DESIGN_FILE, 20000),
    ]);
    const readers = activeReaders(panel, director, state.options.maxReaders).map((reader) => ({ slug: reader.slug, name: reader.name }));
    return { planner: { snapshot, director, readers, language, storyDesignThin: isThinDocument(design), report: (note) => this.announce(note) }, director, panel };
  }

  private announce(note: PlanNote): void {
    if (this.reported.has(note.key)) return;
    this.reported.add(note.key);
    this.emit({ type: "insight", tone: note.tone, title: note.title, ...(note.detail ? { detail: note.detail } : {}) });
  }

  /** Waits before a retry; `false` when a pause ended the wait (or came before it). */
  private async waitBeforeRetry(milliseconds: number): Promise<boolean> {
    if (this.stopRequested || this.controller.signal.aborted) return false;
    const waiting = new AbortController();
    const onStop = () => waiting.abort();
    this.controller.signal.addEventListener("abort", onStop, { once: true });
    this.waiting = waiting;
    try {
      await sleep(milliseconds, waiting.signal);
      return true;
    } catch {
      return false;
    } finally {
      this.waiting = null;
      this.controller.signal.removeEventListener("abort", onStop);
    }
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
        return;
      }
      // Nobody owns the book (somebody paused it): the run's own end is still recorded, but a heartbeat must not bring the lease back.
      if (!stored.state.runner) return;
      const at = this.now();
      const next = stampState({ ...stored.state, runner: { ...stored.state.runner, heartbeatAt: at.toISOString() } }, at);
      await this.store.commit([stateChange(next, stored.stateHash)], "Autopilot: heartbeat");
    } catch {
      // A conflict, or a store that cannot be written right now: the next heartbeat tries again and the run goes on.
    }
  }

  async execute(start: StartOptions = {}): Promise<AutopilotState> {
    const { store } = this;
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
    this.emit({ type: "state", state: summarizeAutopilotState(state) });
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
      if (steps > runStepCeiling(state)) {
        state = await this.finish({ ...state, lastError: { message: "Too many steps in one run.", at: this.now().toISOString() } }, "error", "Too many steps in one run.");
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
        }
        await this.config.hooks?.beforeStep?.(stepController.signal);
        const snapshot = await loadBookSnapshot(store, this.cache);
        const context = await this.stepContext(snapshot, state);
        state = advanceState(state, context.planner);
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
        // A profile the autopilot cannot read as it is written (a typo in director.md, a ghostwriter with broken YAML) is the author's to correct: nothing is spent, and no file is replaced by the defaults.
        const problems = await profileProblems({ store, snapshot, state, director: context.director, panel: context.panel, task: step.task });
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
        const boostKey = step.task.kind;
        const key = taskKey(task);
        if (key === lastSuccessKey && successRepeats >= 2) throw new Error(`The autopilot is not making progress on "${task.title}".`);
        const correction = retry?.key === key ? retry : null;
        retry = null;
        const notes = task.acceptsNotes ? pendingNotes(state) : [];
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
          startedAt: this.now().toISOString(),
          host: this.config.host,
          interventionIds: notes.map((note) => note.id),
        };
        this.current = activity;
        this.emit({ type: "task-started", activity });
        let lastProgress = 0;
        const ai = async (request: Omit<AiRequest, "signal">): Promise<AiResponse> => {
          lastLabel = request.label;
          const onText = request.json ? undefined : (text: string) => {
            const at = Date.now();
            if (text.length > 0 && at - lastProgress < 350) return;
            lastProgress = at;
            this.emit({ type: "task-progress", activityId: activity.id, characters: text.length, preview: tail(text, 700) });
          };
          const user = correction?.label === request.label ? `${request.user}\n\n${currentRequest(correction.note)}` : request.user;
          let response: AiResponse;
          const boost = this.outputBoosts.get(boostKey) ?? 1;
          try {
            response = await this.config.ai.complete({ ...request, user, signal: stepController.signal, onText: request.onText ?? onText, ...(boost > 1 ? { outputBoost: boost } : {}) });
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
          insight: (tone, title, detail) => this.emit({ type: "insight", activityId: activity.id, tone, title, ...(detail ? { detail } : {}) }),
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
          stats: { ...withSpend(working.stats, spend), tasks: working.stats.tasks + 1 },
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
        this.current = null;
        conflictRetries = 0;
        transientRetries = 0;
        otherRetries = 0;
        lastFailure = "";
        successRepeats = key === lastSuccessKey ? successRepeats + 1 : 0;
        lastSuccessKey = key;
        this.emit({ type: "task-finished", activity: done });
        this.emit({ type: "state", state: summarizeAutopilotState(state) });
        await this.config.hooks?.afterCommit?.({ task, message, paths: done.changedPaths ?? [] }).catch((error) => {
          this.emit({ type: "sync", activityId: done.id, tone: "warning", code: "syncFailed", title: italian ? "Sincronizzazione dopo il passo non riuscita." : "Sync after the step failed.", detail: describeError(error) });
        });
        if (task.kind === "consolidate") {
          this.chaptersThisRun += 1;
          const chapter = state.plan?.chapters.find((entry) => entry.number === task!.chapterNumber);
          if (chapter && state.options.syncAfterChapter && this.config.hooks?.afterChapter) {
            await this.config.hooks.afterChapter({ chapterNumber: chapter.number, title: chapter.title }).catch((error) => {
              this.emit({ type: "sync", activityId: done.id, tone: "warning", code: "publishFailed", title: italian ? "Pubblicazione del capitolo non riuscita." : "Publishing the chapter failed.", detail: describeError(error) });
            });
          }
          if (state.options.pauseAfterEachChapter || context.director.autonomy === "ask-always") {
            state = await this.finish(state, "paused", italian ? `Capitolo ${task.chapterNumber} approvato: rileggilo e riprendi.` : `Chapter ${task.chapterNumber} approved: read it and resume.`);
            break;
          }
          if (state.options.chaptersPerRun > 0 && this.chaptersThisRun >= state.options.chaptersPerRun) {
            state = await this.finish(state, "paused", italian ? `${this.chaptersThisRun} capitoli completati in questa sessione.` : `${this.chaptersThisRun} chapters completed in this session.`);
            break;
          }
        }
      } catch (error) {
        const activity = this.current;
        this.current = null;
        const runAborted = this.controller.signal.aborted;
        const interrupted = this.interrupted && isAbortError(error) && !runAborted;
        this.interrupted = false;
        if (activity) {
          const spent = spentSomething(spend);
          const failed: AutopilotActivity = {
            ...activity,
            status: isAbortError(error) ? "cancelled" : "failed",
            endedAt: this.now().toISOString(),
            error: describeError(error),
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
        const kind = retryKindOf(error);
        if (kind) {
          const message = describeError(error);
          const repeated = lastFailure === message && !dependsOnTheMoment(error);
          lastFailure = message;
          const granted = kind === "boost" || (!repeated && (kind === "transient" ? transientRetries < MAX_TRANSIENT_RETRIES : otherRetries < 1));
          if (granted) {
            const base = this.config.retryDelayMs ?? BASE_RETRY_DELAY_MS;
            const scale = base / BASE_RETRY_DELAY_MS;
            let attempt = 1;
            let retries = 1;
            let waitMs = Math.round(base);
            let title = "The step failed: retrying once.";
            if (kind === "boost") {
              waitMs = 0;
              title = `The model used all its output tokens while reasoning: retrying once with a ${OUTPUT_BOOST}× larger limit.`;
            } else if (kind === "transient") {
              transientRetries += 1;
              attempt = transientRetries;
              retries = MAX_TRANSIENT_RETRIES;
              const jitter = 0.75 + (this.config.random ?? Math.random)() * 0.5;
              const retryAfter = error instanceof AiProviderError && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
              waitMs = Math.round(Math.max(BASE_RETRY_DELAY_MS * 3 ** (attempt - 1) * jitter * scale, retryAfter * scale));
              title = `The step failed: retry ${attempt} of ${MAX_TRANSIENT_RETRIES} in ${formatWait(waitMs)}.`;
            } else {
              otherRetries += 1;
            }
            const note = retryNoteFor(error);
            if (task && note && lastLabel) retry = { key: taskKey(task), label: lastLabel, note };
            this.emit({ type: "insight", tone: "warning", code: "failureRetry", title, detail: message, attempt, retries, waitMs });
            if (!(await this.waitBeforeRetry(waitMs))) {
              state = await this.finish(state, "paused", null);
              break;
            }
            continue;
          }
        }
        state = await this.finish({
          ...state,
          stats: { ...state.stats, failures: state.stats.failures + 1 },
          lastError: { message: describeError(error), at: this.now().toISOString(), task: task?.kind },
        }, "error", describeError(error));
        break;
      } finally {
        this.controller.signal.removeEventListener("abort", onRunAbort);
        this.stepController = null;
        // An interrupt that came when the step was already over must not make a later abort look like one.
        this.interrupted = false;
      }
    }
    if (this.leaseLost) state = { ...state, status: "paused", message: TAKEN_OVER, runner: null };
    this.emit({ type: "run-ended", runId: this.runId, status: state.status, message: state.message, ...(this.leaseLost ? { code: "takenOver" as const } : {}) });
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
        const changes = [activityChange([...stored.activities, activity], stored.activityHash)];
        const next = spend && stored.state ? stampState({ ...stored.state, stats: withSpend(stored.state.stats, spend) }, this.now()) : null;
        if (next) changes.push(stateChange(next, stored.stateHash));
        try {
          await this.store.commit(changes, `Autopilot: ${activity.title} (${activity.status})`);
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

  /** Close the run with a final status, persisted together with any queued intervention and with what the author saved since the run last read the state. */
  private async finish(state: AutopilotState, status: AutopilotState["status"], message: string | null): Promise<AutopilotState> {
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
        this.emit({ type: "state", state: summarizeAutopilotState(final) });
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
