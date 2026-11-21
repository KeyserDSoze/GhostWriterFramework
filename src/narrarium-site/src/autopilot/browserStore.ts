import { BookConflictError, isTextBookPath, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "narrarium-engine";
import { getLocalFile, getLocalRepository, listLocalFiles, mutateLocalTextFilesAndCreateCommitAtomically, type LocalRepositoryMeta } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import type { BookEntry } from "@/types/settings";

export class LocalWorkingCopyMissingError extends Error {
  constructor() {
    super("Open the book once so Narrarium can prepare its local working copy, then retry.");
    this.name = "LocalWorkingCopyMissingError";
  }
}

async function repository(book: BookEntry, branch: string): Promise<LocalRepositoryMeta> {
  const scope = captureRepositoryOperationScope();
  const meta = await getLocalRepository(book.owner, book.repo, branch, scope);
  if (!meta || meta.bookId !== book.id || meta.cloneComplete !== true) throw new LocalWorkingCopyMissingError();
  return meta;
}

/**
 * The engine's `BookStore` over the book's local working copy (IndexedDB).
 * Every autopilot step becomes one atomic local commit, published with the usual repository sync.
 */
export function createBrowserBookStore(book: BookEntry, branch: string): BookStore {
  return {
    async list(): Promise<BookFileEntry[]> {
      const meta = await repository(book, branch);
      const files = await listLocalFiles(meta.id);
      return files
        .filter((file) => file.kind === "text" && isTextBookPath(file.path))
        .map((file) => ({ path: file.path, hash: file.currentHash }));
    },
    async read(path: string): Promise<BookFileContent | null> {
      const meta = await repository(book, branch);
      const file = await getLocalFile(meta.id, path, captureRepositoryOperationScope());
      if (!file || file.kind !== "text" || file.text === undefined) return null;
      return { path, content: file.text, hash: file.currentHash };
    },
    async commit(changes: BookFileChange[], message: string): Promise<BookCommitResult> {
      const meta = await repository(book, branch);
      try {
        const commit = await mutateLocalTextFilesAndCreateCommitAtomically(meta.id, captureRepositoryOperationScope(), message, changes.map((change) => ({
          path: change.path,
          content: change.content,
          expectedCurrentHash: change.expectedHash,
        })));
        return { revision: commit.id };
      } catch (error) {
        if (error instanceof Error && /changed since it was read/i.test(error.message)) throw new BookConflictError(error.message);
        throw error;
      }
    },
  };
}
