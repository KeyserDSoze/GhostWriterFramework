import type { AiCallStore } from "./port.js";
import { planRetention } from "./retention.js";
import {
  AI_CALL_LIMITS,
  type AiCallBegin,
  type AiCallEnd,
  type AiCallField,
  type AiCallPruneResult,
  type AiCallRecord,
  type AiCallTask,
  type AiCallTaskDraft,
  type AiCallTaskHeader,
  type AiCallTaskPage,
  type AiCallTextChunk,
  type AiCallTotals,
} from "./types.js";

/** A growing byte buffer: `length` is the end of what was written, the gaps before a late write are zeros until it arrives. */
interface Bytes {
  bytes: Uint8Array;
  length: number;
}

interface CallEntry {
  bookId: string;
  activityId: string;
  record: AiCallRecord;
  system: Bytes;
  user: Bytes;
  responses: Map<number, Bytes>;
  bytes: number;
  ended: boolean;
}

interface TaskEntry {
  bookId: string;
  activityId: string;
  draft: AiCallTaskDraft | null;
  pinned: boolean;
  callIds: Set<string>;
  bytes: number;
  startedAt: string;
  first: { task: AiCallRecord["task"]; chapter: number | null; scene: number | null } | null;
}

interface BookEntry {
  tasks: Map<string, TaskEntry>;
  bytes: number;
  calls: number;
}

interface Orphan {
  attempt: number;
  offset: number;
  data: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function emptyBytes(): Bytes {
  return { bytes: new Uint8Array(0), length: 0 };
}

function writeBytes(target: Bytes, offset: number, data: Uint8Array): void {
  const end = offset + data.length;
  if (end > target.bytes.length) {
    const grown = new Uint8Array(Math.max(end, target.bytes.length * 2, 64));
    grown.set(target.bytes.subarray(0, target.length));
    target.bytes = grown;
  }
  target.bytes.set(data, offset);
  target.length = Math.max(target.length, end);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function callBytes(entry: CallEntry): number {
  let total = entry.system.length + entry.user.length;
  for (const response of entry.responses.values()) total += response.length;
  return total;
}

/** The order of the task list: newest first, by start and then by id. */
function taskKey(task: { startedAt: string; activityId: string }): string {
  return `${task.startedAt}|${task.activityId}`;
}

/**
 * The reference `AiCallStore`: every method behaves as `AiCallStore` documents it, in memory. Hosts' tests compare their store with it, and the
 * recorder and the runner use it in tests. Writes out of order are kept (an `append` before its `begin` waits for it, an `end` is kept as the final
 * state), and a repeated write leaves the same state. The running totals are kept per book, so `totals` and `prune` do not read the texts.
 */
export class MemoryAiCallStore implements AiCallStore {
  private readonly books = new Map<string, BookEntry>();
  private readonly calls = new Map<string, CallEntry>();
  private readonly refused = new Set<string>();
  private readonly orphans = new Map<string, Orphan[]>();
  private readonly orphanEnds = new Map<string, AiCallEnd>();

  async begin({ record, system, user }: AiCallBegin): Promise<void> {
    if (this.calls.has(record.callId) || this.refused.has(record.callId)) return;
    const book = this.book(record.bookId);
    const task = this.task(book, record.bookId, record.activityId);
    if (task.callIds.size >= AI_CALL_LIMITS.maxCallsPerTask) {
      this.refused.add(record.callId);
      return;
    }
    const systemBytes = encoder.encode(system);
    const userBytes = encoder.encode(user);
    const entry: CallEntry = {
      bookId: record.bookId,
      activityId: record.activityId,
      record: copy({ ...record, attempts: [], response: { text: null, partial: false } }),
      system: { bytes: systemBytes, length: systemBytes.length },
      user: { bytes: userBytes, length: userBytes.length },
      responses: new Map(),
      bytes: 0,
      ended: false,
    };
    this.calls.set(record.callId, entry);
    task.callIds.add(record.callId);
    task.first ??= { task: record.task, chapter: record.chapter, scene: record.scene };
    if (record.timing.startedAt < task.startedAt || task.startedAt === "") task.startedAt = record.timing.startedAt;
    book.calls += 1;
    this.resize(entry);
    for (const orphan of this.orphans.get(record.callId) ?? []) this.write(entry, orphan.attempt, orphan.offset, orphan.data);
    this.orphans.delete(record.callId);
    const end = this.orphanEnds.get(record.callId);
    if (end) this.finalize(entry, end);
    this.orphanEnds.delete(record.callId);
  }

  async append(callId: string, attempt: number, offset: number, text: string): Promise<void> {
    if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("The attempt of a response starts at 1.");
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError("The offset of a text is a whole number of bytes, from 0.");
    if (!text) return;
    const data = encoder.encode(text);
    const entry = this.calls.get(callId);
    if (entry) {
      this.write(entry, attempt, offset, data);
      return;
    }
    if (this.refused.has(callId)) return;
    const waiting = this.orphans.get(callId) ?? [];
    waiting.push({ attempt, offset, data });
    this.orphans.set(callId, waiting);
  }

  async end(callId: string, final: AiCallEnd): Promise<void> {
    const entry = this.calls.get(callId);
    if (entry) {
      this.finalize(entry, final);
      return;
    }
    if (!this.refused.has(callId)) this.orphanEnds.set(callId, copy(final));
  }

  async saveTask(draft: AiCallTaskDraft): Promise<void> {
    const book = this.book(draft.bookId);
    const task = this.task(book, draft.bookId, draft.activityId);
    task.draft = copy(draft);
    task.startedAt = draft.startedAt;
  }

  async listTasks(bookId: string, page: { before?: string; limit: number }): Promise<AiCallTaskPage> {
    const book = this.books.get(bookId);
    const limit = Math.min(200, Math.max(1, Math.floor(page.limit)));
    if (!book) return { tasks: [], next: null };
    let listed = [...book.tasks.values()].filter((task) => task.draft !== null || task.callIds.size > 0);
    listed.sort((left, right) => (taskKey(left) < taskKey(right) ? 1 : taskKey(left) > taskKey(right) ? -1 : 0));
    if (page.before !== undefined) listed = listed.filter((task) => taskKey(task) < page.before!);
    const shown = listed.slice(0, limit);
    return {
      tasks: shown.map((task) => this.header(task)),
      next: shown.length < listed.length && shown.length > 0 ? taskKey(shown[shown.length - 1]) : null,
    };
  }

  async readTask(bookId: string, activityId: string): Promise<AiCallTask | null> {
    const task = this.books.get(bookId)?.tasks.get(activityId);
    if (!task || (task.draft === null && task.callIds.size === 0)) return null;
    const calls = [...task.callIds]
      .map((callId) => this.calls.get(callId)?.record)
      .filter((record): record is AiCallRecord => record !== undefined)
      .sort((left, right) => left.seq - right.seq)
      .map((record) => copy(record));
    return { header: this.header(task), calls };
  }

  async readText(bookId: string, callId: string, field: AiCallField, from: number, attempt?: number): Promise<AiCallTextChunk | null> {
    const entry = this.calls.get(callId);
    if (!entry || entry.bookId !== bookId) return null;
    const buffer = this.bufferOf(entry, field, attempt);
    const size = buffer.length;
    let start = Math.min(Math.max(0, Math.floor(from)), size);
    while (start > 0 && start < size && (buffer.bytes[start] & 0xc0) === 0x80) start -= 1;
    const text = decoder.decode(buffer.bytes.subarray(start, size));
    return { text, from: start, next: size, size, complete: entry.ended };
  }

  async keep(bookId: string, activityId: string, pinned: boolean): Promise<void> {
    const task = this.task(this.book(bookId), bookId, activityId);
    task.pinned = pinned;
  }

  async deleteBook(bookId: string): Promise<void> {
    const book = this.books.get(bookId);
    if (!book) return;
    for (const task of book.tasks.values()) for (const callId of task.callIds) this.calls.delete(callId);
    this.books.delete(bookId);
  }

  async prune(bookId: string, budget: number): Promise<AiCallPruneResult> {
    const book = this.book(bookId);
    const tasks = [...book.tasks.values()];
    const plan = planRetention(
      tasks.map((task) => ({ activityId: task.activityId, bytes: task.bytes, pinned: task.pinned, running: (task.draft?.status ?? "running") === "running", startedAt: task.startedAt })),
      budget,
    );
    for (const activityId of plan.drop) this.drop(book, activityId);
    return { dropped: plan.drop, bytes: book.bytes, pinnedTasks: plan.pinnedTasks, pinnedBytes: plan.pinnedBytes, overBudget: plan.overBudget };
  }

  async totals(bookId: string): Promise<AiCallTotals> {
    const book = this.books.get(bookId);
    if (!book) return { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 };
    let pinnedTasks = 0;
    let pinnedBytes = 0;
    let tasks = 0;
    for (const task of book.tasks.values()) {
      if (task.draft === null && task.callIds.size === 0) continue;
      tasks += 1;
      if (!task.pinned) continue;
      pinnedTasks += 1;
      pinnedBytes += task.bytes;
    }
    return { bytes: book.bytes, tasks, calls: book.calls, pinnedTasks, pinnedBytes };
  }

  private book(bookId: string): BookEntry {
    let book = this.books.get(bookId);
    if (!book) {
      book = { tasks: new Map(), bytes: 0, calls: 0 };
      this.books.set(bookId, book);
    }
    return book;
  }

  private task(book: BookEntry, bookId: string, activityId: string): TaskEntry {
    let task = book.tasks.get(activityId);
    if (!task) {
      task = { bookId, activityId, draft: null, pinned: false, callIds: new Set(), bytes: 0, startedAt: "", first: null };
      book.tasks.set(activityId, task);
    }
    return task;
  }

  private header(task: TaskEntry): AiCallTaskHeader {
    if (task.draft) return { ...task.draft, calls: task.callIds.size, bytes: task.bytes, pinned: task.pinned };
    return {
      bookId: task.bookId,
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

  private bufferOf(entry: CallEntry, field: AiCallField, attempt: number | undefined): Bytes {
    if (field === "system") return entry.system;
    if (field === "user") return entry.user;
    if (attempt !== undefined) return entry.responses.get(attempt) ?? emptyBytes();
    let chosen = emptyBytes();
    let chosenNumber = 0;
    for (const [number, buffer] of entry.responses) {
      if (buffer.length > 0 && number > chosenNumber) {
        chosen = buffer;
        chosenNumber = number;
      }
    }
    return chosen;
  }

  private write(entry: CallEntry, attempt: number, offset: number, data: Uint8Array): void {
    let buffer = entry.responses.get(attempt);
    if (!buffer) {
      buffer = emptyBytes();
      entry.responses.set(attempt, buffer);
    }
    writeBytes(buffer, offset, data);
    this.resize(entry);
  }

  private finalize(entry: CallEntry, final: AiCallEnd): void {
    entry.record = copy({ ...entry.record, status: final.status, response: final.response, attempts: final.attempts, timing: final.timing, storedBytes: final.storedBytes, dropped: final.dropped });
    entry.ended = true;
  }

  /** Brings the totals of the call, its task and its book up to the bytes the call keeps now. */
  private resize(entry: CallEntry): void {
    const book = this.books.get(entry.bookId);
    const task = book?.tasks.get(entry.activityId);
    if (!book || !task) return;
    const bytes = callBytes(entry);
    const delta = bytes - entry.bytes;
    entry.bytes = bytes;
    task.bytes += delta;
    book.bytes += delta;
  }

  private drop(book: BookEntry, activityId: string): void {
    const task = book.tasks.get(activityId);
    if (!task) return;
    for (const callId of task.callIds) {
      const entry = this.calls.get(callId);
      if (entry) book.calls -= 1;
      this.calls.delete(callId);
    }
    book.bytes -= task.bytes;
    book.tasks.delete(activityId);
  }
}
