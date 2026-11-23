import {
  AI_CALL_BUDGETS,
  AI_CALL_LIMITS,
  AiCallDiskFullError,
  planRetention,
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
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { MIN_COMPRESSED_BYTES, canCompress, packText, unpackText, type TextEncoding } from "@/autopilot/calls/gzip";
import { AiCallFencedSignal, AiCallStoreUnavailableError, isQuotaError, runTransaction, type AiCallStoreName, type IdbEnvironment, type Tx } from "@/autopilot/calls/idb";
import type { AiCallBudgetsInEffect, AiCallOutbox, AiCallOutboxEntry, AiCallStoreOptions, AiCallStoreStats, AiCallStoreStatus, PersistenceState, StorageManagerLike } from "@/autopilot/calls/types";

/**
 * The AI calls of the autopilot, kept in the browser's IndexedDB: the messages that were sent, the response (also while it streams) and what each provider attempt did.
 * It is the browser's host of the engine's `AiCallStore`, and does what `MemoryAiCallStore` does (the tests run the same suite on both).
 *
 * The data: a task per `[account, book, activity]`; a row per call; the texts of a call as rows of their own (compressed once the call has ended); and, while a
 * response streams, one small row per write (`chunks`), so that a response of megabytes never rewrites itself per delta. The chunks are folded into the text
 * when the call ends, and when the store opens (what a page that was closed in the middle of a call left). Sizes, in bytes of UTF-8, are those of the texts as
 * the port counts them, whatever the compression saves: they are what the budgets are made of.
 *
 * Accounts: a store acts for one account at a time and re-checks it before it writes; what it reads belongs to the account it acts for. A session that was
 * built for an account holds a store bound to it (`bind`): when the account changes, what that session still writes is dropped.
 */

export const AI_CALLS_DB_NAME = "narrarium-ai-calls";
export const AI_CALLS_DB_VERSION = 1;

/** A task that says it is running and has not been touched for this long was left by a page that was closed: the retention may drop it. */
export const STALE_RUNNING_TASK_MS = 24 * 60 * 60 * 1000;
/** The writes of a call that never began are dropped after this long. */
const PENDING_CALL_TTL_MS = 24 * 60 * 60 * 1000;
/** The part of the room the browser says this origin has that the calls may take at most. */
const QUOTA_SHARE = 0.25;
const ESTIMATE_CACHE_MS = 30_000;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_BLOCKED_TIMEOUT_MS = 4_000;
const OUTBOX_DUE_NOW = "";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

interface TaskRow {
  scope: string;
  bookId: string;
  activityId: string;
  draft: AiCallTaskDraft | null;
  /** 0 or 1: a boolean cannot be a key of an index. */
  pinned: 0 | 1;
  calls: number;
  bytes: number;
  startedAt: string;
  first: { task: AiCallRecord["task"]; chapter: number | null; scene: number | null } | null;
  /** 1 once the task has a header or a call: a task that only a pin created is not listed. */
  listed: 0 | 1;
  touchedAt: number;
}

interface CallRow {
  callId: string;
  scope: string;
  /** Not known until the call begins. */
  bookId?: string;
  activityId?: string;
  /** `call` began; `pending` has writes but no `begin` yet; `refused` came past the limit of its task and is not kept. */
  kind: "call" | "pending" | "refused";
  /** Only a pending row has it (and so it is the only one in the index of pending rows). */
  pendingAt?: number;
  seq: number;
  record: AiCallRecord | null;
  /** An `end` that came before the `begin`. */
  end: AiCallEnd | null;
  ended: boolean;
  /** The end of what was written of each response, by attempt: the size of the response. */
  lengths: Record<string, number>;
  /** The longest write of each response (the live read starts that far before where it reads). */
  maxChunk: Record<string, number>;
  /** How many chunk writes the call has had: the order of overlapping ones. */
  writes: number;
  systemBytes: number;
  userBytes: number;
  touchedAt: number;
}

interface TextRow {
  callId: string;
  field: AiCallField;
  /** 0 for the system and the user message. */
  attempt: number;
  encoding: TextEncoding;
  data: Uint8Array;
  size: number;
  /** Counts the folds that wrote it: a fold that finds another number has been beaten by another page and leaves the text alone. */
  rev: number;
}

interface ChunkRow {
  callId: string;
  attempt: number;
  offset: number;
  seq: number;
  data: Uint8Array;
}

interface TotalsRow {
  scope: string;
  bookId: string;
  bytes: number;
  tasks: number;
  calls: number;
}

interface OutboxRow extends AiCallOutboxEntry {
  scope: string;
  /** `nextAt` as a key: an index cannot hold a null. */
  nextKey: string;
}

/** What an operation does for: the account, and a way to find out that it is not the page's any more. */
interface Context {
  scope: string;
  current(): boolean;
  assert(): void;
}

/** A store that was given what `AiCallStoreOptions` leaves to the browser. */
interface Resolved {
  environment: IdbEnvironment;
  name: string;
  version: number;
  scope: () => string;
  storage: StorageManagerLike | null;
  budgets: NonNullable<AiCallStoreOptions["budgets"]>;
  blockedTimeoutMs: number;
  openTimeoutMs: number;
  now: () => number;
  recover: boolean;
}

function upgrade(db: IDBDatabase): void {
  const has = (name: string) => db.objectStoreNames.contains(name);
  if (!has("tasks")) {
    const tasks = db.createObjectStore("tasks", { keyPath: ["scope", "bookId", "activityId"] });
    tasks.createIndex("byStart", ["scope", "bookId", "startedAt"]);
    tasks.createIndex("byPinned", ["scope", "bookId", "pinned"]);
  }
  if (!has("calls")) {
    const calls = db.createObjectStore("calls", { keyPath: "callId" });
    calls.createIndex("byTask", ["scope", "bookId", "activityId"]);
    calls.createIndex("byPending", "pendingAt");
  }
  if (!has("texts")) db.createObjectStore("texts", { keyPath: ["callId", "field", "attempt"] });
  if (!has("chunks")) db.createObjectStore("chunks", { keyPath: ["callId", "attempt", "offset"] });
  if (!has("totals")) db.createObjectStore("totals", { keyPath: ["scope", "bookId"] });
  if (!has("outbox")) {
    const outbox = db.createObjectStore("outbox", { keyPath: ["scope", "bookId", "taskId", "target"] });
    outbox.createIndex("byDue", ["scope", "nextKey"]);
  }
  if (!has("meta")) db.createObjectStore("meta", { keyPath: "key" });
}

function emptyTotals(scope: string, bookId: string): TotalsRow {
  return { scope, bookId, bytes: 0, tasks: 0, calls: 0 };
}

function newTask(scope: string, bookId: string, activityId: string, now: number): TaskRow {
  return { scope, bookId, activityId, draft: null, pinned: 0, calls: 0, bytes: 0, startedAt: "", first: null, listed: 0, touchedAt: now };
}

function callBytes(row: Pick<CallRow, "systemBytes" | "userBytes" | "lengths">): number {
  let total = row.systemBytes + row.userBytes;
  for (const length of Object.values(row.lengths)) total += length;
  return total;
}

/** The order of the task list: newest first, by start and then by id. */
function taskKey(task: { startedAt: string; activityId: string }): string {
  return `${task.startedAt}|${task.activityId}`;
}

function headerOf(task: TaskRow): AiCallTaskHeader {
  if (task.draft) return { ...task.draft, calls: task.calls, bytes: task.bytes, pinned: task.pinned === 1 };
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
    calls: task.calls,
    bytes: task.bytes,
    pinned: task.pinned === 1,
  };
}

function isRunning(task: TaskRow, now: number): boolean {
  return (task.draft?.status ?? "running") === "running" && now - task.touchedAt < STALE_RUNNING_TASK_MS;
}

/** `patch` written over `base` from its first byte: the bytes of a later write at the same place. */
function overlay(base: Uint8Array, patch: Uint8Array): Uint8Array {
  if (patch.length >= base.length) return patch.slice();
  const merged = base.slice();
  merged.set(patch, 0);
  return merged;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function sleepZero(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function isConnectionClosed(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "InvalidStateError";
}

function mapError(error: unknown): unknown {
  return isQuotaError(error) ? new AiCallDiskFullError() : error;
}

function browserStorage(): StorageManagerLike | null {
  return typeof navigator !== "undefined" && navigator.storage ? (navigator.storage as unknown as StorageManagerLike) : null;
}

/** A task that was saved as finished (its header does not say `running`) and that the budget kept, for the account it was saved for. */
export interface TaskFinishedEvent {
  bookId: string;
  activityId: string;
  scope: string;
}

/**
 * What every host of the store shares: the connection, the transactions, what the browser said about keeping the data, the budgets and the folding of live
 * chunks. The ambient store and the stores bound to an account are views of one core.
 */
class StoreCore {
  db: IDBDatabase | null = null;
  persistence: PersistenceState = "unknown";
  /** Writes that were dropped because the account changed. */
  fenced = 0;
  closed = false;
  /** Who is told that a task was saved as finished (the copies to a place of the author's choosing start from it). */
  readonly finished = new Set<(event: TaskFinishedEvent) => void>();
  private opening: Promise<IDBDatabase> | null = null;
  private persistenceAsked = false;
  private estimate: { at: number; quota: number | null; usage: number | null } | null = null;
  private readonly maintenance = new Set<Promise<unknown>>();
  private readonly folding = new Map<string, Promise<void>>();

  constructor(readonly options: Resolved) {}

  get range(): typeof IDBKeyRange {
    return this.options.environment.range;
  }

  now(): number {
    return this.options.now();
  }

  current(): string {
    return this.options.scope();
  }

  open(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const { factory } = this.options.environment;
      let settled = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        reject(error instanceof AiCallStoreUnavailableError ? error : new AiCallStoreUnavailableError("The AI call database could not be opened.", error));
      };
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.options.name, this.options.version);
      } catch (error) {
        fail(error);
        return;
      }
      timers.push(setTimeout(() => fail(new AiCallStoreUnavailableError("The AI call database did not open in time.")), this.options.openTimeoutMs));
      request.onupgradeneeded = () => upgrade(request.result);
      request.onblocked = () => {
        // Another tab holds an older version open. It is asked to close (its `versionchange`); a tab that does not leaves this open waiting, and a wait is not for ever.
        timers.push(setTimeout(() => fail(new AiCallStoreUnavailableError("The AI call database upgrade is blocked by another Narrarium tab.")), this.options.blockedTimeoutMs));
      };
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        timers.forEach(clearTimeout);
        // A newer version in another tab, or a browser that clears the origin: this connection is closed, and the next operation opens again.
        db.onversionchange = () => this.forget(db);
        db.onclose = () => this.forget(db);
        this.db = db;
        resolve(db);
      };
    });
    this.opening = opening;
    // A failed open is not remembered: the next operation tries again.
    opening.catch(() => {
      if (this.opening === opening) this.opening = null;
    });
    return opening;
  }

  /** Lets go of a connection that was closed under the store: the next operation opens again. */
  forget(db: IDBDatabase): void {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    if (this.db === db) {
      this.db = null;
      this.opening = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.db) this.forget(this.db);
  }

  /** One transaction. A connection that was closed since it was last used is opened again, once. */
  async run<T>(stores: readonly AiCallStoreName[], mode: IDBTransactionMode, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.closed) throw new AiCallStoreUnavailableError("The AI call store is closed.");
    for (let attempt = 0; ; attempt += 1) {
      const db = await this.open();
      try {
        return await runTransaction(db, this.range, stores, mode, work);
      } catch (error) {
        if (attempt === 0 && isConnectionClosed(error)) {
          this.forget(db);
          continue;
        }
        throw mapError(error);
      }
    }
  }

  /** Asks the browser, once, to keep the data (`navigator.storage.persist()`), and remembers the answer. It never waits for it. */
  askPersistence(): void {
    if (this.persistenceAsked) return;
    this.persistenceAsked = true;
    const storage = this.options.storage;
    if (!storage || typeof storage.persist !== "function") {
      this.persistence = "unsupported";
      return;
    }
    this.persistence = "pending";
    void (async () => {
      try {
        if (typeof storage.persisted === "function" && (await storage.persisted())) {
          this.persistence = "granted";
          return;
        }
        this.persistence = (await storage.persist!()) ? "granted" : "denied";
      } catch {
        this.persistence = "denied";
      }
    })();
  }

  private async measure(): Promise<{ quota: number | null; usage: number | null }> {
    const cached = this.estimate;
    if (cached && this.now() - cached.at < ESTIMATE_CACHE_MS) return cached;
    let quota: number | null = null;
    let usage: number | null = null;
    try {
      const estimate = await this.options.storage?.estimate?.();
      if (typeof estimate?.quota === "number" && estimate.quota > 0) quota = estimate.quota;
      if (typeof estimate?.usage === "number") usage = estimate.usage;
    } catch {
      // A browser that cannot say has no quota rule.
    }
    this.estimate = { at: this.now(), quota, usage };
    return this.estimate;
  }

  /** The budgets in force: the engine's (or the test's), and never more than a quarter of the room the browser says there is. */
  async budgets(): Promise<AiCallBudgetsInEffect> {
    const { quota, usage } = await this.measure();
    let perDeviceBytes = this.options.budgets.perDeviceBytes ?? AI_CALL_BUDGETS.browserPerDeviceBytes;
    if (quota !== null) perDeviceBytes = Math.min(perDeviceBytes, Math.floor(quota * QUOTA_SHARE));
    const perBookBytes = Math.min(this.options.budgets.perBookBytes ?? AI_CALL_BUDGETS.browserPerBookBytes, perDeviceBytes);
    return { perBookBytes, perDeviceBytes, quotaBytes: quota, usageBytes: usage };
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.maintenance.add(work);
    void work.then(() => this.maintenance.delete(work), () => this.maintenance.delete(work));
    return work;
  }

  /** Resolves when the maintenance that is going on (folds, recovery) is over. */
  async idle(): Promise<void> {
    while (this.maintenance.size) await Promise.allSettled([...this.maintenance]);
  }

  /** Folds the live chunks of a call into its text, compressed. One fold of a call at a time; a failure is for the next fold (at the end of the call, or when the store opens). */
  fold(callId: string): Promise<void> {
    const previous = this.folding.get(callId) ?? Promise.resolve();
    const next = previous.then(() => this.foldOnce(callId)).catch(() => undefined);
    this.folding.set(callId, next);
    void next.then(() => {
      if (this.folding.get(callId) === next) this.folding.delete(callId);
    });
    return this.track(next);
  }

  private async foldOnce(callId: string): Promise<void> {
    const snapshot = await this.run(["calls", "chunks", "texts"], "readonly", async (tx) => ({
      row: await tx.get<CallRow>("calls", callId),
      chunks: await tx.getAll<ChunkRow>("chunks", tx.prefix(callId)),
      texts: await tx.getAll<TextRow>("texts", tx.prefix(callId)),
    }));
    if (!snapshot.row || snapshot.row.kind !== "call") return;
    const textOf = new Map(snapshot.texts.map((text) => [`${text.field}:${text.attempt}`, text]));
    interface Plan {
      field: AiCallField;
      attempt: number;
      size: number;
      baseRev: number;
      packed: { encoding: TextEncoding; data: Uint8Array };
      consumed: ChunkRow[];
    }
    const plans: Plan[] = [];
    const byAttempt = new Map<number, ChunkRow[]>();
    for (const chunk of snapshot.chunks) byAttempt.set(chunk.attempt, [...(byAttempt.get(chunk.attempt) ?? []), chunk]);
    for (const [attempt, chunks] of byAttempt) {
      const existing = textOf.get(`response:${attempt}`);
      let size = existing?.size ?? 0;
      for (const chunk of chunks) size = Math.max(size, chunk.offset + chunk.data.length);
      const bytes = new Uint8Array(size);
      if (existing) bytes.set((await unpackText(existing)).subarray(0, size));
      for (const chunk of [...chunks].sort((left, right) => left.seq - right.seq)) bytes.set(chunk.data, chunk.offset);
      plans.push({ field: "response", attempt, size, baseRev: existing?.rev ?? 0, packed: await packText(bytes), consumed: chunks });
    }
    for (const field of ["system", "user"] as const) {
      const text = textOf.get(`${field}:0`);
      if (!text || text.encoding !== "plain" || text.size < MIN_COMPRESSED_BYTES || !canCompress()) continue;
      const packed = await packText(text.data);
      if (packed.encoding === "gzip") plans.push({ field, attempt: 0, size: text.size, baseRev: text.rev, packed, consumed: [] });
    }
    if (!plans.length) return;
    await this.run(["texts", "chunks"], "readwrite", async (tx) => {
      for (const plan of plans) {
        const current = await tx.get<TextRow>("texts", [callId, plan.field, plan.attempt]);
        // Another page folded this text in the meantime: its result stands, and the chunks it left are folded by the next fold.
        if ((current?.rev ?? 0) !== plan.baseRev) continue;
        await tx.put("texts", { callId, field: plan.field, attempt: plan.attempt, encoding: plan.packed.encoding, data: plan.packed.data, size: plan.size, rev: plan.baseRev + 1 } satisfies TextRow);
        for (const chunk of plan.consumed) {
          const live = await tx.get<ChunkRow>("chunks", [callId, chunk.attempt, chunk.offset]);
          if (live && live.seq === chunk.seq) await tx.delete("chunks", [callId, chunk.attempt, chunk.offset]);
        }
      }
    });
  }

  /** What an earlier page left: the live chunks of every call are folded into its text, and the writes of calls that never began (older than a day) are dropped. */
  recover(): Promise<void> {
    return this.track((async () => {
      const callIds = await this.run(["chunks"], "readonly", (tx) => tx.distinctFirstParts("chunks"));
      for (const callId of callIds) {
        await this.fold(callId);
        await sleepZero();
      }
      await this.run(["calls", "chunks"], "readwrite", async (tx) => {
        const old = await tx.indexGetAll<CallRow>("calls", "byPending", this.range.upperBound(this.now() - PENDING_CALL_TTL_MS));
        for (const row of old) {
          await tx.delete("chunks", tx.prefix(row.callId));
          await tx.delete("calls", row.callId);
        }
      });
    })().catch(() => undefined));
  }
}

/**
 * The browser's `AiCallStore`. `IndexedDbAiCallStore.open()` opens the database and gives the store that acts for the account the page is in at each call;
 * `bind(identity)` gives one that acts for that account for ever, and drops its writes when the page is in another.
 */
export class IndexedDbAiCallStore implements AiCallStore {
  /** The copies' list of tasks that wait for a place outside this device. */
  readonly outbox: AiCallOutbox;

  private constructor(private readonly core: StoreCore, private readonly acting: () => string) {
    this.outbox = {
      put: (entry) => this.putOutbox(entry),
      list: (filter) => this.listOutbox(filter),
      delete: (bookId, taskId, target) => this.deleteOutbox(bookId, taskId, target),
    };
  }

  /**
   * Calls `listener` after a task was saved as finished and kept by the budget: by the engine's session when its step ends, and by the copy of a server's records when a
   * finished task is whole here. Only for a write that was made for the account the page is in, and never for one that was dropped. A listener that throws is not the store's.
   */
  onTaskFinished(listener: (event: TaskFinishedEvent) => void): () => void {
    this.core.finished.add(listener);
    return () => {
      this.core.finished.delete(listener);
    };
  }

  /** Opens the database (and folds what an earlier page left) and gives the store. Throws `AiCallStoreUnavailableError` when the browser does not let it. */
  static async open(options: AiCallStoreOptions = {}): Promise<IndexedDbAiCallStore> {
    const factory = options.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
    if (!factory) throw new AiCallStoreUnavailableError("This browser has no IndexedDB.");
    const range = options.keyRange ?? (typeof IDBKeyRange !== "undefined" ? IDBKeyRange : undefined);
    if (!range) throw new AiCallStoreUnavailableError("This browser has no IndexedDB key ranges.");
    const core = new StoreCore({
      environment: { factory, range },
      name: options.name ?? AI_CALLS_DB_NAME,
      version: options.version ?? AI_CALLS_DB_VERSION,
      scope: options.scope ?? currentRepositoryScopeIdentity,
      storage: options.storage === undefined ? browserStorage() : options.storage,
      budgets: options.budgets ?? {},
      blockedTimeoutMs: options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS,
      openTimeoutMs: options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
      now: options.now ?? (() => Date.now()),
      recover: options.recover ?? true,
    });
    await core.open();
    const store = new IndexedDbAiCallStore(core, core.current.bind(core));
    if (core.options.recover) void core.recover();
    return store;
  }

  /** A store that acts for `identity` whatever account the page is in: what it writes after the page changed account is dropped, and it reads nothing of another one. */
  bind(identity: string): IndexedDbAiCallStore {
    return new IndexedDbAiCallStore(this.core, () => identity);
  }

  /** What the browser answered when the first write asked it to keep the data, and the budgets in force. */
  async status(): Promise<AiCallStoreStatus> {
    return { persistence: this.core.persistence, budgets: await this.core.budgets() };
  }

  /** How many writes were dropped because the account changed. */
  get fencedWrites(): number {
    return this.core.fenced;
  }

  /** Resolves when the folds and the recovery that are going on are over. */
  idle(): Promise<void> {
    return this.core.idle();
  }

  /** Closes the connection. The store gives errors after it. */
  close(): void {
    this.core.close();
  }

  /** How many rows each part of the database holds. */
  stats(): Promise<AiCallStoreStats> {
    return this.core.run(["tasks", "calls", "texts", "chunks", "outbox"], "readonly", async (tx) => {
      const calls = await tx.getAll<CallRow>("calls");
      return {
        tasks: await tx.count("tasks"),
        calls: calls.filter((row) => row.kind === "call").length,
        texts: await tx.count("texts"),
        chunks: await tx.count("chunks"),
        pending: calls.filter((row) => row.kind !== "call").length,
        outbox: await tx.count("outbox"),
      };
    });
  }

  private context(): Context {
    const scope = this.acting();
    const current = () => this.core.current() === scope;
    return {
      scope,
      current,
      assert: () => {
        if (!current()) throw new AiCallFencedSignal();
      },
    };
  }

  /** A write: it asks the browser to keep the data (the first time), is dropped when the account changed, and gives `dropped` then. */
  private async write<T = void>(ctx: Context, stores: readonly AiCallStoreName[], work: (tx: Tx) => Promise<T>, dropped?: T): Promise<T> {
    if (!ctx.current()) {
      this.core.fenced += 1;
      return dropped as T;
    }
    this.core.askPersistence();
    try {
      return await this.core.run(stores, "readwrite", work);
    } catch (error) {
      if (error instanceof AiCallFencedSignal) {
        this.core.fenced += 1;
        return dropped as T;
      }
      throw error;
    }
  }

  private async read<T>(ctx: Context, stores: readonly AiCallStoreName[], work: (tx: Tx) => Promise<T>, none: T): Promise<T> {
    if (!ctx.current()) return none;
    return this.core.run(stores, "readonly", work);
  }

  async begin({ record, system, user }: AiCallBegin): Promise<void> {
    const ctx = this.context();
    const systemBytes = encoder.encode(system);
    const userBytes = encoder.encode(user);
    await this.write(ctx, ["calls", "tasks", "texts", "chunks", "totals"], async (tx) => {
      const existing = await tx.get<CallRow>("calls", record.callId);
      if (existing && (existing.kind === "call" || existing.kind === "refused")) return;
      let pending: CallRow | null = null;
      if (existing) {
        if (existing.scope === ctx.scope) pending = existing;
        else {
          ctx.assert();
          await tx.delete("chunks", tx.prefix(record.callId));
        }
      }
      const now = this.core.now();
      const task = (await tx.get<TaskRow>("tasks", [ctx.scope, record.bookId, record.activityId])) ?? newTask(ctx.scope, record.bookId, record.activityId, now);
      if (task.calls >= AI_CALL_LIMITS.maxCallsPerTask) {
        ctx.assert();
        await tx.delete("chunks", tx.prefix(record.callId));
        await tx.put("calls", refusedRow(record, ctx.scope, now));
        return;
      }
      const row: CallRow = {
        callId: record.callId,
        scope: ctx.scope,
        bookId: record.bookId,
        activityId: record.activityId,
        kind: "call",
        seq: record.seq,
        record: structuredClone({ ...record, attempts: [], response: { text: null, partial: false } }),
        end: null,
        ended: false,
        lengths: pending?.lengths ?? {},
        maxChunk: pending?.maxChunk ?? {},
        writes: pending?.writes ?? 0,
        systemBytes: systemBytes.length,
        userBytes: userBytes.length,
        touchedAt: now,
      };
      if (pending?.end) applyEnd(row, pending.end);
      const bytes = callBytes(row);
      task.calls += 1;
      task.bytes += bytes;
      task.first ??= { task: record.task, chapter: record.chapter, scene: record.scene };
      if (record.timing.startedAt < task.startedAt || task.startedAt === "") task.startedAt = record.timing.startedAt;
      task.touchedAt = now;
      const totals = (await tx.get<TotalsRow>("totals", [ctx.scope, record.bookId])) ?? emptyTotals(ctx.scope, record.bookId);
      if (!task.listed) {
        task.listed = 1;
        totals.tasks += 1;
      }
      totals.calls += 1;
      totals.bytes += bytes;
      ctx.assert();
      await tx.put("calls", row);
      await tx.put("tasks", task);
      await tx.put("totals", totals);
      await tx.put("texts", { callId: record.callId, field: "system", attempt: 0, encoding: "plain", data: systemBytes, size: systemBytes.length, rev: 0 } satisfies TextRow);
      await tx.put("texts", { callId: record.callId, field: "user", attempt: 0, encoding: "plain", data: userBytes, size: userBytes.length, rev: 0 } satisfies TextRow);
    });
  }

  async append(callId: string, attempt: number, offset: number, text: string): Promise<void> {
    if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("The attempt of a response starts at 1.");
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError("The offset of a text is a whole number of bytes, from 0.");
    if (!text) return;
    const ctx = this.context();
    const data = encoder.encode(text);
    await this.write(ctx, ["calls", "tasks", "totals", "chunks"], async (tx) => {
      let row = await tx.get<CallRow>("calls", callId);
      if (row?.kind === "refused") return;
      if (row && row.scope !== ctx.scope) return;
      const now = this.core.now();
      const begun = row?.kind === "call";
      row ??= pendingRow(callId, ctx.scope, now);
      const key = [callId, attempt, offset];
      const same = await tx.get<ChunkRow>("chunks", key);
      const merged = same ? overlay(same.data, data) : data;
      if (same && sameBytes(same.data, merged)) return;
      const slot = String(attempt);
      const before = row.lengths[slot] ?? 0;
      const length = Math.max(before, offset + merged.length);
      row.lengths[slot] = length;
      row.maxChunk[slot] = Math.max(row.maxChunk[slot] ?? 0, merged.length);
      row.writes += 1;
      row.touchedAt = now;
      if (!begun) row.pendingAt = now;
      ctx.assert();
      await tx.put("chunks", { callId, attempt, offset, seq: row.writes, data: merged } satisfies ChunkRow);
      await tx.put("calls", row);
      if (begun && length > before && row.bookId && row.activityId) {
        const task = await tx.get<TaskRow>("tasks", [ctx.scope, row.bookId, row.activityId]);
        const totals = await tx.get<TotalsRow>("totals", [ctx.scope, row.bookId]);
        if (task && totals) {
          task.bytes += length - before;
          task.touchedAt = now;
          totals.bytes += length - before;
          await tx.put("tasks", task);
          await tx.put("totals", totals);
        }
      }
    });
  }

  async end(callId: string, final: AiCallEnd): Promise<void> {
    const ctx = this.context();
    await this.write(ctx, ["calls", "tasks"], async (tx) => {
      let row = await tx.get<CallRow>("calls", callId);
      if (row?.kind === "refused") return;
      if (row && row.scope !== ctx.scope) return;
      const now = this.core.now();
      row ??= pendingRow(callId, ctx.scope, now);
      if (row.kind === "pending") {
        row.end = structuredClone(final);
        row.pendingAt = now;
        row.touchedAt = now;
      } else {
        applyEnd(row, final);
        row.touchedAt = now;
      }
      ctx.assert();
      await tx.put("calls", row);
      if (row.kind === "call" && row.bookId && row.activityId) {
        const task = await tx.get<TaskRow>("tasks", [ctx.scope, row.bookId, row.activityId]);
        if (task) {
          task.touchedAt = now;
          await tx.put("tasks", task);
        }
      }
    });
    // The text that streamed is folded into a text of its own, compressed, after the end is written: a failure is for the next fold.
    void this.core.fold(callId);
  }

  async saveTask(draft: AiCallTaskDraft): Promise<void> {
    const ctx = this.context();
    await this.write(ctx, ["tasks", "totals"], async (tx) => {
      const now = this.core.now();
      const task = (await tx.get<TaskRow>("tasks", [ctx.scope, draft.bookId, draft.activityId])) ?? newTask(ctx.scope, draft.bookId, draft.activityId, now);
      task.draft = structuredClone(draft);
      task.startedAt = draft.startedAt;
      task.touchedAt = now;
      let totals: TotalsRow | undefined;
      if (!task.listed) {
        task.listed = 1;
        totals = (await tx.get<TotalsRow>("totals", [ctx.scope, draft.bookId])) ?? emptyTotals(ctx.scope, draft.bookId);
        totals.tasks += 1;
      }
      ctx.assert();
      await tx.put("tasks", task);
      if (totals) await tx.put("totals", totals);
    });
    // After each task the book keeps what its budget allows: the oldest tasks that are neither pinned nor running go first.
    if (draft.status === "running") return;
    const kept = await this.enforceBudgets(draft.bookId).catch(() => null);
    if (!ctx.current() || kept?.dropped.includes(draft.activityId)) return;
    for (const listener of [...this.core.finished]) {
      try {
        listener({ bookId: draft.bookId, activityId: draft.activityId, scope: ctx.scope });
      } catch {
        // A listener that throws is not the store's.
      }
    }
  }

  async listTasks(bookId: string, page: { before?: string; limit: number }): Promise<AiCallTaskPage> {
    const ctx = this.context();
    const limit = Math.min(200, Math.max(1, Math.floor(page.limit)));
    const { before } = page;
    const cut = before === undefined ? -1 : before.indexOf("|");
    const beforeStart = before === undefined ? "\uffff" : cut < 0 ? before : before.slice(0, cut);
    const rows = await this.read(ctx, ["tasks"], async (tx) => {
      const collected: TaskRow[] = [];
      await tx.scan<TaskRow>("tasks", { index: "byStart", range: this.core.range.bound([ctx.scope, bookId, ""], [ctx.scope, bookId, beforeStart]), direction: "prev" }, (row) => {
        if (!row.listed) return true;
        if (before !== undefined && !(taskKey(row) < before)) return true;
        collected.push(row);
        return collected.length <= limit;
      });
      return collected;
    }, [] as TaskRow[]);
    const shown = rows.slice(0, limit);
    return { tasks: shown.map(headerOf), next: rows.length > limit && shown.length > 0 ? taskKey(shown[shown.length - 1]) : null };
  }

  async readTask(bookId: string, activityId: string): Promise<AiCallTask | null> {
    const ctx = this.context();
    const found = await this.read(ctx, ["tasks", "calls"], async (tx) => {
      const task = await tx.get<TaskRow>("tasks", [ctx.scope, bookId, activityId]);
      if (!task || !task.listed) return null;
      const rows = await tx.indexGetAll<CallRow>("calls", "byTask", this.core.range.only([ctx.scope, bookId, activityId]));
      return { task, rows };
    }, null);
    if (!found) return null;
    const calls = found.rows
      .filter((row): row is CallRow & { record: AiCallRecord } => row.kind === "call" && row.record !== null)
      .map((row) => structuredClone(row.record))
      .sort((left, right) => left.seq - right.seq);
    return { header: headerOf(found.task), calls };
  }

  async readText(bookId: string, callId: string, field: AiCallField, from: number, attempt?: number): Promise<AiCallTextChunk | null> {
    const ctx = this.context();
    const snapshot = await this.read(ctx, ["calls", "texts", "chunks"], async (tx) => {
      const row = await tx.get<CallRow>("calls", callId);
      if (!row || row.kind !== "call" || row.bookId !== bookId || row.scope !== ctx.scope) return null;
      const textAttempt = field === "response" ? attempt ?? lastAttemptWithText(row) : 0;
      const size = field === "system" ? row.systemBytes : field === "user" ? row.userBytes : textAttempt === 0 ? 0 : row.lengths[String(textAttempt)] ?? 0;
      const start = Math.min(Math.max(0, Math.floor(from)), size);
      // A character is at most four bytes: three before the start are enough to find where its character begins.
      const low = Math.max(0, start - 3);
      const base = textAttempt === 0 && field === "response" ? undefined : await tx.get<TextRow>("texts", [callId, field, field === "response" ? textAttempt : 0]);
      let chunks: ChunkRow[] = [];
      if (field === "response" && textAttempt > 0 && size > low) {
        // Only the writes that can reach `low`: the longest of them is known, so the ones before it cannot.
        const reach = row.maxChunk[String(textAttempt)] ?? 0;
        chunks = await tx.getAll<ChunkRow>("chunks", this.core.range.bound([callId, textAttempt, Math.max(0, low - reach + 1)], [callId, textAttempt, []]));
      }
      return { size, start, low, base, chunks, ended: row.ended };
    }, null);
    if (!snapshot) return null;
    const { size, low, base, chunks, ended } = snapshot;
    let start = snapshot.start;
    const bytes = new Uint8Array(Math.max(0, size - low));
    if (base) {
      const whole = await unpackText(base);
      bytes.set(whole.subarray(low, Math.min(size, whole.length)));
    }
    for (const chunk of [...chunks].sort((left, right) => left.seq - right.seq)) {
      const begin = Math.max(chunk.offset, low);
      const end = Math.min(chunk.offset + chunk.data.length, size);
      if (end > begin) bytes.set(chunk.data.subarray(begin - chunk.offset, end - chunk.offset), begin - low);
    }
    while (start > 0 && start < size && (bytes[start - low] & 0xc0) === 0x80) start -= 1;
    return { text: decoder.decode(bytes.subarray(start - low)), from: start, next: size, size, complete: ended };
  }

  async keep(bookId: string, activityId: string, pinned: boolean): Promise<void> {
    const ctx = this.context();
    await this.write(ctx, ["tasks"], async (tx) => {
      const existing = await tx.get<TaskRow>("tasks", [ctx.scope, bookId, activityId]);
      const flag = pinned ? 1 : 0;
      if (existing && existing.pinned === flag) return;
      const task = existing ?? newTask(ctx.scope, bookId, activityId, this.core.now());
      task.pinned = flag;
      ctx.assert();
      await tx.put("tasks", task);
    });
  }

  async deleteBook(bookId: string): Promise<void> {
    const ctx = this.context();
    await this.write(ctx, ["tasks", "calls", "texts", "chunks", "totals", "outbox"], async (tx) => {
      const tasks = await tx.getAll<TaskRow>("tasks", tx.prefix(ctx.scope, bookId));
      ctx.assert();
      for (const task of tasks) await dropTask(tx, task, this.core.range);
      for (const id of await tx.indexGetAllKeys("calls", "byTask", tx.prefix(ctx.scope, bookId))) {
        await tx.delete("texts", tx.prefix(id as string));
        await tx.delete("chunks", tx.prefix(id as string));
        await tx.delete("calls", id);
      }
      await tx.delete("totals", [ctx.scope, bookId]);
      await tx.delete("outbox", tx.prefix(ctx.scope, bookId));
    });
  }

  async prune(bookId: string, budget: number): Promise<AiCallPruneResult> {
    const ctx = this.context();
    return this.write(ctx, ["tasks", "calls", "texts", "chunks", "totals"], (tx) => this.pruneIn(tx, ctx, bookId, budget), { dropped: [], bytes: 0, pinnedTasks: 0, pinnedBytes: 0, overBudget: false });
  }

  private async pruneIn(tx: Tx, ctx: Context, bookId: string, budget: number): Promise<AiCallPruneResult> {
    const now = this.core.now();
    const tasks = await tx.getAll<TaskRow>("tasks", tx.prefix(ctx.scope, bookId));
    const plan = planRetention(tasks.map((task) => ({ activityId: task.activityId, bytes: task.bytes, pinned: task.pinned === 1, running: isRunning(task, now), startedAt: task.startedAt })), budget);
    const totals = (await tx.get<TotalsRow>("totals", [ctx.scope, bookId])) ?? emptyTotals(ctx.scope, bookId);
    if (plan.drop.length) {
      ctx.assert();
      const dropping = new Set(plan.drop);
      for (const task of tasks) {
        if (!dropping.has(task.activityId)) continue;
        await dropTask(tx, task, this.core.range);
        totals.bytes -= task.bytes;
        totals.calls -= task.calls;
        if (task.listed) totals.tasks -= 1;
      }
      await tx.put("totals", totals);
    }
    return { dropped: plan.drop, bytes: totals.bytes, pinnedTasks: plan.pinnedTasks, pinnedBytes: plan.pinnedBytes, overBudget: plan.overBudget };
  }

  /**
   * Keeps the book within its budget, and the device within its own: the oldest tasks that are neither pinned nor running go first, whole. It is what runs after each
   * task. It returns what happened to the book.
   */
  async enforceBudgets(bookId: string): Promise<AiCallPruneResult> {
    const { perBookBytes, perDeviceBytes } = await this.core.budgets();
    const result = await this.prune(bookId, perBookBytes);
    const ctx = this.context();
    const sums = await this.read(ctx, ["totals"], async (tx) => (await tx.getAll<TotalsRow>("totals")).reduce((sum, row) => sum + row.bytes, 0), 0);
    if (sums > perDeviceBytes) await this.pruneDevice(ctx, perDeviceBytes);
    return result;
  }

  /** The device budget: the oldest tasks of every book (and account) that are neither pinned nor running. */
  private pruneDevice(ctx: Context, budget: number): Promise<string[]> {
    return this.write(ctx, ["tasks", "calls", "texts", "chunks", "totals"], async (tx) => {
      const now = this.core.now();
      const tasks = await tx.getAll<TaskRow>("tasks");
      const idOf = (task: TaskRow) => `${task.scope}\u0000${task.bookId}\u0000${task.activityId}`;
      const plan = planRetention(tasks.map((task) => ({ activityId: idOf(task), bytes: task.bytes, pinned: task.pinned === 1, running: isRunning(task, now), startedAt: task.startedAt })), budget);
      if (!plan.drop.length) return [];
      ctx.assert();
      const dropping = new Set(plan.drop);
      const books = new Map<string, TotalsRow>();
      for (const task of tasks) {
        if (!dropping.has(idOf(task))) continue;
        const key = `${task.scope}\u0000${task.bookId}`;
        let totals = books.get(key);
        if (!totals) {
          totals = (await tx.get<TotalsRow>("totals", [task.scope, task.bookId])) ?? emptyTotals(task.scope, task.bookId);
          books.set(key, totals);
        }
        await dropTask(tx, task, this.core.range);
        totals.bytes -= task.bytes;
        totals.calls -= task.calls;
        if (task.listed) totals.tasks -= 1;
      }
      for (const totals of books.values()) await tx.put("totals", totals);
      return plan.drop;
    }, []);
  }

  async totals(bookId: string): Promise<AiCallTotals> {
    const ctx = this.context();
    return this.read(ctx, ["totals", "tasks"], async (tx) => {
      const totals = (await tx.get<TotalsRow>("totals", [ctx.scope, bookId])) ?? emptyTotals(ctx.scope, bookId);
      const pinned = (await tx.indexGetAll<TaskRow>("tasks", "byPinned", this.core.range.only([ctx.scope, bookId, 1]))).filter((task) => task.listed === 1);
      return { bytes: totals.bytes, tasks: totals.tasks, calls: totals.calls, pinnedTasks: pinned.length, pinnedBytes: pinned.reduce((sum, task) => sum + task.bytes, 0) };
    }, { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
  }

  /** The totals of a book recomputed from its rows, for a test or a repair: they must be the ones `totals` answers. */
  async audit(bookId: string): Promise<{ bytes: number; tasks: number; calls: number }> {
    const ctx = this.context();
    return this.read(ctx, ["tasks", "calls"], async (tx) => {
      let bytes = 0;
      let tasks = 0;
      let calls = 0;
      for (const task of await tx.getAll<TaskRow>("tasks", tx.prefix(ctx.scope, bookId))) {
        if (task.listed) tasks += 1;
        for (const row of await tx.indexGetAll<CallRow>("calls", "byTask", this.core.range.only([ctx.scope, bookId, task.activityId]))) {
          if (row.kind !== "call") continue;
          calls += 1;
          bytes += callBytes(row);
        }
      }
      return { bytes, tasks, calls };
    }, { bytes: 0, tasks: 0, calls: 0 });
  }

  /** What the copies of a book have reached (a small note of the copier), and the way to write it. */
  readonly notes = {
    get: async (key: string): Promise<string | null> => {
      const ctx = this.context();
      const row = await this.read(ctx, ["meta"], (tx) => tx.get<{ key: string; value: string }>("meta", `${ctx.scope}\u0000${key}`), undefined);
      return row?.value ?? null;
    },
    set: async (key: string, value: string | null): Promise<void> => {
      const ctx = this.context();
      await this.write(ctx, ["meta"], async (tx) => {
        ctx.assert();
        if (value === null) await tx.delete("meta", `${ctx.scope}\u0000${key}`);
        else await tx.put("meta", { key: `${ctx.scope}\u0000${key}`, value });
      });
    },
  };

  private async putOutbox(entry: AiCallOutboxEntry): Promise<void> {
    const ctx = this.context();
    await this.write(ctx, ["outbox"], async (tx) => {
      ctx.assert();
      await tx.put("outbox", { ...entry, scope: ctx.scope, nextKey: entry.nextAt ?? OUTBOX_DUE_NOW } satisfies OutboxRow);
    });
  }

  private async listOutbox(filter: { bookId?: string; target?: string; dueBy?: string } = {}): Promise<AiCallOutboxEntry[]> {
    const ctx = this.context();
    const rows = await this.read(ctx, ["outbox"], (tx) => tx.indexGetAll<OutboxRow>("outbox", "byDue", this.core.range.bound([ctx.scope, ""], [ctx.scope, filter.dueBy ?? "\uffff"])), [] as OutboxRow[]);
    return rows
      .filter((row) => (filter.bookId === undefined || row.bookId === filter.bookId) && (filter.target === undefined || row.target === filter.target))
      .map(({ scope: _scope, nextKey: _nextKey, ...entry }) => entry);
  }

  private async deleteOutbox(bookId: string, taskId: string, target: string): Promise<void> {
    const ctx = this.context();
    await this.write(ctx, ["outbox"], async (tx) => {
      ctx.assert();
      await tx.delete("outbox", [ctx.scope, bookId, taskId, target]);
    });
  }
}

function pendingRow(callId: string, scope: string, now: number): CallRow {
  return { callId, scope, kind: "pending", pendingAt: now, seq: 0, record: null, end: null, ended: false, lengths: {}, maxChunk: {}, writes: 0, systemBytes: 0, userBytes: 0, touchedAt: now };
}

function refusedRow(record: AiCallRecord, scope: string, now: number): CallRow {
  return { ...pendingRow(record.callId, scope, now), kind: "refused", bookId: record.bookId, activityId: record.activityId, pendingAt: undefined };
}

/** The final state of a call, in the row: what `end` replaces, the texts staying as they are. */
function applyEnd(row: CallRow, final: AiCallEnd): void {
  if (!row.record) return;
  row.record = structuredClone({ ...row.record, status: final.status, response: final.response, attempts: final.attempts, timing: final.timing, storedBytes: final.storedBytes, dropped: final.dropped });
  row.ended = true;
}

/** The last response that has text: the one a read without an attempt means. */
function lastAttemptWithText(row: CallRow): number {
  let last = 0;
  for (const [attempt, length] of Object.entries(row.lengths)) if (length > 0 && Number(attempt) > last) last = Number(attempt);
  return last;
}

/** Removes a task: its calls and their texts and chunks, and the task. The totals of the book are for the caller. */
async function dropTask(tx: Tx, task: TaskRow, range: typeof IDBKeyRange): Promise<void> {
  for (const id of await tx.indexGetAllKeys("calls", "byTask", range.only([task.scope, task.bookId, task.activityId]))) {
    await tx.delete("texts", tx.prefix(id as string));
    await tx.delete("chunks", tx.prefix(id as string));
    await tx.delete("calls", id);
  }
  await tx.delete("tasks", [task.scope, task.bookId, task.activityId]);
}
