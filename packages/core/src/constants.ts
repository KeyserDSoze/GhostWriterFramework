import { formatOrdinal } from "./slug.js";

export const SKILL_NAME = "narrarium-book";
export const DEEP_RESEARCH_SKILL_NAME = "deep-research";
export const AUDIT_DIRECTORY = "audit";
export const AUDIT_BOOK_FILE = "audit/book.md";
export const AUDIT_CHAPTERS_DIRECTORY = "audit/chapters";
export const REWRITE_OPERATIONS_DIRECTORY = "operations/rewrite-from-reader-feedback";

export const BOOK_DIRECTORIES = [
  "guidelines",
  "ghostwriters",
  "characters",
  "items",
  "locations",
  "factions",
  "timelines",
  "timelines/events",
  "secrets",
  "chapters",
  AUDIT_DIRECTORY,
  AUDIT_CHAPTERS_DIRECTORY,
  "drafts",
  "scripts",
  "conversations",
  "conversations/sessions",
  "resumes",
  "resumes/chapters",
  "state",
  "state/chapters",
  "evaluations",
  "evaluations/chapters",
  "evaluations/paragraphs",
  "operations",
  REWRITE_OPERATIONS_DIRECTORY,
  `${REWRITE_OPERATIONS_DIRECTORY}/chapters`,
  `${REWRITE_OPERATIONS_DIRECTORY}/paragraphs`,
  "personas",
  "research",
  "research/wikipedia",
  "deepresearches",
  "assets",
  "assets/book",
  "assets/characters",
  "assets/items",
  "assets/locations",
  "assets/factions",
  "assets/timelines",
  "assets/timelines/events",
  "assets/secrets",
  "assets/chapters",
  ".opencode/skills",
  ".opencode/commands",
  ".opencode/plugins",
  ".opencode/agents",
  ".opencode/agents/web-search-modules",
  ".claude/skills",
  ".claude/agents",
  ".claude/agents/web-search-modules",
  ".vscode",
  ".github",
] as const;

export const ENTITY_TYPE_TO_DIRECTORY = {
  character: "characters",
  item: "items",
  location: "locations",
  faction: "factions",
  secret: "secrets",
  "timeline-event": "timelines/events",
} as const;

export const ENTITY_TYPES = Object.keys(ENTITY_TYPE_TO_DIRECTORY) as Array<
  keyof typeof ENTITY_TYPE_TO_DIRECTORY
>;

export const DEFAULT_CANON = "draft";

export const BOOK_FILE = "book.md";
export const CONTEXT_FILE = "context.md";
export const IDEAS_FILE = "ideas.md";
export const NOTES_FILE = "notes.md";
export const PLOT_FILE = "plot.md";
export const PROMOTED_FILE = "promoted.md";
export const STORY_DESIGN_FILE = "story-design.md";
export const GHOSTWRITERS_DIRECTORY = "ghostwriters";
export const DEFAULT_GHOSTWRITER = "default";
export const DEFAULT_GHOSTWRITER_FILE = `${GHOSTWRITERS_DIRECTORY}/${DEFAULT_GHOSTWRITER}.md`;

export const GUIDELINE_FILES = {
  images: "guidelines/images.md",
} as const;

export const TIMELINE_MAIN_FILE = "timelines/main.md";
export const TOTAL_RESUME_FILE = "resumes/total.md";
export const TOTAL_EVALUATION_FILE = "evaluations/total.md";
export const STORY_STATE_STATUS_FILE = "state/status.md";
export const STORY_STATE_CURRENT_FILE = "state/current.md";
export const SCRIPT_LEDGER_FILE = "state/script-ledger.md";

export const PERSONAS_DIRECTORY = "personas";
export const PERSONAS_REVIEW_FILENAME = "personas-review.md";

export const SCRIPTS_DIRECTORY = "scripts";

/**
 * The outline (Scaletta): the author's chapter-by-chapter trace of the book. `outline/book.md` holds the rough description of
 * the book, and `outline/chapters/<NNN>.md` one entry per chapter (hypothetical title, what happens, the ghostwriter), numbered
 * by the name of the file with the zero-padding of the chapter folders. It is not `plot.md`, which is generated.
 */
export const OUTLINE_DIRECTORY = "outline";
export const OUTLINE_BOOK_FILE = `${OUTLINE_DIRECTORY}/book.md`;
export const OUTLINE_CHAPTERS_DIRECTORY = `${OUTLINE_DIRECTORY}/chapters`;

/** The file of the outline entry of a chapter: `outline/chapters/007.md`, `outline/chapters/1500.md`. */
export function outlineChapterPath(number: number): string {
  return `${OUTLINE_CHAPTERS_DIRECTORY}/${formatOrdinal(number)}.md`;
}

/**
 * The chapter an outline file is the entry of, from its name (the name wins over the frontmatter); `canonical` is false for a
 * name that is not padded as the core pads it (`7.md`, `0007.md`). `null` for any other file.
 */
export function parseOutlineChapterPath(filePath: string): { number: number; canonical: boolean } | null {
  const match = /^outline\/chapters\/(\d+)\.md$/.exec(filePath);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { number, canonical: match[1] === formatOrdinal(number) };
}

export const CONTENT_GLOB = [
  "book.md",
  "context.md",
  "ideas.md",
  "notes.md",
  "plot.md",
  "promoted.md",
  "story-design.md",
  "guidelines/**/*.md",
  "ghostwriters/**/*.md",
  "characters/**/*.md",
  "items/**/*.md",
  "locations/**/*.md",
  "factions/**/*.md",
  "timelines/**/*.md",
  "secrets/**/*.md",
  "chapters/**/*.md",
  "audit/**/*.md",
  "drafts/**/*.md",
  "scripts/**/*.md",
  "resumes/**/*.md",
  "state/**/*.md",
  "evaluations/**/*.md",
  "operations/**/*.md",
  "research/**/*.md",
  "assets/**/*.md",
  "outline/**/*.md",
];
