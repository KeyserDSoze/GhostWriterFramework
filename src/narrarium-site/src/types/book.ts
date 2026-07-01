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
}

export interface Ghostwriter {
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
  /** guidelines/writing-style.md or guidelines/style.md */
  globalWritingStylePath?: string;
  /** guidelines/voices.md */
  voicesPath?: string;
  plotPath?: string;
  /** ghostwriters/<slug>.md profiles */
  ghostwriters: Ghostwriter[];
}
