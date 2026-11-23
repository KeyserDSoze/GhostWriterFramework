/**
 * The brief of the book, which the autopilot reads at every start and configuration. Its text is kept in two files, and each thing has one home:
 *  - the idea (the idea, promise or pitch of the book) is the description of the book: the body of `outline/book.md`, the outline's own file,
 *    written by the author. It is stored there and nowhere else. A description the autopilot wrote is not the author's idea: it is read as none.
 *  - `outline/_brief.md` keeps the rest: `genre`, `audience` and `wordsPerScene` in the frontmatter, and the `synopsis` as its body. An `idea`
 *    key found in it is ignored, and never written.
 * `readOutlineBrief` composes both into one brief, and `writeOutlineBrief` writes both in one commit. Neither file is a chapter: the outline
 * never reads `_brief.md` as an entry, and the description is the outline's own text, read and written by the outline's own rules.
 */
import { parseMarkdown, renderMarkdown } from "../markdown/frontmatter.js";
import { OUTLINE_BOOK_MAX_CHARS, OutlineTextLimitError, serializeOutlineBook, type OutlineBookEntry } from "./outline.js";
import { OUTLINE_BOOK_FILE, OUTLINE_BRIEF_FILE } from "./paths.js";
import { isBookConflictError, type BookFileChange, type BookStore } from "./store.js";

/** The text of a body as the outline keeps it: line endings and the spaces around them do not count. */
function canonicalText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

/** What `outline/_brief.md` holds: the fields of the file, with no idea (the idea is the description of the book). */
export interface OutlineBriefFields {
  genre: string;
  audience: string;
  /** The target of every scene, a whole number from 200 to 8 000. */
  wordsPerScene: number;
  synopsis: string;
}

/**
 * The brief as the autopilot reads it: the idea, which is the description of the book (`outline/book.md`), and the fields of
 * `outline/_brief.md`. The number of chapters is not here: it is the number of chapter entries of the outline.
 */
export interface OutlineBrief extends OutlineBriefFields {
  idea: string;
}

/** The words of a scene the brief may ask for (a whole number in these limits; a value outside them is brought to the nearest limit). */
export const OUTLINE_BRIEF_WORDS_PER_SCENE = { min: 200, max: 8000 } as const;

/** What a book without a brief has: nothing asked but the length of a scene. */
export const OUTLINE_BRIEF_DEFAULT: OutlineBrief = { idea: "", genre: "", audience: "", wordsPerScene: 1400, synopsis: "" };

/** The fields of `outline/_brief.md` as the file says them. */
export interface OutlineBriefFileReading {
  brief: OutlineBriefFields;
  /** The hash of the file, when it exists: what a write expects to find. */
  hash?: string;
  /** Its frontmatter cannot be read: the fields are read as far as they can be, and the file is never written over. */
  unreadable?: boolean;
  /** The frontmatter as it was read, so that a write loses no key of the author (an `idea` key is dropped). */
  frontmatter: Record<string, unknown>;
}

/** The brief as `readOutlineBrief` composes it. `hash` is the hash of `_brief.md` (absent: the file does not exist). */
export interface OutlineBriefReading extends Omit<OutlineBriefFileReading, "brief"> {
  brief: OutlineBrief;
  /** The description of the book cannot be read: its idea is read as none, and a write is refused until the author corrects it. */
  bookUnreadable?: boolean;
}

/** Where `readOutlineBrief` takes the description from: `book` is the description already read (`null`: the book has none); `brief: false` says the brief file is known not to exist. */
export interface OutlineBriefSources {
  book?: OutlineBookEntry | null;
  brief?: boolean;
}

function briefText(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function briefWords(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed)) return OUTLINE_BRIEF_DEFAULT.wordsPerScene;
  return Math.min(OUTLINE_BRIEF_WORDS_PER_SCENE.max, Math.max(OUTLINE_BRIEF_WORDS_PER_SCENE.min, Math.round(parsed)));
}

/** The fields of `outline/_brief.md`'s content; `null` (no file) is the defaults. Never throws. */
export function parseOutlineBrief(content: string | null | undefined, hash?: string): OutlineBriefFileReading {
  if (content === null || content === undefined) return { brief: fieldsOf(OUTLINE_BRIEF_DEFAULT), frontmatter: {} };
  const document = parseMarkdown(content);
  const frontmatter = document.frontmatter;
  return {
    brief: {
      genre: briefText(frontmatter.genre),
      audience: briefText(frontmatter.audience),
      wordsPerScene: briefWords(frontmatter.wordsPerScene),
      synopsis: canonicalText(document.body),
    },
    ...(hash ? { hash } : {}),
    ...(document.error ? { unreadable: true } : {}),
    frontmatter,
  };
}

function fieldsOf(brief: OutlineBrief | OutlineBriefFields): OutlineBriefFields {
  return { genre: brief.genre, audience: brief.audience, wordsPerScene: brief.wordsPerScene, synopsis: brief.synopsis };
}

/**
 * The content of `outline/_brief.md`: its managed keys, the keys of the author kept as they are (an `idea` key is never kept: the idea is
 * the description of the book), and the synopsis as the body.
 */
export function serializeOutlineBrief(brief: OutlineBriefFields, frontmatter: Record<string, unknown> = {}): string {
  const { idea: _ignored, ...kept } = frontmatter;
  return renderMarkdown({
    ...kept,
    type: "outline-brief",
    id: "outline:brief",
    genre: brief.genre.trim() || undefined,
    audience: brief.audience.trim() || undefined,
    wordsPerScene: briefWords(brief.wordsPerScene),
  }, canonicalText(brief.synopsis));
}

/** The idea of a description as the author wrote it: its text, or `""` when there is none or the autopilot wrote it. */
function ideaOfEntry(book: OutlineBookEntry): string {
  return book.origin === "autopilot" ? "" : canonicalText(book.body);
}

/** The idea of the book from the content of `outline/book.md` (the same rule as `ideaOfEntry`). */
function ideaOfContent(content: string | null | undefined): string {
  if (content === null || content === undefined) return "";
  const document = parseMarkdown(content);
  const origin = typeof document.frontmatter.origin === "string" ? document.frontmatter.origin.trim().toLowerCase() : "";
  return origin === "autopilot" ? "" : canonicalText(document.body);
}

/**
 * The brief of the book: the idea from the description (`outline/book.md`), the fields from `outline/_brief.md`. A book with neither file has
 * the defaults. `sources` says what is already known (see `OutlineBriefSources`); without it both files are read.
 */
export async function readOutlineBrief(store: BookStore, sources: OutlineBriefSources = {}): Promise<OutlineBriefReading> {
  const [briefFile, bookFile] = await Promise.all([
    sources.brief === false ? null : store.read(OUTLINE_BRIEF_FILE),
    sources.book !== undefined ? null : store.read(OUTLINE_BOOK_FILE),
  ]);
  return composeReading(briefFile, bookFile, sources);
}

function composeReading(briefFile: { content: string; hash: string } | null, bookFile: { content: string } | null, sources: OutlineBriefSources): OutlineBriefReading {
  const reading = parseOutlineBrief(briefFile?.content, briefFile?.hash);
  const idea = sources.book !== undefined ? (sources.book ? ideaOfEntry(sources.book) : "") : ideaOfContent(bookFile?.content);
  const bookUnreadable = sources.book !== undefined ? Boolean(sources.book?.unreadable) : Boolean(bookFile && parseMarkdown(bookFile.content).error);
  return {
    brief: { idea, ...fieldsOf(reading.brief) },
    ...(reading.hash ? { hash: reading.hash } : {}),
    ...(reading.unreadable ? { unreadable: true } : {}),
    ...(bookUnreadable ? { bookUnreadable: true } : {}),
    frontmatter: reading.frontmatter,
  };
}

/**
 * The changes that a brief write makes, not committed: the description of the book (`outline/book.md`, through the outline's own
 * `serializeOutlineBook`: the working title is kept, the other keys too) when the idea is given, and `outline/_brief.md` when a field is
 * given or the file exists. A file that does not need to change is left out. Compare-and-swap: each change expects the file as it was read.
 * Refuses, with nothing written, an idea over `OUTLINE_BOOK_MAX_CHARS` (`OutlineTextLimitError`) and a file whose frontmatter cannot be read.
 */
export async function outlineBriefChanges(store: BookStore, change: Partial<OutlineBrief>): Promise<{ changes: BookFileChange[]; brief: OutlineBrief }> {
  const [briefFile, bookFile] = await Promise.all([store.read(OUTLINE_BRIEF_FILE), store.read(OUTLINE_BOOK_FILE)]);
  const current = parseOutlineBrief(briefFile?.content, briefFile?.hash);
  if (current.unreadable) throw new Error(`${OUTLINE_BRIEF_FILE}: its frontmatter is not valid YAML: correct the file before the brief can be saved.`);
  const bookDocument = bookFile ? parseMarkdown(bookFile.content) : null;
  if (bookDocument?.error) throw new Error(`${OUTLINE_BOOK_FILE}: its frontmatter is not valid YAML: correct the file before the idea can be saved.`);

  const given = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) as Partial<OutlineBrief>;
  const { idea: ideaGiven, ...fieldsGiven } = given;
  const changes: BookFileChange[] = [];
  let idea = ideaOfContent(bookFile?.content);
  if (ideaGiven !== undefined) {
    const text = canonicalText(ideaGiven);
    if (text.length > OUTLINE_BOOK_MAX_CHARS) {
      throw new OutlineTextLimitError(OUTLINE_BOOK_MAX_CHARS, text.length, `The idea is ${text.length} characters long: the limit is ${OUTLINE_BOOK_MAX_CHARS}. Nothing was written: shorten it.`);
    }
    const title = typeof bookDocument?.frontmatter.title === "string" ? bookDocument.frontmatter.title : undefined;
    const content = serializeOutlineBook({ title, body: text, origin: "author", frontmatter: bookDocument?.frontmatter });
    if (content !== bookFile?.content) changes.push({ path: OUTLINE_BOOK_FILE, content, expectedHash: bookFile ? bookFile.hash : null });
    idea = text;
  }

  let saved = current.brief;
  if (briefFile || Object.keys(fieldsGiven).length > 0) {
    const content = serializeOutlineBrief({ ...current.brief, ...fieldsGiven }, current.frontmatter);
    if (content !== briefFile?.content) changes.push({ path: OUTLINE_BRIEF_FILE, content, expectedHash: briefFile ? briefFile.hash : null });
    saved = parseOutlineBrief(content).brief;
  }
  return { changes, brief: { idea, ...saved } };
}

/**
 * Saves the parts of a brief that are given, the others as they are: the idea into the description of the book, the fields into
 * `outline/_brief.md`, both in ONE commit, compare-and-swap on both files as they are now (a change made meanwhile is read again and
 * merged, never overwritten). Answers the brief as saved.
 */
export async function writeOutlineBrief(store: BookStore, change: Partial<OutlineBrief>, message = "Autopilot: brief"): Promise<OutlineBrief> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { changes, brief } = await outlineBriefChanges(store, change);
    if (changes.length === 0) return brief;
    try {
      await store.commit(changes, message);
      return brief;
    } catch (error) {
      if (!isBookConflictError(error) || attempt === 4) throw error;
    }
  }
  throw new Error("Could not save the brief.");
}
