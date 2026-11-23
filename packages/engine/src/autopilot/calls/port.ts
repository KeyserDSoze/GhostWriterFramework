import type { AiCallBegin, AiCallEnd, AiCallField, AiCallPruneResult, AiCallTask, AiCallTaskDraft, AiCallTaskPage, AiCallTextChunk, AiCallTotals } from "./types.js";

/**
 * The store of the AI call records, implemented by each host: the browser (IndexedDB, fenced by the account) and a personal server (its files,
 * outside git, trashed with its book). The engine's recorder writes through it; the pages read through it. The memory store
 * (`MemoryAiCallStore`) is the reference: a host's tests compare it with the host.
 *
 * Rules every host follows:
 * - Calls are identified by `callId` (`aiCallIdOf`), unique on the device or the server. A task is identified by `bookId` and `activityId`.
 * - Offsets and sizes are in bytes of UTF-8. A text is always written as whole characters; `readText` answers from a character boundary.
 * - Idempotent: a call that repeats a write (the same `begin`, `append` of the same bytes at the same offset, the same `end`, `keep`) leaves the
 *   store as one call left it. Out of order: the calls may arrive in any order. An `append` that arrives before its `begin` is kept until the
 *   call begins; an `end` before the appends is kept as the final state; an `append` after the `end` is still kept (its bytes are the text).
 *   A `saveTask` or `keep` for a task that holds no call yet creates it. A `begin` for a call already begun keeps the first one.
 * - Atomic: each method changes the store as a whole or not at all. A method that fails leaves the store as it was, and the caller may repeat it.
 * - Best effort: the recorder never waits for a write before it goes on, and reports the first failure of a run once. A host reports a failure
 *   by throwing it; a run is never stopped by it.
 * - A host short of disk (under `AI_CALL_BUDGETS.minFreeDiskBytes`, or a quota error from the browser) throws `AiCallDiskFullError` (or the
 *   browser's `QuotaExceededError`) and keeps what it has. It never deletes a pinned task to make room.
 * - Redaction: the strings the recorder gives are already redacted. A host may redact again, but it never stores a key, a header or a URL it was not given.
 * - A `begin` past the `maxCallsPerTask` call of its task is ignored: that call is not kept.
 */
/** A host that is short of disk refuses a write with this error: the store keeps what it has and the recorder reports it once per run. */
export class AiCallDiskFullError extends Error {
  constructor(message = "There is not enough free disk space to keep the AI calls of this book.") {
    super(message);
    this.name = "AiCallDiskFullError";
  }
}

export interface AiCallStore {
  /**
   * Starts a call: its record, its system and user texts. Creates the call's task when it has none yet (with the header the writer saves later).
   * Idempotent by `callId`: a second `begin` of a call is ignored.
   */
  begin(begin: AiCallBegin): Promise<void>;

  /**
   * Writes `text` into the response of the call's provider attempt `attempt` (from 1), at byte `offset` of that response. The bytes at
   * `[offset, offset + length)` become `text`; bytes that are already there with the same content are left as they are. Writes may come in any
   * order: the response is the bytes at each offset. Empty text is a no-op.
   */
  append(callId: string, attempt: number, offset: number, text: string): Promise<void>;

  /**
   * Ends a call with its final state: status, times, attempts, the response's size, `dropped`. It replaces the call's state (the texts stay).
   * Idempotent: the last `end` of a call is the state it keeps.
   */
  end(callId: string, final: AiCallEnd): Promise<void>;

  /**
   * Writes the header of a task (its title, kind, status, times). Creates the task when it has no calls yet. The header's `pinned`, `calls`
   * and `bytes` are kept by the store: a draft does not carry them.
   */
  saveTask(draft: AiCallTaskDraft): Promise<void>;

  /**
   * The task headers of a book, newest first, `limit` at a time (at most 200). `before` is the `next` of the previous page; omit it for the first.
   * A task with no header (only calls) is listed with the title, kind and times of its first call, and status `running` until its header lands.
   */
  listTasks(bookId: string, page: { before?: string; limit: number }): Promise<AiCallTaskPage>;

  /** A task with its calls in order of `seq`, or null when the book holds no such task. */
  readTask(bookId: string, activityId: string): Promise<AiCallTask | null>;

  /**
   * The kept text of a call's field from byte `from`, to its end. `attempt` is the response's attempt (from 1; for a response, the last one
   * with text when it is omitted; ignored for the system and the user). `from` rounds down to a character boundary: the answer's `from` says where
   * the text starts. Null when the call is not kept.
   */
  readText(bookId: string, callId: string, field: AiCallField, from: number, attempt?: number): Promise<AiCallTextChunk | null>;

  /** Pins (`true`) or unpins a task: a pinned task is never dropped by `prune`, but it counts against the budget. */
  keep(bookId: string, activityId: string, pinned: boolean): Promise<void>;

  /** Removes every call and task of the book. A pinned task goes too: this is the author's choice. */
  deleteBook(bookId: string): Promise<void>;

  /**
   * Drops whole tasks, oldest first, until the book keeps at most `budget` bytes. Pinned tasks and the running task are never dropped. It is the
   * retention policy of `planRetention`; a host calls it after each task.
   */
  prune(bookId: string, budget: number): Promise<AiCallPruneResult>;

  /** What the book keeps: its bytes, tasks and calls, and what its pinned tasks keep. Answered from running totals, not by reading the texts. */
  totals(bookId: string): Promise<AiCallTotals>;
}
