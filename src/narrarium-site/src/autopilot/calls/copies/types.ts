/**
 * The remote copies of the AI call records: the shapes the copier, its targets and its two small stores share. The records themselves live in
 * the local `AiCallStore` (the engine's port); a copy is an archive of finished tasks in the account the author chose, one file per task.
 */

/** Where a book's records are also copied: its GitHub repository (a dedicated branch), the hidden app folder of Google Drive, or OneDrive's app folder. */
export type CopyTargetKind = "github" | "google-drive" | "onedrive";

export const COPY_TARGET_KINDS: readonly CopyTargetKind[] = ["github", "google-drive", "onedrive"];

export function isCopyTargetKind(value: unknown): value is CopyTargetKind {
  return typeof value === "string" && (COPY_TARGET_KINDS as readonly string[]).includes(value);
}

const MIB = 1024 * 1024;

/** The caps of an archive and the limits of one file, per target. `trim` deletes the oldest day-folders to make room; `stop` stops copying and warns (history is never rewritten). */
export const COPY_LIMITS: Record<CopyTargetKind, { archiveBytes: number; mode: "trim" | "stop"; maxFileBytes: number }> = {
  github: { archiveBytes: 512 * MIB, mode: "stop", maxFileBytes: 50 * MIB },
  "google-drive": { archiveBytes: 2048 * MIB, mode: "trim", maxFileBytes: 100 * MIB },
  onedrive: { archiveBytes: 2048 * MIB, mode: "trim", maxFileBytes: 100 * MIB },
};

/** The name of the dedicated branch of a book's repository. */
export const COPY_GITHUB_BRANCH = "narrarium-ai-calls";

/** Retry timing: the first retry waits 30 seconds, then it doubles up to an hour; the scheduler also looks every five minutes. */
export const COPY_RETRY = { firstMs: 30_000, maxMs: 60 * 60_000, intervalMs: 5 * 60_000 } as const;

/**
 * Why a copy did not happen. Each code is a state the page words, in both languages:
 * - `reconnect`: the sign-in (or the GitHub token) must be renewed or there is no connection;
 * - `offline`: the device or the service cannot be reached; retried when it is back;
 * - `public-repository`: the repository is public, so nothing is written (GitHub keeps history after deletion);
 * - `unavailable`: the target cannot hold the copies (no repository, an empty one, no permission);
 * - `rate-limited`: the service asked to wait;
 * - `archive-full`: GitHub's 512 MiB archive is full: copying stops until the author deletes the copies;
 * - `too-large`: one task is over what the target accepts: it is skipped;
 * - `failed`: anything else; retried.
 */
export type CopyErrorCode = "reconnect" | "offline" | "public-repository" | "unavailable" | "rate-limited" | "archive-full" | "too-large" | "failed";

export class CopyError extends Error {
  readonly code: CopyErrorCode;
  /** For `rate-limited`: how long the service asked to wait. */
  readonly retryAfterMs?: number;
  constructor(code: CopyErrorCode, message?: string, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(message ?? code);
    this.name = "CopyError";
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    this.code = code;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** A task waiting to be copied. `scope` is the account scope it was queued under: an item of another scope is dropped, never copied (the account fence). */
export interface CopyOutboxItem {
  bookId: string;
  taskId: string;
  target: CopyTargetKind;
  attempts: number;
  /** The time (ms since the epoch) from which the copy may be tried again. */
  nextAt: number;
  /** The code of the last failure, or null when it never failed. */
  error: CopyErrorCode | null;
  scope?: string | null;
}

/**
 * The persistent list of what is still to copy. The browser's store `outbox` of `narrarium-ai-calls` implements it (wired after the merge); `MemoryCopyOutbox`
 * is the reference. An item is identified by `bookId`, `taskId` and `target`; `put` of an item that exists replaces it.
 */
export interface CopyOutbox {
  put(item: CopyOutboxItem): Promise<void>;
  list(bookId?: string): Promise<CopyOutboxItem[]>;
  delete(bookId: string, taskId: string, target: CopyTargetKind): Promise<void>;
}

/** One task that was copied: the day-folder it is in (`YYYY/MM/DD`) and the bytes it takes there (0 once its day was deleted to make room). */
export type CopiedTask = [day: string, bytes: number];

/** What the archive of one book on one target holds, as the copier knows it. It is what the page shows and what makes a copy idempotent. */
export interface CopyLedgerState {
  target: CopyTargetKind;
  copied: Record<string, CopiedTask>;
  /** The bytes the archive takes (the sum of `copied`). */
  bytes: number;
  /** The end of the newest task that was copied. */
  copiedUpTo: string | null;
  /** Set when the archive stopped copying: the page says why and what to do. */
  warning: "archive-full" | null;
  /** Task ids that are over the target's file limit: they are skipped. */
  skipped: string[];
  /** How many day-folders were deleted to stay inside the cap. */
  trimmedDays: number;
}

export function emptyLedger(target: CopyTargetKind): CopyLedgerState {
  return { target, copied: {}, bytes: 0, copiedUpTo: null, warning: null, skipped: [], trimmedDays: 0 };
}

export interface CopyLedger {
  read(bookId: string, target: CopyTargetKind, scope: string | null): Promise<CopyLedgerState>;
  write(bookId: string, target: CopyTargetKind, scope: string | null, state: CopyLedgerState): Promise<void>;
  clear(bookId: string, target: CopyTargetKind, scope: string | null): Promise<void>;
}

/** A file of a batch: its path under the target's root (`YYYY/MM/DD/<HHmmss>-<activityId>.ndjson.gz`) and its bytes. */
export interface CopyFile {
  taskId: string;
  path: string;
  bytes: Uint8Array;
}

/** What a target did with a batch: the files it wrote or found already there (`taskId` and the bytes they take), and the day-folders it deleted to make room. */
export interface CopyWriteResult {
  written: Array<{ taskId: string; bytes: number }>;
}

/**
 * Where a book's records are copied. The three implementations (`targets/`) are written against small API interfaces, so that the copier is tested
 * with fake providers. A target throws `CopyError` for everything it can tell apart; any other error is classified by `classifyCopyFailure`.
 */
export interface CopyTarget {
  readonly kind: CopyTargetKind;
  /** Verifies that copies may be written (a public repository is refused) and creates what the first write needs. Called before each batch. */
  prepare(): Promise<void>;
  /**
   * Writes files, one after the other. A file already there is left as it is. `onWritten` is called after each file that landed, so that what was done
   * is recorded even when a later file fails (GitHub writes a batch as one commit: all of it, or none).
   */
  write(files: CopyFile[], onWritten: (taskId: string, bytes: number) => Promise<void>): Promise<void>;
  /** Deletes the day-folders (`YYYY/MM/DD`) from the archive. Only targets that trim (Drive, OneDrive). */
  removeDays(days: string[]): Promise<void>;
  /** Deletes the whole archive of the book on the target. */
  removeAll(): Promise<void>;
}

/** What the page shows of the copy of one book. */
export interface CopyStatus {
  target: CopyTargetKind;
  /** Tasks still to copy. */
  waiting: number;
  /** The code of the failure that holds them, or null. */
  error: CopyErrorCode | null;
  offline: boolean;
  copiedUpTo: string | null;
  bytes: number;
  capBytes: number;
  warning: "archive-full" | null;
  trimmedDays: number;
  copiedTasks: number;
}
