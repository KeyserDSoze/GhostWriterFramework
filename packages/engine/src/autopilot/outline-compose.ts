import {
  outlineChanges,
  parseOutline,
  readOutlineBook,
  readOutlineChapter,
  type OutlineBookEntry,
  type OutlineChapterEntry,
  type OutlineEdit,
  type OutlineEntryInput,
  type OutlineIndex,
  type OutlineWarning,
} from "../book/outline.js";
import { OUTLINE_BOOK_FILE, outlineChapterPath, parseOutlineChapterPath } from "../book/paths.js";
import type { BookFileChange, BookFileContent } from "../book/store.js";
import { sha256Hex } from "../util/hash.js";

/**
 * A series of edits of the outline (the Scaletta) as the files of one commit. One function for every host that makes the author's edits in a row: the web app's Outline
 * page and Copilot, the personal server's MCP tool.
 *
 * The engine makes every edit (`outlineChanges`): the numbering, the format, the author as the writer of every entry it writes. What it leaves to its caller, and this
 * does:
 *
 *  - Several edits in a row. Each is made on the outline the one before left (a `number` is the number the chapter has at that point of the series), and the files are
 *    written once, with their final text; a file that comes back to what it was is left alone.
 *  - The identity of every entry, followed through the renumbering. A client reads an entry and gets the hash of its file; the text of that entry is replaced, or the entry
 *    removed, only if the hash is still the file's. In a series the entry is no longer where it was, so the hash that was read is checked against the entry it was of,
 *    wherever the edits before have put it (`OutlineSeriesEdit.expectedHash`).
 *  - Only the files that are needed. An outline has no maximum, and an insert at its head renames every entry: but an update of one entry reads one file. An entry is known
 *    by its path and hash (`OutlineIndex`, from the list of the book's files) and read only when an edit is about to rewrite it.
 *  - Limits a caller chooses: how many edits a series has, how many files it may change (checked as the series goes).
 *
 * Pure: nothing is written and no file is read but through `OutlineSource.read`. The files come out as `BookFileChange`s, each expecting the file as it was read, and a commit
 * through a store refuses the lot if any of them changed since.
 */

/** Edits one series may make, unless the caller says another number. */
export const OUTLINE_COMPOSE_MAX_EDITS = 50;
/** Files one series may change, unless the caller says another number: an insert at the head of a long outline renames all of it, and that is for a place where the author sees it and can undo it. */
export const OUTLINE_COMPOSE_MAX_FILES = 1000;

/**
 * An edit of a series: the engine's own (`OutlineEdit`), and for the ones that replace what someone read (`update`, `remove`, `book`) the hash of the file as it was
 * read. For `update` and `remove` it is the hash of the entry as the series found it, wherever the edits before it have put the entry; for `book`, of `outline/book.md`.
 * An entry that the series made has no hash.
 */
export type OutlineSeriesEdit =
  | Exclude<OutlineEdit, { kind: "remove" | "update" | "book" }>
  | (Extract<OutlineEdit, { kind: "remove" | "update" | "book" }> & { expectedHash?: string });

/**
 * Whether an edit replaces what someone must have read: the text of an entry that exists, an entry that is deleted, the description of the book. The rule of a caller that
 * never overwrites what changed meanwhile (`OutlineComposeOptions.requireHash`): a title or a ghostwriter changes no text, and a new entry has no file to compare.
 */
export function outlineEditNeedsHash(edit: OutlineSeriesEdit): boolean {
  switch (edit.kind) {
    case "remove":
      return true;
    case "update":
      return edit.entry.body !== undefined;
    case "book":
      return edit.body !== undefined;
    default:
      return false;
  }
}

/**
 * Where the entry numbered `number` is after `edit`, as the engine places the files; `null` when the edit deletes it. The one rule of the renumbering: the series follows
 * the entries with it, and a page that keeps what the author typed in an entry that moved with it.
 */
export function remapOutlineNumber(edit: OutlineEdit, number: number): number | null {
  switch (edit.kind) {
    case "insert":
      return number >= edit.at ? number + 1 : number;
    case "move":
      if (number === edit.from) return edit.to;
      if (edit.from < edit.to && number > edit.from && number <= edit.to) return number - 1;
      if (edit.from > edit.to && number >= edit.to && number < edit.from) return number + 1;
      return number;
    case "remove":
      if (number === edit.number) return null;
      return edit.renumber && number > edit.number ? number - 1 : number;
    default:
      return number;
  }
}

// ─── What is given, and what is asked ───────────────────────────────────────

/** Where the outline of a book is: its files known by name and hash, and the way to read one. */
export interface OutlineSource {
  /** The entries and the description as the list of the book's files has them (`BookSnapshot.outline`, or `outlineIndex(files)`): paths and hashes, nothing read. */
  index: OutlineIndex;
  /**
   * The paths of the book's files (any: the ones that are not the outline's are left out). The index has one file for a chapter; a second file for it, or a file named as no
   * entry is named (`7.md`, `0007.md`), can only be seen from the list, and an outline that has one is read whole, and read again after each edit, as the engine reads it
   * (what an edit frees is taken by the file that waited). Without the list the index is all there is.
   */
  paths?: Iterable<string>;
  /** `null` for a file that is gone (it changed since it was listed). */
  read(path: string): Promise<BookFileContent | null>;
}

export interface OutlineComposeOptions {
  /** The slugs of the book's ghostwriters (without them they are not checked). */
  ghostwriters?: readonly string[];
  /** Edits a series may have (default `OUTLINE_COMPOSE_MAX_EDITS`); `Infinity` for none. */
  maxEdits?: number;
  /** Files a series may change at any moment of it (default `OUTLINE_COMPOSE_MAX_FILES`); `Infinity` for none. */
  maxFiles?: number;
  /**
   * An edit of a chapter that has no entry (`move`, `remove`): `throw` (the default) refuses the whole series, `warn` is the engine's own answer: that edit changes nothing
   * and a `not-found` warning says so, and the others are made.
   */
  missing?: "throw" | "warn";
  /** Which edits must carry the hash of what they replace (`outlineEditNeedsHash` is the rule of a caller that never overwrites what changed meanwhile). None by default; a hash that is given is always checked. */
  requireHash?: (edit: OutlineSeriesEdit) => boolean;
}

export type OutlineComposeErrorCode = "not_found" | "expected_hash_required" | "conflict" | "too_many_edits" | "too_many_files" | "invalid_edit";

/** Why an edit was a conflict: its entry is not the one that was read (`changed`), is gone (`removed`), was made by the series (`made-in-series`), or a file of the outline is gone (`gone`). */
export type OutlineConflictReason = "changed" | "removed" | "made-in-series" | "gone";

export interface OutlineComposeErrorDetails {
  /** The edit, by its place in the series (from 0), and the edit itself. */
  index?: number;
  edit?: unknown;
  /** The chapter (the number it has at that point of the series) or the description of the book that the error is about, and the file. */
  number?: number;
  path?: string;
  subject?: "chapter" | "book";
  reason?: OutlineConflictReason;
  /** `too_many_edits` and `too_many_files`: how many there were (at least, for the files), and how many are allowed. */
  count?: number;
  limit?: number;
}

/**
 * A series that cannot be made: nothing was written, for nothing is written here. The `code` is one of `OutlineComposeErrorCode`, and the details say which edit and
 * which file, so that a host words it in its own way (the message is English, and names no tool).
 */
export class OutlineComposeError extends Error implements OutlineComposeErrorDetails {
  declare readonly index?: number;
  declare readonly edit?: unknown;
  declare readonly number?: number;
  declare readonly path?: string;
  declare readonly subject?: "chapter" | "book";
  declare readonly reason?: OutlineConflictReason;
  declare readonly count?: number;
  declare readonly limit?: number;

  constructor(readonly code: OutlineComposeErrorCode, message: string, details: OutlineComposeErrorDetails = {}) {
    super(message);
    this.name = "OutlineComposeError";
    for (const [key, value] of Object.entries(details)) if (value !== undefined) Object.defineProperty(this, key, { value, enumerable: true, writable: false, configurable: true });
  }
}

/** What an edit of a series did, in the order of the series (`ComposedOutlineEdits.steps`), for a host that tells it in its words. */
export type OutlineSeriesStep =
  | { kind: "append"; number: number }
  | { kind: "insert"; at: number }
  /**
   * `unchanged`: the entry is where it is asked to go. `missing`: the chapter has no entry (`missing: "warn"`): nothing was done. `origin`: the number the entry had when the
   * series began (absent for an entry the series made, and for one that is not there), so that a host that names the entries names the right one though the numbers shift.
   */
  | { kind: "move"; from: number; to: number; unchanged: boolean; origin?: number; missing?: true }
  | { kind: "remove"; number: number; renumber: boolean; origin?: number; missing?: true }
  /** `created`: the chapter had no entry. `fields`: what the edit set. */
  | { kind: "update"; number: number; created: boolean; fields: Array<"title" | "body" | "ghostwriter">; origin?: number }
  | { kind: "book"; created: boolean; fields: Array<"title" | "body"> };

/** Entries that moved together: `count` entries from chapter `from` are now from chapter `to`. */
export interface OutlineMovedRun {
  from: number;
  to: number;
  count: number;
}

/** An entry the series did something to, with the hash its file had when the series began: the table a caller that checks hashes reads (the series itself checks the ones it is given). */
export interface OutlineIdentity {
  /** The number the entry had when the series began, and the hash of its file then. */
  number: number;
  hash: string;
  /** Where it is when the series is over; `null`: it was deleted. */
  now: number | null;
  /** An edit set its title, its text or its ghostwriter. */
  updated: boolean;
}

export interface ComposedOutlineEdits {
  /** The files of one commit, in order of path, each expecting the file as it was read (`null`: it did not exist). Empty when the series changes nothing. */
  changes: BookFileChange[];
  /** What the engine says, told once; of the gaps, only the one the outline ends with, and only when the series made or changed it. */
  warnings: OutlineWarning[];
  /** One for each edit, in order. */
  steps: OutlineSeriesStep[];
  /** The numbers, when the series is over, of the entries it made (they did not exist) and of the entries that existed and whose title, text or ghostwriter an edit set. */
  created: number[];
  updated: number[];
  /** The numbers, when the series began, of the entries it deleted. */
  removed: number[];
  /** Entries that changed number. */
  moved: OutlineMovedRun[];
  /** The chapters whose entry says something else when the series is over than when it began (an entry that is new for the number counts), and the ones that have no entry now though they had one. */
  changed: number[];
  gone: number[];
  /** How many entries the outline has when the series is over. */
  chapters: number;
  /** Each entry it made or changed, with the hash of its file now. */
  entries: Array<{ number: number; path: string; hash: string }>;
  /** The description of the book, when the series wrote it. */
  book?: { path: string; hash: string; created: boolean };
  /** The entries the series moved, deleted or changed, with their hashes when it began. */
  identities: OutlineIdentity[];
}

// ─── What is known of the outline, and when it is read ─────────────────────

/** Entries read at once when an edit has to read many. */
const READ_BATCH = 64;

/** The entries as the series finds them, most of them known by name and hash only until an edit has to rewrite them. */
interface Loaded {
  readonly source: OutlineSource;
  /** The entries as the series found them: the ones that were read, and for the others what the index says. */
  originals: Map<number, OutlineChapterEntry>;
  /** The entries as the edits made so far leave them. */
  chapters: Map<number, OutlineChapterEntry>;
  book: OutlineBookEntry | null;
  /** The entries that are not read yet. */
  readonly unloaded: Set<string>;
  bookUnloaded: boolean;
  /** The hash of every file of the outline when the series found it, or when it was read. */
  readonly hashes: Map<string, string>;
  /** The text of the files that were read, as they were. */
  readonly contents: Map<string, string>;
  /** Everything is read, and the outline is parsed again whole after each edit. */
  whole: boolean;
  files: Map<string, { content: string; hash: string }>;
}

const stubEntry = (file: { number: number; path: string; hash: string }): OutlineChapterEntry => ({ number: file.number, path: file.path, hash: file.hash, title: "", body: "", origin: "author", contentDigest: "", intact: false, frontmatter: {} });
const stubBook = (file: { path: string; hash: string }): OutlineBookEntry => ({ path: file.path, hash: file.hash, title: "", body: "", origin: "author", contentDigest: "", intact: false, frontmatter: {} });

const isOutlineFile = (path: string): boolean => path === OUTLINE_BOOK_FILE || parseOutlineChapterPath(path) !== null;

const goneError = (path: string, index?: number): OutlineComposeError => new OutlineComposeError("conflict", `${path} changed since the outline was listed: it is gone now.`, { path, reason: "gone", ...(index === undefined ? {} : { index }) });

async function load(source: OutlineSource): Promise<Loaded> {
  const chapters = new Map(source.index.chapters.map((file) => [file.number, stubEntry(file)]));
  const hashes = new Map(source.index.chapters.map((file) => [file.path, file.hash]));
  if (source.index.book) hashes.set(source.index.book.path, source.index.book.hash);
  const listed = source.paths ? [...source.paths].filter(isOutlineFile) : [...source.index.chapters.map((file) => file.path), ...(source.index.book ? [source.index.book.path] : [])];
  const odd = [...listed, ...source.index.chapters.map((file) => file.path)].some((path) => path !== OUTLINE_BOOK_FILE && parseOutlineChapterPath(path)?.canonical === false);
  const loaded: Loaded = {
    source,
    originals: new Map(chapters),
    chapters,
    book: source.index.book ? stubBook(source.index.book) : null,
    unloaded: new Set(source.index.chapters.map((file) => file.path)),
    bookUnloaded: Boolean(source.index.book),
    hashes,
    contents: new Map(),
    whole: odd,
    files: new Map(),
  };
  if (odd) await readWhole(loaded, listed);
  return loaded;
}

async function readAll(source: OutlineSource, paths: readonly string[], index?: number): Promise<BookFileContent[]> {
  const found: BookFileContent[] = [];
  for (let start = 0; start < paths.length; start += READ_BATCH) {
    const batch = paths.slice(start, start + READ_BATCH);
    const reads = await Promise.all(batch.map((path) => source.read(path)));
    reads.forEach((read, position) => {
      if (!read) throw goneError(batch[position], index);
      found.push(read);
    });
  }
  return found;
}

/** The outline read whole, the way the engine reads it: every file, the entries it leaves out because another file has their number too. */
async function readWhole(loaded: Loaded, paths: readonly string[]): Promise<void> {
  for (const read of await readAll(loaded.source, [...new Set(paths)])) {
    loaded.files.set(read.path, { content: read.content, hash: read.hash });
    loaded.contents.set(read.path, read.content);
    loaded.hashes.set(read.path, read.hash);
  }
  const parsed = await parseOutline([...loaded.files].map(([path, file]) => ({ path, ...file })));
  loaded.chapters = new Map(parsed.chapters.map((entry) => [entry.number, entry]));
  loaded.originals = new Map(loaded.chapters);
  loaded.book = parsed.book;
  loaded.unloaded.clear();
  loaded.bookUnloaded = false;
}

/** Read the entries from `from` to `to` that are not read yet: the ones an edit is about to rewrite. */
async function ensureRange(loaded: Loaded, from: number, to: number, index: number): Promise<void> {
  if (loaded.whole) return;
  const wanted = [...loaded.chapters.values()].filter((entry) => entry.number >= from && entry.number <= to && loaded.unloaded.has(entry.path));
  for (let start = 0; start < wanted.length; start += READ_BATCH) {
    const batch = wanted.slice(start, start + READ_BATCH);
    const reads = await readAll(loaded.source, batch.map((entry) => entry.path), index);
    for (let position = 0; position < batch.length; position += 1) {
      const { number, path } = batch[position];
      const read = reads[position];
      const { entry } = await readOutlineChapter(path, number, read.content, read.hash);
      loaded.chapters.set(number, entry);
      loaded.originals.set(number, entry);
      loaded.contents.set(path, read.content);
      loaded.hashes.set(path, read.hash);
      loaded.unloaded.delete(path);
    }
  }
}

async function ensureBook(loaded: Loaded, index: number): Promise<void> {
  if (!loaded.bookUnloaded || !loaded.book) return;
  const [read] = await readAll(loaded.source, [loaded.book.path], index);
  const { book } = await readOutlineBook(read.content, read.hash);
  loaded.book = book;
  loaded.contents.set(book.path, read.content);
  loaded.hashes.set(book.path, read.hash);
  loaded.bookUnloaded = false;
}

// ─── The series ────────────────────────────────────────────────────────────

/** An entry as the series follows it: the number it had when the series began (`null`: a new one) and what the series did to it. */
interface Live {
  origin: number | null;
  touched?: "created" | "updated";
}

/** Runs of consecutive entries that moved together: `{ from, to, count }` means `count` entries from chapter `from` are now from chapter `to`. */
function runs(pairs: ReadonlyArray<readonly [number, number]>): OutlineMovedRun[] {
  const found: OutlineMovedRun[] = [];
  for (const [from, to] of [...pairs].sort(([left], [right]) => left - right)) {
    const last = found.at(-1);
    if (last && from === last.from + last.count && to === last.to + last.count) last.count += 1;
    else found.push({ from, to, count: 1 });
  }
  return found;
}

/** The number an entry had when the series began, as a step says it (nothing for an entry the series made). */
const originOf = (live: Live | undefined): { origin?: number } => (live && live.origin !== null ? { origin: live.origin } : {});

const fieldsOfEntry = (entry: OutlineEntryInput): Array<"title" | "body" | "ghostwriter"> => (["title", "body", "ghostwriter"] as const).filter((key) => entry[key] !== undefined);

/** The chapters from 1 to the last that have no entry, as runs (`2-3,6`): only to tell whether two outlines have the same gaps. */
function gapsOf(numbers: Iterable<number>): string {
  const runsOfGaps: string[] = [];
  let expected = 1;
  for (const number of [...numbers].sort((left, right) => left - right)) {
    if (number > expected) runsOfGaps.push(`${expected}-${number - 1}`);
    expected = Math.max(expected, number + 1);
  }
  return runsOfGaps.join(",");
}

const byNumber = (left: OutlineChapterEntry, right: OutlineChapterEntry): number => left.number - right.number;
const byPath = (left: { path: string }, right: { path: string }): number => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

/** What an edit is, for a message: `update chapter 3`, `remove chapter 9`, `move chapter 5 to 7`, `the description of the book`. */
function describe(edit: OutlineSeriesEdit): string {
  switch (edit.kind) {
    case "move":
      return `move chapter ${edit.from} to ${edit.to}`;
    case "remove":
    case "update":
      return `${edit.kind} chapter ${edit.number}`;
    case "book":
      return "update the description of the book";
    case "insert":
      return `insert chapter ${edit.at}`;
    default:
      return edit.kind;
  }
}

/** The edits of a series, looked at before anything is read: each is an object of a kind the engine has, and a hash only where there is a file to compare with. */
function checkSeries(edits: readonly unknown[]): void {
  edits.forEach((edit, index) => {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) throw new OutlineComposeError("invalid_edit", `edits[${index}] must be an object: an edit has a kind and what the kind takes.`, { index, edit });
    const { kind, expectedHash } = edit as { kind?: unknown; expectedHash?: unknown };
    if (kind !== "append" && kind !== "insert" && kind !== "move" && kind !== "remove" && kind !== "update" && kind !== "book") {
      throw new OutlineComposeError("invalid_edit", `edits[${index}]: ${typeof kind === "string" ? `«${kind.slice(0, 40)}»` : "that"} is not a kind of edit; the kinds are append, insert, move, remove, update and book.`, { index, edit });
    }
    if (expectedHash !== undefined && (kind === "append" || kind === "insert" || kind === "move")) {
      throw new OutlineComposeError("invalid_edit", `edits[${index}] (${kind}): ${kind === "move" ? "a move changes no text" : `${kind === "append" ? "an appended" : "an inserted"} chapter is a new entry, which has no file yet`}, so there is no expectedHash to give.`, { index, edit });
    }
  });
}

/**
 * Make `edits` on the outline `source` describes, in order, and answer the files of one commit. Throws an `OutlineComposeError` for an edit that cannot be made
 * (`not_found`, `invalid_edit`), one whose hash is missing where the caller's rule asks for one (`expected_hash_required`) or is not the entry's (`conflict`), a file that is
 * gone when it is read (`conflict`), and a series that is too long or would change too many files (`too_many_edits`, `too_many_files`). Nothing was written then, for nothing
 * is written here.
 */
export async function composeOutlineEdits(source: OutlineSource, edits: readonly OutlineSeriesEdit[], options: OutlineComposeOptions = {}): Promise<ComposedOutlineEdits> {
  const maxEdits = options.maxEdits ?? OUTLINE_COMPOSE_MAX_EDITS;
  const maxFiles = options.maxFiles ?? OUTLINE_COMPOSE_MAX_FILES;
  const missing = options.missing ?? "throw";
  const ghostwriters = options.ghostwriters;
  if (edits.length > maxEdits) throw new OutlineComposeError("too_many_edits", `A series makes at most ${maxEdits} edits: ${edits.length} were given.`, { count: edits.length, limit: maxEdits });
  checkSeries(edits);

  const loaded = await load(source);
  let lives = new Map<number, Live>([...loaded.chapters.keys()].map((number) => [number, { origin: number }]));
  const verified = new Set<unknown>();
  const finalContent = new Map<string, string | null>();
  const removed: number[] = [];
  const warnings = new Map<string, OutlineWarning>();
  const steps: OutlineSeriesStep[] = [];
  const bookExisted = loaded.book !== null;
  let bookTouched = false;
  let gap: OutlineWarning | null | undefined;

  const outline = () => ({ book: loaded.book, chapters: [...loaded.chapters.values()].sort(byNumber), warnings: [] as OutlineWarning[] });
  const last = () => Math.max(0, ...loaded.chapters.keys());
  /** The identities after an edit: each entry is where the engine put it, and an entry the edit deleted is gone. */
  const follow = (edit: OutlineEdit) => {
    lives = new Map([...lives].flatMap(([number, live]) => {
      const now = remapOutlineNumber(edit, number);
      return now === null ? [] : [[now, live] as const];
    }));
  };

  /** The files the series has changed so far: what it wrote last, leaving alone what came back to what it was and what was made and deleted in the same series. */
  function netChanges(): BookFileChange[] {
    const changes: BookFileChange[] = [];
    for (const [path, content] of finalContent) {
      const known = loaded.hashes.get(path);
      if (content === null) {
        if (known !== undefined) changes.push({ path, content: null, expectedHash: known });
      } else if (known === undefined || loaded.contents.get(path) !== content) {
        changes.push({ path, content, expectedHash: known ?? null });
      }
    }
    return changes.sort(byPath);
  }

  const tooMany = (count: number, index?: number): OutlineComposeError => new OutlineComposeError("too_many_files", `The series would change at least ${count} files of the outline, and at most ${maxFiles} may change: nothing was written.`, { count, limit: maxFiles, ...(index === undefined ? {} : { index }) });

  /** The engine makes the edit; the files it writes become the outline the next edit works on. */
  async function make(edit: OutlineSeriesEdit, index: number, reachesGap = true): Promise<void> {
    const { expectedHash: _hash, ...plain } = edit as OutlineSeriesEdit & { expectedHash?: string };
    const result = outlineChanges({ outline: outline(), edit: plain as OutlineEdit, ghostwriters });
    for (const warning of result.warnings) {
      if (warning.code !== "gap") warnings.set(`${warning.code}|${warning.path ?? ""}|${warning.message}`, warning);
    }
    if (reachesGap) gap = result.warnings.find((warning) => warning.code === "gap") ?? null;
    for (const change of result.changes) finalContent.set(change.path, change.content);
    // A series that has changed more files than it may, at any point of it, is refused there: not after the rest of its edits have rewritten the outline over again.
    if (finalContent.size > maxFiles) {
      const touchedSoFar = netChanges().length;
      if (touchedSoFar > maxFiles) throw tooMany(touchedSoFar, index);
    }
    await apply(result.changes);
  }

  async function apply(changes: readonly BookFileChange[]): Promise<void> {
    if (loaded.whole) {
      for (const change of changes) {
        if (change.content === null) loaded.files.delete(change.path);
        else loaded.files.set(change.path, { content: change.content, hash: await sha256Hex(change.content) });
      }
      const parsed = await parseOutline([...loaded.files].map(([path, file]) => ({ path, ...file })));
      loaded.chapters = new Map(parsed.chapters.map((entry) => [entry.number, entry]));
      loaded.book = parsed.book;
      return;
    }
    for (const change of changes) {
      const hash = change.content === null ? undefined : await sha256Hex(change.content);
      if (change.path === OUTLINE_BOOK_FILE) {
        loaded.book = change.content === null ? null : (await readOutlineBook(change.content, hash)).book;
        continue;
      }
      const number = parseOutlineChapterPath(change.path)?.number;
      if (number === undefined) continue;
      if (change.content === null) {
        if (loaded.chapters.get(number)?.path === change.path) loaded.chapters.delete(number);
      } else {
        loaded.chapters.set(number, (await readOutlineChapter(change.path, number, change.content, hash)).entry);
        loaded.unloaded.delete(change.path);
      }
    }
  }

  /**
   * What a client had to see: the text of an entry is replaced, and an entry removed, by someone who read its file, and a hash that is given is the file's. The entry is
   * followed through the series (`origin`), so the hash is compared with the file the entry had when the series began.
   */
  function check(index: number, edit: OutlineSeriesEdit, subject: { path: string; number?: number; kind: "chapter" | "book"; exists: boolean; created: boolean; hash?: string; key: unknown }): void {
    const expected = (edit as { expectedHash?: string }).expectedHash;
    const where = describe(edit);
    const details = { index, edit, path: subject.path, subject: subject.kind, ...(subject.number === undefined ? {} : { number: subject.number }) };
    if (expected === undefined) {
      if ((options.requireHash?.(edit) ?? false) && subject.exists && !subject.created && !verified.has(subject.key)) {
        throw new OutlineComposeError("expected_hash_required", `edits[${index}] (${where}): replacing the text of an entry, deleting one or replacing the description of the book needs the hash of ${subject.path} as it was read (expectedHash), so that a change made meanwhile is never overwritten.`, details);
      }
      return;
    }
    if (!subject.exists) throw new OutlineComposeError("conflict", `edits[${index}] (${where}): ${subject.path} has no entry now, so the hash given cannot be its: it was removed since it was read.`, { ...details, reason: "removed" });
    if (subject.created) throw new OutlineComposeError("conflict", `edits[${index}] (${where}): ${subject.path} is a new entry made by an earlier edit of the series, so the hash given (of an entry that was read) is not its: the numbers of a series count the edits before them.`, { ...details, reason: "made-in-series" });
    if (expected !== subject.hash) throw new OutlineComposeError("conflict", `edits[${index}] (${where}): ${subject.path} changed since it was read.`, { ...details, reason: "changed" });
    verified.add(subject.key);
  }

  const notFound = (index: number, edit: OutlineSeriesEdit, number: number): OutlineComposeError => new OutlineComposeError("not_found", `edits[${index}] (${describe(edit)}): the outline has no entry for chapter ${number}.`, { index, edit, number });

  for (const [index, edit] of edits.entries()) {
    switch (edit.kind) {
      case "append": {
        const number = last() + 1;
        steps.push({ kind: "append", number });
        await make(edit, index);
        lives.set(number, { origin: null, touched: "created" });
        break;
      }
      case "insert": {
        await ensureRange(loaded, edit.at, Number.POSITIVE_INFINITY, index);
        steps.push({ kind: "insert", at: edit.at });
        await make(edit, index);
        follow(edit);
        lives.set(edit.at, { origin: null, touched: "created" });
        break;
      }
      case "move": {
        const { from, to } = edit;
        if (!loaded.chapters.has(from)) {
          if (missing === "throw") throw notFound(index, edit, from);
          await make(edit, index, false);
          steps.push({ kind: "move", from, to, unchanged: false, missing: true });
          break;
        }
        const origin = originOf(lives.get(from));
        if (from === to) {
          steps.push({ kind: "move", from, to, unchanged: true, ...origin });
          break;
        }
        await ensureRange(loaded, Math.min(from, to), Math.max(from, to), index);
        steps.push({ kind: "move", from, to, unchanged: false, ...origin });
        await make(edit, index);
        follow(edit);
        break;
      }
      case "remove": {
        const { number } = edit;
        const live = lives.get(number);
        if (!live || !loaded.chapters.has(number)) {
          if (missing === "throw") throw notFound(index, edit, number);
          await make(edit, index, false);
          steps.push({ kind: "remove", number, renumber: edit.renumber === true, missing: true });
          break;
        }
        check(index, edit, { path: loaded.chapters.get(number)?.path ?? outlineChapterPath(number), number, kind: "chapter", exists: true, created: live.origin === null, hash: live.origin === null ? undefined : loaded.originals.get(live.origin)?.hash, key: live });
        if (edit.renumber === true) await ensureRange(loaded, number + 1, Number.POSITIVE_INFINITY, index);
        steps.push({ kind: "remove", number, renumber: edit.renumber === true, ...originOf(live) });
        await make(edit, index);
        if (live.origin !== null) removed.push(live.origin);
        follow(edit);
        break;
      }
      case "update": {
        const { number } = edit;
        const exists = loaded.chapters.has(number);
        if (exists) await ensureRange(loaded, number, number, index);
        const live = lives.get(number);
        check(index, edit, { path: loaded.chapters.get(number)?.path ?? outlineChapterPath(number), number, kind: "chapter", exists, created: live?.origin === null, hash: live && live.origin !== null ? loaded.originals.get(live.origin)?.hash : undefined, key: live });
        steps.push({ kind: "update", number, created: !exists, fields: fieldsOfEntry(edit.entry), ...originOf(live) });
        await make(edit, index);
        if (!live) lives.set(number, { origin: null, touched: "created" });
        else live.touched ??= live.origin === null ? "created" : "updated";
        break;
      }
      default: {
        await ensureBook(loaded, index);
        check(index, edit, { path: OUTLINE_BOOK_FILE, kind: "book", exists: loaded.book !== null, created: loaded.book !== null && !bookExisted, hash: loaded.hashes.get(OUTLINE_BOOK_FILE), key: "book" });
        steps.push({ kind: "book", created: loaded.book === null, fields: (["title", "body"] as const).filter((key) => edit[key] !== undefined) });
        await make(edit, index, false);
        bookTouched = true;
      }
    }
  }
  // A gap is told when the series made or changed it, as the outline ends: one that was there before and is still there is no news (a host that reads the outline says it).
  if (gap && gapsOf(loaded.chapters.keys()) !== gapsOf(loaded.originals.keys())) warnings.set(`gap|${gap.path ?? ""}|${gap.message}`, gap);

  const changes = netChanges();
  if (changes.length > maxFiles) throw tooMany(changes.length);

  const written = new Map(changes.flatMap((change) => (change.content === null ? [] : [[change.path, change.content] as const])));
  const numbered = (picked: (live: Live) => boolean) => [...lives].filter(([, live]) => picked(live)).map(([number]) => number).filter((number) => written.has(outlineChapterPath(number))).sort((left, right) => left - right);
  const created = numbered((live) => live.origin === null && live.touched === "created");
  const updated = numbered((live) => live.origin !== null && live.touched === "updated");
  const entries: ComposedOutlineEdits["entries"] = [];
  for (const number of [...created, ...updated].sort((left, right) => left - right)) {
    const path = outlineChapterPath(number);
    entries.push({ number, path, hash: await sha256Hex(written.get(path) as string) });
  }
  const bookContent = written.get(OUTLINE_BOOK_FILE);
  const moved = runs([...lives].flatMap(([number, live]) => (live.origin !== null && live.origin !== number ? [[live.origin, number] as const] : [])));

  const changed: number[] = [];
  const gone: number[] = [];
  for (const number of [...new Set([...loaded.originals.keys(), ...loaded.chapters.keys()])].sort((left, right) => left - right)) {
    const before = loaded.originals.get(number);
    const after = loaded.chapters.get(number);
    if (before === after) continue;
    if (!after) gone.push(number);
    else if (!before || before.contentDigest !== after.contentDigest) changed.push(number);
  }

  const now = new Map<number, Live>();
  const where = new Map<number, number>();
  for (const [number, live] of lives) {
    if (live.origin === null) continue;
    now.set(live.origin, live);
    where.set(live.origin, number);
  }
  const identities: OutlineIdentity[] = [];
  for (const [origin, entry] of [...loaded.originals].sort(([left], [right]) => left - right)) {
    const there = where.get(origin) ?? null;
    const touched = now.get(origin)?.touched === "updated";
    if (there !== origin || touched) identities.push({ number: origin, hash: loaded.hashes.get(entry.path) ?? entry.hash ?? "", now: there, updated: touched });
  }

  return {
    changes,
    warnings: [...warnings.values()],
    steps,
    created,
    updated,
    removed: removed.sort((left, right) => left - right),
    moved,
    changed,
    gone,
    chapters: loaded.chapters.size,
    entries,
    ...(bookTouched && bookContent !== undefined ? { book: { path: OUTLINE_BOOK_FILE, hash: await sha256Hex(bookContent), created: !bookExisted } } : {}),
    identities,
  };
}
