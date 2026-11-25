import { bookStorageMode, type AppSettings, type AutoSyncMode, type BookBranchMemory, type BookEntry } from "@/types/settings";
import { changed, recordBranchUse, withBookBranchMemory } from "@/branches/memory";

/**
 * The changes of the memory of the branches that the person makes (choose, forget, a name, kept in sync, the automatic sync of a book): they load with the
 * switcher and the settings, not with the shell of the app, which only reads the memory (`@/branches/memory`).
 */

const MAX_LABEL = 60;

/** Out of the list: only the memory changes, the branch on GitHub and its copy on this device stay. */
export function forgetBranch(memory: BookBranchMemory | undefined, branch: string, at: string): BookBranchMemory {
  const forgetsLast = memory?.lastWorkingBranch === branch;
  const next = changed(memory, at, { knownBranches: (memory?.knownBranches ?? []).filter((entry) => entry.name !== branch) });
  if (!forgetsLast) return next;
  const { lastWorkingBranch: _branch, lastWorkingAt: _at, ...rest } = next;
  return rest;
}

/** A name of the person's for the branch in the lists (empty: none). The branch keeps its name, on GitHub and here. */
export function labelBranch(memory: BookBranchMemory | undefined, branch: string, label: string, at: string): BookBranchMemory {
  const clean = label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  return changed(memory, at, {
    knownBranches: (memory?.knownBranches ?? []).map((entry) => {
      if (entry.name !== branch) return entry;
      const { label: _label, ...rest } = entry;
      return clean && clean !== branch ? { ...rest, label: clean } : rest;
    }),
  });
}

/** Whether a known branch is kept in sync automatically: always (`true`), never (`false`), or by how recently it was used (`undefined`). */
export function keepBranchInSync(memory: BookBranchMemory | undefined, branch: string, sync: boolean | undefined, at: string): BookBranchMemory {
  return changed(memory, at, {
    knownBranches: (memory?.knownBranches ?? []).map((entry) => {
      if (entry.name !== branch) return entry;
      const { sync: _sync, ...rest } = entry;
      return sync === undefined ? rest : { ...rest, sync };
    }),
  });
}

/** The automatic sync of one book; `undefined` follows the default of the settings. */
export function setBookAutoSync(memory: BookBranchMemory | undefined, mode: AutoSyncMode | undefined, at: string): BookBranchMemory {
  const next = changed(memory, at, {});
  const { autoSync: _mode, ...rest } = next;
  return mode ? { ...rest, autoSync: mode } : rest;
}

/** This device chose `branch` for the book now: its own choice, and the memory's (the same instant, so that neither moves the other). */
export function chooseBranch(settings: AppSettings, book: BookEntry, branch: string, at: string, options: { createdHere?: boolean } = {}): Pick<AppSettings, "books" | "branchMemory"> {
  const books = settings.books.map((entry) => {
    if (entry.id !== book.id) return entry;
    const { adoptedFrom: _from, ...rest } = entry;
    return { ...rest, activeBranch: branch, activeBranchAt: at };
  });
  if (bookStorageMode(book) !== "github" || !book.owner || !book.repo) return { books, branchMemory: settings.branchMemory };
  return { books, ...withBookBranchMemory(settings, book, (memory) => recordBranchUse(memory, branch, at, { current: true, createdHere: options.createdHere })) };
}
