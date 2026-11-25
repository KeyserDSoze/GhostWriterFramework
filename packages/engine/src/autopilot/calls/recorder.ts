import type { AutopilotTaskKind, AutopilotTransportDetail } from "../types.js";
import { redactSecrets } from "../../ai/redact.js";
import type { AiCallStore } from "./port.js";
import { cutHead, endsWithHighSurrogate, suffixStart, utf8Length } from "./utf8.js";
import {
  AI_CALL_CHECKPOINT,
  AI_CALL_ERROR_CHARACTERS,
  AI_CALL_LIMITS,
  AI_CALLS_FORMAT_VERSION,
  aiCallIdOf,
  isSafeAiCallId,
  type AiCallAttempt,
  type AiCallEnd,
  type AiCallHost,
  type AiCallRecord,
  type AiCallRequestInfo,
  type AiCallSkip,
  type AiCallStatus,
  type AiCallTextInfo,
  type AiCallUsage,
} from "./types.js";

/** The live text stops this many characters short of the newest one until the next checkpoint, so a key split across two checkpoints is never kept. */
export const AI_CALL_HOLDBACK_CHARACTERS = 256;

/** The most writes waiting for the store. A live checkpoint is dropped (its text goes with the next one) when the queue is that long; the final write is always queued. */
export const AI_CALL_QUEUE_LIMIT = 8;

/** The clock and the timer of a recorder: injected in tests, the system's in a run. */
export interface AiCallClock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const SYSTEM_AI_CALL_CLOCK: AiCallClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** A provider attempt as the runner reports it at the end of the call: everything but the response's size, which the recorder measures. */
export type AiCallAttemptReport = Omit<AiCallAttempt, "text">;

/** What a recorder needs to start a call: its identity, its request as sent, and the secrets to keep out of it. */
export interface CallRecorderOptions {
  store: AiCallStore;
  bookId: string;
  accountScope: string | null;
  runId: string;
  activityId: string;
  seq: number;
  stepAttempt: number;
  task: AutopilotTaskKind;
  chapter: number | null;
  scene: number | null;
  label: string;
  capability: string;
  host: AiCallHost;
  system: string;
  user: string;
  request?: Partial<Omit<AiCallRequestInfo, "system" | "user">>;
  /** Known secret values (the keys of the integrations, the tokens): replaced in every string before it is written. */
  secrets?: readonly string[];
  clock?: AiCallClock;
  /** Called once per recorder with the first failure of a write. A recorder never throws a write failure into its caller. */
  onError?: (error: unknown) => void;
}

interface TextAttempt {
  number: number;
  latest: string;
  scannedJs: number;
  scannedBytes: number;
  sentJs: number;
  sentBytes: number;
  storedOffset: number;
  cap: number;
  headBytes: number;
  tailBytes: number;
  cut: boolean;
}

/** Strips the address of a URL to its origin; anything else is not an address and is dropped. */
function endpointOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;

function clip(text: string, characters: number): string {
  return text.length > characters ? text.slice(0, characters) : text;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The records of one AI call of an autopilot task. The runner creates one per `ai()` call and passes its `onText` to the client: the text it reports
 * is cumulative, and a shorter text starts a new provider attempt (after a fallback or a retry; `""` resets). The recorder turns it into writes:
 * the text that arrives is appended to the store every 2 seconds or 16 KiB, whichever comes first, and the rest at the end (`finish`).
 *
 * It never waits for the store and never throws a store failure into its caller: writes are queued in order, a live checkpoint is dropped when the
 * queue is full (the next one carries its text), the final writes always queue, and the first failure of the call is reported once through
 * `onError`. Every string is redacted with `redactSecrets` and the secrets the caller gives, and URLs are cut to their origins before they are
 * kept. A response longer than its limit keeps its head and its end (`AI_CALL_LIMITS`); the bytes between them are dropped and the record says so.
 */
export class CallRecorder {
  /** The id of the call, as the store knows it. */
  readonly callId: string;
  private readonly store: AiCallStore;
  private readonly clock: AiCallClock;
  private readonly secrets: readonly string[];
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly startedAt: string;
  private readonly fixedBytes: number;
  private readonly fixedTruncated: boolean;
  private firstTextMs: number | null = null;
  private lastCheckpointMs: number;
  private timer: unknown = null;
  private attempt: TextAttempt | null = null;
  private attemptCount = 0;
  private responseBytes = 0;
  private truncated = false;
  private readonly infos = new Map<number, AiCallTextInfo>();
  private inFlight = 0;
  private chain: Promise<void> = Promise.resolve();
  private reported = false;
  private closed = false;

  constructor(options: CallRecorderOptions) {
    this.callId = aiCallIdOf(options.activityId, options.seq);
    if (!isSafeAiCallId(this.callId)) throw new TypeError(`The activity id "${options.activityId}" cannot name a call.`);
    this.store = options.store;
    this.clock = options.clock ?? SYSTEM_AI_CALL_CLOCK;
    this.secrets = options.secrets ?? [];
    this.onError = options.onError;
    this.lastCheckpointMs = this.clock.now();
    this.startedAt = new Date(this.lastCheckpointMs).toISOString();

    const system = this.limitText(options.system, AI_CALL_LIMITS.maxSystemBytes);
    const user = this.limitText(options.user, AI_CALL_LIMITS.maxUserBytes);
    this.fixedBytes = system.info.storedBytes + user.info.storedBytes;
    this.fixedTruncated = system.info.truncated || user.info.truncated;
    const request = options.request ?? {};
    const record: AiCallRecord = {
      formatVersion: AI_CALLS_FORMAT_VERSION,
      callId: this.callId,
      bookId: options.bookId,
      accountScope: options.accountScope,
      runId: this.redact(options.runId),
      activityId: options.activityId,
      seq: options.seq,
      stepAttempt: options.stepAttempt,
      task: options.task,
      chapter: number(options.chapter),
      scene: number(options.scene),
      label: this.redact(options.label),
      capability: this.redact(options.capability),
      host: options.host,
      request: {
        system: system.info,
        user: user.info,
        images: request.images ?? 0,
        tool: request.tool == null ? null : this.redact(request.tool),
        toolSchemaHash: request.toolSchemaHash == null ? null : this.redact(request.toolSchemaHash),
        structured: request.structured ?? false,
        maxOutputTokens: number(request.maxOutputTokens),
        temperature: number(request.temperature),
      },
      status: "running",
      response: { text: null, partial: false },
      attempts: [],
      timing: { startedAt: this.startedAt, firstTextAt: null, endedAt: null },
      storedBytes: this.fixedBytes,
      dropped: this.fixedTruncated ? "limit" : null,
    };
    this.write(() => this.store.begin({ record, system: system.text, user: user.text }), true);
  }

  /**
   * Receives the cumulative text the client reports (the `onText` of the request). Never throws, and never waits: the text is kept in the recorder
   * until a checkpoint sends it.
   */
  onText(text: string): void {
    if (this.closed || typeof text !== "string") return;
    const current = this.attempt;
    if (current && text.length < current.latest.length) {
      this.finishAttempt(current, current.latest);
      this.attempt = null;
    }
    if (text.length === 0) return;
    const attempt = this.attempt ?? this.startAttempt();
    attempt.latest = text;
    if (this.firstTextMs === null) this.firstTextMs = this.clock.now();
    this.scan(attempt);
    if (attempt.cut || attempt.scannedBytes <= attempt.sentBytes) return;
    if (attempt.scannedBytes - attempt.sentBytes >= AI_CALL_CHECKPOINT.bytes || this.clock.now() - this.lastCheckpointMs >= AI_CALL_CHECKPOINT.intervalMs) this.checkpoint();
    else this.arm();
  }

  /**
   * Ends the call: the text not yet sent is written, and the call is ended with its status and its provider attempts. Never throws: the returned
   * promise settles when the store has taken the final writes (it never rejects; a failure was reported through `onError`). Calling it again does nothing.
   */
  finish(status: Exclude<AiCallStatus, "running">, attempts: readonly AiCallAttemptReport[]): Promise<void> {
    if (this.closed) return this.chain;
    this.closed = true;
    this.disarm();
    if (this.attempt) {
      this.finishAttempt(this.attempt, this.attempt.latest);
      this.attempt = null;
    }
    const last = this.attemptCount > 0 ? this.infos.get(this.attemptCount) ?? null : null;
    const end: AiCallEnd = {
      status,
      response: { text: last, partial: status !== "ok" && last !== null },
      attempts: attempts.map((attempt) => this.cleanAttempt(attempt)),
      timing: {
        startedAt: this.startedAt,
        firstTextAt: this.firstTextMs === null ? null : new Date(this.firstTextMs).toISOString(),
        endedAt: new Date(this.clock.now()).toISOString(),
      },
      storedBytes: this.fixedBytes + this.responseBytes,
      dropped: this.truncated || this.fixedTruncated ? "limit" : null,
    };
    const callId = this.callId;
    this.write(() => this.store.end(callId, end), true);
    return this.chain;
  }

  /** Resolves when every write queued so far has settled. Never rejects. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** The text attempts started so far: the number of the attempt the latest text belongs to (see `AiCallAttempt.textAttempt`). */
  get textAttempts(): number {
    return this.attemptCount;
  }

  /** The bytes kept so far by the call: its system and user, and the responses. Final after `finish`. */
  get storedBytes(): number {
    return this.fixedBytes + this.responseBytes;
  }

  /** The characters of the last text attempt, after `finish`; 0 when no text came. */
  get responseCharacters(): number {
    return this.attemptCount > 0 ? this.infos.get(this.attemptCount)?.characters ?? 0 : 0;
  }

  /** Why the call kept less than it was given, after `finish`: `limit` when a text was longer than its limit. */
  get dropped(): "limit" | null {
    return this.truncated || this.fixedTruncated ? "limit" : null;
  }

  private startAttempt(): TextAttempt {
    this.attemptCount += 1;
    const cap = Math.max(0, Math.min(AI_CALL_LIMITS.maxResponseBytes, AI_CALL_LIMITS.maxCallBytes - this.fixedBytes - this.responseBytes));
    const tailBytes = Math.min(AI_CALL_LIMITS.responseTailBytes, Math.floor(cap / 8));
    const attempt: TextAttempt = { number: this.attemptCount, latest: "", scannedJs: 0, scannedBytes: 0, sentJs: 0, sentBytes: 0, storedOffset: 0, cap, headBytes: cap - tailBytes, tailBytes, cut: false };
    this.attempt = attempt;
    return attempt;
  }

  /** Counts the bytes of the text that is whole: a trailing high surrogate waits for the low one that completes it. */
  private scan(attempt: TextAttempt): void {
    const text = attempt.latest;
    const end = endsWithHighSurrogate(text) ? text.length - 1 : text.length;
    if (end > attempt.scannedJs) {
      attempt.scannedBytes += utf8Length(text, attempt.scannedJs, end);
      attempt.scannedJs = end;
    }
  }

  /**
   * Sends the text of the attempt that is not yet sent, redacted, up to its head limit. A live send keeps its holdback and is refused (returns false)
   * when the queue is full; the final send takes everything and always queues.
   */
  private send(attempt: TextAttempt, final: boolean): boolean {
    if (attempt.cut) return true;
    if (!final && this.inFlight >= AI_CALL_QUEUE_LIMIT) return false;
    const text = attempt.latest;
    let end = text.length;
    if (!final) {
      end = Math.max(attempt.sentJs, text.length - AI_CALL_HOLDBACK_CHARACTERS);
      if (end > attempt.sentJs && endsWithHighSurrogate(text, end)) end -= 1;
    }
    if (end <= attempt.sentJs) return true;
    const remaining = attempt.headBytes - attempt.sentBytes;
    if (utf8Length(text, attempt.sentJs, end) > remaining) {
      end = cutHead(text, attempt.sentJs, remaining);
      attempt.cut = true;
    }
    if (end > attempt.sentJs) this.appendText(attempt, attempt.sentJs, end);
    return true;
  }

  /** Writes text[from, to) of the attempt, redacted, at the next stored offset. */
  private appendText(attempt: TextAttempt, from: number, to: number): void {
    const bytes = utf8Length(attempt.latest, from, to);
    attempt.sentBytes += bytes;
    attempt.sentJs = to;
    this.writeResponse(attempt, this.redact(attempt.latest.slice(from, to)));
  }

  private writeResponse(attempt: TextAttempt, stored: string): void {
    if (!stored) return;
    const offset = attempt.storedOffset;
    attempt.storedOffset += utf8Length(stored);
    const callId = this.callId;
    const number = attempt.number;
    this.write(() => this.store.append(callId, number, offset, stored), true);
  }

  /** Sends the rest of the attempt and settles its size: its head, then its end when the text was longer than its head. */
  private finishAttempt(attempt: TextAttempt, text: string): void {
    attempt.latest = text;
    this.scan(attempt);
    const total = attempt.scannedBytes + utf8Length(text, attempt.scannedJs);
    attempt.scannedJs = text.length;
    attempt.scannedBytes = total;
    this.send(attempt, true);
    let truncated = false;
    if (total > attempt.headBytes) {
      if (total > attempt.cap) {
        truncated = true;
        const start = Math.max(suffixStart(text, attempt.tailBytes), attempt.sentJs);
        if (start < text.length) this.writeResponse(attempt, this.redact(text.slice(start)));
      } else if (attempt.sentJs < text.length) {
        this.appendText(attempt, attempt.sentJs, text.length);
      }
    }
    if (truncated) this.truncated = true;
    this.responseBytes += attempt.storedOffset;
    this.infos.set(attempt.number, { characters: text.length, bytes: total, storedBytes: attempt.storedOffset, truncated });
  }

  private checkpoint(): void {
    this.disarm();
    const attempt = this.attempt;
    if (!attempt) return;
    if (this.send(attempt, false)) this.lastCheckpointMs = this.clock.now();
    else this.arm();
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      if (!this.closed) this.checkpoint();
    }, AI_CALL_CHECKPOINT.intervalMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  /** Queues a store operation behind the ones before it. Live writes are refused when the queue is full; the others always queue. */
  private write(operation: () => Promise<void>, critical: boolean): void {
    if (!critical && this.inFlight >= AI_CALL_QUEUE_LIMIT) return;
    this.inFlight += 1;
    this.chain = this.chain
      .then(operation)
      .catch((error: unknown) => this.report(error))
      .then(() => {
        this.inFlight -= 1;
      });
  }

  private report(error: unknown): void {
    if (this.reported) return;
    this.reported = true;
    try {
      this.onError?.(error);
    } catch {
      // A listener that throws is not the call's failure.
    }
  }

  private limitText(text: string, maxBytes: number): { text: string; info: AiCallTextInfo } {
    const bytes = utf8Length(text);
    const kept = bytes > maxBytes ? text.slice(0, cutHead(text, 0, maxBytes)) : text;
    const stored = this.redact(kept);
    return { text: stored, info: { characters: text.length, bytes, storedBytes: utf8Length(stored), truncated: bytes > maxBytes } };
  }

  /** Every string a record keeps goes through here: the known secrets and the keys that look like keys, then URLs cut to their origins. */
  private redact(text: string): string {
    return redactSecrets(text, this.secrets).replace(URL_PATTERN, (url) => endpointOrigin(url) ?? "[address]");
  }

  private short(value: string | null | undefined): string | null {
    return value == null ? null : clip(this.redact(String(value)), 200);
  }

  private cleanAttempt(attempt: AiCallAttemptReport): AiCallAttempt {
    const text = attempt.textAttempt === null ? null : this.infos.get(attempt.textAttempt) ?? null;
    const usage: AiCallUsage | null = attempt.usage
      ? { inputTokens: number(attempt.usage.inputTokens) ?? 0, outputTokens: number(attempt.usage.outputTokens) ?? 0, cachedInputTokens: number(attempt.usage.cachedInputTokens) ?? 0 }
      : null;
    return {
      index: attempt.index,
      textAttempt: attempt.textAttempt ?? null,
      text,
      provider: this.short(attempt.provider),
      model: this.short(attempt.model),
      integrationId: this.short(attempt.integrationId),
      endpoint: endpointOrigin(attempt.endpoint),
      stream: attempt.stream === true,
      tools: attempt.tools === true,
      firstByteMs: number(attempt.firstByteMs),
      durationMs: number(attempt.durationMs),
      outcome: attempt.outcome,
      finishReason: this.short(attempt.finishReason),
      reasoningCharacters: number(attempt.reasoningCharacters),
      usage,
      usageKnown: flag(attempt.usageKnown),
      cost: number(attempt.cost),
      costKnown: flag(attempt.costKnown),
      currency: this.short(attempt.currency),
      transport: this.cleanTransport(attempt.transport),
      error: attempt.error
        ? {
            name: this.short(attempt.error.name) ?? "Error",
            message: clip(this.redact(attempt.error.message ?? ""), AI_CALL_ERROR_CHARACTERS),
            status: number(attempt.error.status),
            transient: attempt.error.transient === true,
            timedOut: attempt.error.timedOut === true,
          }
        : null,
      partialCharacters: number(attempt.partialCharacters),
      ...(attempt.skip ? { skip: this.cleanSkip(attempt.skip) } : {}),
    };
  }

  private cleanSkip(skip: AiCallSkip): AiCallSkip {
    const promptTokens = number(skip.promptTokens);
    const windowTokens = number(skip.windowTokens);
    return {
      reason: skip.reason,
      ...(skip.why ? { why: skip.why } : {}),
      ...(promptTokens !== null ? { promptTokens } : {}),
      ...(windowTokens !== null ? { windowTokens } : {}),
    };
  }

  private cleanTransport(transport: AutopilotTransportDetail | null | undefined): AutopilotTransportDetail | null {
    if (!transport) return null;
    const out: Record<string, unknown> = {};
    for (const key of ["status", "bytes", "chunks", "events", "lastChunkAfterMs", "silentMs", "partialCharacters"] as const) {
      const value = number(transport[key]);
      if (value !== null) out[key] = value;
    }
    for (const key of ["usageReceived", "usageRequested"] as const) {
      const value = flag(transport[key]);
      if (value !== null) out[key] = value;
    }
    for (const key of ["end", "finishReason", "requestId"] as const) {
      const value = this.short(transport[key]);
      if (value !== null) out[key] = value;
    }
    if (transport.tail !== undefined) out.tail = clip(this.redact(transport.tail), 300);
    return out as AutopilotTransportDetail;
  }
}
