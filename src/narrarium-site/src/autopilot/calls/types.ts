import type { AiCallStore } from "narrarium-engine";

/** What the browser answered when the store asked it to keep the data (`navigator.storage.persist()`): asked on the first write, once. */
export type PersistenceState = "unknown" | "pending" | "granted" | "denied" | "unsupported";

/**
 * A copy of a finished task that is waiting for a place outside this device (the copies of the settings: GitHub, Google Drive, OneDrive). The store keeps the list and
 * nothing else: it never copies. `target` is the name the copies give the place; `nextAt` is the time of the next try (null: now); `attempts` how many tries failed; `error` the last one, cleaned.
 */
export interface AiCallOutboxEntry {
  bookId: string;
  taskId: string;
  target: string;
  attempts: number;
  nextAt: string | null;
  error: string | null;
}

/** The outbox of the copies, in the current account's part of the database. */
export interface AiCallOutbox {
  /** Adds the entry or replaces the one of the same book, task and target. */
  put(entry: AiCallOutboxEntry): Promise<void>;
  /** The entries, the ones due first. `dueBy` is a time: only the entries to try by then (no `nextAt` is due at any time). */
  list(filter?: { bookId?: string; target?: string; dueBy?: string }): Promise<AiCallOutboxEntry[]>;
  /** Removes the entry (nothing happens when there is none). */
  delete(bookId: string, taskId: string, target: string): Promise<void>;
}

/** The budgets in force, in bytes: the engine's, kept within a quarter of the room the browser says this origin has. */
export interface AiCallBudgetsInEffect {
  perBookBytes: number;
  perDeviceBytes: number;
  /** What `navigator.storage.estimate()` said, when it said. */
  quotaBytes: number | null;
  usageBytes: number | null;
}

/** What the store can say of itself, for a page that shows it. */
export interface AiCallStoreStatus {
  persistence: PersistenceState;
  budgets: AiCallBudgetsInEffect;
}

/** How many rows each part of the database holds: for a test or a page that wants to see that the live chunks were folded. */
export interface AiCallStoreStats {
  tasks: number;
  calls: number;
  texts: number;
  chunks: number;
  /** Calls whose first write is not their `begin` yet, and calls that were refused (the task already held its limit). */
  pending: number;
  outbox: number;
}

/** The part of `navigator.storage` that the store uses. */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

/** How the store is built: every field has the browser's own as its default, and a test gives its own. */
export interface AiCallStoreOptions {
  /** The IndexedDB to use (default: the page's). */
  factory?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  /** The name of the database and its version (a test that checks what happens when another tab upgrades gives a higher one). */
  name?: string;
  version?: number;
  /**
   * The account the page is in: a store acts for an account, and what it writes it writes for that account; when the account changes a write
   * of the old one is dropped. Default: the site's own (`currentRepositoryScopeIdentity`).
   */
  scope?: () => string;
  /** `navigator.storage` (default: the page's). */
  storage?: StorageManagerLike | null;
  /** Replaces the budgets of the engine (a test gives small ones). */
  budgets?: { perBookBytes?: number; perDeviceBytes?: number };
  /** How long an open waits for another tab that holds an older version open, and how long it waits at all (milliseconds). */
  blockedTimeoutMs?: number;
  openTimeoutMs?: number;
  /** The time, in milliseconds: a test moves it. */
  now?: () => number;
  /** Whether to fold the live chunks that an earlier page left, as the store opens (default: yes). */
  recover?: boolean;
}

/** The store the browser keeps, for the places that only need the port. */
export type BrowserAiCallStore = AiCallStore;
