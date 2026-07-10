// ─── Narrarium repository structure ──────────────────────────────────────────
// These types mirror the on-disk layout of a Narrarium book repository.

export interface BookFile {
  path: string;
  sha: string;
  size: number;
  /** Present only when the file was fetched with explicit content request */
  content?: string;
  /** Display name from the file's frontmatter (title/name); falls back to the slug when absent. */
  name?: string;
  /** Primary image path (assets/<section>/<slug>/primary.*) when one exists. */
  imagePath?: string;
}

export interface ResearchFile {
  /** File path inside the repo, e.g. research/2024-01-15-rome.md */
  path: string;
  sha: string;
  /** Slug derived from filename */
  slug: string;
  /** Display title from frontmatter, falls back to slug */
  title: string;
}

export interface NoteFile {
  /** File path inside the repo, e.g. notes/idea-for-chapter-3.md */
  path: string;
  sha: string;
  /** Slug derived from filename */
  slug: string;
  /** Display title from frontmatter, falls back to slug */
  title: string;
}

export interface Ghostwriter {
  slug: string;
  path: string;
  name: string;
}

export interface ReaderPersonaFile {
  slug: string;
  path: string;
  name: string;
}

export type CanonSection =
  | "characters"
  | "locations"
  | "factions"
  | "items"
  | "timelines"
  | "secrets";

export interface CanonEntry {
  section: CanonSection;
  /** Filename without extension */
  slug: string;
  path: string;
  /** Frontmatter fields parsed from the markdown file */
  frontmatter: Record<string, unknown>;
  /** Prose body (markdown below the frontmatter) */
  body: string;
}

export interface Paragraph {
  /** e.g. "001", "002" */
  number: string;
  /** Human-readable title derived from filename, e.g. "At the Gate" */
  title: string;
  path: string;
  draftPath?: string;
  scriptPath?: string;
  evaluationPath?: string;
  imagePath?: string;
  imagePromptPath?: string;
  body?: string;
}

export interface Chapter {
  /** e.g. "001-the-arrival" */
  slug: string;
  /** Chapter folder path: chapters/001-the-arrival/ */
  path: string;
  title: string;
  /** Optional chapter-level ghostwriter slug from chapter.md frontmatter. */
  ghostwriter?: string;
  paragraphs: Paragraph[];
  /** Path to the chapter-level writing style file, if present */
  writingStylePath?: string;
  draftPath?: string;
  imagePath?: string;
  imagePromptPath?: string;
  hasResume: boolean;
  hasEvaluation: boolean;
}

export interface BookStructure {
  /** book.md metadata */
  title: string;
  description: string;
  /** Optional language code from book.md frontmatter, e.g. en or it. */
  language?: string;
  /** Optional default ghostwriter slug from book.md frontmatter. */
  ghostwriter?: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  loadedBranch: string;
  bookCoverPath?: string;
  bookCoverPromptPath?: string;
  chapters: Chapter[];
  characters: BookFile[];
  locations: BookFile[];
  factions: BookFile[];
  items: BookFile[];
  timelines: BookFile[];
  secrets: BookFile[];
  /** writing-style.md, or legacy guidelines/writing-style.md / guidelines/style.md */
  globalWritingStylePath?: string;
  /** punctuation-style.md at the repo root: binding punctuation rules for prose */
  globalPunctuationStylePath?: string;
  /** guidelines/voices.md */
  voicesPath?: string;
  plotPath?: string;
  /** ghostwriters/<slug>.md profiles */
  ghostwriters: Ghostwriter[];
  /** personas/<slug>.md reader persona overrides and custom profiles */
  readerPersonas: ReaderPersonaFile[];
  /** saved ReaderEvaluation and ReaderEvaluationSummary markdown files */
  readerEvaluationFiles: BookFile[];
  /** research/*.md files */
  researchFiles: ResearchFile[];
  /** notes/*.md quick personal notes */
  notesFiles: NoteFile[];
}
