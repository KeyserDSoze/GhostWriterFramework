import i18n from "@/i18n";

/** Where earlier versions kept the base of a sync: one `localStorage` key per server and book. */
export const LEGACY_SYNC_BASE_PREFIX = "narrarium-server-sync-base-v1:";

const DB_NAME = "narrarium-autopilot-sync";
const DB_VERSION = 1;
const STORE = "bases";

/** What the next sync starts from: the manifest (path → content hash) both sides had when the last one ended. */
export interface StoredSyncBase {
  base: Map<string, string>;
  /** A base was saved before. Without one the sync is a first sync: it can only add, never delete. */
  found: boolean;
}

/** The base of a sync could not be read or saved: the author is told, instead of the next sync resurrecting deleted files. */
export class SyncBaseError extends Error {
  constructor(readonly operation: "read" | "write", readonly cause?: unknown) {
    super(i18n.t(operation === "write" ? "autopilot.errors.baseSaveFailed" : "autopilot.errors.baseReadFailed"));
    this.name = "SyncBaseError";
  }
}

interface StoredRecord {
  key: string;
  serverId: string;
  bookId: string;
  /** Pairs rather than an object, so a path such as `__proto__` is just a path. */
  files: Array<[string, string]>;
  savedAt: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let migration: Promise<void> | null = null;

const keyOf = (serverId: string, bookId: string) => `${serverId}:${bookId}`;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The sync database upgrade is blocked by another Narrarium tab."));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function readRecord(db: IDBDatabase, key: string): Promise<StoredRecord | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as StoredRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** One object in one transaction: it is saved whole or not at all. */
function putRecord(db: IDBDatabase, record: StoredRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new DOMException("The transaction was aborted.", "AbortError"));
      transaction.objectStore(STORE).put(record);
    } catch (error) {
      reject(error);
    }
  });
}

function deleteRecord(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new DOMException("The transaction was aborted.", "AbortError"));
    transaction.objectStore(STORE).delete(key);
  });
}

function parseLegacy(raw: string | null): Array<[string, string]> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string");
  } catch {
    return null;
  }
}

function legacyKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_SYNC_BASE_PREFIX)) keys.push(key);
    }
  } catch {
    // Without localStorage there is nothing to move.
  }
  return keys;
}

/**
 * Once per page: every base earlier versions kept in `localStorage` is written to IndexedDB and, only after that
 * worked, its old key is deleted. A base that already exists in the new place is not overwritten by an old copy.
 */
function migrateLegacyBases(db: IDBDatabase): Promise<void> {
  migration ??= (async () => {
    for (const legacy of legacyKeys()) {
      const key = legacy.slice(LEGACY_SYNC_BASE_PREFIX.length);
      const separator = key.indexOf(":");
      if (separator <= 0) continue;
      try {
        const existing = await readRecord(db, key);
        if (!existing) {
          const files = parseLegacy(localStorage.getItem(legacy));
          if (!files) {
            localStorage.removeItem(legacy);
            continue;
          }
          await putRecord(db, { key, serverId: key.slice(0, separator), bookId: key.slice(separator + 1), files, savedAt: new Date().toISOString() });
        }
        localStorage.removeItem(legacy);
      } catch {
        // The old copy stays where it is, and is still used (see `readSyncBase`); the next page tries again.
      }
    }
  })();
  return migration;
}

/** The base saved for a book on a server, moving the one an earlier version kept in `localStorage` the first time. */
export async function readSyncBase(serverId: string, bookId: string): Promise<StoredSyncBase> {
  const key = keyOf(serverId, bookId);
  let db: IDBDatabase;
  try {
    db = await openDb();
    await migrateLegacyBases(db);
  } catch (error) {
    throw new SyncBaseError("read", error);
  }
  let record: StoredRecord | undefined;
  try {
    record = await readRecord(db, key);
  } catch (error) {
    throw new SyncBaseError("read", error);
  }
  if (record) return { base: new Map(record.files), found: true };
  // The move failed for this book (the storage was full): the old copy is still the base to use.
  const legacy = parseLegacy((() => { try { return localStorage.getItem(`${LEGACY_SYNC_BASE_PREFIX}${key}`); } catch { return null; } })());
  return legacy ? { base: new Map(legacy), found: true } : { base: new Map(), found: false };
}

/** Save the base after a sync. Fails loudly: a base that was not saved makes the next sync bring deleted files back. */
export async function writeSyncBase(serverId: string, bookId: string, base: ReadonlyMap<string, string>): Promise<void> {
  const key = keyOf(serverId, bookId);
  try {
    const db = await openDb();
    await putRecord(db, { key, serverId, bookId, files: [...base.entries()], savedAt: new Date().toISOString() });
  } catch (error) {
    throw new SyncBaseError("write", error);
  }
  try {
    localStorage.removeItem(`${LEGACY_SYNC_BASE_PREFIX}${key}`);
  } catch {
    // The old key is only a leftover now.
  }
}

/** Forget the base of a book: the next sync is a first sync. */
export async function forgetSyncBase(serverId: string, bookId: string): Promise<void> {
  try {
    await deleteRecord(await openDb(), keyOf(serverId, bookId));
  } catch (error) {
    throw new SyncBaseError("write", error);
  }
}

/** Only for tests: close the database and forget what was migrated, as a new page would. */
export async function resetSyncBaseForTests(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  migration = null;
  if (!open) return;
  try {
    (await open).close();
  } catch {
    // It never opened.
  }
}
