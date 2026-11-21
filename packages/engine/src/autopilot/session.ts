import type { AiPort } from "../ai/types.js";
import { AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_PLAN_FILE, AUTOPILOT_STATE_FILE, type EvaluationTarget } from "../book/paths.js";
import { isBookConflictError, type BookStore } from "../book/store.js";
import { askDirector, type AskDirectorResult } from "../director/opinion.js";
import {
  AutopilotRun,
  applyAnswer,
  applyIntervention,
  readStoredAutopilot,
  stampState,
  stateChange,
  type AutopilotHooks,
} from "./runner.js";
import { createAutopilotState, normalizeBrief, normalizeOptions, summarizeAutopilotState } from "./state.js";
import type {
  AutopilotActivity,
  AutopilotEvent,
  AutopilotEventBody,
  AutopilotSnapshot,
  AutopilotState,
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
  retryDelayMs?: number;
}

export type AutopilotListener = (event: AutopilotEvent) => void;

/**
 * Control surface of one book's autopilot. The browser and the personal server both use
 * this class, so start, pause, interventions, questions and live events behave identically.
 */
export class AutopilotSession {
  private run: AutopilotRun | null = null;
  private runPromise: Promise<AutopilotState> | null = null;
  private seq = 0;
  private events: AutopilotEvent[] = [];
  private readonly listeners = new Set<AutopilotListener>();
  private live: AutopilotSnapshot["live"] = null;
  private readonly now: () => Date;

  constructor(private readonly config: AutopilotSessionConfig) {
    this.now = config.now ?? (() => new Date());
  }

  get bookId(): string {
    return this.config.bookId;
  }

  get running(): boolean {
    return this.run !== null;
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

  private emit(body: AutopilotEventBody): void {
    const event = { ...body, bookId: this.config.bookId, at: this.now().toISOString(), seq: ++this.seq } as AutopilotEvent;
    if (body.type === "task-started") this.live = { activity: body.activity, characters: 0, preview: "" };
    else if (body.type === "task-progress" && this.live?.activity.id === body.activityId) this.live = { ...this.live, characters: body.characters, preview: body.preview };
    else if (body.type === "task-finished" && this.live?.activity.id === body.activity.id) this.live = null;
    else if (body.type === "run-ended") this.live = null;
    // Streaming previews are only useful live; keep the replay buffer for meaningful events.
    if (body.type !== "task-progress") {
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
    if (this.running || !this.config.ownRunnerAlive) return false;
    try {
      return Boolean(await this.config.ownRunnerAlive());
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<AutopilotSnapshot> {
    const stored = await readStoredAutopilot(this.config.store);
    let state = stored.state;
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
    };
  }

  /** Start or resume. Resolves once the run has saved its start, rejects if it could not start. */
  async start(options: StartOptions & { force?: boolean } = {}): Promise<void> {
    if (this.run) throw new AutopilotBusyError(this.config.hostLabel);
    const stored = await readStoredAutopilot(this.config.store);
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
      else this.emit({ type: "insight", tone: "critical", code: "unexpectedStop", title: "The autopilot stopped unexpectedly.", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => {
      if (this.run === run) {
        this.run = null;
        this.runPromise = null;
      }
    });
    this.runPromise.catch(() => undefined);
    await started;
  }

  /** `now` abandons the request in flight; `after-step` lets the current step finish and save. */
  pause(mode: "now" | "after-step" = "after-step"): boolean {
    if (!this.run) return false;
    if (mode === "now") this.run.stop();
    else this.run.stopAfterStep();
    return true;
  }

  /** Resolves when no run is active. */
  async waitForIdle(): Promise<void> {
    await this.runPromise?.catch(() => undefined);
  }

  private async mutate(message: string, change: (state: AutopilotState) => AutopilotState): Promise<AutopilotState> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await readStoredAutopilot(this.config.store);
      const next = stampState(change(stored.state ?? createAutopilotState(this.now())), this.now());
      try {
        await this.config.store.commit([stateChange(next, stored.stateHash)], message);
        this.emit({ type: "state", state: summarizeAutopilotState(next) });
        return next;
      } catch (error) {
        if (!isBookConflictError(error) || attempt === 2) throw error;
      }
    }
    throw new Error("Could not save the autopilot state.");
  }

  /** Record an author intervention. While running it reaches the next step (or interrupts the current one). */
  async intervene(input: InterventionInput): Promise<AutopilotState | null> {
    if (!input.text.trim()) throw new Error("The intervention is empty.");
    if (this.run) {
      this.run.intervene(input);
      this.emit({ type: "insight", tone: "info", code: input.interrupt ? "interventionInterrupt" : "interventionQueued", title: input.interrupt ? "Intervention recorded: the current step restarts with it." : "Intervention recorded: it applies from the next step." });
      return null;
    }
    return this.mutate("Autopilot: author intervention", (state) => applyIntervention(state, input, this.now(), "paused"));
  }

  async answer(answer: QuestionAnswer): Promise<AutopilotState> {
    if (this.run) throw new AutopilotBusyError(this.config.hostLabel);
    return this.mutate("Autopilot: author answer", (state) => applyAnswer(state, answer, this.now()));
  }

  /** Change the brief or the options while the autopilot is not running. */
  async configure(input: StartOptions): Promise<AutopilotState> {
    if (this.run) throw new AutopilotBusyError(this.config.hostLabel);
    return this.mutate("Autopilot: settings", (state) => ({
      ...state,
      brief: normalizeBrief(input.brief ?? {}, state.brief),
      options: normalizeOptions(input.options ?? {}, state.options),
    }));
  }

  /** Forget the autopilot state (plan, history, rules). The book's chapters are never touched. */
  async reset(): Promise<void> {
    if (this.run) throw new AutopilotBusyError(this.config.hostLabel);
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
