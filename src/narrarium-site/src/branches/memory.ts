import { bookStorageMode, type AppSettings, type AutoSyncMode, type BookBranchMemory, type BookEntry, type KnownBranchRecord, type RepositorySettings } from "@/types/settings";

/**
 * The branches a person works on, per GitHub book, in the account data that syncs (`AppSettings.branchMemory`). Everything here is a pure function of the
 * settings: the views and the sync write a new record through these, and nothing but a choice of the person (or the first opening of a branch) writes it.
 */

/** The memory keeps at most this many branches of a book: beyond it the ones used longest ago are dropped (never the last working branch). */
export const MAX_KNOWN_BRANCHES = 50;
const MAX_LABEL = 60;

export function branchMemoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

export function bookBranchMemory(settings: Pick<AppSettings, "branchMemory">, book: Pick<BookEntry, "owner" | "repo"> | undefined): BookBranchMemory | undefined {
  if (!book?.owner || !book.repo) return undefined;
  return settings.branchMemory?.[branchMemoryKey(book.owner, book.repo)];
}

function newestFirst(left: KnownBranchRecord, right: KnownBranchRecord): number {
  return right.lastUsedAt.localeCompare(left.lastUsedAt) || left.name.localeCompare(right.name);
}

function trimmed(branches: KnownBranchRecord[], keep: string | undefined): KnownBranchRecord[] {
  const sorted = [...branches].sort(newestFirst);
  if (sorted.length <= MAX_KNOWN_BRANCHES) return sorted;
  const kept = sorted.slice(0, MAX_KNOWN_BRANCHES);
  const current = keep ? sorted.find((entry) => entry.name === keep) : undefined;
  return current && !kept.includes(current) ? [...kept.slice(0, -1), current] : kept;
}

function changed(memory: BookBranchMemory | undefined, at: string, patch: Partial<BookBranchMemory>): BookBranchMemory {
  const next = { knownBranches: [], ...memory, ...patch, updatedAt: at };
  return { ...next, knownBranches: trimmed(next.knownBranches, next.lastWorkingBranch) };
}

/** The person worked on `branch` (chose it, created it, opened it): it is known from now on, and with `current` it is the branch to open next time, anywhere. */
export function recordBranchUse(memory: BookBranchMemory | undefined, branch: string, at: string, options: { current?: boolean; createdHere?: boolean } = {}): BookBranchMemory {
  const known = memory?.knownBranches ?? [];
  const existing = known.find((entry) => entry.name === branch);
  const entry: KnownBranchRecord = { ...existing, name: branch, lastUsedAt: at, ...(existing?.createdHere || options.createdHere ? { createdHere: true } : {}) };
  return changed(memory, at, {
    knownBranches: [entry, ...known.filter((item) => item.name !== branch)],
    ...(options.current ? { lastWorkingBranch: branch, lastWorkingAt: at } : {}),
  });
}

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

/** The settings patch that replaces the memory of one book. */
export function withBookBranchMemory(settings: Pick<AppSettings, "branchMemory">, book: Pick<BookEntry, "owner" | "repo">, update: (memory: BookBranchMemory | undefined) => BookBranchMemory): Pick<AppSettings, "branchMemory"> {
  const key = branchMemoryKey(book.owner, book.repo);
  return { branchMemory: { ...settings.branchMemory, [key]: update(settings.branchMemory?.[key]) } };
}

/**
 * Two copies of the account data that both changed: each book keeps the record that changed last (`updatedAt`), whatever copy the person chose for the rest.
 * The first copy given wins a tie. A record only one copy has is kept.
 */
export function mergeBranchMemories(...copies: Array<Record<string, BookBranchMemory> | undefined>): Record<string, BookBranchMemory> | undefined {
  const merged: Record<string, BookBranchMemory> = {};
  for (const copy of copies) {
    for (const [key, record] of Object.entries(copy ?? {})) {
      if (!record || typeof record !== "object") continue;
      const current = merged[key];
      if (!current || String(record.updatedAt ?? "") > String(current.updatedAt ?? "")) merged[key] = record;
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

/** The default of the settings: chosen, or read from the switches of older versions; a person who never chose gets the sync on opening and on focus. */
export function defaultAutoSyncMode(repository: Partial<RepositorySettings> | undefined): AutoSyncMode {
  if (repository?.autoSync) return repository.autoSync;
  return (repository?.autoFetchIntervalMinutes ?? 0) > 0 ? "periodic" : "open-focus";
}

export function bookAutoSyncMode(settings: Pick<AppSettings, "repository" | "branchMemory">, book: Pick<BookEntry, "owner" | "repo"> | undefined): AutoSyncMode {
  return bookBranchMemory(settings, book)?.autoSync ?? defaultAutoSyncMode(settings.repository);
}

/** The branch this device should open because it is the one chosen last, on another device: only for a choice newer than the device's own. */
export function rememberedBranchToAdopt(book: BookEntry, memory: BookBranchMemory | undefined): string | null {
  if (bookStorageMode(book) !== "github" || !memory?.lastWorkingBranch || !memory.lastWorkingAt) return null;
  if (memory.lastWorkingBranch === book.activeBranch) return null;
  if (book.activeBranchAt && book.activeBranchAt >= memory.lastWorkingAt) return null;
  return memory.lastWorkingBranch;
}

/**
 * Each GitHub book whose memory names a newer branch than this device's takes it, remembering the one it had (`adoptedFrom`) for when it cannot be opened
 * here. `except` is the book on the screen: it is never moved under the person, it takes the branch the next time it is opened. `only` limits it to one book.
 */
export function adoptRememberedBranches(settings: AppSettings, options: { except?: string | null; only?: string } = {}): AppSettings {
  let adopted = false;
  const books = settings.books.map((book) => {
    if ((options.except && book.id === options.except) || (options.only && book.id !== options.only)) return book;
    const memory = bookBranchMemory(settings, book);
    const branch = rememberedBranchToAdopt(book, memory);
    if (!branch) return book;
    adopted = true;
    return { ...book, activeBranch: branch, activeBranchAt: memory!.lastWorkingAt, adoptedFrom: book.adoptedFrom ?? book.activeBranch ?? "" };
  });
  return adopted ? { ...settings, books } : settings;
}

/** The remembered branch opened on this device: it is this device's branch now. */
export function settleAdoptedBranch(book: BookEntry): BookEntry {
  const { adoptedFrom: _from, ...rest } = book;
  return rest;
}

/** The remembered branch cannot be opened here: the book goes back to the branch it had, and is not moved again until another choice is made. */
export function revertAdoptedBranch(book: BookEntry): BookEntry {
  const { adoptedFrom, activeBranch: _branch, ...rest } = book;
  return adoptedFrom ? { ...rest, activeBranch: adoptedFrom } : rest;
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

/**
 * A branch opened here that the memory does not know yet is recorded (the memory's working branch too, when it has none): the other devices learn of it.
 * This device's own choice is dated with it, so that it is not taken back as a choice of another device. `null`: nothing to record.
 */
export function recordOpenedBranch(settings: AppSettings, book: BookEntry, branch: string, at: string): Pick<AppSettings, "books" | "branchMemory"> | null {
  if (bookStorageMode(book) !== "github" || !book.owner || !book.repo || !branch) return null;
  const memory = bookBranchMemory(settings, book);
  if (memory?.lastWorkingBranch && memory.knownBranches.some((entry) => entry.name === branch)) return null;
  const current = !memory?.lastWorkingBranch;
  const books = current ? settings.books.map((entry) => entry.id === book.id ? { ...entry, activeBranchAt: at } : entry) : settings.books;
  return { books, ...withBookBranchMemory(settings, book, (record) => recordBranchUse(record, branch, at, { current })) };
}
