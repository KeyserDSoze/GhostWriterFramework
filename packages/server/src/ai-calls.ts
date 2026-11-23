import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import {
  AI_CALL_BUDGETS,
  AI_CALL_LIMITS,
  AiCallDiskFullError,
  isSafeAiCallId,
  planRetention,
  redactSecrets,
  type AiCallBegin,
  type AiCallEnd,
  type AiCallField,
  type AiCallPruneResult,
  type AiCallRecord,
  type AiCallStore,
  type AiCallTask,
  type AiCallTaskDraft,
  type AiCallTaskHeader,
  type AiCallTaskPage,
  type AiCallTextChunk,
  type AiCallTotals,
} from "narrarium-engine";
import { atomicJson, atomicWrite, readJson, renameReplacing } from "./files.js";
import { KeyedMutex } from "./fs-store.js";

/**
 * The AI call records of a personal server: what the autopilot sent to the AI as the system and the user message, what came back (also while it streams, and halfway when it stopped), and what
 * each provider attempt did, kept in `books/<id>/ai-calls/` beside the book's working copy and never in it. Nothing here is committed, pushed or synced by the server: the records hold the
 * book's text, its notes and what the author told the director. The folders are private (0700) and so are the files (0600); the folder goes to the trash with its book (see `DataDirectory`).
 *
 *   tasks/YYYY/MM/DD/<activityId>.json     a task: its header, its pin, the records of its calls and the size of each text (written whole, atomically, at every change of a call or of the task)
 *   live/<callId>.<attempt>.response.txt   the response of a call that is still streaming: the bytes at their offsets, appended as they come (no sync per write)
 *   texts/<callId>.<attempt>.<field>.txt.gz the texts of a call, gzipped: the system and the user message (attempt 0) when the call begins, a response when the call ends
 *   totals.json                            what the book keeps (bytes, tasks, calls, pins), so that the admin panel and the budget never read the texts
 *
 * Writes set the bytes at their offsets, so a repeat, or any order, leaves the same text; a text is always whole characters. A server that stopped in the middle of a call finds its text in
 * `live/`: it is folded into `texts/`, the call is marked `interrupted` with its text partial, and its task `stopped`, the next time the book is opened. The budget is in bytes of text (the
 * files are smaller: gzip): over it, whole tasks go, oldest first, when a task ends; the pinned ones and the one that runs never. Under `minFreeDiskBytes` of free disk nothing is written.
 */

export const AI_CALLS_DIRECTORY = "ai-calls";

const KIB = 1024;
const MIB = 1024 * KIB;
/** The longest text of one field that is ever read or written (a response is at most 2 MiB and a call at most 4 MiB: this is twice that, for the day the limits grow). */
export const AI_CALL_FIELD_MAX_BYTES = 2 * AI_CALL_LIMITS.maxCallBytes;
/** The responses of one call: the recorder numbers its provider attempts from 1; far more than a run ever makes. */
const MAX_ATTEMPT = 256;
const MAX_TASK_FILE_BYTES = 16 * MIB;
const MAX_TOTALS_FILE_BYTES = 64 * KIB;
const MAX_GZ_FILE_BYTES = AI_CALL_FIELD_MAX_BYTES + MIB;
/** Task bodies kept in memory per book (the ones with a call that is not over are never let go). */
const MAX_BODIES = 8;
/** Calls whose book is known without reading the disk. */
const MAX_REFS = 8192;
/** Writes that arrive before the `begin` of their call wait for it: this many calls, this many bytes. */
const MAX_ORPHAN_CALLS = 256;
const MAX_ORPHAN_BYTES = 8 * MIB;
const READ_CONCURRENCY = 16;
const TOTALS_DELAY_MS = 1500;
const LOW_DISK_LOG_MS = 10 * 60_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const REDACTED = "[redacted]";
const MIN_SECRET_LENGTH = 6;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface FileAiCallStoreOptions {
  /** The folder of a book's records (`books/<id>/ai-calls`): the host decides it, and refuses an id that is not a book's. */
  directory: (bookId: string) => string;
  /** The secrets this server knows for a book (the keys of its AI integrations, its GitHub token): kept out of every text and record, as the recorder keeps its own out. */
  secrets?: (bookId: string) => readonly string[] | Promise<readonly string[]>;
  /** Bytes of text a book keeps at most (default `AI_CALL_BUDGETS.serverPerBookBytes`, 2 GiB). */
  budgetBytes?: number;
  /** Free disk under which nothing is written (default `AI_CALL_BUDGETS.minFreeDiskBytes`, 1 GiB; 0 turns the check off). */
  minFreeDiskBytes?: number;
  /** The free bytes of the file system a folder is on (default: what the system says; `undefined`: not known, which allows the write). Tests say what the computer would. */
  freeDiskBytes?: (directory: string) => Promise<number | undefined> | number | undefined;
  /** Calls kept for one task (default `AI_CALL_LIMITS.maxCallsPerTask`, 64). */
  maxCallsPerTask?: number;
  /** The owner's switch, asked at every write (default: on). While it says no, `begin`, `append`, `end` and `saveTask` do nothing and say nothing; reads, `keep`, `prune` and `deleteBook` go on. */
  enabled?: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Why the records of a book could not be written: no room (the disk is under the floor, or full), or any other failure of the files. */
export type AiCallFailureKind = "disk" | "error";

/** The last failure of the writes of a book's records since this process started, and when. */
export interface AiCallFailure {
  bookId: string;
  kind: AiCallFailureKind;
  at: string;
}

/** The disk is under the floor the records keep free: how much is free, and how much must be. */
export interface AiCallDiskHold {
  freeBytes: number;
  minFreeBytes: number;
}

/**
 * What a write of the records that failed (not for want of room) is told as: its words say what failed by its code and never where (a path of this computer is not for the clients that read the run's
 * feed, which carries what the engine says of the failure). What the files said, with the path, is in the server's log.
 */
export class AiCallStoreError extends Error {
  constructor(readonly code: string) {
    super(`The AI call records could not be written (${code}).`);
    this.name = "AiCallStoreError";
  }
}

/** What `readText` answers: the chunk of the port, and which response it came from (the last one with text when the caller named none; null for the system and the user message). */
export interface FileAiCallTextChunk extends AiCallTextChunk {
  attempt: number | null;
}

/** How much of each text a call keeps. A response is told by its attempt number, from 1. */
interface Sizes {
  system: number;
  user: number;
  responses: Record<string, number>;
}

/** A task as its file holds it. */
interface TaskFile {
  version: 1;
  activityId: string;
  header: AiCallTaskDraft | null;
  pinned: boolean;
  /** The key the task is listed by (`startedAt|activityId`): the earliest of its header's and its calls' start. */
  startedAt: string;
  first: { task: AiCallRecord["task"]; chapter: number | null; scene: number | null } | null;
  calls: AiCallRecord[];
  sizes: Record<string, Sizes>;
}

/** A task as the index of a book knows it: everything but the records. */
interface TaskEntry {
  activityId: string;
  /** Where the task's file is, relative to the folder of the book. */
  file: string;
  draft: AiCallTaskDraft | null;
  pinned: boolean;
  startedAt: string;
  first: TaskFile["first"];
  callIds: Set<string>;
  bytes: number;
}

/** A call of this process that has not ended: its response is in `live/`, and its attempts' sizes are kept here. */
interface OpenCall {
  activityId: string;
  responses: Map<number, number>;
}

interface BookState {
  readonly bookId: string;
  readonly dir: string;
  loaded: boolean;
  dirsReady: boolean;
  tasks: Map<string, TaskEntry>;
  /** The task of each call the book keeps. */
  callTask: Map<string, string>;
  bytes: number;
  calls: number;
  bodies: Map<string, TaskFile>;
  open: Map<string, OpenCall>;
  /** Calls whose writes are ignored: the ones past the cap of their task, and the ones that were open when the book's records were deleted. */
  refused: Set<string>;
  /** What `totals.json` said before the book was loaded (a book nobody wrote to since the server started is told from it, without reading its tasks). */
  stored: AiCallTotals | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  written: string;
  lowDiskLoggedAt: number;
}

interface Orphan {
  appends: Array<{ attempt: number; offset: number; data: Buffer }>;
  bytes: number;
  end: AiCallEnd | undefined;
}

const EMPTY_TOTALS: AiCallTotals = { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 };

const copy = <T>(value: T): T => structuredClone(value);
const taskKey = (task: { startedAt: string; activityId: string }): string => `${task.startedAt}|${task.activityId}`;
const sizeOf = (sizes: Sizes): number => sizes.system + sizes.user + Object.values(sizes.responses).reduce((total, size) => total + size, 0);
const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A write that failed for want of room is the refusal the port defines; anything else is what it was. */
function asDiskFull(error: unknown): unknown {
  const code = errorCode(error);
  return code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG" ? new AiCallDiskFullError() : error;
}

function assertId(id: unknown, what: string): string {
  if (typeof id !== "string" || !isSafeAiCallId(id)) throw new TypeError(`The id of ${what} is 1 to 160 letters, digits, _ or -.`);
  return id;
}

function assertAttempt(attempt: unknown): number {
  if (!Number.isInteger(attempt) || (attempt as number) < 1) throw new RangeError("The attempt of a response starts at 1.");
  if ((attempt as number) > MAX_ATTEMPT) throw new RangeError(`A call keeps the responses of at most ${MAX_ATTEMPT} attempts.`);
  return attempt as number;
}

/** `YYYY/MM/DD` of an ISO time (digits only, so it can never leave the folder); of the clock when the time says nothing. */
function dayOf(startedAt: string, fallback: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(startedAt);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(fallback.getUTCFullYear(), 4)}/${pad(fallback.getUTCMonth() + 1)}/${pad(fallback.getUTCDate())}`;
}

/** Every string in a record goes through `redactSecrets` with the secrets this server knows. */
function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry, secrets);
    return out as T;
  }
  return value;
}

/**
 * The secrets this server knows, taken out of a text without changing its length in bytes (each is replaced by `[redacted]`, padded with `*`): the offsets of the writes that follow
 * were counted by the recorder over the text it sent, so a text that changed length here would leave a gap or an overlap in the response.
 */
function redactSameLength(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    const key = (secret ?? "").trim();
    if (key.length < MIN_SECRET_LENGTH) continue;
    for (const form of new Set([key, encodeURIComponent(key)])) {
      if (!output.includes(form)) continue;
      const width = Buffer.byteLength(form, "utf8");
      output = output.split(form).join(width >= REDACTED.length ? REDACTED + "*".repeat(width - REDACTED.length) : "*".repeat(width));
    }
  }
  return output;
}

/** How many bytes the UTF-8 character that starts with this byte has. */
function characterWidth(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  return (lead & 0xf8) === 0xf0 ? 4 : 1;
}

/**
 * The piece of a text a reader gets: from `from` rounded down to the start of its character, to `limit` bytes later cut back to the end of a whole character (and at least one character, so a
 * reader always moves on). `bytes` holds the text from absolute offset `base`; it must reach a few bytes before `from` and past the end of the piece.
 */
function sliceBounds(bytes: Uint8Array, base: number, size: number, from: number, limit: number): { start: number; end: number } {
  let start = Math.min(Math.max(0, from), size);
  while (start > base && start < size && isContinuation(bytes[start - base])) start -= 1;
  let end = Math.min(size, start + limit);
  if (end < size) while (end > start && isContinuation(bytes[end - base])) end -= 1;
  if (end <= start && start < size) end = Math.min(size, start + characterWidth(bytes[start - base]));
  return { start, end };
}

/** A regular file read whole, at most `max` bytes, never through a link; `undefined` when there is none. */
async function readFileBounded(file: string, max: number): Promise<Buffer | undefined> {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) throw new Error(`${path.basename(file)} is not a regular file or is too large.`);
  const handle = await fs.open(file, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${path.basename(file)} changed while it was read.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** `length` bytes of a regular file from `position` (fewer at its end); `undefined` when there is no file. */
async function readRange(file: string, position: number, length: number): Promise<{ bytes: Buffer; size: number } | undefined> {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${path.basename(file)} is not a regular file.`);
  const handle = await fs.open(file, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${path.basename(file)} changed while it was read.`);
    const wanted = Math.max(0, Math.min(length, opened.size - position));
    const bytes = Buffer.alloc(wanted);
    let done = 0;
    while (done < wanted) {
      const { bytesRead } = await handle.read(bytes, done, wanted - done, position + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return { bytes: bytes.subarray(0, done), size: opened.size };
  } finally {
    await handle.close();
  }
}

/** The free bytes of the file system a folder is on (the nearest folder that exists, when it is not made yet); `undefined` when the system does not say. */
export async function systemFreeBytes(directory: string): Promise<number | undefined> {
  let probe = directory;
  for (let step = 0; step < 8; step += 1) {
    try {
      const stats = await fs.statfs(probe);
      const free = Number(stats.bavail) * Number(stats.bsize);
      return Number.isFinite(free) ? free : undefined;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return undefined;
      const parent = path.dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
  return undefined;
}

/** A task file as the server wrote it; `undefined` for anything else (a damaged file, one that was edited, one of another task). */
function parseTaskFile(value: unknown, activityId: string): TaskFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || raw.activityId !== activityId || !Array.isArray(raw.calls) || typeof raw.startedAt !== "string") return undefined;
  const calls: AiCallRecord[] = [];
  const seen = new Set<string>();
  for (const entry of raw.calls) {
    const record = entry as Partial<AiCallRecord> | null;
    if (!record || typeof record !== "object" || typeof record.callId !== "string" || !isSafeAiCallId(record.callId) || record.activityId !== activityId || seen.has(record.callId)) return undefined;
    seen.add(record.callId);
    calls.push(record as AiCallRecord);
  }
  const sizes: Record<string, Sizes> = {};
  const rawSizes = raw.sizes && typeof raw.sizes === "object" ? (raw.sizes as Record<string, unknown>) : {};
  for (const call of calls) {
    const entry = rawSizes[call.callId] as Partial<Sizes> | undefined;
    const responses: Record<string, number> = {};
    for (const [attempt, size] of Object.entries(entry?.responses && typeof entry.responses === "object" ? entry.responses : {})) if (/^[1-9][0-9]{0,3}$/.test(attempt) && wholeNumber(size)) responses[attempt] = size;
    sizes[call.callId] = { system: wholeNumber(entry?.system) ? entry.system : 0, user: wholeNumber(entry?.user) ? entry.user : 0, responses };
  }
  const header = raw.header && typeof raw.header === "object" && typeof (raw.header as AiCallTaskDraft).activityId === "string" ? (raw.header as AiCallTaskDraft) : null;
  const first = raw.first && typeof raw.first === "object" ? (raw.first as TaskFile["first"]) : null;
  return { version: 1, activityId, header, pinned: raw.pinned === true, startedAt: raw.startedAt, first, calls, sizes };
}

function newBody(activityId: string): TaskFile {
  return { version: 1, activityId, header: null, pinned: false, startedAt: "", first: null, calls: [], sizes: {} };
}

/**
 * The `AiCallStore` of a personal server: the records of the AI calls of its autopilot runs, in files (see the top of this file). Every method behaves as the port documents it and as the
 * engine's `MemoryAiCallStore` does; the differences are the ones the disk brings: a write that cannot be done leaves the store as it was and throws (`AiCallDiskFullError` for want of room),
 * texts that were never written, or that a damaged file lost, read as empty, and `readText` takes a `limit`.
 */
export class FileAiCallStore implements AiCallStore {
  private readonly mutex = new KeyedMutex();
  private readonly books = new Map<string, BookState>();
  /** The book of each call this process began (the port's writes name the call and not the book). */
  private readonly refs = new Map<string, string>();
  private readonly orphans = new Map<string, Orphan>();
  private orphanBytes = 0;
  private readonly budget: number;
  private readonly minFree: number;
  private readonly maxCalls: number;
  private readonly now: () => Date;
  /** The last failure of each book's writes (`begin` and `append` clear it when they work again). */
  private readonly failed = new Map<string, AiCallFailure>();
  /** The writes that have begun and not settled: `close` waits for them (the engine does not wait for the writes of a run that ends, so the store does). */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** When the server's log last said that a book's records could not be written (at most every ten minutes for each). */
  private readonly failureLogged = new Map<string, number>();

  constructor(private readonly options: FileAiCallStoreOptions) {
    this.budget = options.budgetBytes ?? AI_CALL_BUDGETS.serverPerBookBytes;
    this.minFree = options.minFreeDiskBytes ?? AI_CALL_BUDGETS.minFreeDiskBytes;
    this.maxCalls = options.maxCallsPerTask ?? AI_CALL_LIMITS.maxCallsPerTask;
    this.now = options.now ?? (() => new Date());
  }

  // ---- the port

  async begin({ record, system, user }: AiCallBegin): Promise<void> {
    const callId = assertId(record?.callId, "a call");
    const activityId = assertId(record.activityId, "a task");
    if (typeof record.bookId !== "string" || typeof record.timing?.startedAt !== "string") throw new TypeError("A call's record names its book and says when it started.");
    if (this.off()) return;
    await this.tracked(record.bookId, true, () => this.exclusive(record.bookId, async (book) => {
      // Asked again in the book's turn: a switch that was turned off while this waited for it has cut what was open, and nothing may begin after that.
      if (this.off() || book.callTask.has(callId) || book.refused.has(callId)) return;
      await this.assertWritable(book);
      const existing = book.tasks.get(activityId);
      if (existing && existing.callIds.size >= this.maxCalls) {
        // Not kept, and what it writes next is let go (the writes find the book, and the book says no).
        book.refused.add(callId);
        this.remember(callId, book.bookId);
        this.dropOrphan(callId);
        return;
      }
      const secrets = await this.secretsOf(book.bookId);
      const kept: AiCallRecord = redactDeep(copy({ ...record, attempts: [], response: { text: null, partial: false } }), secrets);
      const systemBytes = Buffer.from(redactSecrets(typeof system === "string" ? system : "", secrets), "utf8");
      const userBytes = Buffer.from(redactSecrets(typeof user === "string" ? user : "", secrets), "utf8");
      await this.ensureDirs(book);
      const files = [this.textFile(book, callId, 0, "system"), this.textFile(book, callId, 0, "user")];
      try {
        await this.writeGz(files[0], systemBytes);
        await this.writeGz(files[1], userBytes);
        const entry = existing ?? this.makeEntry(activityId, record.timing.startedAt);
        const body = existing ? await this.body(book, entry) : newBody(activityId);
        const next: TaskFile = {
          ...body,
          startedAt: body.startedAt === "" || kept.timing.startedAt < body.startedAt ? kept.timing.startedAt : body.startedAt,
          first: body.first ?? { task: kept.task, chapter: kept.chapter, scene: kept.scene },
          calls: [...body.calls, kept],
          sizes: { ...body.sizes, [callId]: { system: systemBytes.length, user: userBytes.length, responses: {} } },
        };
        await this.persist(book, entry, next);
        entry.startedAt = next.startedAt;
        entry.first = next.first;
        entry.callIds.add(callId);
        entry.bytes += systemBytes.length + userBytes.length;
        book.tasks.set(activityId, entry);
        book.callTask.set(callId, activityId);
        book.calls += 1;
        book.bytes += systemBytes.length + userBytes.length;
        book.open.set(callId, { activityId, responses: new Map() });
        this.remember(callId, book.bookId);
      } catch (error) {
        for (const file of files) await fs.rm(file, { force: true }).catch(() => undefined);
        throw asDiskFull(error);
      }
      const orphan = this.takeOrphan(callId);
      for (const waiting of orphan?.appends ?? []) await this.writeResponse(book, callId, waiting.attempt, waiting.offset, waiting.data, secrets);
      if (orphan?.end) await this.finalize(book, callId, orphan.end);
      this.scheduleTotals(book);
    }));
  }

  async append(callId: string, attempt: number, offset: number, text: string): Promise<void> {
    assertAttempt(attempt);
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError("The offset of a text is a whole number of bytes, from 0.");
    if (!text) return;
    assertId(callId, "a call");
    const data = Buffer.from(text, "utf8");
    if (offset + data.length > AI_CALL_FIELD_MAX_BYTES) throw new RangeError(`A response keeps at most ${AI_CALL_FIELD_MAX_BYTES} bytes.`);
    if (this.off()) return;
    const bookId = this.refs.get(callId);
    if (bookId === undefined) {
      this.keepOrphan(callId, { attempt, offset, data });
      return;
    }
    await this.tracked(bookId, true, () => this.exclusive(bookId, async (book) => {
      if (this.off() || book.refused.has(callId) || !book.callTask.has(callId)) return;
      await this.assertWritable(book);
      await this.writeResponse(book, callId, attempt, offset, data, await this.secretsOf(bookId));
      this.scheduleTotals(book);
    }));
  }

  async end(callId: string, final: AiCallEnd): Promise<void> {
    assertId(callId, "a call");
    if (this.off()) return;
    const bookId = this.refs.get(callId);
    if (bookId === undefined) {
      this.keepOrphanEnd(callId, final);
      return;
    }
    await this.tracked(bookId, false, () => this.exclusive(bookId, async (book) => {
      if (this.off() || book.refused.has(callId) || !book.callTask.has(callId)) return;
      await this.finalize(book, callId, final);
      this.scheduleTotals(book);
    }));
  }

  async saveTask(draft: AiCallTaskDraft): Promise<void> {
    const activityId = assertId(draft?.activityId, "a task");
    if (typeof draft.bookId !== "string" || typeof draft.startedAt !== "string") throw new TypeError("A task's header names its book and says when it started.");
    if (this.off()) return;
    await this.tracked(draft.bookId, false, () => this.exclusive(draft.bookId, async (book) => {
      if (this.off()) return;
      // A task that is not kept yet is not started under the floor (nothing is written then); one that is can still be updated and ended: a few bytes.
      if (!book.tasks.has(activityId)) await this.assertWritable(book);
      await this.ensureDirs(book);
      const entry = book.tasks.get(activityId) ?? this.makeEntry(activityId, draft.startedAt);
      const body = book.tasks.has(activityId) ? await this.body(book, entry) : newBody(activityId);
      const kept = redactDeep(copy(draft), await this.secretsOf(book.bookId));
      await this.persist(book, entry, { ...body, header: kept, startedAt: kept.startedAt });
      entry.draft = kept;
      entry.startedAt = kept.startedAt;
      book.tasks.set(activityId, entry);
      // The task is over: what the book keeps is brought back to its budget, whole tasks at a time (a failure to do it never fails the write of the header).
      if (kept.status !== "running" && book.bytes > this.budget) await this.pruneLocked(book, this.budget).catch((error) => this.options.log?.(`The AI call records of ${book.bookId} could not be pruned: ${error instanceof Error ? error.message : String(error)}`));
      await this.writeTotals(book);
    }));
  }

  async listTasks(bookId: string, page: { before?: string; limit: number }): Promise<AiCallTaskPage> {
    return this.exclusive(bookId, async (book) => {
      const limit = Number.isFinite(page?.limit) ? Math.min(200, Math.max(1, Math.floor(page.limit))) : 20;
      let listed = [...book.tasks.values()].filter((task) => task.draft !== null || task.callIds.size > 0);
      listed.sort((left, right) => (taskKey(left) < taskKey(right) ? 1 : taskKey(left) > taskKey(right) ? -1 : 0));
      if (page?.before !== undefined) listed = listed.filter((task) => taskKey(task) < page.before!);
      const shown = listed.slice(0, limit);
      return { tasks: shown.map((task) => this.header(book, task)), next: shown.length < listed.length && shown.length > 0 ? taskKey(shown[shown.length - 1]) : null };
    });
  }

  async readTask(bookId: string, activityId: string): Promise<AiCallTask | null> {
    if (typeof activityId !== "string" || !isSafeAiCallId(activityId)) return null;
    return this.exclusive(bookId, async (book) => {
      const entry = book.tasks.get(activityId);
      if (!entry || (entry.draft === null && entry.callIds.size === 0)) return null;
      const body = await this.body(book, entry);
      return { header: this.header(book, entry), calls: body.calls.map((record) => copy(record)).sort((left, right) => left.seq - right.seq) };
    });
  }

  /**
   * The kept text of a call's field from byte `from`, decoded: the piece starts at the character that holds `from` and ends at the end of the text, or `limit` bytes later (cut at the end of a
   * character). `size` is how much is kept, and `complete` says that the call is over. Null when the call is not kept.
   */
  async readText(bookId: string, callId: string, field: AiCallField, from: number, attempt?: number, limit: number = AI_CALL_FIELD_MAX_BYTES): Promise<FileAiCallTextChunk | null> {
    if (typeof callId !== "string" || !isSafeAiCallId(callId) || (field !== "system" && field !== "user" && field !== "response")) return null;
    const start = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
    const max = Number.isFinite(limit) ? Math.max(1, Math.min(AI_CALL_FIELD_MAX_BYTES, Math.floor(limit))) : AI_CALL_FIELD_MAX_BYTES;
    return this.exclusive(bookId, async (book) => {
      const activityId = book.callTask.get(callId);
      if (activityId === undefined) return null;
      const open = book.open.get(callId);
      const complete = open === undefined;
      let chosen: number | null = null;
      let size = 0;
      if (field === "response") {
        const lengths = open ? open.responses : new Map(Object.entries((await this.body(book, book.tasks.get(activityId)!)).sizes[callId]?.responses ?? {}).map(([key, value]) => [Number(key), value] as const));
        if (attempt !== undefined) chosen = Number.isInteger(attempt) && attempt >= 1 ? attempt : null;
        else for (const [number, length] of lengths) if (length > 0 && (chosen === null || number > chosen)) chosen = number;
        size = chosen === null ? 0 : lengths.get(chosen) ?? 0;
        if (chosen === null || size === 0) return { text: "", from: 0, next: 0, size: 0, complete, attempt: chosen };
      }
      const slot = field === "response" ? (chosen as number) : 0;
      const live = this.liveFile(book, callId, slot);
      // A response that is still being written is read where it is; any other text is read from its gzip.
      if (field === "response" && (open?.responses.has(slot) ?? false)) {
        const base = Math.max(0, start - 3);
        const window = await readRange(live, base, max + 8 + (start - base)).catch(() => undefined);
        if (window) {
          const total = window.size;
          if (start >= total) return { text: "", from: total, next: total, size: total, complete, attempt: chosen };
          const { start: begin, end } = sliceBounds(window.bytes, base, total, start, max);
          return { text: window.bytes.subarray(begin - base, end - base).toString("utf8"), from: begin, next: end, size: total, complete, attempt: chosen };
        }
      }
      const whole = await this.readStored(book, callId, slot, field);
      const { start: begin, end } = sliceBounds(whole, 0, whole.length, start, max);
      return { text: whole.subarray(begin, end).toString("utf8"), from: begin, next: end, size: whole.length, complete, attempt: field === "response" ? chosen : null };
    });
  }

  async keep(bookId: string, activityId: string, pinned: boolean): Promise<void> {
    assertId(activityId, "a task");
    await this.exclusive(bookId, async (book) => {
      if (!book.tasks.has(activityId) && pinned !== true) return;
      const entry = book.tasks.get(activityId) ?? this.makeEntry(activityId, "");
      if (entry.pinned === (pinned === true) && book.tasks.has(activityId)) return;
      await this.ensureDirs(book);
      const body = book.tasks.has(activityId) ? await this.body(book, entry) : newBody(activityId);
      await this.persist(book, entry, { ...body, pinned: pinned === true });
      entry.pinned = pinned === true;
      book.tasks.set(activityId, entry);
      await this.writeTotals(book);
    });
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.mutex.run(bookId, async () => {
      this.failed.delete(bookId);
      const book = this.state(bookId);
      if (book.timer) clearTimeout(book.timer);
      book.timer = undefined;
      // A call that is still being written when the records are deleted is let go: what it writes next is ignored, and the next call of the task begins afresh.
      for (const callId of book.open.keys()) book.refused.add(callId);
      for (const [callId, owner] of this.refs) if (owner === bookId) this.refs.delete(callId);
      await fs.rm(book.dir, { recursive: true, force: true });
      this.reset(book);
      book.loaded = true;
    });
  }

  async prune(bookId: string, budget: number): Promise<AiCallPruneResult> {
    return this.tracked(bookId, false, () => this.exclusive(bookId, (book) => this.pruneLocked(book, budget)));
  }

  async totals(bookId: string): Promise<AiCallTotals> {
    const peek = this.state(bookId);
    if (peek.loaded) return this.compute(peek);
    if (peek.stored) return { ...peek.stored };
    // A book nobody has written to since the server started is told from `totals.json`, without reading its tasks.
    const stored = await this.readStoredTotals(peek.dir);
    if (stored) {
      if (!peek.loaded) peek.stored = stored;
      return { ...stored };
    }
    if (!(await this.exists(peek.dir))) return { ...EMPTY_TOTALS };
    return this.exclusive(bookId, async (book) => this.compute(book));
  }

  // ---- what the server needs besides the port

  /**
   * Lets go of what is in memory for a book whose records were moved away (to the trash with the book), without touching a file: the next access looks at the folder again (an empty one, unless
   * the owner put the records back). Calls that were open are forgotten.
   */
  async forget(bookId: string): Promise<void> {
    await this.mutex.run(bookId, async () => {
      this.failed.delete(bookId);
      const book = this.books.get(bookId);
      if (!book) return;
      if (book.timer) clearTimeout(book.timer);
      for (const callId of book.open.keys()) book.refused.add(callId);
      for (const [callId, owner] of this.refs) if (owner === bookId) this.refs.delete(callId);
      this.reset(book);
      book.loaded = false;
    });
  }

  /**
   * The owner turned recording off: every call that is still open is cut here, as a stop would have left it (its text so far is kept and readable, the call is `interrupted`, its task `stopped`),
   * and what the runs that go on write next is let go (the switch is asked at every write). A call that is cut is not written again, also when the switch is turned on again.
   */
  async interruptOpen(): Promise<void> {
    for (const book of [...this.books.values()]) {
      await this.mutex.run(book.bookId, () => this.cutOpen(book));
    }
  }

  /**
   * What is open in a book is cut where it is (in the book's turn): the calls that were being written are `interrupted` with the text they have, packed and readable, their tasks and every task that
   * still says `running` are `stopped`, and what the runs write for them next is let go. The engine stops recording for a run at the first failure of the store and never finishes what it had open,
   * and the owner's switch says the same by itself: nothing may be left saying it runs. A failure of the files in the middle of this is told in the log and is not another one.
   */
  private async cutOpen(book: BookState): Promise<void> {
    if (!book.loaded) return;
    const affected = new Set<string>();
    for (const open of book.open.values()) affected.add(open.activityId);
    for (const task of book.tasks.values()) if (task.draft?.status === "running") affected.add(task.activityId);
    if (!affected.size) return;
    const liveBy = new Map<string, number[]>();
    for (const [callId, open] of book.open) liveBy.set(callId, [...open.responses.keys()]);
    for (const activityId of affected) {
      const entry = book.tasks.get(activityId);
      if (!entry) continue;
      try {
        await this.settleTask(book, entry, await this.body(book, entry), liveBy);
      } catch (error) {
        this.options.log?.(`The AI call records of the task ${activityId} of ${book.bookId} could not be settled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const callId of book.open.keys()) book.refused.add(callId);
    book.open.clear();
    await this.writeTotals(book).catch(() => undefined);
  }

  /** The disk is under the floor the records keep free (`minFreeDiskBytes`): how much is free and how much must be; `undefined` when there is room, when the floor is off, or when the system does not say. */
  async diskHold(directory: string): Promise<AiCallDiskHold | undefined> {
    if (this.minFree <= 0) return undefined;
    const free = await (this.options.freeDiskBytes ?? systemFreeBytes)(directory);
    return free !== undefined && free < this.minFree ? { freeBytes: free, minFreeBytes: this.minFree } : undefined;
  }

  /** The books whose records could not be written, with the last failure of each since this process started (a book that was written to again is not in it). */
  failures(): AiCallFailure[] {
    return [...this.failed.values()].map((failure) => ({ ...failure }));
  }

  /**
   * Waits for the writes that are still on their way (a run that ends queues the end of its last call and the header of its task, and the engine does not wait for them: each is queued when the one
   * before it has landed, so the store looks again after a turn of the event loop), then writes the running totals of every book that has changes not yet written, and stops the timers.
   */
  async close(): Promise<void> {
    for (let quiet = 0, rounds = 0; quiet < 2 && rounds < 500; rounds += 1) {
      if (this.inFlight.size > 0) {
        await Promise.allSettled([...this.inFlight]);
        quiet = 0;
        continue;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.inFlight.size === 0) quiet += 1;
    }
    const pending = [...this.books.values()].filter((book) => book.timer !== undefined);
    for (const book of pending) {
      clearTimeout(book.timer);
      book.timer = undefined;
    }
    await Promise.all(pending.map((book) => this.mutex.run(book.bookId, () => this.writeTotals(book)).catch(() => undefined)));
  }

  // ---- the switch and the failures

  /** The owner's switch says no (a switch that fails to answer is on: records are not what a bug takes away). */
  private off(): boolean {
    try {
      return this.options.enabled?.() === false;
    } catch {
      return false;
    }
  }

  /**
   * Runs a write of a book's records and keeps the failure of it: no room (`AiCallDiskFullError`) or any other failure of the files, for the admin panel to say why. A write of the kind that
   * the floor refuses (`clears`: `begin` and `append`) that works again clears it. A request that is wrong in itself (a `TypeError` or a `RangeError`) is not a failure of the store.
   */
  private async tracked<T>(bookId: string, clears: boolean, action: () => Promise<T>): Promise<T> {
    const run = action();
    this.inFlight.add(run);
    try {
      const result = await run;
      if (clears) this.failed.delete(bookId);
      return result;
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw error;
      const full = error instanceof AiCallDiskFullError;
      this.failed.set(bookId, { bookId, kind: full ? "disk" : "error", at: this.now().toISOString() });
      // The engine stops recording a run at the first failure and never finishes what it had open: the book's open calls and running tasks are cut here, so that none is left saying it runs.
      const cut = this.mutex.run(bookId, async () => {
        const book = this.books.get(bookId);
        if (book) await this.cutOpen(book);
      }).catch(() => undefined);
      this.inFlight.add(cut);
      void cut.finally(() => this.inFlight.delete(cut));
      if (full) throw error;
      // What the files said (with the path) is for the server's log, once in a while; what is thrown, and so what the run's feed says, is the code of it.
      const at = Date.now();
      if (at - (this.failureLogged.get(bookId) ?? 0) > LOW_DISK_LOG_MS) {
        this.failureLogged.set(bookId, at);
        this.options.log?.(`The AI call records of ${bookId} could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new AiCallStoreError(errorCode(error) ?? "error");
    } finally {
      this.inFlight.delete(run);
    }
  }

  // ---- state of a book

  private state(bookId: string): BookState {
    let book = this.books.get(bookId);
    if (!book) {
      let dir: string;
      try {
        dir = this.options.directory(bookId);
      } catch (error) {
        // An id that is not a book's is a request that is wrong in itself, whatever the host called it.
        throw new TypeError(error instanceof Error ? error.message : "Invalid book id.");
      }
      book = { bookId, dir, loaded: false, dirsReady: false, tasks: new Map(), callTask: new Map(), bytes: 0, calls: 0, bodies: new Map(), open: new Map(), refused: new Set(), stored: undefined, timer: undefined, written: "", lowDiskLoggedAt: 0 };
      this.books.set(bookId, book);
    }
    return book;
  }

  private reset(book: BookState): void {
    book.tasks.clear();
    book.callTask.clear();
    book.bodies.clear();
    book.open.clear();
    book.bytes = 0;
    book.calls = 0;
    book.dirsReady = false;
    book.stored = undefined;
    book.written = "";
  }

  /** One thing at a time per book; the first one reads what is on the disk. */
  private exclusive<T>(bookId: string, action: (book: BookState) => Promise<T>): Promise<T> {
    return this.mutex.run(bookId, async () => {
      const book = this.state(bookId);
      if (!book.loaded) await this.load(book);
      return action(book);
    });
  }

  private compute(book: BookState): AiCallTotals {
    let tasks = 0;
    let pinnedTasks = 0;
    let pinnedBytes = 0;
    for (const task of book.tasks.values()) {
      if (task.draft === null && task.callIds.size === 0) continue;
      tasks += 1;
      if (!task.pinned) continue;
      pinnedTasks += 1;
      pinnedBytes += task.bytes;
    }
    return { bytes: book.bytes, tasks, calls: book.calls, pinnedTasks, pinnedBytes };
  }

  private header(book: BookState, task: TaskEntry): AiCallTaskHeader {
    if (task.draft) return { ...copy(task.draft), calls: task.callIds.size, bytes: task.bytes, pinned: task.pinned };
    return {
      bookId: book.bookId,
      activityId: task.activityId,
      title: "",
      kind: task.first?.task ?? "plan",
      chapter: task.first?.chapter ?? null,
      scene: task.first?.scene ?? null,
      status: "running",
      startedAt: task.startedAt,
      endedAt: null,
      calls: task.callIds.size,
      bytes: task.bytes,
      pinned: task.pinned,
    };
  }

  private makeEntry(activityId: string, startedAt: string): TaskEntry {
    return { activityId, file: `tasks/${dayOf(startedAt, this.now())}/${activityId}.json`, draft: null, pinned: false, startedAt: "", first: null, callIds: new Set(), bytes: 0 };
  }

  private textFile(book: BookState, callId: string, attempt: number, field: AiCallField): string {
    return path.join(book.dir, "texts", `${callId}.${attempt}.${field}.txt.gz`);
  }

  private liveFile(book: BookState, callId: string, attempt: number): string {
    return path.join(book.dir, "live", `${callId}.${attempt}.response.txt`);
  }

  private async exists(file: string): Promise<boolean> {
    return fs.lstat(file).then(() => true, () => false);
  }

  // ---- the disk

  /** The folders of a book, made when the first record is written: private, and real folders (a link in their place is refused). */
  private async ensureDirs(book: BookState): Promise<void> {
    if (book.dirsReady) return;
    for (const part of ["", "tasks", "live", "texts"]) {
      const directory = path.join(book.dir, part);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${part || AI_CALLS_DIRECTORY} is not a folder of this server.`);
    }
    book.dirsReady = true;
  }

  /** No write under `minFreeDiskBytes` of free disk: the store keeps what it has, says so once in a while, and refuses with the port's own error. */
  private async assertWritable(book: BookState): Promise<void> {
    if (this.minFree <= 0) return;
    const free = await (this.options.freeDiskBytes ?? systemFreeBytes)(book.dir);
    if (free === undefined || free >= this.minFree) return;
    const now = Date.now();
    if (now - book.lowDiskLoggedAt > LOW_DISK_LOG_MS) {
      book.lowDiskLoggedAt = now;
      this.options.log?.(`The AI calls of ${book.bookId} are not recorded: the disk has ${Math.floor(free / MIB)} MiB free, and ${Math.floor(this.minFree / MIB)} MiB are kept free.`);
    }
    throw new AiCallDiskFullError();
  }

  private async secretsOf(bookId: string): Promise<readonly string[]> {
    try {
      return (await this.options.secrets?.(bookId)) ?? [];
    } catch {
      return [];
    }
  }

  /** A gzipped text, written whole through a temporary file (no sync: it is derived from what the call said, and a text that a power cut lost reads as empty). */
  private async writeGz(file: string, data: Buffer): Promise<void> {
    const compressed = await gzip(data, { level: 5 });
    const temporary = `${file}.new-${randomUUID().slice(0, 8)}`;
    try {
      await fs.writeFile(temporary, compressed, { flag: "wx", mode: 0o600 });
      await renameReplacing(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw asDiskFull(error);
    }
  }

  /** A stored text, whole; an empty one when there is none or the file is damaged (a text is never what stops a read). */
  private async readStored(book: BookState, callId: string, attempt: number, field: AiCallField): Promise<Buffer> {
    const live = field === "response" ? await readFileBounded(this.liveFile(book, callId, attempt), AI_CALL_FIELD_MAX_BYTES).catch(() => undefined) : undefined;
    if (live) return live;
    try {
      const compressed = await readFileBounded(this.textFile(book, callId, attempt, field), MAX_GZ_FILE_BYTES);
      if (!compressed || compressed.length === 0) return Buffer.alloc(0);
      return await gunzip(compressed, { maxOutputLength: AI_CALL_FIELD_MAX_BYTES + 1 });
    } catch (error) {
      this.options.log?.(`A text of the AI call ${callId} of ${book.bookId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return Buffer.alloc(0);
    }
  }

  /** The body of a task: from memory when it was used lately, else from its file. */
  private async body(book: BookState, entry: TaskEntry): Promise<TaskFile> {
    const cached = book.bodies.get(entry.activityId);
    if (cached) {
      book.bodies.delete(entry.activityId);
      book.bodies.set(entry.activityId, cached);
      return cached;
    }
    const value = await readJson(path.join(book.dir, entry.file), MAX_TASK_FILE_BYTES);
    const body = parseTaskFile(value, entry.activityId) ?? (value === undefined ? newBody(entry.activityId) : undefined);
    if (!body) throw new Error(`The file of the task ${entry.activityId} is not a task of this server.`);
    this.cache(book, body);
    return body;
  }

  private cache(book: BookState, body: TaskFile): void {
    book.bodies.delete(body.activityId);
    book.bodies.set(body.activityId, body);
    for (const activityId of book.bodies.keys()) {
      if (book.bodies.size <= MAX_BODIES) break;
      const busy = [...book.open.values()].some((call) => call.activityId === activityId);
      if (!busy) book.bodies.delete(activityId);
    }
  }

  /** Writes a task's file, whole and atomically; only then is the body what the store holds. */
  private async persist(book: BookState, entry: TaskEntry, body: TaskFile): Promise<void> {
    try {
      await atomicWrite(path.join(book.dir, entry.file), JSON.stringify(body));
    } catch (error) {
      throw asDiskFull(error);
    }
    this.cache(book, body);
  }

  // ---- writing

  /** Sets the bytes of a response at their offset: in `live/` while the call runs, in the gzip when it has ended (a late write is still the text). */
  private async writeResponse(book: BookState, callId: string, attempt: number, offset: number, data: Buffer, secrets: readonly string[]): Promise<void> {
    const bytes = secrets.length ? Buffer.from(redactSameLength(data.toString("utf8"), secrets), "utf8") : data;
    const activityId = book.callTask.get(callId);
    const entry = activityId === undefined ? undefined : book.tasks.get(activityId);
    if (!entry || activityId === undefined) return;
    const open = book.open.get(callId);
    try {
      await this.ensureDirs(book);
      if (open) {
        const handle = await fs.open(this.liveFile(book, callId, attempt), constants.O_WRONLY | constants.O_CREAT | NO_FOLLOW, 0o600);
        try {
          // A write that is cut short (the disk filled up halfway) is not a text that was kept: it goes on until it is whole, or fails with the disk's own error.
          for (let written = 0; written < bytes.length;) {
            const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, offset + written);
            if (bytesWritten === 0) throw Object.assign(new Error("No more room to write the response."), { code: "ENOSPC" });
            written += bytesWritten;
          }
        } finally {
          await handle.close();
        }
        const before = open.responses.get(attempt) ?? 0;
        const after = Math.max(before, offset + bytes.length);
        open.responses.set(attempt, after);
        this.grow(book, entry, after - before);
        return;
      }
      // The call is over: its text is in a gzip; the bytes are put in it and it is written again, with the new size in the task's file.
      const body = await this.body(book, entry);
      const sizes = body.sizes[callId] ?? { system: 0, user: 0, responses: {} };
      const current = await this.readStored(book, callId, attempt, "response");
      const end = Math.max(current.length, offset + bytes.length);
      const next = Buffer.alloc(end);
      current.copy(next);
      bytes.copy(next, offset);
      const before = sizes.responses[String(attempt)] ?? 0;
      if (next.equals(current)) return;
      await this.writeGz(this.textFile(book, callId, attempt, "response"), next);
      // A response that was left in `live/` (a fold that failed) is in the gzip now, and `live/` is what a reader looks at first.
      await fs.rm(this.liveFile(book, callId, attempt), { force: true }).catch(() => undefined);
      const grown = Math.max(before, end);
      await this.persist(book, entry, { ...body, sizes: { ...body.sizes, [callId]: { ...sizes, responses: { ...sizes.responses, [String(attempt)]: grown } } } });
      this.grow(book, entry, grown - before);
    } catch (error) {
      throw asDiskFull(error);
    }
  }

  private grow(book: BookState, entry: TaskEntry, delta: number): void {
    entry.bytes += delta;
    book.bytes += delta;
  }

  /** Ends a call with its final state: the record is replaced, its texts stay (a response in `live/` is folded into its gzip). */
  private async finalize(book: BookState, callId: string, final: AiCallEnd): Promise<void> {
    const activityId = book.callTask.get(callId);
    const entry = activityId === undefined ? undefined : book.tasks.get(activityId);
    if (!entry || activityId === undefined) return;
    const body = await this.body(book, entry);
    const secrets = await this.secretsOf(book.bookId);
    const open = book.open.get(callId);
    const state = redactDeep(copy(final), secrets);
    const calls = body.calls.map((record) => (record.callId === callId ? { ...record, status: state.status, response: state.response, attempts: state.attempts, timing: state.timing, storedBytes: state.storedBytes, dropped: state.dropped } : record));
    const sizes = body.sizes[callId] ?? { system: 0, user: 0, responses: {} };
    const responses = open ? Object.fromEntries([...open.responses].map(([attempt, size]) => [String(attempt), size])) : sizes.responses;
    try {
      await this.persist(book, entry, { ...body, calls, sizes: { ...body.sizes, [callId]: { ...sizes, responses } } });
    } catch (error) {
      throw asDiskFull(error);
    }
    if (!open) return;
    book.open.delete(callId);
    await this.fold(book, callId, [...open.responses.keys()]);
  }

  /** The response of each attempt goes from `live/` into its gzip. A failure leaves the text in `live/`, where it is read and folded the next time. */
  private async fold(book: BookState, callId: string, attempts: readonly number[]): Promise<void> {
    for (const attempt of attempts) {
      try {
        const live = this.liveFile(book, callId, attempt);
        const data = await readFileBounded(live, AI_CALL_FIELD_MAX_BYTES);
        if (!data) continue;
        await this.writeGz(this.textFile(book, callId, attempt, "response"), data);
        await fs.rm(live, { force: true });
      } catch (error) {
        this.options.log?.(`The response of the AI call ${callId} of ${book.bookId} could not be packed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ---- retention

  private async pruneLocked(book: BookState, budget: number): Promise<AiCallPruneResult> {
    const plan = planRetention(
      [...book.tasks.values()].map((task) => ({ activityId: task.activityId, bytes: task.bytes, pinned: task.pinned, running: (task.draft?.status ?? "running") === "running", startedAt: task.startedAt })),
      budget,
    );
    const dropped: string[] = [];
    for (const activityId of plan.drop) {
      const entry = book.tasks.get(activityId);
      if (entry && (await this.dropTask(book, entry))) dropped.push(activityId);
    }
    if (dropped.length) await this.writeTotals(book);
    return { dropped, bytes: book.bytes, pinnedTasks: plan.pinnedTasks, pinnedBytes: plan.pinnedBytes, overBudget: book.bytes > budget };
  }

  /** A whole task: its file first (it is gone from the list at once), then its texts. A task whose file cannot be removed stays. */
  private async dropTask(book: BookState, entry: TaskEntry): Promise<boolean> {
    const body = await this.body(book, entry).catch(() => undefined);
    try {
      await fs.rm(path.join(book.dir, entry.file), { force: true });
    } catch (error) {
      this.options.log?.(`The AI call records of the task ${entry.activityId} of ${book.bookId} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    for (const callId of entry.callIds) {
      const sizes = body?.sizes[callId];
      const attempts = new Set<number>(Object.keys(sizes?.responses ?? {}).map(Number));
      const open = book.open.get(callId);
      for (const attempt of open?.responses.keys() ?? []) attempts.add(attempt);
      const files = [this.textFile(book, callId, 0, "system"), this.textFile(book, callId, 0, "user")];
      for (const attempt of attempts) files.push(this.textFile(book, callId, attempt, "response"), this.liveFile(book, callId, attempt));
      for (const file of files) await fs.rm(file, { force: true }).catch(() => undefined);
      book.callTask.delete(callId);
      book.open.delete(callId);
    }
    book.tasks.delete(entry.activityId);
    book.bodies.delete(entry.activityId);
    book.bytes -= entry.bytes;
    book.calls -= entry.callIds.size;
    await this.removeEmptyDays(book, entry.file);
    return true;
  }

  /** The folders of a day, a month and a year that have no task left go with the last one. */
  private async removeEmptyDays(book: BookState, file: string): Promise<void> {
    let directory = path.dirname(path.join(book.dir, file));
    const root = path.join(book.dir, "tasks");
    for (let step = 0; step < 3 && directory.startsWith(root + path.sep); step += 1) {
      try {
        await fs.rmdir(directory);
      } catch {
        return;
      }
      directory = path.dirname(directory);
    }
  }

  // ---- totals

  private scheduleTotals(book: BookState): void {
    if (book.timer) return;
    book.timer = setTimeout(() => {
      book.timer = undefined;
      void this.mutex.run(book.bookId, () => this.writeTotals(book)).catch(() => undefined);
    }, TOTALS_DELAY_MS);
    book.timer.unref?.();
  }

  private async writeTotals(book: BookState): Promise<void> {
    if (!book.loaded) return;
    const totals = this.compute(book);
    const text = JSON.stringify(totals);
    if (text === book.written) return;
    // A book with nothing and no folder is not given one.
    if (totals.bytes === 0 && totals.tasks === 0 && !(await this.exists(book.dir))) {
      book.written = text;
      return;
    }
    try {
      await atomicJson(path.join(book.dir, "totals.json"), { version: 1, ...totals, updatedAt: this.now().toISOString() });
      book.written = text;
    } catch (error) {
      // The same once-in-a-while rule as a failed write of the records: a folder that is broken fails every totals write too.
      const at = Date.now();
      if (at - (this.failureLogged.get(book.bookId) ?? 0) > LOW_DISK_LOG_MS) {
        this.failureLogged.set(book.bookId, at);
        this.options.log?.(`The totals of the AI call records of ${book.bookId} could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async readStoredTotals(dir: string): Promise<AiCallTotals | undefined> {
    try {
      const value = (await readJson(path.join(dir, "totals.json"), MAX_TOTALS_FILE_BYTES)) as Record<string, unknown> | undefined;
      if (!value || value.version !== 1 || !wholeNumber(value.bytes) || !wholeNumber(value.tasks) || !wholeNumber(value.calls) || !wholeNumber(value.pinnedTasks) || !wholeNumber(value.pinnedBytes)) return undefined;
      return { bytes: value.bytes, tasks: value.tasks, calls: value.calls, pinnedTasks: value.pinnedTasks, pinnedBytes: value.pinnedBytes };
    } catch {
      return undefined;
    }
  }

  // ---- calls that arrive before their `begin`

  private remember(callId: string, bookId: string): void {
    this.refs.delete(callId);
    this.refs.set(callId, bookId);
    for (const key of this.refs.keys()) {
      if (this.refs.size <= MAX_REFS) break;
      this.refs.delete(key);
    }
  }

  private orphanOf(callId: string): Orphan {
    let orphan = this.orphans.get(callId);
    if (!orphan) {
      orphan = { appends: [], bytes: 0, end: undefined };
      this.orphans.set(callId, orphan);
    }
    for (const key of this.orphans.keys()) {
      if (this.orphans.size <= MAX_ORPHAN_CALLS && this.orphanBytes <= MAX_ORPHAN_BYTES) break;
      if (key === callId) continue;
      this.dropOrphan(key);
    }
    return orphan;
  }

  private keepOrphan(callId: string, write: { attempt: number; offset: number; data: Buffer }): void {
    const orphan = this.orphanOf(callId);
    orphan.appends.push(write);
    orphan.bytes += write.data.length;
    this.orphanBytes += write.data.length;
  }

  private keepOrphanEnd(callId: string, final: AiCallEnd): void {
    this.orphanOf(callId).end = copy(final);
  }

  private dropOrphan(callId: string): void {
    const orphan = this.orphans.get(callId);
    if (!orphan) return;
    this.orphanBytes -= orphan.bytes;
    this.orphans.delete(callId);
  }

  private takeOrphan(callId: string): Orphan | undefined {
    const orphan = this.orphans.get(callId);
    if (orphan) this.dropOrphan(callId);
    return orphan;
  }

  // ---- reading a book from its folder

  /** Reads the tasks of a book (their headers and what they hold), settles what a stopped server left, and clears what no task owns. Once per book and process. */
  private async load(book: BookState): Promise<void> {
    const found: Array<{ entry: TaskEntry; body: TaskFile }> = [];
    let clean = true;
    const files = await this.taskFiles(book.dir);
    let next = 0;
    const read = async (): Promise<void> => {
      for (;;) {
        const at = next;
        next += 1;
        if (at >= files.length) return;
        const { relative, activityId } = files[at];
        try {
          const body = parseTaskFile(await readJson(path.join(book.dir, relative), MAX_TASK_FILE_BYTES), activityId);
          if (!body) {
            clean = false;
            this.options.log?.(`The file ${relative} of the AI call records of ${book.bookId} is not a task of this server: it is left as it is.`);
            continue;
          }
          found.push({ entry: this.entryOf(relative, body), body });
        } catch (error) {
          clean = false;
          this.options.log?.(`The file ${relative} of the AI call records of ${book.bookId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, Math.max(1, files.length)) }, read));
    const tasks = new Map<string, TaskEntry>();
    const callTask = new Map<string, string>();
    for (const { entry } of found.sort((left, right) => (left.entry.file < right.entry.file ? -1 : 1))) {
      if (tasks.has(entry.activityId)) continue;
      tasks.set(entry.activityId, entry);
      for (const callId of entry.callIds) callTask.set(callId, entry.activityId);
    }
    book.tasks = tasks;
    book.callTask = callTask;
    book.bytes = [...tasks.values()].reduce((total, task) => total + task.bytes, 0);
    book.calls = [...tasks.values()].reduce((total, task) => total + task.callIds.size, 0);
    book.stored = undefined;
    book.bodies.clear();
    book.loaded = true;
    await this.settle(book, found.filter(({ entry }) => tasks.get(entry.activityId) === entry).map(({ body }) => body), clean);
    this.scheduleTotals(book);
  }

  private entryOf(file: string, body: TaskFile): TaskEntry {
    const callIds = new Set(body.calls.map((record) => record.callId));
    let bytes = 0;
    for (const callId of callIds) bytes += sizeOf(body.sizes[callId] ?? { system: 0, user: 0, responses: {} });
    return { activityId: body.activityId, file, draft: body.header, pinned: body.pinned, startedAt: body.startedAt, first: body.first, callIds, bytes };
  }

  /** The task files of a book: `tasks/YYYY/MM/DD/<activityId>.json`, whatever else is in the folders is left alone. */
  private async taskFiles(dir: string): Promise<Array<{ relative: string; activityId: string }>> {
    const found: Array<{ relative: string; activityId: string }> = [];
    const list = async (directory: string, pattern: RegExp): Promise<string[]> => {
      try {
        return (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name);
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
        throw error;
      }
    };
    const root = path.join(dir, "tasks");
    for (const year of await list(root, /^\d{4}$/)) {
      for (const month of await list(path.join(root, year), /^\d{2}$/)) {
        for (const day of await list(path.join(root, year, month), /^\d{2}$/)) {
          const directory = path.join(root, year, month, day);
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const match = /^([A-Za-z0-9_-]{1,160})\.json$/.exec(entry.name);
            if (entry.isFile() && match) found.push({ relative: `tasks/${year}/${month}/${day}/${entry.name}`, activityId: match[1] });
          }
        }
      }
    }
    return found;
  }

  /**
   * What a server that stopped in the middle of a call leaves: a call whose record says `running` ends here as `interrupted`, its response (what `live/` holds) partial and packed, and its
   * task `stopped`; a response that was not packed yet is packed; and what no task owns (texts of a call whose task file never landed, a temporary file) is removed.
   */
  private async settle(book: BookState, bodies: readonly TaskFile[], clean: boolean): Promise<void> {
    let live: string[] = [];
    try {
      live = await fs.readdir(path.join(book.dir, "live"));
    } catch {
      // No folder: nothing was written.
    }
    const liveBy = new Map<string, number[]>();
    for (const name of live) {
      const match = /^([A-Za-z0-9_-]{1,160})\.([1-9][0-9]{0,3})\.response\.txt$/.exec(name);
      if (!match) continue;
      liveBy.set(match[1], [...(liveBy.get(match[1]) ?? []), Number(match[2])]);
    }
    for (const body of bodies) {
      const entry = book.tasks.get(body.activityId);
      if (!entry) continue;
      const interrupted = body.calls.filter((record) => record.status === "running");
      const stale = body.calls.filter((record) => record.status !== "running" && liveBy.has(record.callId));
      if (!interrupted.length && !stale.length && !(entry.draft === null ? body.calls.length > 0 : entry.draft.status === "running")) continue;
      try {
        await this.settleTask(book, entry, body, liveBy);
      } catch (error) {
        this.options.log?.(`The AI call records of the task ${body.activityId} of ${book.bookId} could not be settled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!clean) return;
    for (const folder of ["live", "texts"]) {
      let names: string[] = [];
      try {
        names = await fs.readdir(path.join(book.dir, folder));
      } catch {
        continue;
      }
      for (const name of names) {
        const callId = name.split(".")[0];
        if (book.callTask.has(callId) && !name.includes(".new-")) continue;
        await fs.rm(path.join(book.dir, folder, name), { force: true, recursive: false }).catch(() => undefined);
      }
    }
  }

  private async settleTask(book: BookState, entry: TaskEntry, body: TaskFile, liveBy: Map<string, number[]>): Promise<void> {
    let stoppedAt = "";
    const sizes: Record<string, Sizes> = { ...body.sizes };
    const calls: AiCallRecord[] = [];
    for (const record of body.calls) {
      const attempts = liveBy.get(record.callId) ?? [];
      let known = sizes[record.callId] ?? { system: 0, user: 0, responses: {} };
      let moment = "";
      if (attempts.length) {
        const responses = { ...known.responses };
        for (const attempt of attempts) {
          const file = this.liveFile(book, record.callId, attempt);
          const info = await fs.lstat(file).catch(() => undefined);
          if (!info?.isFile()) continue;
          responses[String(attempt)] = Math.max(responses[String(attempt)] ?? 0, info.size);
          if (info.mtime.toISOString() > moment) moment = info.mtime.toISOString();
        }
        known = { ...known, responses };
        sizes[record.callId] = known;
        await this.fold(book, record.callId, attempts);
      }
      if (record.status !== "running") {
        calls.push(record);
        continue;
      }
      let last = 0;
      for (const [attempt, size] of Object.entries(known.responses)) if (size > 0 && Number(attempt) > last) last = Number(attempt);
      let text: AiCallRecord["response"]["text"] = null;
      if (last > 0) {
        const bytes = await this.readStored(book, record.callId, last, "response");
        text = { characters: bytes.toString("utf8").length, bytes: bytes.length, storedBytes: bytes.length, truncated: false };
      }
      const endedAt = moment || this.now().toISOString();
      if (endedAt > stoppedAt) stoppedAt = endedAt;
      calls.push({ ...record, status: "interrupted", response: { text, partial: text !== null }, timing: { ...record.timing, endedAt }, storedBytes: sizeOf(known) });
    }
    const first = calls[0];
    const draft: AiCallTaskDraft | null = entry.draft && entry.draft.status !== "running"
      ? entry.draft
      : {
          ...(entry.draft ?? { bookId: book.bookId, activityId: entry.activityId, title: first?.label ?? "", kind: first?.task ?? "plan", chapter: first?.chapter ?? null, scene: first?.scene ?? null, startedAt: entry.startedAt }),
          status: "stopped",
          endedAt: stoppedAt || this.now().toISOString(),
        };
    const next: TaskFile = { ...body, header: draft, calls, sizes };
    await this.persist(book, entry, next);
    entry.draft = draft;
    entry.bytes = 0;
    for (const callId of entry.callIds) entry.bytes += sizeOf(sizes[callId] ?? { system: 0, user: 0, responses: {} });
    book.bytes = [...book.tasks.values()].reduce((total, task) => total + task.bytes, 0);
  }
}
