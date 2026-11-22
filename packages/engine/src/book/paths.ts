import { chapterSlug, formatOrdinal, paragraphSlug, slugCode, slugify, slugifyAny, transliterate } from "narrarium/slug";

export { chapterSlug, formatOrdinal, paragraphSlug, slugCode, slugify, slugifyAny, transliterate };

export const BOOK_FILE = "book.md";
export const CONTEXT_FILE = "context.md";
export const STORY_DESIGN_FILE = "story-design.md";
export const PLOT_FILE = "plot.md";
export const NOTES_FILE = "notes.md";
export const TOTAL_RESUME_FILE = "resumes/total.md";
export const EVALUATION_GUIDELINES_FILE = "evaluation-guidelines.md";
/** The author's stand-in: vision, taste, priorities and red lines used by the autopilot. */
export const DIRECTOR_FILE = "director.md";
export const AUTOPILOT_DIRECTORY = "autopilot";
export const AUTOPILOT_STATE_FILE = "autopilot/state.json";
export const AUTOPILOT_ACTIVITY_FILE = "autopilot/activity.json";
export const AUTOPILOT_PLAN_FILE = "autopilot/plan.md";

/**
 * The outline (Scaletta): the author's chapter-by-chapter trace of the book, a main part of it (the core's `OUTLINE_*`).
 * `outline/book.md` is the rough description, `outline/chapters/<NNN>.md` one entry per chapter, numbered by the name of the
 * file with the zero-padding of the chapter folders. Not to be confused with `plot.md`, which is generated.
 */
export const OUTLINE_DIRECTORY = "outline";
export const OUTLINE_BOOK_FILE = "outline/book.md";
export const OUTLINE_CHAPTERS_DIRECTORY = "outline/chapters";

/** The file of the outline entry of a chapter: `outline/chapters/007.md`, `outline/chapters/1500.md`. */
export function outlineChapterPath(number: number): string {
  return `${OUTLINE_CHAPTERS_DIRECTORY}/${formatOrdinal(number)}.md`;
}

/**
 * The chapter an outline file is the entry of, from its name (the name wins over the frontmatter); `canonical` is false for a
 * name padded otherwise (`7.md`, `0007.md`). `null` for any other file.
 */
export function parseOutlineChapterPath(path: string): { number: number; canonical: boolean } | null {
  const match = /^outline\/chapters\/(\d+)\.md$/.exec(path);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { number, canonical: match[1] === formatOrdinal(number) };
}

export type CanonKind = "character" | "location" | "faction" | "item" | "secret" | "timeline-event";

export const CANON_DIRECTORIES: Record<CanonKind, string> = {
  character: "characters",
  location: "locations",
  faction: "factions",
  item: "items",
  secret: "secrets",
  "timeline-event": "timelines/events",
};

export function chapterFilePath(slug: string): string {
  return `chapters/${slug}/chapter.md`;
}

export function paragraphFilePath(chapter: string, paragraph: string): string {
  return `chapters/${chapter}/${paragraph}.md`;
}

export function chapterResumePath(slug: string): string {
  return `resumes/chapters/${slug}.md`;
}

export function chapterId(slug: string): string {
  return `chapter:${slug}`;
}

export function paragraphId(chapter: string, paragraph: string): string {
  return `paragraph:${chapter}:${paragraph}`;
}

export function canonPath(kind: CanonKind, slug: string): string {
  return `${CANON_DIRECTORIES[kind]}/${slug}.md`;
}

/**
 * File name of a canon entry made from its name: the slug the name has always had; for Cyrillic and Greek the name read
 * letter by letter; for any other script the kind of entry and a short code of the name, which is always the same
 * (`character-0crj2m`). Never empty. It is what the core gives the same entry.
 */
export function canonSlug(kind: CanonKind, name: string): string {
  return slugifyAny(name, kind, true);
}

export function pathSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

const CHAPTER_FILE_PATTERN = /^chapters\/([^/]+)\/chapter\.md$/;
/** Folders and scenes named by the author may use letters of any script; `001-.md` is what older versions made of a title they could not read. */
const PARAGRAPH_FILE_PATTERN = /^chapters\/([^/]+)\/(\d{3}(?:-[^/]*)?)\.md$/;

export function parseChapterFilePath(path: string): { chapter: string } | null {
  const match = CHAPTER_FILE_PATTERN.exec(path);
  return match ? { chapter: match[1] } : null;
}

export function parseParagraphFilePath(path: string): { chapter: string; paragraph: string; number: number } | null {
  const match = PARAGRAPH_FILE_PATTERN.exec(path);
  return match ? { chapter: match[1], paragraph: match[2], number: Number(match[2].slice(0, 3)) } : null;
}

export function chapterNumberFromSlug(slug: string): number | undefined {
  const match = /^(\d{3,})-/.exec(slug);
  return match ? Number(match[1]) : undefined;
}

export type EvaluationTarget =
  | { kind: "book" }
  | { kind: "chapter"; chapter: string }
  | { kind: "paragraph"; chapter: string; paragraph: string };

/** Reader evaluation file, same layout the web app uses. */
export function readerEvaluationPath(target: Exclude<EvaluationTarget, { kind: "book" }>, readerSlug: string): string {
  return target.kind === "chapter"
    ? `evaluations/readers/chapters/${target.chapter}/${readerSlug}.md`
    : `evaluations/readers/paragraphs/${target.chapter}/${target.paragraph}/${readerSlug}.md`;
}

export function readerSummaryPath(target: Exclude<EvaluationTarget, { kind: "book" }>): string {
  return target.kind === "chapter"
    ? `evaluations/readers/summaries/chapters/${target.chapter}.md`
    : `evaluations/readers/summaries/paragraphs/${target.chapter}/${target.paragraph}.md`;
}

/** Where the director's saved opinions live. */
export function directorOpinionPath(target: EvaluationTarget): string {
  if (target.kind === "book") return "evaluations/director/book.md";
  if (target.kind === "chapter") return `evaluations/director/chapters/${target.chapter}.md`;
  return `evaluations/director/paragraphs/${target.chapter}/${target.paragraph}.md`;
}

/** Text files the engine and the sync protocol care about. Binary assets are left to the hosts. */
export function isTextBookPath(path: string): boolean {
  return /\.(md|markdown|txt|json|ya?ml)$/i.test(path);
}

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
/** Code points HFS+ ignores when it compares names, so `.g\u200cit` is the repository's own folder there. */
const IGNORED_BY_FILE_SYSTEMS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
/** Control characters and the characters Windows forbids; the colon also covers NTFS alternate data streams. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f"*:<>?|]/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;

/**
 * Git refuses to check out its own metadata folder under any spelling, but only after the bytes were
 * written: letter case, trailing dots and spaces (NTFS), the 8.3 short name `git~1`, look-alike
 * Unicode and the code points HFS+ ignores. Every spelling is refused before anything is written.
 */
function isRepositoryMetadataName(segment: string): boolean {
  const name = segment.normalize("NFKC").replace(IGNORED_BY_FILE_SYSTEMS, "").replace(/[. ]+$/, "").toLowerCase();
  return name === ".git" || name === "git~1";
}

/**
 * Relative, normalized repository path. Rejects traversal, absolute and drive paths, empty segments,
 * every spelling of `.git`, Windows device names and characters, and names that Windows would trim
 * (trailing dots or spaces) so that two spellings can never reach the same file.
 */
export function assertSafeBookPath(path: string): string {
  const unsafe = (): never => {
    throw new Error(`Unsafe book path: ${path}`);
  };
  if (typeof path !== "string" || !path || path.length > MAX_PATH_LENGTH) return unsafe();
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return unsafe();
  for (const segment of normalized.split("/")) {
    if (!segment || segment.length > MAX_SEGMENT_LENGTH || segment === "." || segment === "..") return unsafe();
    if (segment !== segment.trim() || /[. ]$/.test(segment) || FORBIDDEN_CHARACTERS.test(segment)) return unsafe();
    if (isRepositoryMetadataName(segment) || WINDOWS_DEVICE_NAME.test(segment)) return unsafe();
  }
  return normalized;
}

/** Whether a path coming from another host is already in its canonical, safe spelling. */
export function isSafeBookPath(path: string): boolean {
  try {
    return !path.includes("\\") && assertSafeBookPath(path) === path;
  } catch {
    return false;
  }
}

/**
 * Whether the `ghostwriter` of a book, a chapter or a scene can be the slug of `ghostwriters/<slug>.md`: one safe file
 * name and not a path. Every slug the core makes (letters, digits and hyphens, in Latin script) is one, and so is a name
 * the author gave the file in any script.
 */
export function isValidGhostwriterSlug(slug: string): boolean {
  return Boolean(slug) && slug === slug.trim() && !/^\.+$/.test(slug) && !/[\\/]/.test(slug) && isSafeBookPath(`ghostwriters/${slug}.md`);
}
