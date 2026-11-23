import type { AiCallField, AiCallTask, AiCallTaskPage } from "narrarium-engine";

/**
 * Where the pages read the records of the AI calls of a book's autopilot: what each call of a task sent (system and user) and what it answered, while
 * it streams and after. The engine defines the records and the port its hosts implement (`AiCallStore`); a page reads them through a `CallsSource`,
 * whatever keeps them: the store of this browser for a book that runs here (`localCallsSource`), the personal server for one that runs there
 * (`serverCallsSource`). `useCallsSource` picks the one of a book, or says why there is none.
 */

/** What a personal server announces in the `features` of `GET /api/v1/info` when it keeps the records of the AI calls and answers their routes. */
export const CALLS_SERVER_FEATURE = "autopilot-calls";

/**
 * Why the records of a book cannot be read here. Each is said to the author in words, never as an error:
 * - `server-outdated`: the personal server that runs the book does not announce `autopilot-calls` (it is older than the records): update it.
 * - `server-offline`: the personal server is not connected now; its records can be read once it is.
 * - `no-store`: this browser keeps no records (no IndexedDB, as in some private windows).
 * - `recording-off`: the author turned the recording off.
 * - `unwired`: this build does not read the records yet: nothing is shown.
 */
export type CallsUnavailableReason = "server-outdated" | "server-offline" | "no-store" | "recording-off" | "unwired";

/** A piece of the kept text of a call: from byte `from` to `next`, the end of what is kept now. `done` once the call has ended (the text is whole). */
export interface CallTextRead {
  text: string;
  from: number;
  next: number;
  done: boolean;
}

/** Which text of a call: the response of one provider attempt (`attempt`, from 1; the last one with text when omitted), read from byte `from`. */
export interface CallTextOptions {
  attempt?: number;
  from?: number;
}

/** A page of task headers, newest first; `before` is the `next` of the page before. */
export interface CallsPageOptions {
  before?: string;
  limit?: number;
}

export interface CallsSource {
  /** Whether the records can be read here; `reason` says why not. */
  readonly available: boolean;
  readonly reason: CallsUnavailableReason | null;
  /**
   * How often a view that is open asks again for a call that is still running, in milliseconds: once a second from a personal server, more often from
   * the store of this browser. A view asks only while it is open, and not while the page is hidden.
   */
  readonly pollMs: number;
  /** The recording is turned off for this book on this device: what was kept before is read as ever, but nothing more is kept, and the view says so. */
  readonly notRecording?: boolean;
  listTasks(bookId: string, page?: CallsPageOptions): Promise<AiCallTaskPage>;
  /** A task with its calls in order, or null when none was recorded for it (a step older than the records, or deleted). */
  readTask(bookId: string, activityId: string): Promise<AiCallTask | null>;
  /** The kept text of one field of a call from byte `from` (0 when omitted) to its end, or null when the call is not kept. */
  readText(bookId: string, callId: string, field: AiCallField, options?: CallTextOptions): Promise<CallTextRead | null>;
  /** Keeps a task (`pinned`) or lets it go: a kept task is never deleted to make room. */
  keep(bookId: string, activityId: string, pinned: boolean): Promise<void>;
  /** Deletes every record of the book, kept tasks included. */
  deleteAll(bookId: string): Promise<void>;
}

/** What a source that is not available answers to every question: the reason, never a record. */
export class CallsUnavailableError extends Error {
  constructor(readonly reason: CallsUnavailableReason) {
    super(`The records of the AI calls are not available here (${reason}).`);
    this.name = "CallsUnavailableError";
  }
}

/** The source of a book whose records cannot be read here: it says why, and refuses every question. */
export function unavailableCallsSource(reason: CallsUnavailableReason): CallsSource {
  const refuse = () => Promise.reject(new CallsUnavailableError(reason));
  return { available: false, reason, pollMs: 0, listTasks: refuse, readTask: refuse, readText: refuse, keep: refuse, deleteAll: refuse };
}

/** Whether a personal server keeps the records of the AI calls (it announces `autopilot-calls`). Never throws: an older server, or an odd answer, says no. */
export function serverKeepsCalls(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(CALLS_SERVER_FEATURE);
}
