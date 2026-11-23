import type { AutopilotSnapshot } from "narrarium-engine";
import { cleanText } from "./admin-log.js";
import type { BookRuntime } from "./books.js";
import type { SpendLedger } from "./spend.js";

/**
 * The books in progress, for the admin panel: for each book the state of its autopilot in a few words (running, waiting for a new attempt, waiting for an answer, looks stalled,
 * stopped by an error…), which chapter of how many, the step, since when, what the run spent, who runs it. It is read from the engine's summary and its live session
 * (`AutopilotSession.snapshot()`: the two small files of the autopilot, never the chapters), so that a server with many books is not slowed by the panel. Nothing the engine
 * says in words is passed on (the run's message, a question, the title of a step, the text of an error): only closed lists, numbers and times.
 */

/** From what needs the owner's eye first to what does not. */
export const RUN_STATES = ["stalled", "retrying", "running", "waiting", "error", "unreadable", "paused", "idle", "completed", "none"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** A run that says nothing for this long looks stalled: the engine saves a heartbeat every five minutes at least, and treats one that is twenty minutes old as a run that died. */
export const DEFAULT_STALLED_AFTER_MS = 10 * 60_000;
export const MAX_RUNS_PER_PAGE = 200;

export interface RunSpend {
  tokens: number;
  calls: number;
  cost?: number;
  currency?: string;
  costUnknownCalls?: number;
  /** When the run that spent it began. */
  startedAt: string;
  /** The run is going on now (otherwise this is the last run the server counted for the book). */
  active: boolean;
}

export interface RunView {
  bookId: string;
  title: string;
  storage: "local" | "github";
  state: RunState;
  /** The engine's own status and phase, as they are. */
  status: string | null;
  phase: string | null;
  /** This server's session is running the book now. */
  live: boolean;
  /** Who runs it: this server, another server, or a browser (its label as it called itself). */
  runner: { host: "server" | "browser"; label?: string; thisServer: boolean } | null;
  /** The chapter the run is at (or the next one to do) of how many, and how many are done. */
  chapter: { current: number; total: number; done: number } | null;
  /** The step of a run that is going on, by the engine's own name for it (`write`, `director-review`…). */
  step: string | null;
  stepChapter?: number;
  stepScene?: number;
  stepSinceMs?: number;
  /** Since when the run is going (not since when the book exists). */
  sinceMs: number | null;
  heartbeatAgeMs: number | null;
  updatedAt: string | null;
  /** While the run waits to try a failed step again: which retry, of how many, and in how long. */
  retry: { at: string; attempt: number; retries: number; inMs: number } | null;
  /** A question waits for the author's answer. */
  question: boolean;
  pausePending: "after-step" | "after-chapter" | null;
  spend: RunSpend | null;
  lastError: { kind?: string; at?: string; task?: string; status?: number } | null;
  /** What is wrong with the book itself (its repository, or its state file that cannot be read), as the panel has always shown it. */
  error: string | null;
  /** What the records of the book's AI calls keep on this server, in bytes of text; left out when they keep none. */
  aiCallBytes?: number;
}

export interface RunInput {
  bookId: string;
  title: string;
  storage: "local" | "github";
  /** `undefined` when the session could not be read at all. */
  snapshot: Pick<AutopilotSnapshot, "summary" | "live" | "running" | "stateError"> | undefined;
  /** What is wrong with the book, when something is: the repository, or a session that could not be read. */
  problem?: string;
  spend?: RunSpend;
  /** What the records of the book's AI calls keep (see `RunView.aiCallBytes`). */
  aiCallBytes?: number;
  nowMs: number;
  stalledAfterMs: number;
  /** This server's id: a runner that says it is this server's is this server's. */
  serverId?: string;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const whole = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const time = (value: unknown): number | null => {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
/** A name from one of the engine's closed lists (a task, a kind of error): lower case words, never a sentence. */
const word = (value: unknown): string | undefined => (typeof value === "string" && /^[a-z][a-z_-]{0,29}$/.test(value) ? value : undefined);

/** What one book's autopilot is, from what the engine says of it. Pure: nothing is read, and nothing the engine says in words comes out. */
export function describeRun(input: RunInput): RunView {
  const { snapshot, nowMs } = input;
  const summary = snapshot?.summary ? record(snapshot.summary) : null;
  const live = snapshot?.running === true;
  const problem = cleanText(input.problem ?? snapshot?.stateError?.message, 500) ?? null;

  const runner = record(summary?.runner);
  const host = runner.host === "browser" || runner.host === "server" ? runner.host : undefined;
  const heartbeat = time(runner.heartbeatAt);
  const started = time(runner.startedAt);
  const heartbeatAgeMs = heartbeat === null ? null : Math.max(0, nowMs - heartbeat);
  const sinceMs = started === null ? null : Math.max(0, nowMs - started);
  const label = cleanText(runner.label, 80);
  const thisServer = live || (host === "server" && typeof runner.hostId === "string" && runner.hostId === input.serverId);

  const retrySource = record(summary?.retry);
  const retryAt = time(retrySource.at);
  const attempt = whole(retrySource.attempt);
  const retries = whole(retrySource.retries);
  const retry = retryAt !== null && attempt !== undefined && retries !== undefined ? { at: retrySource.at as string, attempt, retries, inMs: Math.max(0, retryAt - nowMs) } : null;

  const status = typeof summary?.status === "string" ? summary.status.slice(0, 30) : null;
  const stalled = heartbeatAgeMs !== null && heartbeatAgeMs > input.stalledAfterMs;
  let state: RunState;
  if (problem) state = "unreadable";
  else if (!summary) state = "none";
  else if (retry) state = "retrying";
  else if (status === "running") state = stalled ? "stalled" : "running";
  else if (status === "waiting-author") state = "waiting";
  else if (status === "error") state = "error";
  else if (status === "paused") state = "paused";
  else if (status === "completed") state = "completed";
  else state = live ? "running" : "idle";

  const activity = live ? record(snapshot?.live?.activity) : {};
  const task = word(activity.task);
  const stepChapter = whole(activity.chapterNumber);
  const stepScene = whole(activity.sceneNumber);
  const stepStarted = time(activity.startedAt);

  const progress = record(summary?.progress);
  const total = whole(progress.chapters);
  const done = whole(progress.chaptersDone);
  const chapter = total && done !== undefined
    ? { current: status === "completed" ? total : Math.min(total, Math.max(1, stepChapter ?? done + 1)), total, done: Math.min(done, total) }
    : null;

  const failure = record(summary?.lastError);
  const failureKind = word(failure.kind ?? failure.errorKind);
  const failureTask = word(failure.task);
  const failureStatus = whole(record(failure.detail ?? failure.errorDetail).status);
  const failureAt = time(failure.at) === null ? undefined : (failure.at as string);
  const lastError = failureKind || failureAt || failureTask ? {
    ...(failureKind ? { kind: failureKind } : {}),
    ...(failureAt ? { at: failureAt } : {}),
    ...(failureTask ? { task: failureTask } : {}),
    ...(failureStatus !== undefined && failureStatus >= 100 && failureStatus <= 599 ? { status: failureStatus } : {}),
  } : null;

  return {
    bookId: input.bookId,
    title: input.title,
    storage: input.storage,
    state,
    status,
    phase: typeof summary?.phase === "string" ? summary.phase.slice(0, 30) : null,
    live,
    runner: host ? { host, ...(label ? { label } : {}), thisServer } : live ? { host: "server", thisServer: true } : null,
    chapter,
    step: task ?? null,
    ...(task && stepChapter !== undefined ? { stepChapter } : {}),
    ...(task && stepScene !== undefined ? { stepScene } : {}),
    ...(task && stepStarted !== null ? { stepSinceMs: Math.max(0, nowMs - stepStarted) } : {}),
    sinceMs,
    heartbeatAgeMs,
    updatedAt: time(summary?.updatedAt) === null ? null : (summary?.updatedAt as string),
    retry,
    question: Boolean(summary?.question),
    pausePending: summary?.pausePending === "after-step" || summary?.pausePending === "after-chapter" ? summary.pausePending : null,
    spend: input.spend ?? null,
    lastError,
    error: problem,
    ...(whole(input.aiCallBytes) ? { aiCallBytes: input.aiCallBytes as number } : {}),
  };
}

const RANK = new Map<RunState, number>(RUN_STATES.map((state, index) => [state, index]));

/** What needs the eye first, then the newest. */
function order(left: RunView, right: RunView): number {
  const byState = (RANK.get(left.state) ?? 99) - (RANK.get(right.state) ?? 99);
  if (byState) return byState;
  const byTime = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  return byTime || left.title.localeCompare(right.title) || left.bookId.localeCompare(right.bookId);
}

/** One page of the books, and the totals of all of them (the states that have a book, each counted). */
export function runsPage(views: readonly RunView[], page: { limit: number; offset: number }): { books: RunView[]; total: number; counts: Partial<Record<RunState, number>>; nextOffset: number | null } {
  const counts: Partial<Record<RunState, number>> = {};
  for (const view of views) counts[view.state] = (counts[view.state] ?? 0) + 1;
  const books = views.slice(page.offset, page.offset + page.limit);
  return { books, total: views.length, counts, nextOffset: page.offset + books.length < views.length ? page.offset + books.length : null };
}

export interface RunBoardOptions {
  books: { all(): BookRuntime[] };
  spend: Pick<SpendLedger, "run" | "activeRun">;
  now: () => Date;
  stalledAfterMs: number;
  serverId: () => string;
  /** The records of the AI calls: what each book keeps is told with its row (a book whose totals cannot be read is told without). */
  calls?: { totals(bookId: string): Promise<{ bytes: number }> };
}

/** Every hosted book as `describeRun` sees it, read from its live session. Readers that come together share one read. */
export class RunBoard {
  private inflight: Promise<RunView[]> | undefined;

  constructor(private readonly options: RunBoardOptions) {}

  collect(): Promise<RunView[]> {
    if (!this.inflight) {
      const reading: Promise<RunView[]> = this.read().finally(() => {
        if (this.inflight === reading) this.inflight = undefined;
      });
      this.inflight = reading;
    }
    return this.inflight;
  }

  private async read(): Promise<RunView[]> {
    const nowMs = this.options.now().getTime();
    const views = await Promise.all(this.options.books.all().map((runtime) => this.describe(runtime, nowMs)));
    return views.sort(order);
  }

  private async describe(runtime: BookRuntime, nowMs: number): Promise<RunView> {
    const { bookId, title, storage } = runtime.book;
    let snapshot: AutopilotSnapshot | undefined;
    let problem = runtime.error;
    try {
      snapshot = await runtime.session.snapshot();
    } catch {
      problem ??= "The autopilot's state of this book could not be read.";
    }
    const last = this.options.spend.run(bookId);
    const spend: RunSpend | undefined = last
      ? {
        tokens: last.tokens,
        calls: last.calls,
        ...(last.cost !== undefined ? { cost: last.cost, ...(last.currency ? { currency: last.currency } : {}) } : {}),
        ...(last.costUnknownCalls ? { costUnknownCalls: last.costUnknownCalls } : {}),
        startedAt: last.startedAt,
        active: this.options.spend.activeRun(bookId) === last.runId,
      }
      : undefined;
    const kept = await this.options.calls?.totals(bookId).catch(() => undefined);
    return describeRun({ bookId, title, storage: storage.kind, snapshot, ...(problem ? { problem } : {}), ...(spend ? { spend } : {}), ...(kept ? { aiCallBytes: kept.bytes } : {}), nowMs, stalledAfterMs: this.options.stalledAfterMs, serverId: this.options.serverId() });
  }
}
