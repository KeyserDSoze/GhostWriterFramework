import { chapterSlug, formatOrdinal, paragraphSlug, slugify } from "narrarium/slug";

export { chapterSlug, formatOrdinal, paragraphSlug, slugify };

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

export function pathSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

const CHAPTER_FILE_PATTERN = /^chapters\/([^/]+)\/chapter\.md$/;
const PARAGRAPH_FILE_PATTERN = /^chapters\/([^/]+)\/(\d{3}(?:-[^/]+)?)\.md$/;

export function parseChapterFilePath(path: string): { chapter: string } | null {
  const match = CHAPTER_FILE_PATTERN.exec(path);
  return match ? { chapter: match[1] } : null;
}

export function parseParagraphFilePath(path: string): { chapter: string; paragraph: string; number: number } | null {
  const match = PARAGRAPH_FILE_PATTERN.exec(path);
  return match ? { chapter: match[1], paragraph: match[2], number: Number(match[2].slice(0, 3)) } : null;
}

export function chapterNumberFromSlug(slug: string): number | undefined {
  const match = /^(\d{3})-/.exec(slug);
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

/** Relative, normalized repository path; rejects traversal and absolute paths. */
export function assertSafeBookPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new Error(`Unsafe book path: ${path}`);
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) throw new Error(`Unsafe book path: ${path}`);
  return normalized;
}
