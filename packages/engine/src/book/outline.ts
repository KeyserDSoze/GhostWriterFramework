import { parseMarkdown, renderMarkdown } from "../markdown/frontmatter.js";
import { sha256Hex } from "../util/hash.js";
import { clipText } from "../util/text.js";
import { OUTLINE_BOOK_FILE, OUTLINE_DIRECTORY, formatOrdinal, isValidGhostwriterSlug, outlineChapterPath, parseOutlineChapterPath } from "./paths.js";
import type { BookFileChange, BookStore } from "./store.js";

/**
 * The outline (Scaletta): the author's chapter-by-chapter trace of the book. `outline/book.md` is the rough description of the
 * book (`type: outline`), and every chapter has a file of its own, `outline/chapters/<NNN>.md` (`type: outline-chapter`): its
 * hypothetical `title`, what happens in its body (plain text) and, optionally, the `ghostwriter` that writes it. `origin` says who
 * wrote the entry last; the autopilot writes `origin: autopilot` with the `digest` of what it wrote, so an entry whose content
 * no longer matches its digest is the author's. An entry of the author binds the autopilot; one the autopilot wrote and nobody
 * touched since (`intact`) is the autopilot's own, and it may rewrite it.
 */
export type OutlineOrigin = "author" | "autopilot";

/** Characters of the text of one entry: an edit that writes more is cut, with a warning, and the autopilot reads no more. */
export const OUTLINE_ENTRY_MAX_CHARS = 20_000;
/** Characters of a hypothetical title: it becomes the name of the chapter's folder. */
export const OUTLINE_TITLE_MAX_CHARS = 200;

export type OutlineWarningCode =
  | "unreadable"
  | "number-mismatch"
  | "duplicate"
  | "gap"
  | "not-an-entry"
  | "origin-unknown"
  | "not-text"
  | "text-too-long"
  | "title-too-long"
  | "ghostwriter-missing"
  | "ghostwriter-invalid"
  | "not-found";

/** Something odd in the outline. Never an error: the outline is read, and written, all the same. The message is in English and names the file. */
export interface OutlineWarning {
  code: OutlineWarningCode;
  message: string;
  path?: string;
  number?: number;
}

export interface OutlineChapterEntry {
  /** The chapter, from the name of the file. */
  number: number;
  path: string;
  /** The hash of the file, when it was read from a store: what an edit expects to find. */
  hash?: string;
  /** The hypothetical title; empty when the entry has none. */
  title: string;
  /** What happens in the chapter. */
  body: string;
  /** The slug of `ghostwriters/<slug>.md`; absent: the book's. */
  ghostwriter?: string;
  origin: OutlineOrigin;
  /** The digest the autopilot wrote with the entry. */
  digest?: string;
  /** The digest of the entry as it is now (`outlineEntryDigest`). */
  contentDigest: string;
  /** Written by the autopilot and untouched since: the autopilot may rewrite it. Every other entry is the author's, and binds. */
  intact: boolean;
  /** Its frontmatter cannot be read: it is the author's, and the autopilot never rewrites it. */
  unreadable?: boolean;
  /** The frontmatter as it was read, so that a rewrite loses no key. */
  frontmatter: Record<string, unknown>;
  /** The file as it is, for an entry whose frontmatter cannot be read: it is moved as it is. */
  raw?: string;
}

export interface OutlineBookEntry {
  path: string;
  hash?: string;
  /** The working title (the book's own title stays in `book.md`). */
  title: string;
  /** The rough description of the book. */
  body: string;
  origin: OutlineOrigin;
  digest?: string;
  contentDigest: string;
  intact: boolean;
  unreadable?: boolean;
  frontmatter: Record<string, unknown>;
}

export interface ParsedOutline {
  book: OutlineBookEntry | null;
  /** One entry per chapter, in order of number. */
  chapters: OutlineChapterEntry[];
  warnings: OutlineWarning[];
}

// ─── Digests ────────────────────────────────────────────────────────────────

function canonicalText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

/**
 * The fingerprint of what an entry says: its title, its text and its ghostwriter (line endings and the spaces around them do not
 * count). Sixteen hexadecimal characters of a SHA-256. The autopilot writes it with the entries it writes (`digest`), and the plan
 * keeps it for the chapters that come from an entry (`PlannedChapter.outlineDigest`).
 */
export async function outlineEntryDigest(entry: { title?: string; body?: string; ghostwriter?: string | null }): Promise<string> {
  return (await sha256Hex(JSON.stringify(["outline-chapter", canonicalText(entry.title), canonicalText(entry.ghostwriter), canonicalText(entry.body)]))).slice(0, 16);
}

/** The fingerprint of the description of the book: its working title and its text. */
export async function outlineBookDigest(book: { title?: string; body?: string }): Promise<string> {
  return (await sha256Hex(JSON.stringify(["outline-book", canonicalText(book.title), canonicalText(book.body)]))).slice(0, 16);
}

// ─── Reading ────────────────────────────────────────────────────────────────

function quoted(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (value && typeof value === "object") return "a mapping";
  const text = String(value);
  return `«${text.length > 40 ? `${text.slice(0, 40)}…` : text}»`;
}

interface EntryReading {
  frontmatter: Record<string, unknown>;
  body: string;
  unreadable: boolean;
  title: string;
  origin: OutlineOrigin;
  digest?: string;
  warn: (code: OutlineWarningCode, message: string) => void;
}

/** What every file of the outline has in common: the frontmatter, the text, the title and who wrote it. */
function readEntryFile(path: string, content: string, warnings: OutlineWarning[], number?: number): EntryReading {
  const document = parseMarkdown(content ?? "");
  const unreadable = Boolean(document.error);
  const where = number === undefined ? { path } : { path, number };
  if (document.error) {
    warnings.push({ code: "unreadable", ...where, message: `${path}: the frontmatter is not valid YAML (${document.errorLine ? `line ${document.errorLine}: ` : ""}${document.error}): the entry is read as far as it can be and the autopilot never rewrites it; correct the file.` });
  }
  // After an error in the YAML every value is a guess: one warning says it all.
  const warn = (code: OutlineWarningCode, message: string) => {
    if (!unreadable) warnings.push({ code, ...where, message: `${path}: ${message}` });
  };
  const frontmatter = document.frontmatter;
  const title = textField(frontmatter, "title", warn);
  let origin: OutlineOrigin = "author";
  const declared = frontmatter.origin;
  if (declared !== undefined && declared !== null && !(typeof declared === "string" && !declared.trim())) {
    const value = typeof declared === "string" ? declared.trim().toLowerCase() : "";
    if (value === "author" || value === "autopilot") origin = value;
    else warn("origin-unknown", `origin ${quoted(declared)} is neither author nor autopilot: the entry is the author's`);
  }
  const digest = typeof frontmatter.digest === "string" && frontmatter.digest.trim() ? frontmatter.digest.trim() : undefined;
  if (document.body.length > OUTLINE_ENTRY_MAX_CHARS) warn("text-too-long", `the text is ${document.body.length} characters long: the autopilot reads the first ${OUTLINE_ENTRY_MAX_CHARS}`);
  return { frontmatter, body: document.body, unreadable, title, origin, ...(digest ? { digest } : {}), warn };
}

function textField(frontmatter: Record<string, unknown>, key: string, warn: (code: OutlineWarningCode, message: string) => void): string {
  const value = frontmatter[key];
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  warn("not-text", `${key} must be text (${quoted(value)} is not): it is left empty`);
  return "";
}

/** One entry of the outline from its file. The number is the file's; a frontmatter that says another is a warning. */
export async function readOutlineChapter(path: string, number: number, content: string, hash?: string): Promise<{ entry: OutlineChapterEntry; warnings: OutlineWarning[] }> {
  const warnings: OutlineWarning[] = [];
  const reading = readEntryFile(path, content, warnings, number);
  const ghostwriter = textField(reading.frontmatter, "ghostwriter", reading.warn) || undefined;
  const declared = reading.frontmatter.number;
  if (declared !== undefined && declared !== null && Number(declared) !== number) {
    reading.warn("number-mismatch", `the frontmatter says chapter ${quoted(declared)}, the name of the file says ${number}: the name wins`);
  }
  const contentDigest = await outlineEntryDigest({ title: reading.title, body: reading.body, ghostwriter });
  const intact = !reading.unreadable && reading.origin === "autopilot" && reading.digest === contentDigest;
  return {
    entry: {
      number,
      path,
      ...(hash ? { hash } : {}),
      title: reading.title,
      body: reading.body,
      ...(ghostwriter ? { ghostwriter } : {}),
      origin: reading.origin,
      ...(reading.digest ? { digest: reading.digest } : {}),
      contentDigest,
      intact,
      ...(reading.unreadable ? { unreadable: true, raw: content } : {}),
      frontmatter: reading.frontmatter,
    },
    warnings,
  };
}

/** The description of the book from `outline/book.md`. */
export async function readOutlineBook(content: string, hash?: string): Promise<{ book: OutlineBookEntry; warnings: OutlineWarning[] }> {
  const warnings: OutlineWarning[] = [];
  const reading = readEntryFile(OUTLINE_BOOK_FILE, content, warnings);
  const contentDigest = await outlineBookDigest({ title: reading.title, body: reading.body });
  return {
    book: {
      path: OUTLINE_BOOK_FILE,
      ...(hash ? { hash } : {}),
      title: reading.title,
      body: reading.body,
      origin: reading.origin,
      ...(reading.digest ? { digest: reading.digest } : {}),
      contentDigest,
      intact: !reading.unreadable && reading.origin === "autopilot" && reading.digest === contentDigest,
      ...(reading.unreadable ? { unreadable: true } : {}),
      frontmatter: reading.frontmatter,
    },
    warnings,
  };
}

/** Runs of numbers that have no entry, from 1 to the last entry: `2-3`, `6`. */
function missingRanges(numbers: number[]): string[] {
  const ranges: string[] = [];
  let expected = 1;
  for (const number of numbers) {
    if (number > expected) ranges.push(number - 1 === expected ? `${expected}` : `${expected}-${number - 1}`);
    expected = Math.max(expected, number + 1);
  }
  return ranges;
}

const LISTED_GAPS = 10;

function gapWarning(numbers: number[]): OutlineWarning | null {
  const ranges = missingRanges(numbers);
  if (!ranges.length) return null;
  const listed = ranges.slice(0, LISTED_GAPS).join(", ");
  const more = ranges.length > LISTED_GAPS ? ` and ${ranges.length - LISTED_GAPS} more runs` : "";
  return { code: "gap", message: `outline: chapters ${listed}${more} have no entry; the autopilot plans them freely, between the entries around them.` };
}

/**
 * The outline from its files (`outline/book.md`, `outline/chapters/<NNN>.md`; the other files are left out). Pure, with no I/O:
 * `files` are the files as a store has them, with their hashes when an edit has to be made on them. Never throws: what is odd
 * (YAML that cannot be read, two files for one chapter, a number of the frontmatter that is not the file's, a chapter without an
 * entry between two that have one) is a warning, and the entry is read as far as it can be.
 */
export async function parseOutline(files: ReadonlyArray<{ path: string; content: string; hash?: string } | null | undefined>): Promise<ParsedOutline> {
  const warnings: OutlineWarning[] = [];
  let book: OutlineBookEntry | null = null;
  const byNumber = new Map<number, Array<{ path: string; content: string; hash?: string; canonical: boolean }>>();
  for (const file of files) {
    if (!file) continue;
    if (file.path === OUTLINE_BOOK_FILE) {
      const read = await readOutlineBook(file.content, file.hash);
      book = read.book;
      warnings.push(...read.warnings);
      continue;
    }
    if (!file.path.startsWith(`${OUTLINE_DIRECTORY}/`)) continue;
    const parsed = parseOutlineChapterPath(file.path);
    if (!parsed) {
      warnings.push({ code: "not-an-entry", path: file.path, message: `${file.path} is not an entry of the outline: an entry is outline/chapters/<number>.md, as outline/chapters/${formatOrdinal(1)}.md.` });
      continue;
    }
    const same = byNumber.get(parsed.number) ?? [];
    same.push({ path: file.path, content: file.content, hash: file.hash, canonical: parsed.canonical });
    byNumber.set(parsed.number, same);
  }
  const numbers = [...byNumber.keys()].sort((left, right) => left - right);
  const chosen = numbers.map((number) => {
    const candidates = byNumber.get(number)!.sort((left, right) => Number(right.canonical) - Number(left.canonical) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (const other of candidates.slice(1)) {
      warnings.push({ code: "duplicate", path: other.path, number, message: `${other.path} is a second entry for chapter ${number}: ${candidates[0].path} is the one that counts; remove or renumber the other.` });
    }
    return { number, ...candidates[0] };
  });
  const chapters: OutlineChapterEntry[] = [];
  for (const file of chosen) {
    const read = await readOutlineChapter(file.path, file.number, file.content, file.hash);
    chapters.push(read.entry);
    warnings.push(...read.warnings);
  }
  const gap = gapWarning(numbers);
  if (gap) warnings.push(gap);
  return { book, chapters, warnings };
}

// ─── Writing ────────────────────────────────────────────────────────────────

/** An entry to write. `origin` is the author's unless the autopilot writes it; only the autopilot's carries a `digest`. */
export interface OutlineChapterInput {
  number: number;
  title?: string;
  body?: string;
  ghostwriter?: string | null;
  origin?: OutlineOrigin;
  digest?: string;
  /** The keys the file has now: kept, but for the ones the format manages. */
  frontmatter?: Record<string, unknown>;
}

export function serializeOutlineChapter(entry: OutlineChapterInput): string {
  const origin: OutlineOrigin = entry.origin === "autopilot" ? "autopilot" : "author";
  return renderMarkdown({
    ...(entry.frontmatter ?? {}),
    type: "outline-chapter",
    id: `outline-chapter:${formatOrdinal(entry.number)}`,
    number: entry.number,
    title: entry.title?.trim() || undefined,
    ghostwriter: entry.ghostwriter?.trim() || undefined,
    origin,
    digest: origin === "autopilot" ? entry.digest?.trim() || undefined : undefined,
  }, canonicalText(entry.body));
}

export interface OutlineBookInput {
  title?: string | null;
  body?: string;
  origin?: OutlineOrigin;
  digest?: string;
  frontmatter?: Record<string, unknown>;
}

export function serializeOutlineBook(book: OutlineBookInput): string {
  const origin: OutlineOrigin = book.origin === "autopilot" ? "autopilot" : "author";
  return renderMarkdown({
    ...(book.frontmatter ?? {}),
    type: "outline",
    id: "outline:book",
    title: book.title?.trim() || undefined,
    origin,
    digest: origin === "autopilot" ? book.digest?.trim() || undefined : undefined,
  }, canonicalText(book.body));
}

// ─── Edits on behalf of the author ──────────────────────────────────────────

export interface OutlineEntryInput {
  title?: string;
  body?: string;
  /** `null` takes the ghostwriter away: the book's writes the chapter. */
  ghostwriter?: string | null;
}

/**
 * What the author does to the outline. `append` adds a chapter after the last; `insert` puts one at position `at`, and the entries
 * from there on move one number up; `move` takes the entry `from` to position `to`, the ones in between following; `remove` deletes
 * an entry and leaves its number empty, unless `renumber` closes the gap; `update` changes the title, the text or the ghostwriter
 * of an entry (the fields that are given), and creates it when there is none; `book` changes the working title or the description.
 */
export type OutlineEdit =
  | { kind: "append"; entry: OutlineEntryInput }
  | { kind: "insert"; at: number; entry: OutlineEntryInput }
  | { kind: "move"; from: number; to: number }
  | { kind: "remove"; number: number; renumber?: boolean }
  | { kind: "update"; number: number; entry: OutlineEntryInput }
  | { kind: "book"; title?: string | null; body?: string };

export interface OutlineChangesInput {
  /** The outline as it is now, read with the hashes of its files (`parseOutline`): every change expects the file it read. */
  outline: ParsedOutline;
  edit: OutlineEdit;
  /** The ghostwriters of the book (the slugs of `ghostwriters/<slug>.md`). Without the list, the ghostwriters are not checked. */
  ghostwriters?: readonly string[];
}

export interface OutlineChangesResult {
  /** One commit of the store: the files to write and to delete, each expecting the file as it was read (`null`: it must not exist). */
  changes: BookFileChange[];
  warnings: OutlineWarning[];
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`The outline edit needs ${name} to be a whole number from 1: ${String(value)} is not.`);
  return value;
}

interface Placement {
  number: number;
  entry?: OutlineChapterEntry;
  input?: OutlineEntryInput;
}

/** The text and the title of an edit within their limits, and its ghostwriter checked: what is cut or odd is a warning. */
function checkedInput(number: number, input: OutlineEntryInput, base: OutlineChapterEntry | undefined, ghostwriters: readonly string[] | undefined, warnings: OutlineWarning[]): { title: string; body: string; ghostwriter?: string } {
  const path = outlineChapterPath(number);
  let title = (input.title !== undefined ? input.title : base?.title ?? "").trim();
  let body = canonicalText(input.body !== undefined ? input.body : base?.body ?? "");
  const ghostwriter = (input.ghostwriter === null ? "" : input.ghostwriter !== undefined ? input.ghostwriter : base?.ghostwriter ?? "").trim();
  if (title.length > OUTLINE_TITLE_MAX_CHARS) {
    warnings.push({ code: "title-too-long", path, number, message: `${path}: the title was ${title.length} characters long and is cut at ${OUTLINE_TITLE_MAX_CHARS}: it becomes the name of the chapter's folder.` });
    title = clipText(title, OUTLINE_TITLE_MAX_CHARS).trim();
  }
  if (body.length > OUTLINE_ENTRY_MAX_CHARS) {
    warnings.push({ code: "text-too-long", path, number, message: `${path}: the text was ${body.length} characters long and is cut at ${OUTLINE_ENTRY_MAX_CHARS}.` });
    body = clipText(body, OUTLINE_ENTRY_MAX_CHARS);
  }
  if (ghostwriter && !isValidGhostwriterSlug(ghostwriter)) {
    warnings.push({ code: "ghostwriter-invalid", path, number, message: `${path}: the ghostwriter ${quoted(ghostwriter)} is not the name of a file of ghostwriters/: the book's ghostwriter will write the chapter.` });
  } else if (ghostwriter && ghostwriters && !ghostwriters.includes(ghostwriter)) {
    warnings.push({ code: "ghostwriter-missing", path, number, message: `${path}: the ghostwriter ${ghostwriter} does not exist (ghostwriters/${ghostwriter}.md): the book's ghostwriter will write the chapter until it does.` });
  }
  if (base?.unreadable) {
    warnings.push({ code: "unreadable", path, number, message: `${path}: its frontmatter could not be read, so the entry is written anew from this edit; keys that could not be read are not kept.` });
  }
  return { title, body, ...(ghostwriter ? { ghostwriter } : {}) };
}

/**
 * The changes that make an edit of the author: one list for one commit, however many files move (inserting a chapter at the head of
 * an outline of 5000 renames 5000 entries). Every entry the edit writes or moves is the author's (`origin: author`, no `digest`):
 * the autopilot follows it and never rewrites it. The keys of a file the format does not manage are kept; an entry whose frontmatter
 * cannot be read is moved as it is. Never an error for what the outline says (a ghostwriter that does not exist, a text too long, a
 * chapter left without an entry): those are warnings. Only arguments that are not numbers of chapters throw.
 */
export function outlineChanges(input: OutlineChangesInput): OutlineChangesResult {
  const { outline, edit, ghostwriters } = input;
  const warnings: OutlineWarning[] = [];

  if (edit.kind === "book") {
    const base = outline.book ?? undefined;
    let body = canonicalText(edit.body !== undefined ? edit.body : base?.body ?? "");
    if (body.length > OUTLINE_ENTRY_MAX_CHARS) {
      warnings.push({ code: "text-too-long", path: OUTLINE_BOOK_FILE, message: `${OUTLINE_BOOK_FILE}: the description was ${body.length} characters long and is cut at ${OUTLINE_ENTRY_MAX_CHARS}.` });
      body = clipText(body, OUTLINE_ENTRY_MAX_CHARS);
    }
    const title = edit.title === null ? undefined : (edit.title !== undefined ? edit.title : base?.title)?.trim();
    const content = serializeOutlineBook({ title, body, origin: "author", frontmatter: base && !base.unreadable ? base.frontmatter : undefined });
    return { changes: [{ path: OUTLINE_BOOK_FILE, content, expectedHash: base ? base.hash : null }], warnings };
  }

  const entries = outline.chapters;
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
  const last = entries.reduce((highest, entry) => Math.max(highest, entry.number), 0);
  const unchanged = (entry: OutlineChapterEntry): Placement => ({ number: entry.number, entry });
  let placements: Placement[];
  switch (edit.kind) {
    case "append":
      placements = [...entries.map(unchanged), { number: last + 1, input: edit.entry ?? {} }];
      break;
    case "insert": {
      const at = positiveNumber(edit.at, "the position");
      placements = [...entries.map((entry) => ({ number: entry.number >= at ? entry.number + 1 : entry.number, entry })), { number: at, input: edit.entry ?? {} }];
      break;
    }
    case "move": {
      const from = positiveNumber(edit.from, "the chapter to move");
      const to = positiveNumber(edit.to, "the position");
      if (!byNumber.has(from)) {
        warnings.push({ code: "not-found", number: from, message: `outline: chapter ${from} has no entry to move.` });
        return { changes: [], warnings };
      }
      if (from === to) return { changes: [], warnings };
      placements = entries.map((entry) => {
        if (entry.number === from) return { number: to, entry };
        if (from < to && entry.number > from && entry.number <= to) return { number: entry.number - 1, entry };
        if (from > to && entry.number >= to && entry.number < from) return { number: entry.number + 1, entry };
        return unchanged(entry);
      });
      break;
    }
    case "remove": {
      const number = positiveNumber(edit.number, "the chapter to remove");
      if (!byNumber.has(number)) {
        warnings.push({ code: "not-found", number, message: `outline: chapter ${number} has no entry to remove.` });
        return { changes: [], warnings };
      }
      placements = entries.filter((entry) => entry.number !== number).map((entry) => ({ number: edit.renumber && entry.number > number ? entry.number - 1 : entry.number, entry }));
      break;
    }
    case "update": {
      const number = positiveNumber(edit.number, "the chapter to change");
      const base = byNumber.get(number);
      placements = [...entries.filter((entry) => entry.number !== number).map(unchanged), { number, ...(base ? { entry: base } : {}), input: edit.entry ?? {} }];
      break;
    }
    default:
      throw new TypeError(`Unknown outline edit: ${String((edit as { kind?: unknown }).kind)}`);
  }

  // What every file of the outline holds once the edit is made: the entries that keep their number and their text stay as they are.
  const writes = new Map<string, string>();
  const kept = new Set<string>();
  for (const placement of placements) {
    const { entry, number } = placement;
    if (entry && !placement.input && entry.number === number) {
      kept.add(entry.path);
      continue;
    }
    const path = outlineChapterPath(number);
    if (placement.input) {
      const value = checkedInput(number, placement.input, entry, ghostwriters, warnings);
      writes.set(path, serializeOutlineChapter({ number, ...value, origin: "author", frontmatter: entry && !entry.unreadable ? entry.frontmatter : undefined }));
    } else if (entry?.unreadable && entry.raw !== undefined) {
      writes.set(path, entry.raw);
    } else if (entry) {
      writes.set(path, serializeOutlineChapter({ number, title: entry.title, body: entry.body, ghostwriter: entry.ghostwriter, origin: "author", frontmatter: entry.frontmatter }));
    }
  }
  const hashOf = new Map(entries.map((entry) => [entry.path, entry.hash]));
  const changes: BookFileChange[] = [];
  for (const [path, content] of writes) changes.push({ path, content, expectedHash: hashOf.has(path) ? hashOf.get(path) : null });
  for (const entry of entries) {
    if (kept.has(entry.path) || writes.has(entry.path)) continue;
    changes.push({ path: entry.path, content: null, expectedHash: entry.hash });
  }
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const gap = gapWarning([...new Set(placements.map((placement) => placement.number))].sort((left, right) => left - right));
  if (gap) warnings.push(gap);
  return { changes, warnings };
}

// ─── The outline of a book in a store ───────────────────────────────────────

export interface OutlineIndexEntry {
  number: number;
  path: string;
  hash: string;
}

/** The files of the outline with their hashes, known from the list of the book's files without reading any. */
export interface OutlineIndex {
  book: { path: string; hash: string } | null;
  /** One file per chapter (the one with the name the core gives it, when there are two), in order of number. */
  chapters: OutlineIndexEntry[];
}

export function outlineIndex(files: Iterable<readonly [string, string]>): OutlineIndex {
  let book: OutlineIndex["book"] = null;
  const byNumber = new Map<number, { path: string; hash: string; canonical: boolean }>();
  for (const [path, hash] of files) {
    if (path === OUTLINE_BOOK_FILE) {
      book = { path, hash };
      continue;
    }
    if (!path.startsWith("outline/chapters/")) continue;
    const parsed = parseOutlineChapterPath(path);
    if (!parsed) continue;
    const known = byNumber.get(parsed.number);
    if (!known || (!known.canonical && (parsed.canonical || path < known.path))) byNumber.set(parsed.number, { path, hash, canonical: parsed.canonical });
  }
  const chapters = [...byNumber.entries()].sort(([left], [right]) => left - right).map(([number, file]) => ({ number, path: file.path, hash: file.hash }));
  return { book, chapters };
}

/** Entries read from a store, kept by path and hash: a run reads a file of the outline again only when it changed. */
export class OutlineCache {
  private readonly chapters = new Map<string, { hash: string; entry: OutlineChapterEntry; warnings: OutlineWarning[] }>();
  private book: { hash: string; book: OutlineBookEntry; warnings: OutlineWarning[] } | null = null;

  async chapter(store: BookStore, file: OutlineIndexEntry): Promise<{ entry: OutlineChapterEntry; warnings: OutlineWarning[] } | null> {
    const cached = this.chapters.get(file.path);
    if (cached && cached.hash === file.hash) return cached;
    const read = await store.read(file.path);
    if (!read) return null;
    const result = await readOutlineChapter(file.path, file.number, read.content, read.hash);
    const value = { hash: read.hash, ...result };
    this.chapters.set(file.path, value);
    return value;
  }

  async bookEntry(store: BookStore, file: { path: string; hash: string }): Promise<{ book: OutlineBookEntry; warnings: OutlineWarning[] } | null> {
    if (this.book && this.book.hash === file.hash) return this.book;
    const read = await store.read(file.path);
    if (!read) return null;
    const result = await readOutlineBook(read.content, read.hash);
    this.book = { hash: read.hash, ...result };
    return this.book;
  }
}

/** Files read at once by `OutlineReader.chapters`: a big outline is read in batches, never with thousands of reads in flight. */
const READ_BATCH = 64;

/**
 * The outline of a book as the autopilot reads it: from the index of the snapshot (paths and hashes), reading a file only when
 * something needs what it says, through a cache that a run keeps from one step to the next.
 */
export class OutlineReader {
  private readonly byNumber: Map<number, OutlineIndexEntry>;
  private readonly seen = new Map<string, OutlineWarning[]>();

  constructor(private readonly store: BookStore, readonly index: OutlineIndex, private readonly cache = new OutlineCache()) {
    this.byNumber = new Map(index.chapters.map((entry) => [entry.number, entry]));
  }

  /** The outline of a snapshot: its index when it has one, else the one its files make. */
  static of(store: BookStore, snapshot: { files: ReadonlyMap<string, string>; outline?: OutlineIndex }, cache?: OutlineCache): OutlineReader {
    return new OutlineReader(store, snapshot.outline ?? outlineIndex(snapshot.files), cache);
  }

  /** No entry and no description. */
  get empty(): boolean {
    return !this.index.book && this.index.chapters.length === 0;
  }

  has(number: number): boolean {
    return this.byNumber.has(number);
  }

  /** The highest chapter that has an entry, binding or not (0 without entries). */
  get last(): number {
    return this.index.chapters.at(-1)?.number ?? 0;
  }

  async chapter(number: number): Promise<OutlineChapterEntry | null> {
    const file = this.byNumber.get(number);
    if (!file) return null;
    const read = await this.cache.chapter(this.store, file);
    if (!read) return null;
    this.seen.set(file.path, read.warnings);
    return read.entry;
  }

  /** The entries of these chapters (all of them without a list), in order of number. */
  async chapters(numbers?: Iterable<number>): Promise<OutlineChapterEntry[]> {
    const wanted = numbers ? new Set(numbers) : null;
    const files = wanted ? this.index.chapters.filter((file) => wanted.has(file.number)) : this.index.chapters;
    const entries: OutlineChapterEntry[] = [];
    for (let start = 0; start < files.length; start += READ_BATCH) {
      const read = await Promise.all(files.slice(start, start + READ_BATCH).map((file) => this.chapter(file.number)));
      for (const entry of read) if (entry) entries.push(entry);
    }
    return entries;
  }

  async book(): Promise<OutlineBookEntry | null> {
    if (!this.index.book) return null;
    const read = await this.cache.bookEntry(this.store, this.index.book);
    if (!read) return null;
    this.seen.set(this.index.book.path, read.warnings);
    return read.book;
  }

  /**
   * The last chapter the author's outline asks for: the highest number above `above` whose entry binds (the author's), else 0.
   * Only the entries above `above` are read, from the last down, until one binds.
   */
  async lastAuthorChapter(above = 0): Promise<number> {
    for (let index = this.index.chapters.length - 1; index >= 0; index -= 1) {
      const file = this.index.chapters[index];
      if (file.number <= above) break;
      const entry = await this.chapter(file.number);
      if (entry && !entry.intact) return entry.number;
    }
    return 0;
  }

  /** The warnings of the files read so far. */
  warnings(): OutlineWarning[] {
    return [...this.seen.values()].flat();
  }
}
