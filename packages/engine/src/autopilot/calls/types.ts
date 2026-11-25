import type { AiLeftOutReason, AiUnusableWhy } from "../../ai/types.js";
import type { AutopilotTaskKind, AutopilotTransportDetail } from "../types.js";

/**
 * The record of every AI call of an autopilot task: what was sent (system and user, as sent, images as a placeholder), what came back while it
 * streamed, and what each provider attempt did. The engine defines the shapes and the limits; hosts keep them (see `AiCallStore`, the port).
 * Sizes are in bytes of UTF-8 unless a name says characters. Times are ISO 8601 strings in UTC.
 */

/** The version of the format of a record. A host that reads a record of another version keeps it as it is and says so. */
export const AI_CALLS_FORMAT_VERSION = 1;

const KIB = 1024;
const MIB = 1024 * KIB;

/** The size limits of one call. The recorder enforces them; a host may store less but never more. */
export const AI_CALL_LIMITS = {
  /** The system message: the first bytes of it are kept, the rest is dropped (`truncated`). */
  maxSystemBytes: 1 * MIB,
  /** The user message: the first bytes of it are kept, the rest is dropped (`truncated`). */
  maxUserBytes: 1 * MIB,
  /** The response of one provider attempt: its head, and its last `responseTailBytes`, when it is longer. */
  maxResponseBytes: 2 * MIB,
  /** The end of a response longer than `maxResponseBytes` that is kept (at most an eighth of the limit). */
  responseTailBytes: 256 * KIB,
  /** Everything of one call (system, user and every attempt's response). */
  maxCallBytes: 4 * MIB,
  /** Calls kept for one task; a task that makes more keeps the first ones and says so in its header. */
  maxCallsPerTask: 64,
} as const;

/**
 * The budgets of the records, as data the hosts read. Budgets are per book unless a name says device. `minFreeDiskBytes` is the free disk a
 * personal server keeps before it writes a record: under it, a call is recorded without its texts and the server says so once.
 */
export const AI_CALL_BUDGETS = {
  browserPerBookBytes: 256 * MIB,
  browserPerDeviceBytes: 1024 * MIB,
  serverPerBookBytes: 2048 * MIB,
  minFreeDiskBytes: 1024 * MIB,
} as const;

/** When the recorder sends the text it has received while the answer streams: every 2 seconds or every 16 KiB, whichever comes first, and always at the end. */
export const AI_CALL_CHECKPOINT = {
  intervalMs: 2000,
  bytes: 16 * KIB,
} as const;

/** Where a call ran: in the browser (its IndexedDB) or on a personal server (its `books/<id>/ai-calls/`). */
export type AiCallHost = "browser" | "server";

/** The state of a call. `running` until it ends; the others are final. `partial` on the record says that its text stopped halfway. */
export type AiCallStatus = "running" | "ok" | "failed" | "interrupted" | "aborted";

/**
 * How one provider attempt ended. `timeout` is a deadline that ran out (`start`, `idle` or `total`). `skipped` is no attempt at all: a candidate of the route that the call did not ask,
 * with the reason in `skip` (it has no duration, no usage and no error).
 */
export type AiCallAttemptOutcome = "ok" | "failed" | "interrupted" | "aborted" | "timeout" | "skipped";

/** Why a candidate of the route was not asked, and the numbers that say it (see `AiRouteStep`). */
export interface AiCallSkip {
  reason: AiLeftOutReason;
  /** `unusable`: why the target the author wrote cannot be called. */
  why?: AiUnusableWhy;
  /** `context-window`: the tokens the prompt needs (as estimated before sending) and what the model's window leaves for it. */
  promptTokens?: number;
  windowTokens?: number;
}

/** The state of the task that holds calls. `stopped` is a task the author or the autopilot stopped. */
export type AiCallTaskStatus = "running" | "done" | "failed" | "stopped";

/** The field of a call whose text is kept: the system message, the user message, or the response of one provider attempt. */
export type AiCallField = "system" | "user" | "response";

/** Size and shape of one text, as it was given and as it is kept. `bytes` is the length of the original, `storedBytes` the length kept. */
export interface AiCallTextInfo {
  characters: number;
  bytes: number;
  storedBytes: number;
  truncated: boolean;
}

/** The request of a call, as sent. The texts themselves are kept by the store (`readText`), never in the record. */
export interface AiCallRequestInfo {
  system: AiCallTextInfo;
  user: AiCallTextInfo;
  /** The images sent with the user message (each one is a placeholder in `user`). */
  images: number;
  /** The name of the function that carried a structured reply, and a hash of its schema. */
  tool: string | null;
  toolSchemaHash: string | null;
  structured: boolean;
  /** The output limit asked for, and the temperature, when the call set them. */
  maxOutputTokens: number | null;
  temperature: number | null;
}

/** The response of a call: the text of its last provider attempt that had text, and whether it stopped halfway. */
export interface AiCallResponseInfo {
  text: AiCallTextInfo | null;
  partial: boolean;
}

/** Tokens of one provider attempt (the engine's usage, `usageKnown` says whether the provider reported them). */
export interface AiCallUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** A cleaned error of one provider attempt: its words are redacted and short, and it never carries a key or a URL. */
export interface AiCallError {
  name: string;
  /** At most `AI_CALL_ERROR_CHARACTERS` characters, redacted. */
  message: string;
  status: number | null;
  transient: boolean;
  timedOut: boolean;
}

/** The most characters of an error message that a record keeps. */
export const AI_CALL_ERROR_CHARACTERS = 500;

/**
 * One provider attempt of a call. The index is the attempt in order, from 1, counting the candidates of the route that were left out (`outcome` `skipped`, with `skip`)
 * in the place they have in the route. `textAttempt` says which response of the call holds its text (the
 * recorder numbers the responses it saw, from 1; an attempt with no text has none), and `text` is that response's size, filled by the recorder.
 * `endpoint` is the origin of the provider's address (`https://api.openai.com`), never a path, a query or a key. `reasoningCharacters` is the
 * count of the reasoning, never its words.
 */
export interface AiCallAttempt {
  index: number;
  textAttempt: number | null;
  text: AiCallTextInfo | null;
  provider: string | null;
  model: string | null;
  integrationId: string | null;
  endpoint: string | null;
  /** The API version the request carried (Azure OpenAI's `api-version`, or `v1`). Absent for a provider that has none, and from the records of an engine that did not say. */
  apiVersion?: string;
  stream: boolean;
  tools: boolean;
  firstByteMs: number | null;
  durationMs: number | null;
  outcome: AiCallAttemptOutcome;
  finishReason: string | null;
  reasoningCharacters: number | null;
  usage: AiCallUsage | null;
  usageKnown: boolean | null;
  cost: number | null;
  costKnown: boolean | null;
  currency: string | null;
  /** What the engine's client saw of the transport (its `transport` facts; the tail is cleaned of credentials). */
  transport: AutopilotTransportDetail | null;
  error: AiCallError | null;
  partialCharacters: number | null;
  /** For a candidate that was left out (`outcome` `skipped`): why. Absent from every attempt that was asked, and from the records of an engine that did not say. */
  skip?: AiCallSkip;
}

/** The times of a call. `firstTextAt` is null when no text arrived. */
export interface AiCallTiming {
  startedAt: string;
  firstTextAt: string | null;
  endedAt: string | null;
}

/**
 * One AI call of one task. Its identity is `callId`, unique on the device or the server: `aiCallIdOf(activityId, seq)`. `seq` counts the calls of the
 * task from 1, and `stepAttempt` counts the attempts of the step that made the call, from 1 (a retry of the step is a new activity, so it is 1 there).
 * `accountScope` is the account the book belongs to in the browser (the store fences its writes by it) and null on a server.
 * `storedBytes` is the size kept by the call: its system and user, and the responses of all its attempts.
 */
export interface AiCallRecord {
  formatVersion: number;
  callId: string;
  bookId: string;
  accountScope: string | null;
  runId: string;
  activityId: string;
  seq: number;
  stepAttempt: number;
  task: AutopilotTaskKind;
  chapter: number | null;
  scene: number | null;
  /** What the call is, in words (the label of the request). */
  label: string;
  /** The router capability of the call (`autopilot`, `review`...). */
  capability: string;
  host: AiCallHost;
  request: AiCallRequestInfo;
  status: AiCallStatus;
  response: AiCallResponseInfo;
  attempts: AiCallAttempt[];
  timing: AiCallTiming;
  storedBytes: number;
  /** Set when the call kept less than it was given: `limit` (a text was longer than its limit, so its head and end were kept) or `disk` (a host was short of disk). */
  dropped: AiCallDropReason | null;
}

/** Why a call kept less than it was given. */
export type AiCallDropReason = "limit" | "disk";

/**
 * The task that holds calls. It outlives the 200 activities of `autopilot/activity.json`: the hosts keep it with its calls. `calls` and `bytes`
 * are what the store holds for it (the store answers them; a writer does not set them). `pinned` is set by `keep`.
 */
export interface AiCallTaskHeader {
  bookId: string;
  activityId: string;
  title: string;
  kind: AutopilotTaskKind;
  chapter: number | null;
  scene: number | null;
  status: AiCallTaskStatus;
  startedAt: string;
  endedAt: string | null;
  calls: number;
  bytes: number;
  pinned: boolean;
}

/** What a writer gives for a task header: the header without the numbers the store keeps and the pin that `keep` sets. */
export type AiCallTaskDraft = Omit<AiCallTaskHeader, "calls" | "bytes" | "pinned">;

/** A call as the port receives it when it begins: its record, and the system and user texts as they are kept (already limited and redacted). */
export interface AiCallBegin {
  record: AiCallRecord;
  system: string;
  user: string;
}

/** What a call carries when it ends: its final status, times, attempts and sizes. Its texts were appended before. */
export type AiCallEnd = Pick<AiCallRecord, "status" | "response" | "attempts" | "timing" | "storedBytes" | "dropped">;

/** A task with its calls, in the order of `seq`. */
export interface AiCallTask {
  header: AiCallTaskHeader;
  calls: AiCallRecord[];
}

/** One page of task headers, newest first. `next` is the cursor of the next page, or null on the last one. */
export interface AiCallTaskPage {
  tasks: AiCallTaskHeader[];
  next: string | null;
}

/** A piece of kept text: from byte `from` to the end of what is kept (`size`), decoded. `complete` is true once the call has ended. */
export interface AiCallTextChunk {
  text: string;
  from: number;
  next: number;
  size: number;
  complete: boolean;
}

/** The totals of a book: what its calls keep, and what the pinned tasks keep. */
export interface AiCallTotals {
  bytes: number;
  tasks: number;
  calls: number;
  pinnedTasks: number;
  pinnedBytes: number;
}

/** What `prune` did: the tasks it dropped (oldest first) and what is kept now. `overBudget` is true when the pinned tasks alone exceed the budget. */
export interface AiCallPruneResult {
  dropped: string[];
  bytes: number;
  pinnedTasks: number;
  pinnedBytes: number;
  overBudget: boolean;
}

/**
 * The id of a call: its task's activity id and its number in the task, `activity_<uuid>-0003`. Only letters, digits, `_` and `-`, so a host can
 * use it in a file name.
 */
export function aiCallIdOf(activityId: string, seq: number): string {
  return `${activityId}-${String(seq).padStart(4, "0")}`;
}

/** Whether an id is safe to use as a file name and in a URL: 1 to 160 letters, digits, `_` or `-`. */
export function isSafeAiCallId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,160}$/.test(id);
}
