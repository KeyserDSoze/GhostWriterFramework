import type { AiCallStore } from "./calls/port.js";
import { redactSecrets } from "../ai/redact.js";
import type { AiPort } from "../ai/types.js";
import { FrozenChapterError, freezeChapterChanges, markReviewedChanges, parseChapterFreeze, unfreezeChapterChanges } from "../book/freeze.js";
import { writeOutlineBrief } from "../book/outline-brief.js";
import { OutlineCache, OutlineReader } from "../book/outline.js";
import { AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_PLAN_FILE, AUTOPILOT_STATE_FILE, type EvaluationTarget } from "../book/paths.js";
import { SnapshotCache, loadBookSnapshot, type BookSnapshot } from "../book/snapshot.js";
import { isBookConflictError, type BookFileChange, type BookStore } from "../book/store.js";
import { askDirector, type AskDirectorResult } from "../director/opinion.js";
import { parseMarkdown } from "../markdown/frontmatter.js";
import { defaultDirector } from "../profiles/director.js";
import { randomId } from "../util/hash.js";
import { isItalian, languageCode } from "../util/text.js";
import {
  applyFrozenDecision,
  forgetFrozenChapter,
  frozenActions,
  frozenAnswerAction,
  frozenWaitingCount,
  frozenWork,
  isFrozenQuestion,
  withoutPendingReview,
  type FrozenChapterResult,
  type FrozenDecision,
  type FrozenStatus,
  type FrozenStatusEntry,
  type FrozenWorkItem,
} from "./frozen.js";
import { readBrief } from "./brief.js";
import { applyLiveAttempt, applyLiveProgress, startLive } from "./live.js";
import { outlinePlanStatus, type OutlineWrittenChange } from "./outline-check.js";
import { advanceState } from "./planner.js";
import {
  AutopilotRun,
  AutopilotStateCorruptError,
  applyAnswer,
  applyIntervention,
  assertStoredStateReadable,
  readStoredAutopilot,
  stampState,
  stateChange,
  type AutopilotHooks,
  type StoredAutopilot,
} from "./runner.js";
import { AutopilotRuleError, DEFAULT_OPTIONS, createAutopilotState, hostDefaultPublish, normalizeOptions, normalizeRuleText, summarizeAutopilotState, withoutStopCause } from "./state.js";
import {
  FROZEN_ACTIONS,
  FROZEN_CHANGE_ACTIONS,
  LIVE_AUTOPILOT_OPTIONS,
  type AutopilotActivity,
  type AutopilotEvent,
  type AutopilotEventBody,
  type AutopilotOptions,
  type AutopilotOptionsUpdate,
  type AutopilotPauseMode,
  type AutopilotPausePending,
  type AutopilotPublishMode,
  type AutopilotRestartCause,
  type AutopilotRunnerInfo,
  type AutopilotSnapshot,
  type AutopilotBrief,
  type AutopilotState,
  type AutopilotStateSummary,
  type FrozenAction,
  type FrozenChangeKind,
  type InterventionInput,
  type QuestionAnswer,
  type StartOptions,
} from "./types.js";

/** Minutes after which a `running` state without heartbeat is treated as interrupted. */
export const RUNNER_STALE_MINUTES = 20;

export class AutopilotBusyError extends Error {
  constructor(readonly runnerLabel: string) {
    super(`The autopilot of this book is already running on ${runnerLabel}.`);
    this.name = "AutopilotBusyError";
  }
}

/** Whether a stored runner is still alive according to its heartbeat. */
export function runnerActivity(state: AutopilotState | null, now = new Date()): "none" | "active" | "stale" {
  if (!state || state.status !== "running" || !state.runner) return "none";
  const heartbeat = Date.parse(state.runner.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return "stale";
  return now.getTime() - heartbeat > RUNNER_STALE_MINUTES * 60_000 ? "stale" : "active";
}

/** How old the heartbeat of the recorded runner is, in milliseconds; `null` when nobody runs or the heartbeat cannot be read. Works on a state and on the summary of a live event. */
export function runnerHeartbeatAgeMs(state: { runner: AutopilotRunnerInfo | null } | null | undefined, now = new Date()): number | null {
  if (!state?.runner) return null;
  const heartbeat = Date.parse(state.runner.heartbeatAt);
  return Number.isFinite(heartbeat) ? Math.max(0, now.getTime() - heartbeat) : null;
}

/** How often a live run says it is alive (ms). */
export const DEFAULT_HEARTBEAT_MS = 30_000;

export interface AutopilotSessionConfig {
  bookId: string;
  store: BookStore;
  ai: AiPort;
  host: "browser" | "server";
  hostLabel: string;
  /** Stable identity of this host (device or server id). Without it the label identifies the host. */
  hostId?: string;
  /**
   * Whether a run recorded by this same host is alive outside this session (for example in
   * another tab of the same browser). Without it, such a run is treated as interrupted.
   */
  ownRunnerAlive?: () => boolean | Promise<boolean>;
  now?: () => Date;
  hooks?: AutopilotHooks;
  /**
   * Where the host publishes the book when the author has not chosen (`options.publishEvery`): after every step, after every
   * chapter, or never. The engine calls `hooks.afterCommit` (every step) and `hooks.afterChapter` (every chapter) accordingly. Without
   * it a server host publishes after every step, as it always did, and a browser host as `options.syncAfterChapter` says.
   */
  defaultPublish?: AutopilotPublishMode;
  /** Live events kept in memory for late subscribers (default 400). */
  maxEvents?: number;
  /** Base delay before a retry of a failed step (ms, default 4000): see `AutopilotRunConfig`. */
  retryDelayMs?: number;
  /** Source of the retry jitter, in [0, 1) (default `Math.random`). */
  random?: () => number;
  /**
   * While a run is active the session emits a `state` event this often (ms), with the run's current heartbeat in memory; nothing
   * is saved for it. 0 switches it off. Default 30 000.
   */
  heartbeatMs?: number;
  /**
   * Longest silence (ms) of `autopilot/state.json` during a run: after it the run saves a fresh `runner.heartbeatAt`, so that a
   * long step is not taken for a dead run by another host. 0 switches it off. Default 300 000 (5 minutes).
   */
  persistHeartbeatMs?: number;
  /**
   * Where the records of the AI calls of the autopilot are kept (see `calls/`): each call of a task with what was sent and what came back as it
   * streamed, its provider attempts, and the task headers. Without it nothing is recorded: no cost, and no `call-started` or `call-ended` events.
   */
  calls?: AiCallStore;
  /** The known secret values of the host (its keys, its tokens): redacted from every record. Read when each call starts. */
  callsSecrets?: () => string[];
  /** The budget of the book's records in bytes: after each task the oldest finished unpinned tasks are dropped to keep it (default 256 MiB). */
  callsBudgetBytes?: number;
  /** The account the book belongs to, when the store is fenced by it (a browser); null otherwise. */
  callsAccountScope?: string | null;
}

export type AutopilotListener = (event: AutopilotEvent) => void;

/**
 * The changes of a book and what can be done with them, for a host outside a run (and during one): the plan as the next step would see it
 * (folders followed, scenes reconciled), and the outline entries of the chapters already closed, read through `outlineCache`.
 */
async function bookFrozenStatus(store: BookStore, snapshot: BookSnapshot, state: AutopilotState | null, outlineCache: OutlineCache): Promise<{ status: FrozenStatus; items: FrozenWorkItem[] }> {
  const language = languageCode(snapshot.book.language);
  const advanced = state ? advanceState(state, { snapshot, director: defaultDirector(language), readers: [], language, storyDesignThin: false }) : null;
  const written = advanced ? (await outlinePlanStatus(OutlineReader.of(store, snapshot, outlineCache), advanced, language)).written : new Map<number, OutlineWrittenChange>();
  const items = frozenWork(advanced, snapshot, written);
  const changes: FrozenStatusEntry[] = items.map((item) => ({
    kind: item.kind,
    number: item.number,
    slug: item.slug,
    title: item.title,
    fingerprint: item.fingerprint,
    actions: frozenActions(item),
    ...(item.change ? { by: item.change.by, frozenAt: item.change.frozenAt, changed: item.change.changed } : {}),
    ...(item.outline ? { outline: { title: item.outline.title, digest: item.outline.digest } } : {}),
    ...(item.pending ? { pending: { action: item.pending.action, at: item.pending.at } } : {}),
  }));
  return {
    status: {
      mode: state?.options.frozenEdits ?? "ask",
      changes,
      pending: [...(state?.pendingReviews ?? [])],
      warnings: snapshot.chapters.filter((chapter) => chapter.frozenProblem).map((chapter) => ({ slug: chapter.slug, path: chapter.path, problem: chapter.frozenProblem! })),
    },
    items,
  };
}

/** Whether two states say the same (what every write changes aside). */
function sameState(left: AutopilotState, right: AutopilotState): boolean {
  const plain = ({ version: _version, updatedAt: _updatedAt, ...rest }: AutopilotState) => JSON.stringify(rest);
  return plain(left) === plain(right);
}

/** Why a server that started again did not resume the run by itself (`holdAfterRestart`): it already did so `times` times in the last `hours` hours. */
function restartLimitMessage(italian: boolean, times: number, hours: number): string {
  return italian
    ? `Non ripreso dopo il riavvio del server: l'autopilot si è già ripreso da solo ${times} ${times === 1 ? "volta" : "volte"} nelle ultime ${hours} ore. Riprendilo quando vuoi.`
    : `Not resumed after the server restart: the autopilot already resumed by itself ${times} ${times === 1 ? "time" : "times"} in the last ${hours} hours. Resume it when you are ready.`;
}

/**
 * Control surface of one book's autopilot. The browser and the personal server both use
 * this class, so start, pause, interventions, questions and live events behave identically.
 */
export class AutopilotSession {
  private run: AutopilotRun | null = null;
  private runPromise: Promise<AutopilotState> | null = null;
  /** A `start()` in flight: from its first line until the run has saved its start, or the start has failed. */
  private starting: Promise<void> | null = null;
  /** A pause asked for while a start was in flight: it is applied as soon as the run exists. The stricter request is the one kept: `now`, then `after-step`, then `after-chapter`. */
  private pendingPause: AutopilotPauseMode | null = null;
  /** The pause that waits for the run to exist is the server's stop (`stopForShutdown`), not the author's. */
  private pendingShutdown = false;
  private seq = 0;
  private events: AutopilotEvent[] = [];
  private readonly listeners = new Set<AutopilotListener>();
  private live: AutopilotSnapshot["live"] = null;
  private readonly now: () => Date;
  /** The latest `state` event, whoever emitted it: what a heartbeat event repeats with a fresh heartbeat. */
  private summary: AutopilotStateSummary | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  /** The heartbeat of the active run in memory: newer than the one in the file between two saves. */
  private liveHeartbeatAt: string | null = null;
  /** How many chapters have a change waiting for the author, as the last run or the last `frozenStatus()` found; `null` until one looked. */
  private frozenCount: number | null = null;
  /** The book as `frozenStatus()` and the decisions about changes read it: a file is read again only when it changed. */
  private readonly bookCache = new SnapshotCache();
  private readonly outlineCache = new OutlineCache();

  constructor(private readonly config: AutopilotSessionConfig) {
    this.now = config.now ?? (() => new Date());
  }

  get bookId(): string {
    return this.config.bookId;
  }

  /** A run is active, or a start is about to create one. */
  get running(): boolean {
    return this.run !== null || this.starting !== null;
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(listener: AutopilotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Live events after `since` (exclusive), oldest first. */
  recentEvents(since = 0): AutopilotEvent[] {
    return this.events.filter((event) => event.seq > since);
  }

  private emit(body: AutopilotEventBody, options: { replay?: boolean } = {}): void {
    const event = { ...body, bookId: this.config.bookId, at: this.now().toISOString(), seq: ++this.seq } as AutopilotEvent;
    if (body.type === "state") this.summary = body.state;
    // What `snapshot().live` says follows the events by the one rule every client follows (`applyLiveProgress`, `applyLiveAttempt`).
    if (body.type === "task-started") this.live = startLive(body.activity);
    else if (body.type === "task-progress" && this.live?.activity.id === body.activityId) this.live = applyLiveProgress(this.live, body);
    else if (body.type === "call-attempt" && this.live?.activity.id === body.activityId) this.live = applyLiveAttempt(this.live, body);
    else if (body.type === "task-finished" && this.live?.activity.id === body.activity.id) this.live = null;
    else if (body.type === "run-ended") this.live = null;
    // Streaming previews and heartbeats are only useful live; keep the replay buffer for meaningful events.
    if (body.type !== "task-progress" && options.replay !== false) {
      this.events.push(event);
      const max = this.config.maxEvents ?? 400;
      if (this.events.length > max) this.events = this.events.slice(-max);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }

  /** A runner recorded by this host (this session, another tab, or a previous process). */
  isOwnRunner(runner: AutopilotState["runner"]): boolean {
    if (!runner || runner.host !== this.config.host) return false;
    return runner.hostId && this.config.hostId ? runner.hostId === this.config.hostId : runner.label === this.config.hostLabel;
  }

  private async ownRunnerAliveElsewhere(): Promise<boolean> {
    if (this.run || !this.config.ownRunnerAlive) return false;
    try {
      return Boolean(await this.config.ownRunnerAlive());
    } catch {
      return false;
    }
  }

  private startBeat(run: AutopilotRun): void {
    const { heartbeatMs } = this.config;
    const every = typeof heartbeatMs === "number" && Number.isFinite(heartbeatMs) ? heartbeatMs : DEFAULT_HEARTBEAT_MS;
    if (!(every > 0)) return;
    const timer = setInterval(() => this.beat(run), every);
    (timer as { unref?: () => void }).unref?.();
    this.beatTimer = timer;
  }

  private stopBeat(): void {
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
    this.liveHeartbeatAt = null;
  }

  /** The run is alive: say so with the latest state and the heartbeat of now. Nothing is saved, and nothing is said once the run is over. */
  private beat(run: AutopilotRun): void {
    const summary = this.summary;
    if (this.run !== run || !summary?.runner || summary.runner.runId !== run.runId) return;
    this.liveHeartbeatAt = this.now().toISOString();
    this.emit({ type: "state", state: { ...summary, runner: { ...summary.runner, heartbeatAt: this.liveHeartbeatAt } } }, { replay: false });
  }

  /**
   * A pause asked for or taken back changes what a client shows, and nothing is written for it: the summary of the active run is
   * said again with the pause as it is now. Nothing is said before the run has told its first summary (its first one carries it).
   */
  private announcePause(run: AutopilotRun): void {
    const summary = this.summary;
    if (this.run !== run || !summary?.runner || summary.runner.runId !== run.runId) return;
    // The retry is the run's own word, said as it is now: one the run no longer waits for must not be carried over from the last summary.
    const { retry: _earlier, ...rest } = summary;
    this.emit({ type: "state", state: { ...rest, ...run.runtime(), runner: this.liveRunner(summary.runner) ?? summary.runner } });
  }

  /** The summary of a state as a client of this session sees it: with the pause that waits, the limits of the run, the retry it waits for, and where the book is published. */
  private summarize(state: AutopilotState): AutopilotStateSummary {
    const runtime = this.run?.runtime();
    const waiting: AutopilotPausePending | null = this.pendingPause === "after-step" || this.pendingPause === "after-chapter" ? this.pendingPause : null;
    const summary = summarizeAutopilotState(state, {
      pausePending: runtime ? runtime.pausePending : this.starting ? waiting : null,
      limits: runtime?.limits ?? null,
      retry: runtime?.retry ?? null,
      defaultPublish: hostDefaultPublish(this.config.host, this.config.defaultPublish),
      frozenChanges: runtime?.frozenChanges ?? this.frozenCount,
    });
    return summary.runner ? { ...summary, runner: this.liveRunner(summary.runner) } : summary;
  }

  /** The runner as the active run's own session knows it: its heartbeat is the one in memory when that is newer than the saved one. */
  private liveRunner(runner: AutopilotRunnerInfo | null): AutopilotRunnerInfo | null {
    if (!runner || !this.run || !this.liveHeartbeatAt || runner.runId !== this.run.runId) return runner;
    return Date.parse(this.liveHeartbeatAt) > Date.parse(runner.heartbeatAt) ? { ...runner, heartbeatAt: this.liveHeartbeatAt } : runner;
  }

  async snapshot(): Promise<AutopilotSnapshot> {
    const wasRunning = this.running;
    let stored = await readStoredAutopilot(this.config.store);
    // A run that began or ended while the files were being read leaves what was read older than what `running` says now: a stopped run
    // would read as "interrupted" (its state still says it runs) and a run that began would show the state of the one before it. Read again.
    if (this.running !== wasRunning) stored = await readStoredAutopilot(this.config.store);
    const running = this.running;
    let state = stored.state;
    if (state?.runner && this.liveRunner(state.runner) !== state.runner) state = { ...state, runner: this.liveRunner(state.runner) };
    const interrupted = "Interrupted: resume to continue from the last saved step.";
    if (state && !running && state.status === "running" && this.isOwnRunner(state.runner) && !(await this.ownRunnerAliveElsewhere())) {
      state = { ...state, status: "paused", runner: null, message: state.message ?? interrupted };
    }
    if (state && !running && runnerActivity(state, this.now()) === "stale") {
      state = { ...state, status: "paused", runner: null, message: interrupted };
    }
    const activities: AutopilotActivity[] = [...stored.activities];
    const current = this.run?.activity;
    if (current && !activities.some((activity) => activity.id === current.id)) activities.push(current);
    return {
      bookId: this.config.bookId,
      state,
      summary: state ? this.summarize(state) : null,
      activities,
      live: this.live,
      running,
      host: running ? this.config.host : state?.status === "running" ? state.runner?.host ?? null : null,
      ...(stored.corrupt ? { stateError: { code: "state_corrupt" as const, message: new AutopilotStateCorruptError(stored.corrupt).message } } : {}),
    };
  }

  /**
   * Start or resume. Resolves once the run has saved its start, rejects if it could not start. `options.limits` bound this run only
   * (pause after that many steps or chapters; see `AutopilotRunLimits`): they are not saved, and the next run starts without them.
   * `afterRestart` is the host's own, never a request's: the server resumes the run by itself after it started again
   * (`options.resumeAfterRestart`), and the run says so first (a `resumedAfterRestart` insight). Any start takes away what the server
   * said of its stop (`stoppedBy`).
   */
  async start(options: StartOptions & { force?: boolean; afterRestart?: boolean } = {}): Promise<void> {
    // The claim is taken before anything is awaited: two concurrent calls can never both create a run.
    if (this.running) throw new AutopilotBusyError(this.config.hostLabel);
    const starting = this.launch(options);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
      this.pendingPause = null;
      this.pendingShutdown = false;
    }
  }

  private async launch(options: StartOptions & { force?: boolean; afterRestart?: boolean }): Promise<void> {
    const stored = await readStoredAutopilot(this.config.store);
    assertStoredStateReadable(stored);
    const runner = stored.state?.runner;
    if (!options.force && runner && runnerActivity(stored.state, this.now()) === "active" && (!this.isOwnRunner(runner) || await this.ownRunnerAliveElsewhere())) {
      throw new AutopilotBusyError(runner.label || runner.host);
    }
    // A brief sent with the start is the book's brief from now on (the run reads the file, see `readBrief`).
    if (options.brief) await writeOutlineBrief(this.config.store, options.brief);
    let resolveStarted: () => void = () => undefined;
    let rejectStarted: (error: unknown) => void = () => undefined;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    let didStart = false;
    const run = new AutopilotRun({
      bookId: this.config.bookId,
      store: this.config.store,
      ai: this.config.ai,
      host: this.config.host,
      hostLabel: this.config.hostLabel,
      hostId: this.config.hostId,
      now: this.config.now,
      hooks: this.config.hooks,
      defaultPublish: this.config.defaultPublish,
      retryDelayMs: this.config.retryDelayMs,
      random: this.config.random,
      persistHeartbeatMs: this.config.persistHeartbeatMs,
      calls: this.config.calls,
      callsSecrets: this.config.callsSecrets,
      callsBudgetBytes: this.config.callsBudgetBytes,
      callsAccountScope: this.config.callsAccountScope,
      emit: (event) => {
        if (event.type === "run-started" && !didStart) {
          didStart = true;
          resolveStarted();
        }
        this.emit(event);
      },
    });
    this.run = run;
    this.runPromise = run.execute(options).catch((error) => {
      if (!didStart) rejectStarted(error);
      else this.emit({ type: "insight", tone: "critical", code: "unexpectedStop", title: "The autopilot stopped unexpectedly.", detail: redactSecrets(error instanceof Error ? error.message : String(error)) });
      throw error;
    }).finally(() => {
      // What the run found of the changes stays known after it.
      if (run.frozenWaiting !== null) this.frozenCount = run.frozenWaiting;
      if (this.run === run) {
        this.run = null;
        this.runPromise = null;
        this.stopBeat();
      }
    });
    this.runPromise.catch(() => undefined);
    this.startBeat(run);
    const pause = this.pendingPause;
    const shutdown = this.pendingShutdown;
    this.pendingPause = null;
    this.pendingShutdown = false;
    if (pause === "now") {
      if (shutdown) run.stopForShutdown();
      else run.stop();
    } else if (pause === "after-step") run.stopAfterStep();
    else if (pause === "after-chapter") run.stopAfterChapter();
    await started;
  }

  /**
   * `now` abandons the request in flight; `after-step` lets the current step finish and save, then pauses; `after-chapter` goes on to
   * the end of the chapter in progress (its closing and its publishing included), then pauses (with no chapter in progress it is
   * `after-step`). The stricter request is the one that counts: `after-step` is not undone by a later `after-chapter`, and `now`
   * by neither. Every change of the pause that waits is a `state` event (`pausePending` of the summary). With no run active, nor starting, it
   * pauses nothing and answers `false` (a host whose author paused then calls `forgetStopCause`).
   */
  pause(mode: AutopilotPauseMode = "after-step"): boolean {
    const asked: AutopilotPauseMode = mode === "now" || mode === "after-chapter" ? mode : "after-step";
    const run = this.run;
    if (run) {
      const before = run.pausePending;
      if (asked === "now") run.stop();
      else if (asked === "after-chapter") run.stopAfterChapter();
      else run.stopAfterStep();
      if (run.pausePending !== before) this.announcePause(run);
      return true;
    }
    if (!this.starting) return false;
    const strictest = (left: AutopilotPauseMode | null, right: AutopilotPauseMode): AutopilotPauseMode => {
      const rank = { "after-chapter": 1, "after-step": 2, now: 3 };
      return left && rank[left] > rank[right] ? left : right;
    };
    this.pendingPause = strictest(this.pendingPause, asked);
    this.pendingShutdown = false;
    return true;
  }

  /**
   * Pause now because the host is stopping (the personal server's Ctrl+C, a service stop): as `pause("now")`, and the paused state says so
   * (`stoppedBy: "server-shutdown"`), so that the server, when it starts again, resumes the run if the author asked for it
   * (`options.resumeAfterRestart`). A pause the author asked for before stays the author's. `false` when no run is active nor starting.
   */
  stopForShutdown(): boolean {
    const run = this.run;
    if (run) {
      run.stopForShutdown();
      return true;
    }
    if (!this.starting) return false;
    // A start in flight stops as soon as its run exists: the server's stop, unless the author asked for a pause first.
    if (this.pendingPause === null) this.pendingShutdown = true;
    this.pendingPause = "now";
    return true;
  }

  /**
   * What a host that has just started finds of the run of this book, when the author asked that the run be resumed by itself after a restart
   * (`options.resumeAfterRestart`): `interrupted` when the state still says that the run goes on, with this host's runner (the process ended
   * without pausing it) or with a runner silent for longer than `RUNNER_STALE_MINUTES`; `server-shutdown` when the run was paused because the
   * server stopped (`stoppedBy`). `null` for anything else: the option off, a run the author paused (or that paused by itself), a run of another
   * host that is alive, a run active in this session, no state, a state that cannot be read. It reads, and changes nothing.
   */
  async restartResumeCause(): Promise<AutopilotRestartCause | null> {
    if (this.running) return null;
    const stored = await readStoredAutopilot(this.config.store);
    if (stored.corrupt) return null;
    return this.restartCauseOf(stored.state, await this.ownRunnerAliveElsewhere());
  }

  private restartCauseOf(state: AutopilotState | null, ownAliveElsewhere: boolean): AutopilotRestartCause | null {
    if (!state || state.options.resumeAfterRestart !== true) return null;
    if (state.status === "paused") return state.stoppedBy === "server-shutdown" ? "server-shutdown" : null;
    if (state.status !== "running" || !state.runner) return null;
    if (runnerActivity(state, this.now()) === "stale") return "interrupted";
    return this.isOwnRunner(state.runner) && !ownAliveElsewhere ? "interrupted" : null;
  }

  /**
   * Leave for the author the run that `restartResumeCause` found, when the host does not resume it by itself because it already did so
   * `limit.times` times in the last `limit.hours` hours: the state says why in its message (in the language of the book), a state that still
   * says `running` is paused, and what the server said of its stop (`stoppedBy`) goes, so that only the author resumes it now. Nothing is
   * written when the run is no longer such a run (the author resumed or paused it meanwhile), nor while a run is active here: `null` then.
   */
  async holdAfterRestart(limit: { times: number; hours: number }): Promise<AutopilotState | null> {
    if (this.running) return null;
    const language = await loadBookSnapshot(this.config.store, this.bookCache).then((snapshot) => languageCode(snapshot.book.language), () => "");
    const message = restartLimitMessage(isItalian(language), limit.times, limit.hours);
    const ownAliveElsewhere = await this.ownRunnerAliveElsewhere();
    let held = false;
    const saved = await this.mutate("Autopilot: not resumed after the restart", (state) => {
      held = this.restartCauseOf(state, ownAliveElsewhere) !== null;
      return held ? { ...withoutStopCause(state), status: "paused", runner: null, message } : state;
    }, { create: false });
    return held ? saved : null;
  }

  /**
   * The author paused the book when no run was active (`pause()` answered `false`): a run the server paused when it stopped (`stoppedBy`) is from now
   * on paused by the author, and a server that starts again does not resume it. Answers the state saved, or `null` when there was nothing to take
   * away (and nothing is written: also for a book without a state, and while a run is active, whose state has none).
   */
  async forgetStopCause(): Promise<AutopilotState | null> {
    if (this.running) return null;
    // A state that cannot be read has nothing to take away, and is never written over; nor has one without the server's word.
    const stored = await readStoredAutopilot(this.config.store);
    if (stored.corrupt || !stored.state?.stoppedBy) return null;
    let forgot = false;
    const saved = await this.mutate("Autopilot: paused by the author", (state) => {
      const plain = withoutStopCause(state);
      forgot = plain !== state;
      return plain;
    }, { create: false });
    return forgot ? saved : null;
  }

  /**
   * Take back a pause that is waiting (`after-step`, `after-chapter`) without stopping anything: `true` when there was one. A `now`
   * that already happened is not waiting, and cannot be taken back.
   */
  cancelPause(): boolean {
    const run = this.run;
    if (run) {
      const before = run.pausePending;
      const cancelled = run.cancelPause();
      if (run.pausePending !== before) this.announcePause(run);
      return cancelled;
    }
    if (this.starting && (this.pendingPause === "after-step" || this.pendingPause === "after-chapter")) {
      this.pendingPause = null;
      return true;
    }
    return false;
  }

  /**
   * «Retry now»: end the wait before the next attempt of a failed step (a quick retry, or a cycle of «Retry later», `options.longRetry`), so that
   * the attempt starts at once. `true` when the run was waiting; `false` when there is no run or it is not waiting (nothing happens, and it is no
   * error). It uses up nothing more: the retry, or the cycle, the wait belonged to stays counted. Told with a `retrySkipped` insight and, at once, a
   * `state` event without `retry`. It is not a pause: a pause asked before or after it works as always.
   */
  retryNow(): boolean {
    return this.run?.retryNow() ?? false;
  }

  /** Resolves when no run is active, and no start is about to create one. */
  async waitForIdle(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    await this.runPromise?.catch(() => undefined);
  }

  /**
   * Save a change of the state with a compare-and-swap commit, read again and tried again when the file changed in between (a run saves it too). A change that returns the state it was given writes nothing,
   * except for a book without a state, which gets one; with `create: false` it gets none either.
   */
  private async mutate(message: string, change: (state: AutopilotState) => AutopilotState, options: { create?: boolean } = {}): Promise<AutopilotState> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stored = await readStoredAutopilot(this.config.store);
      assertStoredStateReadable(stored);
      const base = stored.state ?? createAutopilotState(this.now());
      const changed = change(base);
      if (changed === base && (stored.state || options.create === false)) return base;
      const next = stampState(changed, this.now());
      try {
        await this.config.store.commit([stateChange(next, stored.stateHash)], message);
        this.emit({ type: "state", state: this.summarize(next) });
        return next;
      } catch (error) {
        if (!isBookConflictError(error) || attempt === 4) throw error;
      }
    }
    throw new Error("Could not save the autopilot state.");
  }

  /**
   * Record an author intervention. It is saved at once, even while a step runs: the run is not repeated for it (it merges what the
   * author saved when the step commits), and it is not lost if the process dies. A note reaches the next step that writes, a rule
   * every step from the next one; with `interrupt` the step in flight is abandoned and repeated with it. A rule over the limit of
   * characters is refused, never cut.
   */
  async intervene(input: InterventionInput): Promise<AutopilotState | null> {
    const text = input.text.trim();
    if (!text) throw new Error("The intervention is empty.");
    if (input.scope !== "next_step") normalizeRuleText(text);
    // A start in flight is about to own the book: let it settle first, so that the run it creates is the one that is told.
    if (this.starting) await this.starting.catch(() => undefined);
    const run = this.run;
    const during = run ? run.activity?.title ?? "running" : "paused";
    const saved = await this.mutate("Autopilot: author intervention", (state) => applyIntervention(state, input, this.now(), during));
    if (!run) return saved;
    if (input.interrupt) run.interrupt();
    this.emit({ type: "insight", tone: "info", code: input.interrupt ? "interventionInterrupt" : "interventionQueued", title: input.interrupt ? "Intervention recorded: the current step restarts with it." : "Intervention recorded: it applies from the next step." });
    return null;
  }

  /** The rule at `index` of `state.constraints`, which must still be `expectedText` when one is given: a rule that changed in the meantime is never overwritten. */
  private ruleAt(state: AutopilotState, index: number, expectedText?: string): string {
    const current = Number.isInteger(index) && index >= 0 ? state.constraints[index] : undefined;
    if (current === undefined) throw new AutopilotRuleError("rule_not_found", `There is no rule number ${index + 1}.`);
    if (expectedText !== undefined && current !== expectedText.trim()) throw new AutopilotRuleError("rule_changed", "The rule changed in the meantime: reload the rules and try again.");
    return current;
  }

  /** Replace the text of one permanent rule. `expectedText` is what the author saw: when the rule is no longer that, nothing is written and the call is refused. */
  async updateRule(index: number, text: string, expectedText?: string): Promise<AutopilotState> {
    const rule = normalizeRuleText(text);
    return this.mutate("Autopilot: rule edited", (state) => {
      const current = this.ruleAt(state, index, expectedText);
      if (rule === current) return state;
      if (state.constraints.includes(rule)) throw new AutopilotRuleError("rule_duplicate", "Another rule already says this.");
      return { ...state, constraints: state.constraints.map((entry, position) => (position === index ? rule : entry)) };
    });
  }

  /** Remove one permanent rule, with the same check of `expectedText`. */
  async removeRule(index: number, expectedText?: string): Promise<AutopilotState> {
    return this.mutate("Autopilot: rule removed", (state) => {
      this.ruleAt(state, index, expectedText);
      return { ...state, constraints: state.constraints.filter((_, position) => position !== index) };
    });
  }

  /**
   * Answer the question the run stopped with. The answer to a question about a change of a frozen chapter (or of the outline of a written
   * one) is a decision (`frozenAnswerAction`): marking it reviewed, or keeping the text, is done at once; a review is recorded for the
   * next run, which does it before going on with the plan.
   */
  async answer(answer: QuestionAnswer): Promise<AutopilotState> {
    if (this.running) throw new AutopilotBusyError(this.config.hostLabel);
    const stored = await readStoredAutopilot(this.config.store);
    const question = stored.state?.question;
    if (stored.state && isFrozenQuestion(question) && question.id === answer.questionId) {
      const { action, note } = frozenAnswerAction(question, answer);
      const { items } = await this.frozenView();
      const item = items.find((entry) => entry.kind === question.frozen.kind && entry.number === question.frozen.number);
      // The change is gone meanwhile (taken back, or decided elsewhere): the question is only closed.
      if (!item) return this.mutate("Autopilot: author answer", (state) => forgetFrozenChapter(state, question.frozen.number, question.frozen.kind));
      if (!frozenActions(item).includes(action)) throw new FrozenChapterError("invalid_action", `${action} cannot be done with chapter ${item.number} now.`);
      const saved = await this.carryOutDecision({ kind: item.kind, number: item.number, action, fingerprint: item.fingerprint, ...(note ? { note } : {}), ...(answer.asRule ? { asRule: true } : {}) }, item);
      await this.frozenView();
      return saved ?? (await readStoredAutopilot(this.config.store)).state ?? stored.state;
    }
    return this.mutate("Autopilot: author answer", (state) => applyAnswer(state, answer, this.now()));
  }

  // ─── Frozen chapters ──────────────────────────────────────────────────────

  /** The changes of frozen chapters (and of the outline of written ones), with what can be done with each, and the summary's count of them. */
  async frozenStatus(): Promise<FrozenStatus> {
    return (await this.frozenView()).status;
  }

  private async frozenView(): Promise<{ status: FrozenStatus; items: FrozenWorkItem[]; snapshot: BookSnapshot; stored: StoredAutopilot }> {
    const stored = await readStoredAutopilot(this.config.store);
    const snapshot = await loadBookSnapshot(this.config.store, this.bookCache);
    const { status, items } = await bookFrozenStatus(this.config.store, snapshot, stored.state, this.outlineCache);
    const count = frozenWaitingCount(status);
    const changed = count !== this.frozenCount;
    this.frozenCount = count;
    // The count is part of the summary and changes without a write: a client is told, as it is told of a pause that waits.
    if (changed && stored.state && !this.running) this.emit({ type: "state", state: this.summarize(stored.state) });
    return { status, items, snapshot, stored };
  }

  /**
   * Decide about the change of a chapter, as the answer to the question would: `mark-reviewed` (and `keep-text`) at once, in one commit of
   * the chapter.md and of the state, also while a run goes on (`keep-text` then at the run's next step); a review is recorded in
   * `state.pendingReviews` and done by the next run before the plan (by a run in progress, at its next step). `kind` tells the change when
   * a chapter has both (its text and its outline); without it the action says it, and `mark-reviewed` is about the text first. `note` is the
   * author's word for the director. Refused with a `FrozenChapterError`: `chapter_not_found`, `not_changed` (nothing to decide), and
   * `invalid_action` (not an action, or not one that can be done with this change now). Answers the status after it.
   */
  async resolveFrozenChange(number: number, action: FrozenAction, options: { kind?: FrozenChangeKind; note?: string } = {}): Promise<FrozenStatus> {
    if (!(FROZEN_ACTIONS as readonly string[]).includes(action)) throw new FrozenChapterError("invalid_action", `${String(action).slice(0, 40)} is not one of: ${FROZEN_ACTIONS.join(", ")}.`);
    if (options.kind !== undefined && !(options.kind in FROZEN_CHANGE_ACTIONS)) throw new FrozenChapterError("invalid_action", "The kind of change is frozen or outline.");
    const kind: FrozenChangeKind | undefined = options.kind ?? (action === "rewrite-to-outline" || action === "keep-text" ? "outline" : action === "mark-reviewed" ? undefined : "frozen");
    if (this.starting) await this.starting.catch(() => undefined);
    const { items, snapshot, stored } = await this.frozenView();
    const item = items.find((entry) => entry.number === number && (!kind || entry.kind === kind));
    if (!item) {
      const known = snapshot.chapters.some((chapter) => chapter.number === number) || Boolean(stored.state?.plan?.chapters.some((chapter) => chapter.number === number));
      throw known
        ? new FrozenChapterError("not_changed", `Chapter ${number} has no change to decide about${kind === "outline" ? " in its outline" : kind === "frozen" ? " in its text" : ""}.`)
        : new FrozenChapterError("chapter_not_found", `There is no chapter ${number}.`);
    }
    if (!frozenActions(item).includes(action)) {
      throw new FrozenChapterError("invalid_action", item.inPlan ? `${action} is not something that can be done with a change of ${item.kind === "frozen" ? "a frozen chapter" : "the outline of a written chapter"}.` : `Chapter ${number} is not in the autopilot's plan: it can only be marked as reviewed.`);
    }
    const note = options.note?.trim();
    await this.carryOutDecision({ kind: item.kind, number, action, fingerprint: item.fingerprint, ...(note ? { note } : {}) }, item);
    return this.frozenStatus();
  }

  /** Record a decision and do at once what needs no model. One commit, compare-and-swap, tried again when the files changed meanwhile. */
  private async carryOutDecision(decision: FrozenDecision, item: FrozenWorkItem): Promise<AutopilotState | null> {
    const message = `Autopilot: chapter ${decision.number}, ${decision.action}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stored = await readStoredAutopilot(this.config.store);
      const at = this.now().toISOString();
      const id = randomId("review");
      const changes: BookFileChange[] = [];
      let next: AutopilotState | null = null;
      if (stored.state && !stored.corrupt) next = applyFrozenDecision(stored.state, decision, at, id);
      else if (decision.action !== "mark-reviewed") assertStoredStateReadable(stored);
      if (decision.kind === "frozen" && decision.action === "mark-reviewed") {
        const snapshot = await loadBookSnapshot(this.config.store, this.bookCache);
        if (snapshot.chapters.find((chapter) => chapter.slug === item.slug)?.frozen) changes.push(...markReviewedChanges(snapshot, item.slug, at));
        if (next) next = withoutPendingReview(next, id);
      } else if (decision.kind === "outline" && (decision.action === "keep-text" || decision.action === "mark-reviewed") && next?.plan && !this.running) {
        // While a run goes on the plan is its own: the decision waits for its next step.
        const chapter = next.plan.chapters.find((entry) => entry.number === decision.number);
        if (chapter) chapter.outlineDigest = decision.fingerprint;
        next = withoutPendingReview(next, id);
      }
      const write = next && stored.state && !sameState(stored.state, next) ? stampState(next, this.now()) : null;
      if (!changes.length && !write) return stored.state;
      try {
        await this.config.store.commit([...changes, ...(write ? [stateChange(write, stored.stateHash)] : [])], message);
        if (write) this.emit({ type: "state", state: this.summarize(write) });
        return write ?? stored.state;
      } catch (error) {
        if (!isBookConflictError(error) || attempt === 4) throw error;
      }
    }
    return null;
  }

  /** Freeze a chapter by hand (`by: author`), as it is now: a change the author made to it is accepted, and the decisions that waited for it are dropped. */
  async freezeChapter(slug: string): Promise<FrozenChapterResult> {
    return this.setFrozen(slug, true);
  }

  /** Take the record of a chapter away (one that cannot be read too): the chapter is not frozen any more, and nothing waits for it. */
  async unfreezeChapter(slug: string): Promise<FrozenChapterResult> {
    return this.setFrozen(slug, false);
  }

  private async setFrozen(slug: string, frozen: boolean): Promise<FrozenChapterResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stored = await readStoredAutopilot(this.config.store);
      const snapshot = await loadBookSnapshot(this.config.store, this.bookCache);
      const chapter = snapshot.chapters.find((entry) => entry.slug === slug);
      if (!chapter) throw new FrozenChapterError("chapter_not_found", `There is no chapter in the folder chapters/${slug}.`);
      const changes = frozen ? freezeChapterChanges(snapshot, slug, "author", this.now().toISOString()) : unfreezeChapterChanges(snapshot, slug);
      const record = frozen ? parseChapterFreeze(parseMarkdown(changes[0].content ?? "").frontmatter.frozen).freeze ?? null : null;
      const next = stored.state && !stored.corrupt ? forgetFrozenChapter(stored.state, chapter.number, "frozen") : null;
      const write = next && stored.state && !sameState(stored.state, next) ? stampState(next, this.now()) : null;
      if (!changes.length && !write) return { slug, number: chapter.number, frozen: record };
      try {
        await this.config.store.commit([...changes, ...(write ? [stateChange(write, stored.stateHash)] : [])], `Autopilot: chapter ${slug} ${frozen ? "frozen" : "unfrozen"} by the author`);
        if (write) this.emit({ type: "state", state: this.summarize(write) });
        await this.frozenView();
        return { slug, number: chapter.number, frozen: record };
      } catch (error) {
        if (!isBookConflictError(error) || attempt === 4) throw error;
      }
    }
    throw new Error("Could not save the chapter.");
  }

  /**
   * Change the brief or the options while the autopilot is not running. The brief is the book's `outline/_brief.md`: a brief sent is saved
   * there first, and the state takes the brief the file has; without one, the state takes the file's brief as well.
   */
  async configure(input: StartOptions): Promise<AutopilotState> {
    if (this.running) throw new AutopilotBusyError(this.config.hostLabel);
    const brief = await this.briefOf(input.brief);
    return this.mutate("Autopilot: settings", (state) => ({
      ...state,
      brief,
      options: normalizeOptions(input.options ?? {}, state.options),
    }));
  }

  /** The brief as the file has it after the author's, when one is sent (see `configure`). */
  private async briefOf(sent: Partial<AutopilotBrief> | undefined): Promise<AutopilotBrief> {
    if (sent) return writeOutlineBrief(this.config.store, sent);
    const stored = await readStoredAutopilot(this.config.store);
    const { brief, changes } = await readBrief(this.config.store, stored.state);
    if (changes.length) await this.config.store.commit(changes, "Autopilot: brief");
    return brief;
  }

  /**
   * Change the options, also while a run goes on, for the settings that can (`LIVE_AUTOPILOT_OPTIONS`): where the book is published
   * (`publishEvery`; `null` takes the choice back, so that the host decides again), whether to pause after every chapter
   * (`pauseAfterEachChapter`), what to do with a change of a frozen chapter (`frozenEdits`), «Retry later» (`longRetry`; `null` turns it
   * off) and «Resume after a restart» (`resumeAfterRestart`, which the server reads when it starts again). They are saved at once with a
   * compare-and-swap commit, as an intervention is: the step that is running neither fails nor is
   * repeated, and the run reads the new value at the end of that step (or of the chapter); `longRetry` when a step has failed, and turning it
   * off while the run waits for it ends the wait (the run stops with the failure it waited to try again), while new minutes or cycles count from
   * the next cycle. Any other option is refused while a run is active, as `configure` refuses it (`AutopilotBusyError`), and nothing of such a
   * request is applied; with no run active any option can change. A value nobody knows changes nothing, and a request that changes nothing
   * writes nothing. Answers the saved state.
   */
  async updateOptions(input: AutopilotOptionsUpdate): Promise<AutopilotState> {
    const source: Record<string, unknown> = input && typeof input === "object" ? { ...input } : {};
    if (this.running) {
      const live = new Set<string>(LIVE_AUTOPILOT_OPTIONS);
      const options = new Set<string>([...Object.keys(DEFAULT_OPTIONS), "publishEvery", "longRetry"]);
      if (Object.keys(source).some((key) => options.has(key) && !live.has(key) && source[key] !== undefined)) throw new AutopilotBusyError(this.config.hostLabel);
      for (const key of Object.keys(source)) if (!live.has(key)) delete source[key];
    }
    const saved = await this.mutate("Autopilot: options", (state) => {
      const options = normalizeOptions(source, state.options);
      const keys = new Set<keyof AutopilotOptions>([...Object.keys(state.options), ...Object.keys(options)] as Array<keyof AutopilotOptions>);
      // Compared by value: «Retry later» is an object.
      return [...keys].every((key) => JSON.stringify(options[key]) === JSON.stringify(state.options[key])) ? state : { ...state, options };
    });
    this.run?.optionsChanged(saved);
    return saved;
  }

  /** Forget the autopilot state (plan, history, rules). The book's chapters are never touched. */
  async reset(): Promise<void> {
    if (this.running) throw new AutopilotBusyError(this.config.hostLabel);
    const changes = (await Promise.all([AUTOPILOT_STATE_FILE, AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_PLAN_FILE].map(async (path) => {
      const file = await this.config.store.read(path);
      return file ? { path, content: null, expectedHash: file.hash } : null;
    }))).filter((change): change is { path: string; content: null; expectedHash: string } => Boolean(change));
    if (changes.length) await this.config.store.commit(changes, "Autopilot: reset");
    this.events = [];
    this.emit({ type: "insight", tone: "info", code: "reset", title: "Autopilot reset." });
  }

  /** "What does the director think?" on the book, a chapter or a scene. */
  askDirector(input: { target: EvaluationTarget; question?: string; save?: boolean; signal?: AbortSignal }): Promise<AskDirectorResult> {
    return askDirector({ ...input, store: this.config.store, ai: this.config.ai, now: this.now });
  }
}
