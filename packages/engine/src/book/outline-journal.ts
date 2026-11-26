import { Document, isMap, isSeq, parseDocument } from "yaml";
import { readOutlineChapter } from "./outline.js";
import { OUTLINE_CHANGES_FILE, parseOutlineChapterPath } from "./paths.js";
import type { BookFileChange } from "./store.js";
import { randomId } from "../util/hash.js";
import { isItalian } from "../util/text.js";

/**
 * The journal of the Synopsis (`outline/changes.yml`): every series of edits of its entries, oldest first, with when, who and what happened to each
 * chapter, so that the author reads on any device what changed since the autopilot last worked. It is the readable history and nothing else: the
 * autopilot decides from the digest each planned chapter keeps (`PlannedChapter.outlineDigest`), never from here, and a book whose journal is gone
 * loses only its history.
 *
 * - One series a line of history: `id` (unique), `at`, `by` (the author, Brainstorming, the autopilot, an assistant through the personal server's
 *   MCP), an optional `note` (one line: the summary of a proposal), and one item for each chapter whose entry says something else after it: the
 *   chapter (its number in the book), the change (`created`, `modified`, `moved` from another chapter, `removed`), the digest of the entry before
 *   and after (`outlineEntryDigest`), its title and what it was, and a one-line `summary` in the language of the book for whoever opens the file.
 * - Append-only and mergeable: a series is never rewritten, so two copies of the journal are merged by putting their series together (by `id`,
 *   in order of time): `mergeOutlineJournals`. A file that cannot be read, or an item that is not one, is skipped and never stops a write.
 * - Small: the series of the last `OUTLINE_JOURNAL_KEEP_DAYS` days, and never more than the newest `OUTLINE_JOURNAL_MAX_SERIES`; a series lists at
 *   most `OUTLINE_JOURNAL_MAX_CHAPTERS` chapters (and says how many more it changed). Every write prunes it.
 * - Written by the code that saves a series of edits, in the same commit (`outlineJournalChange`): the Synopsis page, the Copilot and Brainstorming
 *   of the web app, the personal server's MCP tool and the autopilot when it fills the Synopsis from its plan.
 */

export const OUTLINE_JOURNAL_KEEP_DAYS = 180;
export const OUTLINE_JOURNAL_MAX_SERIES = 200;
export const OUTLINE_JOURNAL_MAX_CHAPTERS = 200;

const TITLE_CHARS = 120;
const LINE_CHARS = 240;
const DAY_MS = 86_400_000;
const MAX_CHAPTER = 100_000;

/** Who made a series: the author (on the Synopsis page, or applying a proposal of the Copilot), Brainstorming, the autopilot, an assistant through MCP. */
export type OutlineJournalAuthor = "author" | "brainstorming" | "autopilot" | "mcp";
export const OUTLINE_JOURNAL_AUTHORS: readonly OutlineJournalAuthor[] = ["author", "brainstorming", "autopilot", "mcp"];

/**
 * What happened to a chapter: its entry is new (`created`), says something else (`modified`), is the entry of another chapter that moved here
 * (`moved`, with `from`), or is gone (`removed`: the chapter has no entry now).
 */
export type OutlineJournalChangeKind = "created" | "modified" | "moved" | "removed";
export const OUTLINE_JOURNAL_CHANGES: readonly OutlineJournalChangeKind[] = ["created", "modified", "moved", "removed"];

export interface OutlineJournalChapter {
  /** The chapter of the book: the number of its entry after the series (for `removed`, the number that lost its entry). */
  chapter: number;
  change: OutlineJournalChangeKind;
  /** `moved`: the chapter whose entry this one has now. */
  from?: number;
  /** `moved`: and its text changed too. */
  edited?: true;
  /** The title of the entry the chapter has now (for `removed`, of the entry it lost). */
  title?: string;
  /** The title the chapter's entry had before, when it is another one now. */
  was?: string;
  /** The digest of the entry before and after the series (`outlineEntryDigest`); absent when there was none, or there is none. */
  before?: string;
  after?: string;
  /** One line for whoever opens the file, in the language of the book. A host words the change from the fields above, in its own language. */
  summary: string;
}

export interface OutlineJournalSeries {
  id: string;
  /** ISO time. */
  at: string;
  by: OutlineJournalAuthor;
  /** One line: what the series was for (the summary of a proposal), when somebody said it. */
  note?: string;
  chapters: OutlineJournalChapter[];
  /** Chapters the series changed beyond the ones it lists (a series that renumbers a long Synopsis). */
  more?: number;
}

export interface OutlineJournal {
  /** When the author last marked what changed as reviewed: a host lists what came after. The latest of two copies wins. */
  reviewedAt?: string;
  /** Oldest first. */
  series: OutlineJournalSeries[];
}

// ─── Reading ────────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const DIGEST = /^[0-9a-f]{8,64}$/;

function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function moment(value: unknown): string | undefined {
  const text = value instanceof Date ? value.toISOString() : typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function whole(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" ? allowed.find((entry) => entry === value) : undefined;
}

function readChapter(value: unknown): OutlineJournalChapter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const chapter = whole(source.chapter, 1, MAX_CHAPTER);
  const change = oneOf(source.change, OUTLINE_JOURNAL_CHANGES);
  if (chapter === undefined || !change) return null;
  const from = change === "moved" ? whole(source.from, 1, MAX_CHAPTER) : undefined;
  const title = line(source.title, TITLE_CHARS);
  const was = line(source.was, TITLE_CHARS);
  const before = typeof source.before === "string" && DIGEST.test(source.before) ? source.before : undefined;
  const after = typeof source.after === "string" && DIGEST.test(source.after) ? source.after : undefined;
  return {
    chapter,
    change,
    ...(from !== undefined ? { from } : {}),
    ...(change === "moved" && source.edited === true ? { edited: true as const } : {}),
    ...(title ? { title } : {}),
    ...(was ? { was } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    summary: line(source.summary, LINE_CHARS) ?? "",
  };
}

function readSeries(value: unknown): OutlineJournalSeries | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" && ID.test(source.id) ? source.id : undefined;
  const at = moment(source.at);
  const by = oneOf(source.by, OUTLINE_JOURNAL_AUTHORS);
  if (!id || !at || !by || !Array.isArray(source.chapters)) return null;
  const chapters = source.chapters.map(readChapter).filter((entry): entry is OutlineJournalChapter => entry !== null).slice(0, OUTLINE_JOURNAL_MAX_CHAPTERS);
  const note = line(source.note, LINE_CHARS);
  const more = whole(source.more, 1, Number.MAX_SAFE_INTEGER);
  if (!chapters.length && !more) return null;
  return { id, at, by, ...(note ? { note } : {}), chapters, ...(more ? { more } : {}) };
}

/**
 * The journal as a file says it, read tolerantly: a file that is not YAML, or not the journal, is an empty journal, and a series or an item that is
 * not one is left out; the others are kept, in order of time. Never throws.
 */
export function parseOutlineJournal(text: string | null | undefined): OutlineJournal {
  if (!text?.trim()) return { series: [] };
  let data: unknown;
  try {
    const document = parseDocument(text, { uniqueKeys: false, prettyErrors: false });
    if (document.errors.length) return { series: [] };
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { series: [] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { series: [] };
  const source = data as Record<string, unknown>;
  const reviewedAt = moment(source.reviewedAt);
  const series = Array.isArray(source.series) ? source.series.map(readSeries).filter((entry): entry is OutlineJournalSeries => entry !== null) : [];
  return normalized({ ...(reviewedAt ? { reviewedAt } : {}), series });
}

/** The series by `id` (the first copy of one wins) in order of time, then of `id`. */
function normalized(journal: OutlineJournal): OutlineJournal {
  const seen = new Set<string>();
  const series = journal.series.filter((entry) => !seen.has(entry.id) && seen.add(entry.id));
  series.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { ...(journal.reviewedAt ? { reviewedAt: journal.reviewedAt } : {}), series };
}

// ─── Merging and pruning ────────────────────────────────────────────────────

/**
 * Two copies of the journal (or more) as one: the series of all of them, each once, in order of time, and the latest «reviewed». What two devices
 * wrote apart is all there after it; nothing is lost but what pruning leaves out.
 */
export function mergeOutlineJournals(...journals: ReadonlyArray<OutlineJournal | string | null | undefined>): OutlineJournal {
  const read = journals.map((journal) => (typeof journal === "string" || journal === null || journal === undefined ? parseOutlineJournal(journal) : journal));
  const reviewed = read.map((journal) => journal.reviewedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  return normalized({ ...(reviewed ? { reviewedAt: reviewed } : {}), series: read.flatMap((journal) => journal.series) });
}

/** The series the journal keeps at `now`: those of the last `OUTLINE_JOURNAL_KEEP_DAYS` days (one dated later, a clock that runs ahead, too), at most the newest `OUTLINE_JOURNAL_MAX_SERIES`. */
export function pruneOutlineJournal(journal: OutlineJournal, now: Date = new Date()): OutlineJournal {
  const oldest = now.getTime() - OUTLINE_JOURNAL_KEEP_DAYS * DAY_MS;
  const series = normalized(journal).series.filter((entry) => Date.parse(entry.at) >= oldest).slice(-OUTLINE_JOURNAL_MAX_SERIES);
  return { ...(journal.reviewedAt ? { reviewedAt: journal.reviewedAt } : {}), series };
}

// ─── Writing ────────────────────────────────────────────────────────────────

const HEADER = [
  " The journal of the Synopsis: every series of edits of its entries, oldest first, with when, who and what changed in each chapter.",
  ` Narrarium writes it with every series and keeps the last ${OUTLINE_JOURNAL_KEEP_DAYS} days (at most ${OUTLINE_JOURNAL_MAX_SERIES} series). The autopilot does not decide from it:`,
  " deleting it loses only the history.",
].join("\n");

/** The text of the journal: a short header, then one block for each series, with one line for each chapter. */
export function serializeOutlineJournal(journal: OutlineJournal): string {
  const data = {
    version: 1,
    ...(journal.reviewedAt ? { reviewedAt: journal.reviewedAt } : {}),
    series: journal.series.map((entry) => ({
      id: entry.id,
      at: entry.at,
      by: entry.by,
      ...(entry.note ? { note: entry.note } : {}),
      chapters: entry.chapters.map((chapter) => ({
        chapter: chapter.chapter,
        change: chapter.change,
        ...(chapter.from !== undefined ? { from: chapter.from } : {}),
        ...(chapter.edited ? { edited: true } : {}),
        ...(chapter.title ? { title: chapter.title } : {}),
        ...(chapter.was ? { was: chapter.was } : {}),
        ...(chapter.before ? { before: chapter.before } : {}),
        ...(chapter.after ? { after: chapter.after } : {}),
        summary: chapter.summary,
      })),
      ...(entry.more ? { more: entry.more } : {}),
    })),
  };
  const document = new Document(data);
  document.commentBefore = HEADER;
  const series = document.get("series", true);
  if (isSeq(series)) {
    for (const item of series.items) {
      if (!isMap(item)) continue;
      const chapters = item.get("chapters", true);
      if (isSeq(chapters)) for (const chapter of chapters.items) if (isMap(chapter)) chapter.flow = true;
    }
  }
  return document.toString({ lineWidth: 0 });
}

/** The journal text with `series` at its end, pruned at `now`. */
export function appendOutlineJournal(text: string | null | undefined, series: OutlineJournalSeries, now: Date = new Date()): string {
  return serializeOutlineJournal(pruneOutlineJournal(mergeOutlineJournals(text, { series: [series] }), now));
}

// ─── What a series did to each chapter ─────────────────────────────────────

/** An entry as the journal compares it: its title and the digest of what it says. */
export interface OutlineJournalSeen {
  title: string;
  digest: string;
}

function quotedTitle(title: string | undefined): string {
  return title ? ` «${title}»` : "";
}

function summaryOf(item: Omit<OutlineJournalChapter, "summary">, language: string): string {
  const it = isItalian(language);
  const n = item.chapter;
  const title = quotedTitle(item.title);
  switch (item.change) {
    case "created":
      return it ? `Il capitolo ${n}${title} è nuovo.` : `Chapter ${n}${title} is new.`;
    case "modified":
      return it ? `La voce del capitolo ${n}${title} è cambiata${item.was ? ` (era «${item.was}»)` : ""}.` : `The entry of chapter ${n}${title} changed${item.was ? ` (it was «${item.was}»)` : ""}.`;
    case "moved":
      return it
        ? `Il capitolo ${n} ora è${title || " la voce"} del capitolo ${item.from}${item.edited ? ", cambiata" : ""}${item.was ? ` (era «${item.was}»)` : ""}.`
        : `Chapter ${n} is now${title || " the entry"} of chapter ${item.from}${item.edited ? ", changed" : ""}${item.was ? ` (it was «${item.was}»)` : ""}.`;
    default:
      return it ? `Il capitolo ${n}${title} non è più nella Sinossi.` : `Chapter ${n}${title} is no longer in the Synopsis.`;
  }
}

/** What the code that made a series knows of it (the engine's composer, `ComposedOutlineEdits`): the entries it made, and the ones that changed number. */
export interface OutlineJournalHints {
  /** The numbers, after the series, of the entries it made. */
  created?: Iterable<number>;
  /** Entries that changed number: `count` entries from chapter `from` are now from chapter `to`. */
  moved?: ReadonlyArray<{ from: number; to: number; count: number }>;
}

/**
 * What a series did to each chapter, from the entries as they were (`before`) and as they are (`after`), by the number of their chapter. An entry
 * that is now where another one was is `moved` from there; one that says something else in the same place is `modified`; one that is new is
 * `created`; a chapter that has no entry now is `removed`. A chapter whose entry says the same (a change of its frontmatter only) is not listed.
 * `hints` (what the composer knows) say it exactly; without them an entry is followed by what it says (the same digest; or the same title, and
 * then its text changed too: `edited`), and a new entry in the place of another one is told as that place's entry `modified`. In order of chapter,
 * at most `OUTLINE_JOURNAL_MAX_CHAPTERS` (`more` says how many more).
 */
export function outlineJournalChaptersOf(before: ReadonlyMap<number, OutlineJournalSeen>, after: ReadonlyMap<number, OutlineJournalSeen>, language = "en", hints: OutlineJournalHints = {}): { chapters: OutlineJournalChapter[]; more: number } {
  const numbers = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left - right);
  const created = new Set(hints.created ?? []);
  const movedTo = new Map<number, number>();
  for (const run of hints.moved ?? []) for (let offset = 0; offset < run.count; offset += 1) movedTo.set(run.to + offset, run.from + offset);
  // The places the composer says an entry left are taken: no other entry is followed there.
  const used = new Set<number>(movedTo.values());
  /** The chapter whose entry is now at `number`: the composer's word, else the same digest, else the same title (and then its text changed too). */
  const originOf = (number: number, now: OutlineJournalSeen): { from: number; edited: boolean } | null => {
    const hinted = movedTo.get(number);
    if (hinted !== undefined) return { from: hinted, edited: before.get(hinted)?.digest !== now.digest };
    if (created.has(number)) return null;
    const tests: Array<[(was: OutlineJournalSeen) => boolean, (was: OutlineJournalSeen, there: OutlineJournalSeen | undefined) => boolean, boolean]> = [
      [(was) => was.digest === now.digest, (was, there) => there?.digest !== was.digest, false],
      [(was) => Boolean(now.title) && was.title === now.title, (was, there) => there?.title !== was.title, true],
    ];
    for (const [matches, gone, edited] of tests) {
      for (const candidate of numbers) {
        const was = before.get(candidate);
        if (candidate === number || used.has(candidate) || !was || !matches(was) || !gone(was, after.get(candidate))) continue;
        used.add(candidate);
        return { from: candidate, edited };
      }
    }
    return null;
  };
  const items: OutlineJournalChapter[] = [];
  for (const number of numbers) {
    const was = before.get(number);
    const now = after.get(number);
    if (was && now && was.digest === now.digest && !movedTo.has(number)) continue;
    let item: Omit<OutlineJournalChapter, "summary">;
    if (!now) item = { chapter: number, change: "removed", ...(was!.title ? { title: was!.title } : {}), before: was!.digest };
    else {
      const moved = originOf(number, now);
      const renamed = was && was.title && was.title !== now.title ? { was: was.title } : {};
      if (moved) item = { chapter: number, change: "moved", from: moved.from, ...(moved.edited ? { edited: true as const } : {}), ...(now.title ? { title: now.title } : {}), ...renamed, ...(was ? { before: was.digest } : {}), after: now.digest };
      else if (was && !created.has(number)) item = { chapter: number, change: "modified", ...(now.title ? { title: now.title } : {}), ...renamed, before: was.digest, after: now.digest };
      else item = { chapter: number, change: "created", ...(now.title ? { title: now.title } : {}), ...renamed, ...(was ? { before: was.digest } : {}), after: now.digest };
    }
    items.push({ ...item, summary: summaryOf(item, language) });
  }
  return { chapters: items.slice(0, OUTLINE_JOURNAL_MAX_CHAPTERS), more: Math.max(0, items.length - OUTLINE_JOURNAL_MAX_CHAPTERS) };
}

async function seenOf(path: string, content: string | null | undefined): Promise<[number, OutlineJournalSeen] | null> {
  const parsed = parseOutlineChapterPath(path);
  if (!parsed || content === null || content === undefined) return null;
  const { entry } = await readOutlineChapter(path, parsed.number, content);
  return [parsed.number, { title: entry.title.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS), digest: entry.contentDigest }];
}

/**
 * The chapters a commit of files of the Synopsis changes: `before` has the text of each of its files as it was (a path that is not there did not
 * exist), `changes` the files of the commit. Only the entries of chapters count (`outline/chapters/<NNN>.md`): their files are all in the commit
 * when an entry moves, for it leaves one file and goes into another.
 */
export async function outlineJournalChapters(before: ReadonlyMap<string, string>, changes: readonly BookFileChange[], language = "en", hints: OutlineJournalHints = {}): Promise<{ chapters: OutlineJournalChapter[]; more: number }> {
  const was = new Map<number, OutlineJournalSeen>();
  const now = new Map<number, OutlineJournalSeen>();
  for (const change of changes) {
    if (!parseOutlineChapterPath(change.path)) continue;
    const old = await seenOf(change.path, before.get(change.path));
    if (old && !was.has(old[0])) was.set(...old);
    const next = await seenOf(change.path, change.content);
    if (next && !now.has(next[0])) now.set(...next);
  }
  return outlineJournalChaptersOf(was, now, language, hints);
}

export interface OutlineJournalChangeInput {
  /** The journal as the book has it now (`null`: none yet), with its hash: the commit expects it. */
  journal: { content: string; hash: string } | null;
  /** The text of each file of the commit as it was before it (a path that is not there did not exist). */
  before: ReadonlyMap<string, string>;
  /** The files of the commit. */
  changes: readonly BookFileChange[];
  by: OutlineJournalAuthor;
  note?: string;
  /** The language of the book, for the summaries (English when it is not Italian). */
  language?: string;
  now?: Date;
  /** The id of the series (a new one when absent). */
  id?: string;
  /** What the composer knows of the series (`ComposedOutlineEdits.created`, `.moved`): the journal says it exactly. */
  hints?: OutlineJournalHints;
}

/**
 * The change of the journal that goes into the commit of a series of edits, with the series at its end (`null` when no chapter's entry changed:
 * a series of the description of the book alone, or of a frontmatter, is no news of chapters). It expects the journal as it was read.
 */
export async function outlineJournalChange(input: OutlineJournalChangeInput): Promise<BookFileChange | null> {
  const { chapters, more } = await outlineJournalChapters(input.before, input.changes, input.language, input.hints);
  if (!chapters.length) return null;
  const now = input.now ?? new Date();
  const note = line(input.note, LINE_CHARS);
  const series: OutlineJournalSeries = { id: input.id ?? randomId("series"), at: now.toISOString(), by: input.by, ...(note ? { note } : {}), chapters, ...(more ? { more } : {}) };
  return { path: OUTLINE_CHANGES_FILE, content: appendOutlineJournal(input.journal?.content, series, now), expectedHash: input.journal?.hash ?? null };
}

/** The change of the journal that marks what changed as reviewed at `at`: a host lists only what came after. The other series stay. */
export function markOutlineJournalReviewed(journal: { content: string; hash: string } | null, at: Date = new Date()): BookFileChange {
  const current = parseOutlineJournal(journal?.content);
  return { path: OUTLINE_CHANGES_FILE, content: serializeOutlineJournal(pruneOutlineJournal({ ...current, reviewedAt: at.toISOString() }, at)), expectedHash: journal?.hash ?? null };
}
