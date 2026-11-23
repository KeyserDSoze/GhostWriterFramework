import { AiProviderError, AiStreamInterruptedError, type AiResponse, type AiTransportDiagnostics } from "../../ai/types.js";
import type { FetchAiAttempt, FetchAiAttemptEnd } from "../../ai/fetch-client.js";
import { isAbortError } from "../../util/abort.js";
import type { AutopilotTaskKind } from "../types.js";
import { CallRecorder } from "./recorder.js";
import type { AiCallStore } from "./port.js";
import { AI_CALL_BUDGETS, type AiCallAttempt, type AiCallAttemptOutcome, type AiCallDropReason, type AiCallError, type AiCallHost, type AiCallStatus, type AiCallTaskDraft } from "./types.js";
import { utf8Length } from "./utf8.js";

/** A provider attempt as the recorder keeps it (its text size is added by the recorder). */
type AttemptReport = Omit<AiCallAttempt, "text">;

export interface RunCallsOptions {
  store: AiCallStore;
  bookId: string;
  accountScope: string | null;
  host: AiCallHost;
  /** The budget of the book's records: after each task the oldest finished tasks are dropped until the book keeps this many bytes. */
  budgetBytes?: number;
  /** The known secret values of the host, redacted from every record. */
  secrets: () => readonly string[];
  /** Called once per run with the first failure of the store: the run says it, and keeps going without records. */
  onFailure: (error: unknown) => void;
  now: () => Date;
}

/** What a call is, as the runner knows it when the call starts. */
export interface CallStart {
  runId: string;
  activityId: string;
  seq: number;
  stepAttempt: number;
  task: AutopilotTaskKind;
  chapter: number | null;
  scene: number | null;
  label: string;
  capability: string;
  system: string;
  user: string;
  structured: boolean;
  tool: string | null;
  toolSchemaHash: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
}

/** What a call kept, once it ended: what the runner tells its listeners (never the text). */
export interface CallEndInfo {
  callId: string;
  status: AiCallStatus;
  attempts: number;
  characters: number;
  storedBytes: number;
  partial: boolean;
  dropped: AiCallDropReason | null;
  durationMs: number;
}

/**
 * The records of one autopilot run: one recorder per AI call, the task headers, and the budget. A store failure stops the records for the rest of the
 * run (reported once through `onFailure`); it never fails a step, and nothing waits for the store.
 */
export class RunCalls {
  private stopped = false;

  constructor(private readonly options: RunCallsOptions) {}

  get active(): boolean {
    return !this.stopped;
  }

  saveTask(draft: AiCallTaskDraft): void {
    if (this.stopped) return;
    this.settle(this.options.store.saveTask(draft));
  }

  prune(): void {
    if (this.stopped) return;
    this.settle(this.options.store.prune(this.options.bookId, this.options.budgetBytes ?? AI_CALL_BUDGETS.browserPerBookBytes));
  }

  start(input: CallStart): CallRecording | null {
    if (this.stopped) return null;
    try {
      const recorder = new CallRecorder({
        store: this.options.store,
        bookId: this.options.bookId,
        accountScope: this.options.accountScope,
        runId: input.runId,
        activityId: input.activityId,
        seq: input.seq,
        stepAttempt: input.stepAttempt,
        task: input.task,
        chapter: input.chapter,
        scene: input.scene,
        label: input.label,
        capability: input.capability,
        host: this.options.host,
        system: input.system,
        user: input.user,
        request: { images: 0, tool: input.tool, toolSchemaHash: input.toolSchemaHash, structured: input.structured, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature },
        secrets: this.options.secrets(),
        clock: { now: () => this.options.now().getTime(), setTimer: (callback, ms) => globalThis.setTimeout(callback, ms), clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>) },
        onError: (error) => this.fail(error),
      });
      return new CallRecording(recorder, input, utf8Length(input.system), utf8Length(input.user), this.options.now);
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.options.onFailure(error);
    } catch {
      // A listener that throws is not the store's failure.
    }
  }

  private settle(result: Promise<unknown>): void {
    result.then(undefined, (error: unknown) => this.fail(error));
  }
}

/**
 * One AI call of a step: the recorder, and the provider attempts of the call. Its `onAttempt` and `onAttemptEnd` are the client's per-request hooks.
 *
 * Attempts and texts: the recorder numbers the texts it receives (a text attempt starts at a text that is not longer than the one before it, and
 * at the first text). A provider attempt has the text attempt of the text it started, when it produced one (`textAttempt`), and no text otherwise.
 * An attempt that fails after the model answered keeps its text as the text attempt it started; the next attempt starts a new one, because the
 * client resets the text when a candidate fails.
 */
export class CallRecording {
  readonly callId: string;
  readonly seq: number;
  readonly systemBytes: number;
  readonly userBytes: number;
  private readonly startedMs: number;
  private readonly open = new Map<string, { index: number; start: FetchAiAttempt; texts: number }>();
  private readonly reports: AttemptReport[] = [];
  private hooked = false;
  private index = 0;
  private result: CallEndInfo | null = null;

  constructor(
    private readonly recorder: CallRecorder,
    private readonly input: CallStart,
    systemBytes: number,
    userBytes: number,
    private readonly now: () => Date,
  ) {
    this.callId = recorder.callId;
    this.seq = input.seq;
    this.systemBytes = systemBytes;
    this.userBytes = userBytes;
    this.startedMs = now().getTime();
  }

  /** The cumulative text of the reply (`onText`), or of the arguments of a structured reply (`onStructuredText`). */
  onText(text: string): void {
    this.recorder.onText(text);
  }

  readonly onAttempt = (attempt: FetchAiAttempt): void => {
    this.hooked = true;
    this.index += 1;
    this.open.set(attempt.attemptId, { index: this.index, start: attempt, texts: this.recorder.textAttempts });
  };

  readonly onAttemptEnd = (end: FetchAiAttemptEnd): void => {
    const started = this.open.get(end.attemptId);
    if (!started) return;
    this.open.delete(end.attemptId);
    const textAttempt = this.recorder.textAttempts > started.texts ? this.recorder.textAttempts : null;
    this.reports.push(reportOf(started.index, started.start, end, textAttempt));
  };

  /**
   * Ends the call: `status` is what happened (`statusOf`), and `response` or `error` is what the call gave. Idempotent. Returns what the call kept.
   * Without the client's attempt hooks (a host that does not forward them) the attempt is taken from the response or the error.
   */
  end(status: Exclude<AiCallStatus, "running">, outcome: { response?: AiResponse; error?: unknown } = {}): CallEndInfo {
    if (this.result) return this.result;
    const attempts = this.hooked ? this.reports : this.synthesize(outcome.response, outcome.error);
    const durationMs = this.now().getTime() - this.startedMs;
    this.recorder.finish(status, attempts).catch(() => undefined);
    const characters = this.recorder.responseCharacters;
    this.result = { callId: this.callId, status, attempts: attempts.length, characters, storedBytes: this.recorder.storedBytes, partial: status !== "ok" && characters > 0, dropped: this.recorder.dropped, durationMs };
    return this.result;
  }

  private synthesize(response: AiResponse | undefined, error: unknown): AttemptReport[] {
    const failure = error instanceof AiProviderError ? error : undefined;
    const provider = failure?.provider ?? response?.provider ?? null;
    const model = failure?.model ?? response?.model ?? null;
    if (!provider && !model && !failure?.usage && !response) return [];
    return [{
      index: 1,
      textAttempt: this.recorder.textAttempts > 0 ? this.recorder.textAttempts : null,
      provider,
      model,
      integrationId: failure?.integrationId ?? response?.integrationId ?? null,
      endpoint: failure?.target?.endpoint ?? null,
      stream: false,
      tools: this.input.structured,
      firstByteMs: null,
      durationMs: this.now().getTime() - this.startedMs,
      outcome: failure ? outcomeOfError(failure) : "ok",
      finishReason: failure?.transport?.finishReason ?? null,
      reasoningCharacters: null,
      usage: failure?.usage ?? response?.usage ?? null,
      usageKnown: failure?.usageKnown ?? response?.usageKnown ?? null,
      cost: failure?.cost ?? response?.cost ?? null,
      costKnown: failure?.costKnown ?? response?.costKnown ?? null,
      currency: failure?.currency ?? response?.currency ?? null,
      transport: failure?.transport ?? null,
      error: failure ? errorOf(failure) : null,
      partialCharacters: failure?.partialText ? failure.partialText.length : null,
    }];
  }
}

/** The status of a call that ended with `error` (or none). An abort is `aborted`: the run stopped while the call was running. */
export function statusOf(error: unknown, aborted = false): Exclude<AiCallStatus, "running"> {
  if (!error) return "ok";
  if (aborted || isAbortError(error)) return "aborted";
  if (error instanceof AiStreamInterruptedError) return "interrupted";
  return "failed";
}

/** A stable hash of a schema (FNV-1a, 8 hex digits): what a record keeps of a structured reply's schema, never the schema itself. */
export function schemaHashOf(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function outcomeOfError(error: unknown): AiCallAttemptOutcome {
  if (isAbortError(error)) return "aborted";
  if (error instanceof AiStreamInterruptedError) return "interrupted";
  if (error instanceof AiProviderError && error.timedOut) return "timeout";
  return "failed";
}

function outcomeOfEnd(end: FetchAiAttemptEnd): AiCallAttemptOutcome {
  if (end.outcome === "ok") return "ok";
  if (end.outcome === "cancelled") return "aborted";
  if (end.failureKind === "timeout" || end.transport?.end === "timeout") return "timeout";
  if (end.transport?.end && end.transport.end !== "done") return "interrupted";
  return "failed";
}

function errorOf(error: unknown): AiCallError {
  const failure = error instanceof Error ? error : new Error(String(error));
  const provider = error instanceof AiProviderError ? error : undefined;
  return { name: failure.name, message: failure.message, status: provider?.status ?? null, transient: provider?.transient === true, timedOut: provider?.timedOut === true };
}

function reportOf(index: number, start: FetchAiAttempt, end: FetchAiAttemptEnd, textAttempt: number | null): AttemptReport {
  const outcome = outcomeOfEnd(end);
  const failed = end.outcome !== "ok";
  const transport: AiTransportDiagnostics | undefined = end.transport;
  return {
    index,
    textAttempt,
    provider: end.provider,
    model: end.model,
    integrationId: end.integrationId,
    endpoint: start.endpoint,
    stream: start.stream,
    tools: start.tools,
    firstByteMs: end.firstByteMs ?? null,
    durationMs: end.durationMs,
    outcome,
    finishReason: end.finishReason ?? null,
    reasoningCharacters: end.reasoningCharacters ?? null,
    usage: end.usage ?? null,
    usageKnown: end.usageKnown,
    cost: end.cost ?? null,
    costKnown: end.costKnown,
    currency: end.currency ?? null,
    transport: transport ?? null,
    error: failed
      ? {
          name: outcome === "interrupted" ? "AiStreamInterruptedError" : outcome === "timeout" ? "AiTimeoutError" : outcome === "aborted" ? "AbortError" : "AiProviderError",
          message: end.error ?? "",
          status: end.status ?? null,
          transient: end.failureKind === "timeout" || end.status === 429 || (end.status ?? 0) >= 500,
          timedOut: end.failureKind === "timeout",
        }
      : null,
    partialCharacters: failed ? end.replyCharacters ?? end.partialText?.length ?? null : null,
  };
}
