import { AiProviderError, AiUnavailableError, type AiPort, type AiRequest, type AiResponse, type AiUsage } from "../ai/types.js";
import { activeReaders, isThinDocument, loadDirectorProfile, loadReaderPanel, readBody } from "../book/context.js";
import { AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_STATE_FILE, STORY_DESIGN_FILE } from "../book/paths.js";
import { SnapshotCache, loadBookSnapshot, type BookSnapshot } from "../book/snapshot.js";
import { isBookConflictError, normalizeChanges, type BookFileChange, type BookStore } from "../book/store.js";
import type { DirectorProfile } from "../profiles/director.js";
import type { ReaderPersonaProfile } from "../profiles/readers.js";
import { abortError, isAbortError, sleep } from "../util/abort.js";
import { randomId } from "../util/hash.js";
import { StructuredReplyError } from "../util/json.js";
import { isItalian, languageCode, tail } from "../util/text.js";
import { advanceState, nextStep, phaseOf, type PlannerContext, type TaskDescriptor } from "./planner.js";
import {
  MAX_INTERVENTIONS,
  createAutopilotState,
  normalizeBrief,
  normalizeOptions,
  parseActivityLog,
  parseAutopilotState,
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
  /** Delay before the single automatic retry of a failed step (ms). */
  retryDelayMs?: number;
}

export interface StoredAutopilot {
  state: AutopilotState | null;
  stateHash: string | null;
  activities: AutopilotActivity[];
  activityHash: string | null;
}

export async function readStoredAutopilot(store: BookStore): Promise<StoredAutopilot> {
  const [stateFile, activityFile] = await Promise.all([store.read(AUTOPILOT_STATE_FILE), store.read(AUTOPILOT_ACTIVITY_FILE)]);
  return {
    state: parseAutopilotState(stateFile?.content),
    stateHash: stateFile?.hash ?? null,
    activities: parseActivityLog(activityFile?.content),
    activityHash: activityFile?.hash ?? null,
  };
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

/** Pure application of an author intervention to the state. */
export function applyIntervention(state: AutopilotState, input: InterventionInput, now: Date, during: string): AutopilotState {
  const text = input.text.trim();
  if (!text) throw new Error("The intervention is empty.");
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
  if (input.scope !== "next_step" && !next.constraints.includes(text)) next.constraints.push(text);
  if (input.scope === "rewrite") {
    const written = next.plan?.chapters.some((chapter) => chapter.scenes.some((scene) => scene.status !== "planned"));
    if (written) {
      next.revision = next.revision && next.revision.targets === null
        ? { ...next.revision, instruction: `${next.revision.instruction}\n${text}` }
        : { id: randomId("revision"), instruction: text, createdAt: at, targets: null, cursor: 0 };
      next.finalDone = false;
    } else if (next.plan) {
      next.plan = { ...next.plan, approved: false, awaitingAuthor: false, revisionNotes: [...next.plan.revisionNotes, text] };
    }
  }
  next.interventions = [...next.interventions, entry].slice(-MAX_INTERVENTIONS);
  return next;
}

/** Pure application of the author's answer to the director's question. */
export function applyAnswer(state: AutopilotState, answer: QuestionAnswer, now: Date): AutopilotState {
  if (!state.question || state.question.id !== answer.questionId) throw new Error("This question is no longer open.");
  const next = structuredClone(state);
  const question = next.question!;
  next.question = null;
  const text = answer.answer.trim();
  if (!answer.accept && text) {
    next.interventions = [...next.interventions, {
      id: randomId("intervention"),
      scope: "next_step" as const,
      text: `Answer to the director's question «${question.question}»: ${text}`,
      createdAt: now.toISOString(),
      during: question.question,
      status: "pending" as const,
    }].slice(-MAX_INTERVENTIONS);
  }
  if (next.status === "waiting-author") next.status = "paused";
  next.message = null;
  return next;
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
      revisionNotes: [`Extend the book to ${state.brief.targetChapters} chapters, continuing from the chapters already written.`],
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AiUnavailableError) return false;
  if (error instanceof AiProviderError) return error.retryable || error.status === undefined;
  if (error instanceof StructuredReplyError) return true;
  return error instanceof Error && !isBookConflictError(error);
}

function taskKey(task: TaskDescriptor): string {
  return [task.kind, task.chapterNumber ?? "", task.sceneNumber ?? "", task.reader ?? ""].join(":");
}

interface StepContext {
  planner: PlannerContext;
  director: DirectorProfile;
  panel: ReaderPersonaProfile[];
}

/** One autopilot run: loops over steps until it completes, pauses, or fails. */
export class AutopilotRun {
  readonly runId = randomId("run");
  private readonly controller = new AbortController();
  private stepController: AbortController | null = null;
  private stopRequested = false;
  private interrupted = false;
  private readonly queue: InterventionInput[] = [];
  private readonly cache = new SnapshotCache();
  private readonly now: () => Date;
  private chaptersThisRun = 0;
  private current: AutopilotActivity | null = null;

  constructor(private readonly config: AutopilotRunConfig) {
    this.now = config.now ?? (() => new Date());
  }

  get activity(): AutopilotActivity | null {
    return this.current;
  }

  /** Stop now: the AI request in flight is abandoned (the provider may still bill it). */
  stop(): void {
    this.stopRequested = true;
    this.controller.abort(abortError("Paused by the author."));
  }

  /** Finish and save the current step, then pause. */
  stopAfterStep(): void {
    this.stopRequested = true;
  }

  /** Queue an intervention; with `interrupt` the running step is abandoned and repeated with it. */
  intervene(input: InterventionInput): void {
    if (!input.text.trim()) throw new Error("The intervention is empty.");
    this.queue.push(input);
    if (input.interrupt && this.stepController) {
      this.interrupted = true;
      this.stepController.abort(abortError("Interrupted by an author intervention."));
    }
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
      loadDirectorProfile(this.config.store, language),
      loadReaderPanel(this.config.store, snapshot),
      readBody(this.config.store, STORY_DESIGN_FILE, 20000),
    ]);
    const readers = activeReaders(panel, director, state.options.maxReaders).map((reader) => ({ slug: reader.slug, name: reader.name }));
    return { planner: { snapshot, director, readers, language, storyDesignThin: isThinDocument(design) }, director, panel };
  }

  private drainQueue(state: AutopilotState, during: string): AutopilotState {
    let next = state;
    while (this.queue.length) next = applyIntervention(next, this.queue.shift()!, this.now(), during);
    return next;
  }

  async execute(start: StartOptions = {}): Promise<AutopilotState> {
    const { store } = this.config;
    const stored = await readStoredAutopilot(store);
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
    this.emit({ type: "run-started", runId: this.runId, host: this.config.host });
    this.emit({ type: "state", state: summarizeAutopilotState(state) });

    let conflictRetries = 0;
    let failureRetries = 0;
    let lastSuccessKey = "";
    let successRepeats = 0;
    for (let steps = 0; ; steps += 1) {
      if (this.stopRequested) {
        state = await this.finish(state, "paused", null);
        break;
      }
      if (steps > 5000) {
        state = await this.finish({ ...state, lastError: { message: "Too many steps in one run.", at: this.now().toISOString() } }, "error", "Too many steps in one run.");
        break;
      }
      const latest = await readStoredAutopilot(store);
      if (latest.state?.runner?.runId && latest.state.runner.runId !== this.runId) {
        this.emit({ type: "insight", tone: "warning", code: "takenOver", title: "Another runner took over this book: this run stops." });
        break;
      }
      if (latest.state) state = { ...latest.state, status: "running", runner: state.runner };
      let task: TaskDescriptor | null = null;
      const stepController = new AbortController();
      this.stepController = stepController;
      const onRunAbort = () => stepController.abort(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", onRunAbort, { once: true });
      try {
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
        if (state.options.budgetLimit > 0 && state.stats.cost >= state.options.budgetLimit) {
          state = await this.finish(state, "paused", italian ? "Budget raggiunto: alza il limite per continuare." : "Budget reached: raise the limit to continue.");
          break;
        }
        task = step.task;
        const key = taskKey(task);
        if (key === lastSuccessKey && successRepeats >= 2) throw new Error(`The autopilot is not making progress on "${task.title}".`);
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
        const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        let cost = 0;
        let calls = 0;
        let model: string | undefined;
        let provider: string | undefined;
        let currency: string | undefined;
        let lastProgress = 0;
        const ai = async (request: Omit<AiRequest, "signal">): Promise<AiResponse> => {
          const onText = request.json ? undefined : (text: string) => {
            const at = Date.now();
            if (text.length > 0 && at - lastProgress < 350) return;
            lastProgress = at;
            this.emit({ type: "task-progress", activityId: activity.id, characters: text.length, preview: tail(text, 700) });
          };
          const response = await this.config.ai.complete({ ...request, signal: stepController.signal, onText: request.onText ?? onText });
          calls += 1;
          model = response.model ?? model;
          provider = response.provider ?? provider;
          currency = response.currency ?? currency;
          if (response.usage) {
            usage.inputTokens += response.usage.inputTokens;
            usage.outputTokens += response.usage.outputTokens;
            usage.cachedInputTokens += response.usage.cachedInputTokens;
          }
          cost += response.cost ?? 0;
          return response;
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
          model,
          provider,
          usage,
          cost: cost || undefined,
        };
        let next: AutopilotState = {
          ...working,
          interventions: working.interventions.map((entry) => applied.has(entry.id) ? { ...entry, status: "applied" as const, appliedAt: finishedAt.toISOString(), appliedBy: activity.id } : entry),
          stats: {
            ...working.stats,
            tasks: working.stats.tasks + 1,
            aiCalls: working.stats.aiCalls + calls,
            inputTokens: working.stats.inputTokens + usage.inputTokens,
            outputTokens: working.stats.outputTokens + usage.outputTokens,
            cost: working.stats.cost + cost,
            currency: currency ?? working.stats.currency,
          },
          runner: state.runner ? { ...state.runner, heartbeatAt: finishedAt.toISOString() } : null,
          lastError: null,
        };
        next = this.drainQueue(next, task.title);
        next = stampState({ ...next, phase: phaseOf(next) }, finishedAt);
        const message = `Autopilot: ${task.title}`;
        await store.commit(normalizeChanges([...changes, stateChange(next, latest.stateHash), activityChange([...latest.activities, done], latest.activityHash)]), message);
        state = next;
        this.current = null;
        conflictRetries = 0;
        failureRetries = 0;
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
          const failed: AutopilotActivity = { ...activity, status: isAbortError(error) ? "cancelled" : "failed", endedAt: this.now().toISOString(), error: describeError(error) };
          this.emit({ type: "task-finished", activity: failed });
          await this.persistActivity(failed).catch(() => undefined);
        }
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
        if (isRetryable(error) && failureRetries < 1) {
          failureRetries += 1;
          this.emit({ type: "insight", tone: "warning", code: "failureRetry", title: "The step failed: retrying once.", detail: describeError(error) });
          try {
            await sleep(this.config.retryDelayMs ?? 4000, this.controller.signal);
          } catch {
            state = await this.finish(state, "paused", null);
            break;
          }
          continue;
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
      }
    }
    this.emit({ type: "run-ended", runId: this.runId, status: state.status, message: state.message });
    return state;
  }

  private async persistActivity(activity: AutopilotActivity): Promise<void> {
    const stored = await readStoredAutopilot(this.config.store);
    await this.config.store.commit([activityChange([...stored.activities, activity], stored.activityHash)], `Autopilot: ${activity.title} (${activity.status})`);
  }

  /** Close the run with a final status, persisted together with any queued intervention. */
  private async finish(state: AutopilotState, status: AutopilotState["status"], message: string | null): Promise<AutopilotState> {
    let final: AutopilotState = state;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await readStoredAutopilot(this.config.store);
      final = { ...state, status: state.question ? "waiting-author" : status, message, runner: null, phase: phaseOf(state) };
      final = stampState(this.drainQueue(final, message ?? status), this.now());
      try {
        await this.config.store.commit([stateChange(final, stored.stateHash)], `Autopilot: ${final.status}`);
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
