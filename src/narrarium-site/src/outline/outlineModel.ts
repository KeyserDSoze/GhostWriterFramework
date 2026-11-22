import {
  OUTLINE_BOOK_FILE,
  outlineChanges,
  parseChapterFreeze,
  parseMarkdown,
  parseOutline,
  parseOutlineChapterPath,
  readOutlineBook,
  readOutlineChapter,
  sha256Hex,
  type BookFileChange,
  type FrozenEditsMode,
  type OutlineChapterEntry,
  type OutlineEdit,
  type OutlineWarning,
  type ParsedOutline,
  type PlannedChapter,
} from "narrarium-engine";
import { chapterNumberFromSlug } from "@/lib/chapterSlug";
import { matchKey } from "@/lib/matchText";

/**
 * What the Outline page knows of the outline (the Scaletta, `outline/` of the book) and how its edits become one commit. Everything here works on
 * the engine's own reading of the files (`parseOutline`, `readOutlineChapter`) and on its edits (`outlineChanges`): the page never writes a
 * frontmatter itself, and an entry it writes is the author's (`origin: author`) because the engine makes it so.
 */

/** A file of `outline/` as the book has it: its text and the hash of the text (hex SHA-256, the hash of the local working copy and of the engine). */
export interface OutlineFile {
  path: string;
  content: string;
  hash: string;
}

/** The files of the outline and what the engine reads of them. */
export interface OutlineSnapshot {
  files: ReadonlyMap<string, OutlineFile>;
  outline: ParsedOutline;
}

export async function snapshotOf(files: readonly OutlineFile[]): Promise<OutlineSnapshot> {
  const map = new Map(files.filter((file) => isOutlinePath(file.path)).map((file) => [file.path, file]));
  return { files: map, outline: await parseOutline([...map.values()]) };
}

export function isOutlinePath(path: string): boolean {
  return path === OUTLINE_BOOK_FILE || path.startsWith("outline/");
}

/** Two files for one chapter, or a file that is no entry: the outline is read again whole, as the engine reads it, instead of entry by entry. */
function needsFullReading(outline: ParsedOutline): boolean {
  return outline.warnings.some((warning) => warning.code === "duplicate" || warning.code === "not-an-entry");
}

/**
 * The outline once `changes` are saved. Only the files that changed are read again (an outline of 5000 entries is not parsed again for an edit of
 * one); an outline with two files for one chapter is read again whole, so that the same file wins as in the engine.
 */
export async function applyToSnapshot(snapshot: OutlineSnapshot, changes: readonly BookFileChange[]): Promise<OutlineSnapshot> {
  const files = new Map(snapshot.files);
  const written: OutlineFile[] = [];
  const removed: string[] = [];
  for (const change of changes) {
    if (!isOutlinePath(change.path)) continue;
    if (change.content === null) {
      files.delete(change.path);
      removed.push(change.path);
    } else {
      const file = { path: change.path, content: change.content, hash: await sha256Hex(change.content) };
      files.set(change.path, file);
      written.push(file);
    }
  }
  if (needsFullReading(snapshot.outline) || [...written, ...removed.map((path) => ({ path }))].some(({ path }) => path !== OUTLINE_BOOK_FILE && !parseOutlineChapterPath(path)?.canonical)) {
    return { files, outline: await parseOutline([...files.values()]) };
  }
  const changed = new Set([...written.map((file) => file.path), ...removed]);
  let book = snapshot.outline.book;
  const byNumber = new Map(snapshot.outline.chapters.map((entry) => [entry.number, entry]));
  const warnings = snapshot.outline.warnings.filter((warning) => warning.code !== "gap" && !(warning.path && changed.has(warning.path)));
  for (const path of removed) {
    if (path === OUTLINE_BOOK_FILE) book = null;
    else {
      const number = parseOutlineChapterPath(path)?.number;
      if (number !== undefined && byNumber.get(number)?.path === path) byNumber.delete(number);
    }
  }
  for (const file of written) {
    if (file.path === OUTLINE_BOOK_FILE) {
      const read = await readOutlineBook(file.content, file.hash);
      book = read.book;
      warnings.push(...read.warnings);
      continue;
    }
    const number = parseOutlineChapterPath(file.path)!.number;
    const read = await readOutlineChapter(file.path, number, file.content, file.hash);
    byNumber.set(number, read.entry);
    warnings.push(...read.warnings);
  }
  return { files, outline: { book, chapters: [...byNumber.values()].sort((left, right) => left.number - right.number), warnings } };
}

export interface ComposedEdits {
  /** One commit: every file written or deleted once, expecting the version that was read (`null`: it must not exist). */
  changes: BookFileChange[];
  warnings: OutlineWarning[];
  /** The outline once the commit is saved. */
  next: OutlineSnapshot;
}

/**
 * Several edits of the author as one commit: each is made by the engine on the outline the previous one left, and the files are then written
 * once, with their final text. A file that comes back to what it was is left alone.
 */
export async function composeEdits(snapshot: OutlineSnapshot, edits: readonly OutlineEdit[], ghostwriters?: readonly string[]): Promise<ComposedEdits> {
  let current = snapshot;
  const finalContent = new Map<string, string | null>();
  const warnings: OutlineWarning[] = [];
  for (const edit of edits) {
    const result = outlineChanges({ outline: current.outline, edit, ghostwriters });
    warnings.push(...result.warnings);
    for (const change of result.changes) finalContent.set(change.path, change.content);
    current = await applyToSnapshot(current, result.changes);
  }
  const changes: BookFileChange[] = [];
  for (const [path, content] of finalContent) {
    const original = snapshot.files.get(path);
    if ((original?.content ?? null) === content) continue;
    changes.push({ path, content, expectedHash: original ? original.hash : null });
  }
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  // What the files are after the commit, read again from the final texts (the intermediate ones are gone).
  const next = changes.length ? await applyToSnapshot(snapshot, changes) : snapshot;
  return { changes, warnings, next };
}

/** The changes that put back the files an action changed, each expecting the version the action left. */
export async function restoreChanges(before: OutlineSnapshot, changes: readonly BookFileChange[]): Promise<BookFileChange[]> {
  return Promise.all(changes.map(async (change) => {
    const previous = before.files.get(change.path);
    return { path: change.path, content: previous ? previous.content : null, expectedHash: change.content === null ? null : await sha256Hex(change.content) };
  }));
}

// ─── What the page says of an entry ─────────────────────────────────────────

export interface WrittenChapter {
  slug: string;
  title: string;
}

export interface EntryStatus {
  /** `autopilot`: written by the autopilot from its plan and untouched since; every other entry is the author's, and binds. */
  origin: "autopilot" | "author";
  /** The chapter of the book with this number, when it has text. */
  written: WrittenChapter | null;
  /** The plan of the autopilot says the chapter is approved. */
  approved: boolean;
  /** The entry changed since the plan followed it and the chapter is not written yet: the autopilot plans it again before writing it. */
  replan: boolean;
  /** The ghostwriter the entry names, when the book does not have it. */
  missingGhostwriter: string | null;
  /** What the engine found odd in the file of the entry (YAML, number, length…). */
  warnings: OutlineWarning[];
  /** The written chapter is frozen: its chapter.md holds a record the engine reads. */
  frozen: boolean;
  /** What the autopilot does when the entry changes, its chapter being closed (`ask`, `auto`, `notify`); `null` when it does nothing of the kind. */
  afterChange: FrozenEditsMode | null;
}

export interface StatusContext {
  plan: ReadonlyMap<number, PlannedChapter>;
  written: ReadonlyMap<number, WrittenChapter>;
  ghostwriters: ReadonlySet<string>;
  warnings: ReadonlyMap<string, OutlineWarning[]>;
  /** The slugs of the written chapters that are frozen (the page reads those of the entries on the screen). */
  frozen?: ReadonlySet<string>;
  /** `options.frozenEdits` of the autopilot: `ask` when it has none. */
  mode?: FrozenEditsMode;
}

/** The written chapters among these files of chapter.md that are frozen: a record the engine reads, as it reads it (one that cannot be read is no freeze). */
export function frozenChapterSlugs(files: ReadonlyArray<{ path: string; content: string }>): Set<string> {
  const frozen = new Set<string>();
  for (const file of files) {
    const slug = /^chapters\/([^/]+)\/chapter\.md$/.exec(file.path)?.[1];
    if (!slug) continue;
    try {
      if (parseChapterFreeze(parseMarkdown(file.content).frontmatter.frozen).freeze) frozen.add(slug);
    } catch {
      // A frontmatter that cannot be read holds no record.
    }
  }
  return frozen;
}

/**
 * What the autopilot does when the entry of chapter `number` changes: the engine's rule (`outlineCheck`), for a chapter it closed whose plan
 * remembers the entry it followed; it asks, rewrites the chapter or only reports it, as `options.frozenEdits` says, and never rewrites a chapter
 * of the author for a decision of its own. `null` for any other chapter: one not written yet is planned again, one being written is decided
 * about once it is closed.
 */
export function changeOfWritten(number: number, context: Pick<StatusContext, "plan" | "mode">): FrozenEditsMode | null {
  const planned = context.plan.get(number);
  if (!planned || planned.status !== "done" || !planned.outlineDigest) return null;
  const mode = context.mode ?? "ask";
  return mode === "auto" && planned.imported ? "notify" : mode;
}

/** The chapters among `numbers` whose change the autopilot will ask about, carry out or report, grouped by what it will do, in the order of the book. */
export function writtenChanges(numbers: readonly number[], context: Pick<StatusContext, "plan" | "mode">): Array<{ mode: FrozenEditsMode; numbers: number[] }> {
  const groups = new Map<FrozenEditsMode, number[]>();
  for (const number of [...new Set(numbers)].sort((left, right) => left - right)) {
    const mode = changeOfWritten(number, context);
    if (mode) groups.set(mode, [...(groups.get(mode) ?? []), number]);
  }
  return (["ask", "auto", "notify"] as const).filter((mode) => groups.has(mode)).map((mode) => ({ mode, numbers: groups.get(mode)! }));
}

/** The chapters of the book that have text, by number (the number of the folder: `007-the-key`). */
export function writtenChapters(chapters: ReadonlyArray<{ slug: string; title: string; paragraphs: readonly unknown[] }>): Map<number, WrittenChapter> {
  const written = new Map<number, WrittenChapter>();
  for (const chapter of chapters) {
    const number = chapterNumberFromSlug(chapter.slug);
    if (number !== null && chapter.paragraphs.length > 0 && !written.has(number)) written.set(number, { slug: chapter.slug, title: chapter.title });
  }
  return written;
}

export function warningsByPath(warnings: readonly OutlineWarning[]): Map<string, OutlineWarning[]> {
  const byPath = new Map<string, OutlineWarning[]>();
  for (const warning of warnings) {
    if (!warning.path) continue;
    byPath.set(warning.path, [...(byPath.get(warning.path) ?? []), warning]);
  }
  return byPath;
}

export function entryStatus(entry: OutlineChapterEntry, context: StatusContext): EntryStatus {
  const plan = context.plan.get(entry.number);
  const written = context.written.get(entry.number) ?? null;
  const approved = plan?.status === "done";
  // The rule of the engine (`outlinePlanStatus`): an entry that is not the one the plan followed, unless it is the autopilot's own for a plan that never knew it.
  const replan = Boolean(plan && !written && !approved && !plan.imported && !entry.unreadable && entry.contentDigest !== plan.outlineDigest && !(entry.intact && !plan.outlineDigest));
  const missingGhostwriter = entry.ghostwriter && !context.ghostwriters.has(entry.ghostwriter) ? entry.ghostwriter : null;
  return {
    origin: entry.intact ? "autopilot" : "author",
    written,
    approved,
    replan,
    missingGhostwriter,
    warnings: context.warnings.get(entry.path) ?? [],
    frozen: Boolean(written && context.frozen?.has(written.slug)),
    afterChange: changeOfWritten(entry.number, context),
  };
}

/** The chapters between the first and the last entry that have none, as runs: `[[3, 4], [7, 7]]`. */
export function missingNumbers(numbers: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let expected = 1;
  for (const number of [...numbers].sort((left, right) => left - right)) {
    if (number > expected) runs.push([expected, number - 1]);
    expected = Math.max(expected, number + 1);
  }
  return runs;
}

/** The entries that match what the author typed: the number of the chapter, or words of its title or of what happens, whatever their case and accents. */
export function filterEntries(entries: readonly OutlineChapterEntry[], query: string): OutlineChapterEntry[] {
  const text = query.trim();
  if (!text) return [...entries];
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return entries.filter((entry) => entry.number === number);
  }
  const key = matchKey(text);
  if (!key) return [...entries];
  return entries.filter((entry) => matchKey(`${entry.title} ${entry.body}`).includes(key));
}

/** Where the entry numbered `number` is after `edit`, as the engine places the files; `null` when the edit deletes it. */
export function remapNumber(edit: OutlineEdit, number: number): number | null {
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

// ─── The chapter-by-chapter synopsis of the brief ───────────────────────────

export interface ConvertedSynopsis {
  /** What comes before the first chapter: it goes to the description of the book. */
  description: string;
  entries: Array<{ number: number; title: string; body: string }>;
}

const CHAPTER_LINE = /^(?:#+\s*)?(?:[-*•]\s*)?(?:\*\*)?(?:capitolo|cap\.|chapter|chap\.|ch\.)\s*(\d+)(?:\*\*)?\s*(?:[:.)\-–—]\s*)?(?:\*\*)?\s*(.*)$/i;
const NUMBERED_LINE = /^(?:#+\s*)?(\d+)\s*[.)]\s+(.*)$/;
const TITLE_SEPARATOR = /\s+[—–-]\s+|:\s+/;
const TITLE_MAX = 80;

/** A hypothetical title and what happens, from the text after the number: `The key — Mira finds it` splits; a short phrase is a title; a sentence is what happens. */
function titleAndBody(text: string): { title: string; body: string } {
  const separator = TITLE_SEPARATOR.exec(text);
  if (separator && separator.index > 0 && separator.index <= TITLE_MAX) {
    return { title: text.slice(0, separator.index).trim(), body: text.slice(separator.index + separator[0].length).trim() };
  }
  if (text.length <= 60 && !/[.!?…]$/.test(text) && !text.includes(", ")) return { title: text, body: "" };
  return { title: "", body: text };
}

/**
 * The lines `Capitolo N: …`, `Chapter N - …` or `N. …` of a synopsis as entries of the outline, with the lines that follow each one as part of what
 * happens in it; what comes before the first is the description of the book. A number used twice, or 0, takes the one after the last.
 */
export function convertSynopsis(text: string): ConvertedSynopsis {
  const preface: string[] = [];
  const entries: Array<{ number: number; title: string; lines: string[] }> = [];
  const used = new Set<number>();
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const match = CHAPTER_LINE.exec(line) ?? NUMBERED_LINE.exec(line);
    if (match) {
      let number = Number(match[1]);
      if (!Number.isSafeInteger(number) || number < 1 || used.has(number)) number = Math.max(0, ...used) + 1;
      used.add(number);
      const rest = match[2].replace(/\*\*/g, "").trim();
      const { title, body } = titleAndBody(rest);
      entries.push({ number, title, lines: body ? [body] : [] });
    } else if (entries.length) {
      entries[entries.length - 1].lines.push(line);
    } else {
      preface.push(line);
    }
  }
  const tidy = (lines: string[]) => lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { description: tidy(preface), entries: entries.map((entry) => ({ number: entry.number, title: entry.title, body: tidy(entry.lines) })) };
}
