import { redactSecrets } from "../ai/redact.js";
import type { AiPort } from "../ai/types.js";
import { AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_PLAN_FILE, AUTOPILOT_STATE_FILE, type EvaluationTarget } from "../book/paths.js";
import { isBookConflictError, type BookStore } from "../book/store.js";
import { askDirector, type AskDirectorResult } from "../director/opinion.js";
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
} from "./runner.js";
import { AutopilotRuleError, createAutopilotState, normalizeBrief, normalizeOptions, normalizeRuleText, summarizeAutopilotState } from "./state.js";
import type {
  AutopilotActivity,
  AutopilotEvent,
  AutopilotEventBody,
  AutopilotRunnerInfo,
  AutopilotSnapshot,
  AutopilotState,
  AutopilotStateSummary,
  InterventionInput,
  QuestionAnswer,
  StartOptions,
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
}

export type AutopilotListener = (event: AutopilotEvent) => void;

/**
 * Control surface of one book's autopilot. The browser and the personal server both use
 * this class, so start, pause, interventions, questions and live events behave identically.
 */
export class AutopilotSession {
  private run: AutopilotRun | null = null;
  private runPromise: Promise<AutopilotState> | null = null;
  /** A `start()` in flight: from its first line until the run has saved its start, or the start has failed. */
  private starting: Promise<void> | null = null;
  /** A pause asked for while a start was in flight: it is applied as soon as the run exists. */
  private pendingPause: "now" | "after-step" | null = null;
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
    if (body.type === "task-started") this.live = { activity: body.activity, characters: 0, preview: "" };
    else if (body.type === "task-progress" && this.live?.activity.id === body.activityId) this.live = { ...this.live, characters: body.characters, preview: body.preview };
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

  /** The runner as the active run's own session knows it: its heartbeat is the one in memory when that is newer than the saved one. */
  private liveRunner(runner: AutopilotRunnerInfo | null): AutopilotRunnerInfo | null {
    if (!runner || !this.run || !this.liveHeartbeatAt || runner.runId !== this.run.runId) return runner;
    return Date.parse(this.liveHeartbeatAt) > Date.parse(runner.heartbeatAt) ? { ...runner, heartbeatAt: this.liveHeartbeatAt } : runner;
  }

  async snapshot(): Promise<AutopilotSnapshot> {
    const stored = await readStoredAutopilot(this.config.store);
    let state = stored.state;
    if (state?.runner && this.liveRunner(state.runner) !== state.runner) state = { ...state, runner: this.liveRunner(state.runner) };
    const interrupted = "Interrupted: resume to continue from the last saved step.";
    if (state && !this.running && state.status === "running" && this.isOwnRunner(state.runner) && !(await this.ownRunnerAliveElsewhere())) {
      state = { ...state, status: "paused", runner: null, message: state.message ?? interrupted };
    }
    if (state && !this.running && runnerActivity(state, this.now()) === "stale") {
      state = { ...state, status: "paused", runner: null, message: interrupted };
    }
    const activities: AutopilotActivity[] = [...stored.activities];
    const current = this.run?.activity;
    if (current && !activities.some((activity) => activity.id === current.id)) activities.push(current);
    return {
      bookId: this.config.bookId,
      state,
      activities,
      live: this.live,
      running: this.running,
      host: this.running ? this.config.host : state?.status === "running" ? state.runner?.host ?? null : null,
      ...(stored.corrupt ? { stateError: { code: "state_corrupt" as const, message: new AutopilotStateCorruptError(stored.corrupt).message } } : {}),
    };
  }

  /** Start or resume. Resolves once the run has saved its start, rejects if it could not start. */
  async start(options: StartOptions & { force?: boolean } = {}): Promise<void> {
    // The claim is taken before anything is awaited: two concurrent calls can never both create a run.
    if (this.running) throw new AutopilotBusyError(this.config.hostLabel);
    const starting = this.launch(options);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
      this.pendingPause = null;
    }
  }

  private async launch(options: StartOptions & { force?: boolean }): Promise<void> {
    const stored = await readStoredAutopilot(this.config.store);
    assertStoredStateReadable(stored);
    const runner = stored.state?.runner;
    if (!options.force && runner && runnerActivity(stored.state, this.now()) === "active" && (!this.isOwnRunner(runner) || await this.ownRunnerAliveElsewhere())) {
      throw new AutopilotBusyError(runner.label || runner.host);
    }
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
      retryDelayMs: this.config.retryDelayMs,
      random: this.config.random,
      persistHeartbeatMs: this.config.persistHeartbeatMs,
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
      if (this.run === run) {
        this.run = null;
        this.runPromise = null;
        this.stopBeat();
      }
    });
    this.runPromise.catch(() => undefined);
    this.startBeat(run);
    const pause = this.pendingPause;
    this.pendingPause = null;
    if (pause === "now") run.stop();
    else if (pause === "after-step") run.stopAfterStep();
    await started;
  }

  /** `now` abandons the request in flight; `after-step` lets the current step finish and save. */
  pause(mode: "now" | "after-step" = "after-step"): boolean {
    if (this.run) {
      if (mode === "now") this.run.stop();
      else this.run.stopAfterStep();
      return true;
    }
    if (!this.starting) return false;
    this.pendingPause = mode === "now" || this.pendingPause === "now" ? "now" : "after-step";
    return true;
  }

  /** Resolves when no run is active, and no start is about to create one. */
  async waitForIdle(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    await this.runPromise?.catch(() => undefined);
  }

  /** Save a change of the state with a compare-and-swap commit, read again and tried again when the file changed in between (a run saves it too). A change that returns the state it was given writes nothing. */
  private async mutate(message: string, change: (state: AutopilotState) => AutopilotState): Promise<AutopilotState> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stored = await readStoredAutopilot(this.config.store);
      assertStoredStateReadable(stored);
      const base = stored.state ?? createAutopilotState(this.now());
      const changed = change(base);
      if (changed === base && stored.state) return base;
      const next = stampState(changed, this.now());
      try {
        await this.config.store.commit([stateChange(next, stored.stateHash)], message);
        const summary = summarizeAutopilotState(next);
        this.emit({ type: "state", state: summary.runner ? { ...summary, runner: this.liveRunner(summary.runner) } : summary });
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

  async answer(answer: QuestionAnswer): Promise<AutopilotState> {
    if (this.running) throw new AutopilotBusyError(this.config.hostLabel);
    return this.mutate("Autopilot: author answer", (state) => applyAnswer(state, answer, this.now()));
  }

  /** Change the brief or the options while the autopilot is not running. */
  async configure(input: StartOptions): Promise<AutopilotState> {
    if (this.running) throw new AutopilotBusyError(this.config.hostLabel);
    return this.mutate("Autopilot: settings", (state) => ({
      ...state,
      brief: normalizeBrief(input.brief ?? {}, state.brief),
      options: normalizeOptions(input.options ?? {}, state.options),
    }));
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
