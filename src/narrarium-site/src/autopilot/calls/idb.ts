/**
 * What the AI call store needs of IndexedDB, and nothing else: a transaction whose steps are awaited (the continuation of an awaited request runs while the
 * transaction is still active, which is how every browser and `fake-indexeddb` behave), and the key ranges of a prefix of a composite key. A transaction that fails
 * is aborted and its error is the one that comes out; a transaction is never left open.
 */

/** The object stores of the database. */
export type AiCallStoreName = "tasks" | "calls" | "texts" | "chunks" | "totals" | "outbox" | "meta";

/** The reason a step stops a transaction without being a failure: the account changed, so the write is dropped. */
export class AiCallFencedSignal extends Error {
  constructor() {
    super("The AI calls of this account are not written: the account changed.");
    this.name = "AiCallFencedSignal";
  }
}

/** The database could not be opened, or was closed under the store (blocked by another tab, a version it does not know, a browser that refuses). */
export class AiCallStoreUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AiCallStoreUnavailableError";
  }
}

/** The factory and the key range class of the IndexedDB the store runs on: the page's, or a fake in a test. */
export interface IdbEnvironment {
  factory: IDBFactory;
  range: typeof IDBKeyRange;
}

/** One request, as a promise of its result. */
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("An IndexedDB request failed."));
  });
}

/** A transaction with the steps the store takes, each one a promise of its request. */
export class Tx {
  constructor(readonly raw: IDBTransaction, private readonly range: typeof IDBKeyRange) {}

  private store(name: AiCallStoreName): IDBObjectStore {
    return this.raw.objectStore(name);
  }

  /** The keys that start with `parts`: `[a, b]` is before `[a, b, x]` and `[a, b, []]` is after every `[a, b, x]` that is not an array. */
  prefix(...parts: IDBValidKey[]): IDBKeyRange {
    return this.range.bound(parts, [...parts, []]);
  }

  get<T>(name: AiCallStoreName, key: IDBValidKey): Promise<T | undefined> {
    return requestResult(this.store(name).get(key)) as Promise<T | undefined>;
  }

  put(name: AiCallStoreName, value: unknown): Promise<unknown> {
    return requestResult(this.store(name).put(value));
  }

  delete(name: AiCallStoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
    return requestResult(this.store(name).delete(key)).then(() => undefined);
  }

  getAll<T>(name: AiCallStoreName, range?: IDBKeyRange): Promise<T[]> {
    return requestResult(this.store(name).getAll(range)) as Promise<T[]>;
  }

  getAllKeys(name: AiCallStoreName, range?: IDBKeyRange): Promise<IDBValidKey[]> {
    return requestResult(this.store(name).getAllKeys(range));
  }

  indexGetAll<T>(name: AiCallStoreName, index: string, range?: IDBKeyRange): Promise<T[]> {
    return requestResult(this.store(name).index(index).getAll(range)) as Promise<T[]>;
  }

  indexGetAllKeys(name: AiCallStoreName, index: string, range?: IDBKeyRange): Promise<IDBValidKey[]> {
    return requestResult(this.store(name).index(index).getAllKeys(range));
  }

  count(name: AiCallStoreName, range?: IDBKeyRange): Promise<number> {
    return requestResult(this.store(name).count(range));
  }

  /**
   * Visits the rows of an index (or of the store, with no index) in a range, in `direction`, until `visit` returns `false`: a cursor that never reads more than
   * the caller wants.
   */
  scan<T>(name: AiCallStoreName, options: { index?: string; range?: IDBKeyRange; direction?: IDBCursorDirection }, visit: (value: T, primaryKey: IDBValidKey) => boolean | void): Promise<void> {
    const source = options.index ? this.store(name).index(options.index) : this.store(name);
    return new Promise<void>((resolve, reject) => {
      const request = source.openCursor(options.range, options.direction);
      request.onerror = () => reject(request.error ?? new Error("An IndexedDB cursor failed."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        if (visit(cursor.value as T, cursor.primaryKey) === false) return resolve();
        cursor.continue();
      };
    });
  }

  /** The keys of a store, one per distinct first part of a composite key (a cursor that jumps over the rest of each prefix). */
  distinctFirstParts(name: AiCallStoreName): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const found: string[] = [];
      const request = this.store(name).openKeyCursor();
      request.onerror = () => reject(request.error ?? new Error("An IndexedDB cursor failed."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(found);
        const first = (cursor.key as IDBValidKey[])[0] as string;
        found.push(first);
        cursor.continue([first, []]);
      };
    });
  }
}

/** Runs the steps of `work` in one transaction: it commits when they are all done, and is aborted, with the error that stopped it, when one fails. */
export async function runTransaction<T>(db: IDBDatabase, range: typeof IDBKeyRange, stores: readonly AiCallStoreName[], mode: IDBTransactionMode, work: (tx: Tx) => Promise<T>): Promise<T> {
  const raw = db.transaction([...stores], mode);
  let finished = false;
  const done = new Promise<void>((resolve, reject) => {
    raw.oncomplete = () => {
      finished = true;
      resolve();
    };
    raw.onabort = () => {
      finished = true;
      reject(raw.error ?? new DOMException("The transaction was aborted.", "AbortError"));
    };
  });
  // A failure that is told through the steps is the one that comes out: the abort that follows it is not another one.
  done.catch(() => undefined);
  let failure: unknown;
  let failed = false;
  let result: T | undefined;
  try {
    result = await work(new Tx(raw, range));
  } catch (error) {
    failed = true;
    failure = error;
    if (!finished) {
      try {
        raw.abort();
      } catch {
        // Already finished.
      }
    }
  }
  try {
    await done;
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result as T;
}

/** Whether an error is the browser saying that the origin is out of space. */
export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  return name === "QuotaExceededError" || code === 22 || (typeof message === "string" && /quota/i.test(message) && name !== "TypeError");
}
