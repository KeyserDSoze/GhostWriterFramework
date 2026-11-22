import { AUTOPILOT_STATE_FILE, normalizeAutopilotState, type AutopilotState, type BookFileChange, type BookStore } from "narrarium-engine";
import { LocalWorkingCopyMissingError, createBrowserBookStore } from "@/autopilot/browserStore";
import { getLocalRepository, listLocalFilesUnder } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { isOutlinePath, type OutlineFile } from "@/outline/outlineModel";
import type { BookEntry } from "@/types/settings";

/**
 * Where the Outline page reads and saves the outline. In the app it is the book's local working copy, through the same `BookStore` the
 * autopilot and the Director page write with: every save is one local commit, published with the book like any other, and a book whose
 * autopilot runs on the personal server receives it with the usual sync. A commit expects the files as they were read, so a version
 * that changed in the meantime is never overwritten (`BookConflictError`).
 */
export interface OutlineSource {
  /** The files of `outline/`, with their text and hash. */
  files(): Promise<OutlineFile[]>;
  commit(changes: BookFileChange[], message: string): Promise<void>;
  /** The autopilot's state (`autopilot/state.json`), for the plan: `null` when the book has none or it cannot be read. */
  readState(): Promise<AutopilotState | null>;
  /** Other files of the book (the canon an entry mentions, for the assistant), the ones that exist. */
  readFiles(paths: string[]): Promise<Array<{ path: string; content: string }>>;
}

async function readFrom(store: BookStore, paths: string[]): Promise<Array<{ path: string; content: string }>> {
  if (!paths.length) return [];
  const files = store.readMany ? await store.readMany(paths) : (await Promise.all(paths.map((path) => store.read(path)))).filter((file) => file !== null);
  return files.map((file) => ({ path: file.path, content: file.content }));
}

const OUTLINE_PREFIX = "outline/";

function stateOf(content: string | undefined): AutopilotState | null {
  if (!content) return null;
  try {
    return normalizeAutopilotState(JSON.parse(content));
  } catch {
    return null;
  }
}

/** Some files of the outline as they are now, with the hash a commit expects of them (`null`: the file is not there). */
export async function outlineFilesAt(source: OutlineSource, paths: readonly string[]): Promise<Array<{ content: string; sha: string } | null>> {
  const files = new Map((await source.files()).map((file) => [file.path, file]));
  return paths.map((path) => {
    const file = files.get(path);
    return file ? { content: file.content, sha: file.hash } : null;
  });
}

/** The outline of any `BookStore` (the tests, a host without a working copy). */
export function storeOutlineSource(store: BookStore): OutlineSource {
  return {
    async files() {
      const paths = (await store.list()).map((entry) => entry.path).filter(isOutlinePath);
      if (!paths.length) return [];
      const files = store.readMany ? await store.readMany(paths) : (await Promise.all(paths.map((path) => store.read(path)))).filter((file) => file !== null);
      return files.map((file) => ({ path: file.path, content: file.content, hash: file.hash })).sort((left, right) => left.path.localeCompare(right.path));
    },
    async commit(changes, message) {
      await store.commit(changes, message);
    },
    async readState() {
      return stateOf((await store.read(AUTOPILOT_STATE_FILE))?.content);
    },
    readFiles: (paths) => readFrom(store, paths),
  };
}

/** The outline of a book in this browser: its working copy, read one folder at a time. */
export function browserOutlineSource(book: BookEntry, branch: string): OutlineSource {
  const store = createBrowserBookStore(book, branch);
  return {
    async files() {
      const scope = captureRepositoryOperationScope();
      const meta = await getLocalRepository(book.owner, book.repo, branch, scope);
      if (!meta || meta.bookId !== book.id || meta.cloneComplete !== true) throw new LocalWorkingCopyMissingError();
      const files = await listLocalFilesUnder(meta.id, OUTLINE_PREFIX, scope);
      return files
        .filter((file) => file.kind === "text" && file.text !== undefined)
        .map((file) => ({ path: file.path, content: file.text!, hash: file.currentHash }));
    },
    async commit(changes, message) {
      await store.commit(changes, message);
    },
    async readState() {
      return stateOf((await store.read(AUTOPILOT_STATE_FILE))?.content);
    },
    readFiles: (paths) => readFrom(store, paths),
  };
}
