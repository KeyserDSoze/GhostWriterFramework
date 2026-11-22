import { AUTOPILOT_STATE_FILE, type BookFileContent, type BookStore } from "narrarium-engine";
import { LocalWorkingCopyMissingError } from "@/autopilot/browserStore";
import { getLocalFile, getLocalRepository, listLocalFilesUnder } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import type { BookEntry } from "@/types/settings";

/** One chapter's folder as this browser has it, and whether the book has an autopilot (a state of its own). */
export interface ChapterFolder {
  /** Reads only: `chapter.md` and the scenes, as the engine's snapshot reads a book. */
  store: BookStore;
  hasAutopilot: boolean;
}

/**
 * The files of one chapter in the book's working copy, read with one range of keys: the page of a chapter checks its freeze without reading the
 * rest of the book. A book without a working copy (not opened in this browser yet) is `LocalWorkingCopyMissingError`.
 */
export async function readChapterFolder(book: BookEntry, branch: string, slug: string): Promise<ChapterFolder> {
  const scope = captureRepositoryOperationScope();
  const meta = await getLocalRepository(book.owner, book.repo, branch, scope);
  if (!meta || meta.bookId !== book.id || meta.cloneComplete !== true) throw new LocalWorkingCopyMissingError();
  const [files, state] = await Promise.all([listLocalFilesUnder(meta.id, `chapters/${slug}/`, scope), getLocalFile(meta.id, AUTOPILOT_STATE_FILE, scope)]);
  const texts = new Map(files.filter((file) => file.kind === "text" && file.text !== undefined).map((file) => [file.path, file]));
  const read = (path: string): BookFileContent | null => {
    const file = texts.get(path);
    return file ? { path, content: file.text!, hash: file.currentHash } : null;
  };
  return {
    store: {
      list: async () => [...texts.values()].map((file) => ({ path: file.path, hash: file.currentHash })),
      read: async (path) => read(path),
      readMany: async (paths) => paths.map(read).filter((file): file is BookFileContent => file !== null),
      commit: async () => {
        throw new Error("The view of a chapter's folder only reads.");
      },
    },
    hasAutopilot: Boolean(state),
  };
}
