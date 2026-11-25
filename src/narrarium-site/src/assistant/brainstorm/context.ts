import { chapterFilePath, clipMiddle, parseMarkdown, type AutopilotState, type ParsedOutline, type PlannedChapter } from "narrarium-engine";
import { OUTLINE_BRIEF_FILE } from "@/autopilot/outlineBrief";
import { frozenChapterSlugs, snapshotOf, writtenChapters, type OutlineSnapshot } from "@/outline/outlineModel";
import { browserOutlineSource, type OutlineSource } from "@/outline/outlineSource";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

/**
 * What Brainstorming knows of the book, and nothing else: the Synopsis (the description of the book and every chapter entry), the description of
 * `book.md` and the brief, the chapters already written (their summaries and whether they are approved, frozen or imported) and the names of the
 * canon. No text of a chapter, no note, no secret: the scope is the big design of the book, and it is decided here, not by the model.
 */

/** The canon whose names Brainstorming knows. The secrets are not among them: their names can give away what the book keeps for later. */
export const BRAINSTORM_CANON_SECTIONS = ["characters", "locations", "factions", "items", "timelines"] as const;
export type BrainstormCanonSection = (typeof BRAINSTORM_CANON_SECTIONS)[number];

export type WrittenState = "approved" | "frozen" | "imported" | "written";

export interface BrainstormWrittenChapter {
  number: number;
  slug: string;
  title: string;
  /** The summary the chapter carries (`chapter.md`), or the one of the plan when it has none yet. */
  summary: string;
  states: WrittenState[];
}

export interface BrainstormCanonName {
  section: BrainstormCanonSection;
  name: string;
  path: string;
}

export interface BrainstormContext {
  book: BookEntry;
  branch: string;
  /** The language of the book (`book.md`), or "" when it says none. */
  language: string;
  title: string;
  /** The description of `book.md`. */
  description: string;
  synopsis: OutlineSnapshot;
  brief: { genre: string; audience: string; plot: string } | null;
  written: BrainstormWrittenChapter[];
  canon: BrainstormCanonName[];
  /** The ghostwriters of the book (their slugs): an entry may name one of them. */
  ghostwriters: string[];
  state: AutopilotState | null;
  source: OutlineSource;
}

/** The written chapters whose `chapter.md` is read for the context; the others are read one at a time, when asked for. */
const READ_CHAPTERS = 300;

export async function loadBrainstormContext(input: { book: BookEntry; branch: string; structure: BookStructure | undefined; source?: OutlineSource }): Promise<BrainstormContext> {
  const source = input.source ?? browserOutlineSource(input.book, input.branch);
  const [files, state] = await Promise.all([source.files(), source.readState().catch(() => null)]);
  const synopsis = await snapshotOf(files);
  const written = [...writtenChapters(input.structure?.chapters ?? [])].sort(([left], [right]) => left - right);
  const chapterFiles = await source.readFiles(written.slice(0, READ_CHAPTERS).map(([, chapter]) => chapterFilePath(chapter.slug))).catch((): Array<{ path: string; content: string }> => []);
  const byPath = new Map<string, string>(chapterFiles.map((file): [string, string] => [file.path, file.content]));
  const frozen = frozenChapterSlugs(chapterFiles);
  const planned = new Map<number, PlannedChapter>((state?.plan?.chapters ?? []).map((chapter): [number, PlannedChapter] => [chapter.number, chapter]));
  return {
    book: input.book,
    branch: input.branch,
    language: input.structure?.language ?? "",
    title: input.structure?.title || input.book.name,
    description: input.structure?.description ?? "",
    synopsis,
    brief: briefOf(synopsis),
    written: written.map(([number, chapter]) => {
      const plan = planned.get(number);
      const states: WrittenState[] = [];
      if (plan?.status === "done") states.push("approved");
      if (frozen.has(chapter.slug)) states.push("frozen");
      if (plan?.imported) states.push("imported");
      if (!states.length) states.push("written");
      return { number, slug: chapter.slug, title: chapter.title, summary: summaryOf(byPath.get(chapterFilePath(chapter.slug))) || plan?.summary || "", states };
    }),
    canon: canonNames(input.structure),
    ghostwriters: (input.structure?.ghostwriters ?? []).map((ghostwriter) => ghostwriter.slug),
    state,
    source,
  };
}

function briefOf(snapshot: OutlineSnapshot): BrainstormContext["brief"] {
  const file = snapshot.files.get(OUTLINE_BRIEF_FILE);
  if (!file) return null;
  try {
    const { frontmatter, body } = parseMarkdown(file.content);
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    return { genre: text(frontmatter.genre), audience: text(frontmatter.audience), plot: body.trim() };
  } catch {
    return null;
  }
}

/** The summary a `chapter.md` carries in its frontmatter, or "". */
export function summaryOf(content: string | undefined): string {
  if (!content) return "";
  try {
    const value = parseMarkdown(content).frontmatter.summary;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function canonNames(structure: BookStructure | undefined): BrainstormCanonName[] {
  if (!structure) return [];
  return BRAINSTORM_CANON_SECTIONS.flatMap((section) => (structure[section] ?? []).map((file) => ({
    section,
    name: file.name || file.path.split("/").pop()!.replace(/\.md$/, ""),
    path: file.path,
  })));
}

// ─── The context as the model reads it ──────────────────────────────────────

/** How much of each part the model reads at once; the tools read the rest, one entry or one chapter at a time. */
const LIMITS = { description: 4_000, entries: 32_000, entry: 1_500, titles: 600, written: 12_000, summary: 600, canon: 400 };

function entryLines(outline: ParsedOutline): string {
  const entries = outline.chapters;
  let room = LIMITS.entries;
  const whole: string[] = [];
  const titles: string[] = [];
  for (const entry of entries) {
    const head = `Chapter ${entry.number}${entry.title ? ` — ${entry.title}` : ""}${entry.ghostwriter ? ` [ghostwriter: ${entry.ghostwriter}]` : ""}${entry.intact ? " [written by the autopilot, untouched]" : ""}`;
    const line = `${head}:\n${clipMiddle(entry.body.trim(), LIMITS.entry) || "(no text yet)"}`;
    if (room - line.length >= 0) {
      whole.push(line);
      room -= line.length;
    } else if (titles.length < LIMITS.titles) {
      titles.push(`${entry.number}. ${entry.title || "(untitled)"}`);
    }
  }
  return [
    `CHAPTER ENTRIES OF THE SYNOPSIS (${entries.length}; the number is the chapter):\n${whole.join("\n\n") || "(none yet)"}`,
    titles.length ? `MORE ENTRIES (titles only; read_synopsis_entry reads one whole):\n${titles.join("\n")}${entries.length - whole.length > titles.length ? `\n… and ${entries.length - whole.length - titles.length} more` : ""}` : "",
  ].filter(Boolean).join("\n\n");
}

function writtenLines(written: readonly BrainstormWrittenChapter[]): string {
  if (!written.length) return "CHAPTERS ALREADY WRITTEN: none yet.";
  let room = LIMITS.written;
  const lines: string[] = [];
  for (const chapter of written) {
    const line = `${chapter.number}. ${chapter.title || chapter.slug} [${chapter.states.join(", ")}]${chapter.summary ? `: ${clipMiddle(chapter.summary, LIMITS.summary)}` : ""}`;
    if (room - line.length < 0) {
      lines.push(`… and ${written.length - lines.length} more (read_chapter_summary reads one)`);
      break;
    }
    lines.push(line);
    room -= line.length;
  }
  return `CHAPTERS ALREADY WRITTEN (${written.length}; approved, frozen and imported ones are the author's settled text):\n${lines.join("\n")}`;
}

function canonLines(canon: readonly BrainstormCanonName[]): string {
  if (!canon.length) return "CANON: none yet.";
  const bySection = BRAINSTORM_CANON_SECTIONS.map((section) => {
    const names = canon.filter((entry) => entry.section === section).map((entry) => entry.name);
    return names.length ? `${section}: ${names.slice(0, LIMITS.canon).join(", ")}${names.length > LIMITS.canon ? ", …" : ""}` : "";
  }).filter(Boolean);
  return `CANON (names only; read_canon_entry reads one):\n${bySection.join("\n")}`;
}

/** Everything Brainstorming knows of the book, as the data of its request. */
export function brainstormContextText(context: BrainstormContext): string {
  const outline = context.synopsis.outline;
  const head = outline.book;
  return [
    `BOOK: ${context.title || "(untitled)"}${context.language ? ` (language: ${context.language})` : ""}`,
    context.description.trim() ? `DESCRIPTION OF THE BOOK (book.md):\n${clipMiddle(context.description.trim(), LIMITS.description)}` : "",
    `IDEA OF THE BOOK (the Synopsis, outline/book.md)${head?.title ? `, working title «${head.title}»` : ""}:\n${clipMiddle(head?.body.trim() ?? "", LIMITS.description) || "(none yet)"}`,
    context.brief && (context.brief.genre || context.brief.audience || context.brief.plot)
      ? `BRIEF: genre ${context.brief.genre || "(none)"}; audience ${context.brief.audience || "(none)"}${context.brief.plot ? `\nChapter-by-chapter plot of the brief (where the entries say nothing):\n${clipMiddle(context.brief.plot, LIMITS.description)}` : ""}`
      : "",
    `GHOSTWRITERS OF THE BOOK (slugs an entry may name; none: the book's own writes it): ${context.ghostwriters.join(", ") || "(none)"}`,
    entryLines(outline),
    writtenLines(context.written),
    canonLines(context.canon),
  ].filter(Boolean).join("\n\n");
}
