import type { AiCallStore } from "narrarium-engine";
import { classifyCopyFailure } from "./classify";
import { dayOfPath, encodeTaskFile, readTaskForCopy, taskDayOf, taskFilePath } from "./format";
import {
  COPY_LIMITS,
  COPY_RETRY,
  CopyError,
  type CopyErrorCode,
  type CopyFile,
  type CopyLedger,
  type CopyLedgerState,
  type CopyOutbox,
  type CopyOutboxItem,
  type CopyStatus,
  type CopyTarget,
  type CopyTargetKind,
} from "./types";

export interface CallsCopierDeps {
  /** The local store the finished tasks are read from (the engine's `AiCallStore`; the browser's IndexedDB host, or the memory store in tests). */
  store: () => AiCallStore | null;
  outbox: CopyOutbox;
  ledger: CopyLedger;
  /** The account scope now: an item queued under another one is dropped, never copied (the same fence the repository operations have). */
  scope: () => string | null;
  /** The target of a book. It may throw `CopyError` (`reconnect` without a connection). */
  openTarget: (bookId: string, kind: CopyTargetKind) => Promise<CopyTarget>;
  now?: () => number;
  online?: () => boolean;
  /** How many files one slice writes before the outbox is read again (25). */
  sliceSize?: number;
  /** Called when the outbox or the ledger of a book changed, so that a page can draw it again. */
  onChange?: (bookId: string, kind: CopyTargetKind) => void;
}

export interface RunOptions {
  /** Ignore the waiting time of the items: the device is back online, or a token was renewed. */
  force?: boolean;
}

const SEVERITY: CopyErrorCode[] = ["public-repository", "reconnect", "archive-full", "unavailable", "rate-limited", "offline", "failed", "too-large"];

function backoffMs(attempts: number, error: CopyError): number {
  const exponential = Math.min(COPY_RETRY.maxMs, COPY_RETRY.firstMs * 2 ** Math.max(0, attempts - 1));
  return error.retryAfterMs !== undefined ? Math.max(exponential, error.retryAfterMs) : exponential;
}

/**
 * Copies the finished tasks of a book's local `AiCallStore` to the target the author chose, one file per task, from the browser. It never writes into
 * the store, never blocks a run or the page (every failure is caught and queued for a retry), and never copies a task twice: the file name comes from the
 * task, and what was copied is in the ledger. What is waiting is in the persistent outbox, so a reload resumes it; an account change drops it.
 */
export class CallsCopier {
  private readonly now: () => number;
  private readonly online: () => boolean;
  private readonly sliceSize: number;
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: CallsCopierDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.online = deps.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
    this.sliceSize = deps.sliceSize ?? 25;
  }

  private changed(bookId: string, kind: CopyTargetKind): void {
    try { this.deps.onChange?.(bookId, kind); } catch { /* a listener never stops a copy */ }
  }

  /** Puts a finished task in the outbox. A task already copied, or already waiting, is left as it is. */
  async enqueue(bookId: string, kind: CopyTargetKind, taskId: string): Promise<void> {
    const scope = this.deps.scope();
    const ledger = await this.deps.ledger.read(bookId, kind, scope);
    if (ledger.warning || ledger.copied[taskId] || ledger.skipped.includes(taskId)) return;
    const waiting = await this.deps.outbox.list(bookId);
    if (waiting.some((item) => item.target === kind && item.taskId === taskId && (item.scope ?? null) === scope)) return;
    await this.deps.outbox.put({ bookId, taskId, target: kind, attempts: 0, nextAt: 0, error: null, scope });
    this.changed(bookId, kind);
  }

  /** Queues every finished task the local store holds that is not copied yet (what choosing a target does, and what a reload repeats). Returns how many were queued. */
  async scan(bookId: string, kind: CopyTargetKind): Promise<number> {
    const store = this.deps.store();
    if (!store) return 0;
    const scope = this.deps.scope();
    const ledger = await this.deps.ledger.read(bookId, kind, scope);
    if (ledger.warning) return 0;
    const waiting = new Set((await this.deps.outbox.list(bookId)).filter((item) => item.target === kind && (item.scope ?? null) === scope).map((item) => item.taskId));
    const found: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 1000; page += 1) {
      const result = await store.listTasks(bookId, { limit: 200, ...(before ? { before } : {}) });
      for (const header of result.tasks) {
        if (header.status === "running" || !header.endedAt) continue;
        if (ledger.copied[header.activityId] || ledger.skipped.includes(header.activityId) || waiting.has(header.activityId)) continue;
        found.push(header.activityId);
      }
      if (!result.next) break;
      before = result.next;
    }
    // The store lists newest first; the oldest is queued first.
    for (const taskId of found.reverse()) await this.deps.outbox.put({ bookId, taskId, target: kind, attempts: 0, nextAt: 0, error: null, scope });
    if (found.length) this.changed(bookId, kind);
    return found.length;
  }

  /** Copies what is due, one slice at a time. One run per book and target at a time: a call while one is going on waits for it. */
  run(bookId: string, kind: CopyTargetKind, options: RunOptions = {}): Promise<void> {
    const key = `${bookId}\u0000${kind}`;
    const active = this.running.get(key);
    if (active) return active;
    const promise = this.runOnce(bookId, kind, options).catch(() => undefined).finally(() => { this.running.delete(key); this.changed(bookId, kind); });
    this.running.set(key, promise);
    return promise;
  }

  async runAll(targets: ReadonlyArray<{ bookId: string; kind: CopyTargetKind }>, options: RunOptions = {}): Promise<void> {
    await Promise.all(targets.map(({ bookId, kind }) => this.run(bookId, kind, options)));
  }

  private async items(bookId: string, kind: CopyTargetKind, scope: string | null): Promise<CopyOutboxItem[]> {
    const all = (await this.deps.outbox.list(bookId)).filter((item) => item.target === kind);
    const current: CopyOutboxItem[] = [];
    for (const item of all) {
      if (item.scope !== undefined && (item.scope ?? null) !== scope) await this.deps.outbox.delete(item.bookId, item.taskId, item.target);
      else current.push(item);
    }
    return current;
  }

  private async fail(items: CopyOutboxItem[], error: CopyError): Promise<void> {
    const at = this.now();
    for (const item of items) {
      const attempts = item.attempts + 1;
      await this.deps.outbox.put({ ...item, attempts, error: error.code, nextAt: at + backoffMs(attempts, error) });
    }
  }

  private async runOnce(bookId: string, kind: CopyTargetKind, options: RunOptions): Promise<void> {
    const scope = this.deps.scope();
    const store = this.deps.store();
    let queue = await this.items(bookId, kind, scope);
    if (!queue.length || !store) return;
    let ledger = await this.deps.ledger.read(bookId, kind, scope);
    if (ledger.warning === "archive-full") return;
    const at = this.now();
    const due = (items: CopyOutboxItem[]) => items.filter((item) => options.force || item.nextAt <= at);
    if (!due(queue).length || !this.online()) return;

    let target: CopyTarget;
    try {
      target = await this.deps.openTarget(bookId, kind);
      await target.prepare();
    } catch (error) {
      await this.fail(due(queue), classifyCopyFailure(error, this.online()));
      return;
    }

    const tried = new Set<string>();
    for (;;) {
      if (this.deps.scope() !== scope) { await this.items(bookId, kind, this.deps.scope()); return; }
      queue = await this.items(bookId, kind, scope);
      const slice = due(queue).filter((item) => !tried.has(item.taskId)).slice(0, this.sliceSize);
      if (!slice.length) return;
      for (const item of slice) tried.add(item.taskId);
      const files: Array<CopyFile & { item: CopyOutboxItem; day: string; endedAt: string | null }> = [];
      for (const item of slice) {
        ledger = await this.deps.ledger.read(bookId, kind, scope);
        if (ledger.copied[item.taskId]) { await this.deps.outbox.delete(bookId, item.taskId, kind); continue; }
        let built: Awaited<ReturnType<typeof readTaskForCopy>>;
        try { built = await readTaskForCopy(store, bookId, item.taskId); } catch (error) { await this.fail([item], classifyCopyFailure(error, this.online())); continue; }
        if (!built) {
          // A task that is gone from the local store (pruned) has nothing to copy; one that is still running is looked at again later.
          const header = (await store.readTask(bookId, item.taskId).catch(() => null))?.header;
          if (!header) await this.deps.outbox.delete(bookId, item.taskId, kind);
          else await this.deps.outbox.put({ ...item, nextAt: this.now() + COPY_RETRY.firstMs });
          continue;
        }
        const bytes = await encodeTaskFile(built);
        if (bytes.length > COPY_LIMITS[kind].maxFileBytes) {
          ledger.skipped = [...ledger.skipped, item.taskId];
          await this.deps.ledger.write(bookId, kind, scope, ledger);
          await this.deps.outbox.delete(bookId, item.taskId, kind);
          continue;
        }
        files.push({ taskId: item.taskId, path: taskFilePath(built.header), bytes, item, day: taskDayOf(built.header.startedAt), endedAt: built.header.endedAt });
      }
      if (!files.length) continue;

      ledger = await this.deps.ledger.read(bookId, kind, scope);
      const limits = COPY_LIMITS[kind];
      const incoming = files.reduce((sum, file) => sum + file.bytes.length, 0);
      if (ledger.bytes + incoming > limits.archiveBytes) {
        if (limits.mode === "stop") {
          ledger.warning = "archive-full";
          await this.deps.ledger.write(bookId, kind, scope, ledger);
          for (const item of await this.items(bookId, kind, scope)) await this.deps.outbox.delete(bookId, item.taskId, kind);
          return;
        }
        ledger = await this.makeRoom(target, bookId, kind, scope, ledger, incoming, new Set(files.map((file) => file.day)));
      }

      const done = new Set<string>();
      try {
        await target.write(files, async (taskId, bytes) => {
          const file = files.find((entry) => entry.taskId === taskId);
          if (!file) return;
          const current = await this.deps.ledger.read(bookId, kind, scope);
          if (!current.copied[taskId]) current.bytes += bytes;
          current.copied[taskId] = [file.day, bytes];
          if (file.endedAt && (!current.copiedUpTo || file.endedAt > current.copiedUpTo)) current.copiedUpTo = file.endedAt;
          await this.deps.ledger.write(bookId, kind, scope, current);
          await this.deps.outbox.delete(bookId, taskId, kind);
          done.add(taskId);
          this.changed(bookId, kind);
        });
      } catch (error) {
        const failure = classifyCopyFailure(error, this.online());
        if (this.deps.scope() !== scope) { await this.items(bookId, kind, this.deps.scope()); return; }
        const rest = files.filter((file) => !done.has(file.taskId)).map((file) => file.item);
        if (failure.code === "archive-full") {
          const current = await this.deps.ledger.read(bookId, kind, scope);
          current.warning = "archive-full";
          await this.deps.ledger.write(bookId, kind, scope, current);
          for (const item of await this.items(bookId, kind, scope)) await this.deps.outbox.delete(bookId, item.taskId, kind);
        } else await this.fail(rest, failure);
        return;
      }
    }
  }

  /** Deletes the oldest day-folders (not the ones about to be written) until the incoming bytes fit under the cap. */
  private async makeRoom(target: CopyTarget, bookId: string, kind: CopyTargetKind, scope: string | null, ledger: CopyLedgerState, incoming: number, keep: Set<string>): Promise<CopyLedgerState> {
    const perDay = new Map<string, number>();
    for (const [day, bytes] of Object.values(ledger.copied)) if (bytes > 0 && !keep.has(day)) perDay.set(day, (perDay.get(day) ?? 0) + bytes);
    const days = [...perDay.keys()].sort();
    let total = ledger.bytes;
    const doomed: string[] = [];
    for (const day of days) {
      if (total + incoming <= COPY_LIMITS[kind].archiveBytes) break;
      doomed.push(day);
      total -= perDay.get(day) ?? 0;
    }
    if (!doomed.length) return ledger;
    await target.removeDays(doomed);
    const next = await this.deps.ledger.read(bookId, kind, scope);
    for (const [taskId, [day, bytes]] of Object.entries(next.copied)) {
      if (!doomed.includes(day)) continue;
      next.bytes -= bytes;
      next.copied[taskId] = [day, 0];
    }
    next.trimmedDays += doomed.length;
    await this.deps.ledger.write(bookId, kind, scope, next);
    return next;
  }

  /** What the page shows: what waits, why it waits, and what the archive holds. */
  async status(bookId: string, kind: CopyTargetKind): Promise<CopyStatus> {
    const scope = this.deps.scope();
    const items = (await this.deps.outbox.list(bookId)).filter((item) => item.target === kind && (item.scope === undefined || (item.scope ?? null) === scope));
    const ledger = await this.deps.ledger.read(bookId, kind, scope);
    const codes = items.map((item) => item.error).filter((code): code is CopyErrorCode => code !== null);
    const error = SEVERITY.find((code) => codes.includes(code)) ?? null;
    return {
      target: kind,
      waiting: items.length,
      error,
      offline: !this.online(),
      copiedUpTo: ledger.copiedUpTo,
      bytes: ledger.bytes,
      capBytes: COPY_LIMITS[kind].archiveBytes,
      warning: ledger.warning,
      trimmedDays: ledger.trimmedDays,
      copiedTasks: Object.values(ledger.copied).filter(([, bytes]) => bytes > 0).length,
    };
  }

  /** Checks that the target accepts copies now (a public repository does not). Returns the code of the refusal, or null. */
  async check(bookId: string, kind: CopyTargetKind): Promise<CopyErrorCode | null> {
    try {
      const target = await this.deps.openTarget(bookId, kind);
      await target.prepare();
      return null;
    } catch (error) {
      return classifyCopyFailure(error, this.online()).code;
    }
  }

  /** Stops waiting for a book's target (the author chose another one, or none): its outbox is emptied; what was already copied stays where it is. */
  async forget(bookId: string, kind: CopyTargetKind): Promise<void> {
    for (const item of (await this.deps.outbox.list(bookId)).filter((entry) => entry.target === kind)) await this.deps.outbox.delete(bookId, item.taskId, kind);
    this.changed(bookId, kind);
  }

  /** Deletes the copies in the target and forgets them. Only the author's explicit second choice calls it. */
  async deleteCopies(bookId: string, kind: CopyTargetKind): Promise<void> {
    const scope = this.deps.scope();
    const target = await this.deps.openTarget(bookId, kind);
    await target.removeAll();
    await this.forget(bookId, kind);
    await this.deps.ledger.clear(bookId, kind, scope);
    this.changed(bookId, kind);
  }
}

export { dayOfPath };
