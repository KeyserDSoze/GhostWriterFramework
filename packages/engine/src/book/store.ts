import { sha256Hex } from "../util/hash.js";

export interface BookFileEntry {
  path: string;
  /** Lowercase hex SHA-256 of the UTF-8 content. */
  hash: string;
}

export interface BookFileContent extends BookFileEntry {
  content: string;
}

export interface BookFileChange {
  path: string;
  /** New text, or `null` to delete the file. */
  content: string | null;
  /** `undefined` skips validation, `null` requires the file to be absent, a hash requires that exact content. */
  expectedHash?: string | null;
}

export interface BookCommitResult {
  revision?: string;
}

/**
 * The only way the engine touches a book. The browser implements it over the IndexedDB
 * working copy, the server over a git working tree. Both must apply a commit atomically
 * and reject it with `BookConflictError` when any `expectedHash` does not match.
 */
export interface BookStore {
  /** Text files of the book with their content hashes. */
  list(): Promise<BookFileEntry[]>;
  read(path: string): Promise<BookFileContent | null>;
  /**
   * Several files at once, in the order asked, each once; a file that does not exist is left out. A store over a
   * network provides it so that a big book is not read with one request per file; callers fall back to `read`.
   */
  readMany?(paths: string[]): Promise<BookFileContent[]>;
  commit(changes: BookFileChange[], message: string): Promise<BookCommitResult>;
}

export class BookConflictError extends Error {
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "BookConflictError";
  }
}

export function isBookConflictError(error: unknown): error is BookConflictError {
  return error instanceof BookConflictError || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "BookConflictError");
}

export async function readText(store: BookStore, path: string): Promise<string | null> {
  return (await store.read(path))?.content ?? null;
}

export async function contentEntry(path: string, content: string): Promise<BookFileContent> {
  return { path, content, hash: await sha256Hex(content) };
}

/** Keep only effective changes and drop duplicates (last write wins). */
export function normalizeChanges(changes: BookFileChange[]): BookFileChange[] {
  const byPath = new Map<string, BookFileChange>();
  for (const change of changes) {
    const previous = byPath.get(change.path);
    byPath.set(change.path, previous && change.expectedHash === undefined ? { ...change, expectedHash: previous.expectedHash } : change);
  }
  return [...byPath.values()];
}
