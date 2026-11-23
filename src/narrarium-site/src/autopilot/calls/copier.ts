import type { AiCallEnd, AiCallField, AiCallRecord, AiCallTask, AiCallTaskDraft, AiCallTaskHeader, AiCallTaskPage, ServerCallText } from "narrarium-engine";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import type { IndexedDbAiCallStore } from "@/autopilot/calls/store";

/**
 * When a book's autopilot runs on the personal server, the server keeps the records of its AI calls, and this browser keeps its own copy of the finished tasks:
 * the records are always on this device, whoever ran the book. The copier reads the server's records through the engine client (`ServerCallsApi`: the methods
 * that the server's feature `autopilot-calls` adds), and writes them into this browser's store, in small steps that give the page its turn between them.
 *
 * What it promises:
 * - only finished tasks are copied (a task that still runs is copied when it has finished);
 * - it is incremental: it remembers, for each book, up to which task everything is settled (copied, or not wanted), and a reload does not start over: what was
 *   copied is known from the store itself, and a task whose copy was cut in the middle has no header yet, so the next pass does it again from its start (the
 *   store's writes are idempotent);
 * - it stays within this device's budget: the newest tasks come first, each copy is followed by the retention of the store, and it stops when what it just
 *   copied is what the retention drops (the older ones would not stay either); a task bigger than the whole budget is not copied;
 * - it is fenced by the account: it copies for the account it was made for, and stops (`fenced`) when the page is in another.
 */

/**
 * What the copier reads of the server: the methods of the engine's client (`NarrariumServerClient`) that the server's feature `autopilot-calls` adds, with their own
 * names and signatures, so that the client itself is the API. `listCalls` answers a page of task headers `{ tasks, next }`, newest first; `readCallTask` a task with
 * its call records; `readCallText` a piece of a text (`ServerCallText`). The client answers a task or a call the server does not hold with a `ServerRequestError` of
 * status 404 (`call_task_not_found`, `call_not_found`): the copier takes it for «not there», as it does a `null`.
 */
export interface ServerCallsApi {
  /** Whether the server announces the records (`autopilot-calls`). Absent: the server is taken to announce them (the client asks, and says no with a 501 `feature_unavailable`). */
  available?(): boolean | Promise<boolean>;
  listCalls(bookId: string, page: { before?: string; limit?: number }): Promise<AiCallTaskPage>;
  readCallTask(bookId: string, activityId: string): Promise<AiCallTask | null>;
  readCallText(bookId: string, callId: string, options: { field: AiCallField; attempt?: number; from?: number; limit?: number }): Promise<ServerCallText | null>;
}

/** An answer of the server that says the thing asked for is not there (404): not a failure of the pass. */
function isNotThere(error: unknown): boolean {
  return error instanceof Error && (error as { status?: unknown }).status === 404;
}

/** A piece of a text, as the copier writes it: where it starts, what it says, and whether the text ends with it. */
interface TextPiece {
  text: string;
  from: number;
  next: number;
  done: boolean;
}

/** How a pass ended: `done` (everything the server has is settled), `unsupported` (no such feature), `fenced` (the account changed), `stopped`, or `failed` (the server or the store said no: the next pass starts from what was done). */
export type CopyState = "done" | "unsupported" | "fenced" | "stopped" | "failed";

export interface CopyReport {
  state: CopyState;
  /** The tasks copied by this pass, and the ones that were settled without a copy (already here, or not wanted: over the budget, or older than what the budget keeps). */
  copied: number;
  skipped: number;
  /** Up to which task, in the order of the task list, everything is settled now (`startedAt|activityId`), or null. */
  marker: string | null;
  error?: string;
}

export interface ServerCallsCopierOptions {
  /** The browser's store. The copier binds it to `identity`. */
  store: IndexedDbAiCallStore;
  api: ServerCallsApi;
  /** The account this copier works for. */
  identity: string;
  /** The account the page is in now (default: the site's). */
  currentIdentity?: () => string;
  /** How many task headers to ask for at a time (default 25). */
  pageSize?: number;
  /** Gives the page its turn: between tasks, between the calls of a task and between pages of the list (default: `scheduler.yield()`, else a macrotask). */
  yieldToUi?: () => Promise<void>;
}

class Fenced extends Error {
  constructor() {
    super("The AI calls were not copied: the account changed.");
    this.name = "AiCallsCopyFenced";
  }
}

class Stopped extends Error {
  constructor() {
    super("The copy of the AI calls was stopped.");
    this.name = "AiCallsCopyStopped";
  }
}

const noteKey = (bookId: string) => `copier:${bookId}`;
const taskKey = (task: { startedAt: string; activityId: string }) => `${task.startedAt}|${task.activityId}`;
const DEFAULT_PAGE_SIZE = 25;
/** A text is never read in more pieces than this: a server that never says it is done does not keep a pass going for ever. */
const MAX_TEXT_READS = 10_000;

/** Gives the page its turn. */
export function yieldToUi(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler && typeof scheduler.yield === "function") return scheduler.yield();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function draftOf(header: AiCallTaskHeader): AiCallTaskDraft {
  const { calls: _calls, bytes: _bytes, pinned: _pinned, ...draft } = header;
  return draft;
}

function endOf(call: AiCallRecord): AiCallEnd {
  return { status: call.status, response: call.response, attempts: call.attempts, timing: call.timing, storedBytes: call.storedBytes, dropped: call.dropped };
}

/** The numbers of the responses that have text, as the recorder numbered them. */
function responseAttempts(call: AiCallRecord): number[] {
  const numbers = new Set<number>();
  for (const attempt of call.attempts) if (attempt.textAttempt !== null && attempt.textAttempt >= 1) numbers.add(attempt.textAttempt);
  if (!numbers.size && call.response.text) numbers.add(1);
  return [...numbers].sort((left, right) => left - right);
}

export class ServerCallsCopier {
  private readonly store: IndexedDbAiCallStore;
  private api: ServerCallsApi;
  private readonly identity: string;
  private readonly currentIdentity: () => string;
  private readonly pageSize: number;
  private readonly yieldToUi: () => Promise<void>;
  private readonly running = new Map<string, Promise<CopyReport>>();
  private readonly again = new Set<string>();
  private stopped = false;

  constructor(options: ServerCallsCopierOptions) {
    this.identity = options.identity;
    this.store = options.store.bind(options.identity);
    this.api = options.api;
    this.currentIdentity = options.currentIdentity ?? currentRepositoryScopeIdentity;
    this.pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
    this.yieldToUi = options.yieldToUi ?? yieldToUi;
  }

  /** Ends the pass that is going on, at its next step, and refuses the ones that follow. */
  stop(): void {
    this.stopped = true;
  }

  /** Reads from another client of the same server from the next request on (the site builds a client for each connection it verifies). */
  useApi(api: ServerCallsApi): void {
    this.api = api;
  }

  /**
   * Copies what the server has finished for the book and this device has not settled. Called when the app opens and when a run ends (`reason` is for whoever reads
   * the report). A call that comes while a pass is going on does not start another one beside it: when that pass ends, one more runs, and both calls get the report of
   * the last. Never throws: how it went is in the report.
   */
  catchUp(bookId: string, _reason: "open" | "run-ended" = "open"): Promise<CopyReport> {
    const going = this.running.get(bookId);
    if (going) {
      this.again.add(bookId);
      return going;
    }
    const pass = (async () => {
      let report = await this.pass(bookId);
      // What finished while the pass went on is for one more pass, and it is a pass of its own, not a part of the last.
      while (this.again.delete(bookId) && report.state === "done" && !this.stopped) report = await this.pass(bookId);
      return report;
    })().finally(() => {
      this.running.delete(bookId);
      this.again.delete(bookId);
    });
    this.running.set(bookId, pass);
    return pass;
  }

  /** One book after the other: the books of the author that run on the server. */
  async catchUpBooks(bookIds: readonly string[], reason: "open" | "run-ended" = "open"): Promise<Map<string, CopyReport>> {
    const reports = new Map<string, CopyReport>();
    for (const bookId of bookIds) {
      reports.set(bookId, await this.catchUp(bookId, reason));
      await this.yieldToUi();
    }
    return reports;
  }

  private checkpoint(): void {
    if (this.stopped) throw new Stopped();
    if (this.currentIdentity() !== this.identity) throw new Fenced();
  }

  private async pass(bookId: string): Promise<CopyReport> {
    const report: CopyReport = { state: "done", copied: 0, skipped: 0, marker: null };
    try {
      this.checkpoint();
      if (this.api.available && !(await this.api.available())) return { ...report, state: "unsupported" };
      const marker = await this.store.notes.get(noteKey(bookId));
      report.marker = marker;
      const { perBookBytes } = (await this.store.status()).budgets;

      // What the server has that this device has not settled: its finished tasks newer than the marker, newest first; the ones that run are left for later.
      const finished: AiCallTaskHeader[] = [];
      const running: string[] = [];
      let before: string | undefined;
      scan: for (;;) {
        this.checkpoint();
        const page = await this.api.listCalls(bookId, { before, limit: this.pageSize });
        for (const task of page.tasks) {
          if (marker !== null && taskKey(task) <= marker) break scan;
          if (task.status === "running") running.push(taskKey(task));
          else finished.push(task);
        }
        if (!page.next) break;
        before = page.next;
        await this.yieldToUi();
      }

      for (const task of finished) {
        this.checkpoint();
        const here = await this.store.readTask(bookId, task.activityId);
        if ((here && here.header.status !== "running") || task.bytes > perBookBytes) {
          report.skipped += 1;
          continue;
        }
        await this.copyTask(bookId, task);
        report.copied += 1;
        // The retention of the store keeps the book within its budget: the oldest tasks go, and when it is the copy just made that goes, the older ones would go too.
        const kept = await this.store.enforceBudgets(bookId);
        if (kept.dropped.includes(task.activityId)) break;
        await this.yieldToUi();
      }

      // Everything finished that is older than the oldest task that still runs is settled now: the next pass starts after it.
      const ceiling = running.length ? running.reduce((least, key) => (key < least ? key : least)) : null;
      let newest: string | null = null;
      for (const task of finished) {
        const key = taskKey(task);
        if ((ceiling === null || key < ceiling) && (newest === null || key > newest)) newest = key;
      }
      if (newest !== null && (marker === null || newest > marker)) {
        await this.store.notes.set(noteKey(bookId), newest);
        report.marker = newest;
      }
      return report;
    } catch (error) {
      if (error instanceof Fenced) return { ...report, state: "fenced" };
      if (error instanceof Stopped) return { ...report, state: "stopped" };
      return { ...report, state: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Copies one task: its calls with their texts, then its header, which says that the task is here (a copy that was cut has none, and is done again). */
  private async copyTask(bookId: string, header: AiCallTaskHeader): Promise<void> {
    const task = await this.api.readCallTask(bookId, header.activityId).catch((error: unknown) => {
      if (isNotThere(error)) return null;
      throw error;
    });
    if (!task) return;
    for (const call of [...task.calls].sort((left, right) => left.seq - right.seq)) {
      this.checkpoint();
      let system = "";
      let user = "";
      await this.readText(bookId, call.callId, "system", undefined, (_from, text) => {
        system += text;
      });
      await this.readText(bookId, call.callId, "user", undefined, (_from, text) => {
        user += text;
      });
      await this.store.begin({ record: call, system, user });
      for (const attempt of responseAttempts(call)) {
        await this.readText(bookId, call.callId, "response", attempt, (from, text) => this.store.append(call.callId, attempt, from, text));
      }
      await this.store.end(call.callId, endOf(call));
      await this.yieldToUi();
    }
    this.checkpoint();
    await this.store.saveTask(draftOf(task.header));
  }

  /** Reads a text of a call from its start, piece by piece, and gives each piece to `sink` with the byte offset where it starts. */
  private async readText(bookId: string, callId: string, field: AiCallField, attempt: number | undefined, sink: (from: number, text: string) => void | Promise<void>): Promise<void> {
    let from = 0;
    for (let reads = 0; reads < MAX_TEXT_READS; reads += 1) {
      this.checkpoint();
      const piece: TextPiece | null = await this.api.readCallText(bookId, callId, { field, from, ...(attempt === undefined ? {} : { attempt }) }).catch((error: unknown) => {
        if (isNotThere(error)) return null;
        throw error;
      });
      if (!piece) return;
      if (piece.text) await sink(piece.from, piece.text);
      // A server that has nothing more, or that does not move on, ends the text.
      if (piece.done || piece.next <= from) return;
      from = piece.next;
    }
  }
}
