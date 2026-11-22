import { frontmatterList, frontmatterNumber, frontmatterString, parseMarkdown, type MarkdownDocument } from "../markdown/frontmatter.js";
import { clipText, slugToTitle } from "../util/text.js";
import { chapterBodyDigest, parseChapterFreeze, sceneBodyDigest, type ChapterFreeze } from "./freeze.js";
import { outlineIndex, type OutlineIndex } from "./outline.js";
import {
  BOOK_FILE,
  CANON_DIRECTORIES,
  DIRECTOR_FILE,
  chapterNumberFromSlug,
  parseChapterFilePath,
  parseParagraphFilePath,
  type CanonKind,
} from "./paths.js";
import type { BookStore } from "./store.js";

export interface BookInfo {
  title: string;
  language: string;
  author?: string;
  ghostwriter?: string;
  description: string;
}

export interface ParagraphInfo {
  chapter: string;
  slug: string;
  number: number;
  title: string;
  summary?: string;
  viewpoint?: string;
  ghostwriter?: string;
  path: string;
  hash: string;
  /** The fingerprint of the text of the scene (`sceneBodyDigest`: its body, without the frontmatter), computed when the file was read. */
  bodyDigest?: string;
}

export interface ChapterInfo {
  slug: string;
  number: number;
  title: string;
  summary?: string;
  pov: string[];
  ghostwriter?: string;
  path: string;
  hash?: string;
  paragraphs: ParagraphInfo[];
  /** The freeze record of chapter.md, when it holds a valid one: the chapter is frozen (see `book/freeze.ts`). */
  frozen?: ChapterFreeze;
  /** Why the `frozen` of chapter.md cannot be read: the chapter then counts as not frozen. Absent when there is no record, or a valid one. */
  frozenProblem?: string;
  /** The fingerprint of the body of chapter.md, its title heading excluded (`chapterBodyDigest`), computed when the file was read. */
  bodyDigest?: string;
  /** chapter.md as it was read (its whole body, and why its frontmatter cannot be read): what freezing the chapter rewrites, without reading it again. */
  document?: MarkdownDocument;
}

export interface CanonInfo {
  kind: CanonKind;
  slug: string;
  name: string;
  summary?: string;
  aliases: string[];
  knownFrom?: string;
  revealIn?: string;
  path: string;
  hash: string;
}

export interface BookSnapshot {
  /** path → content hash for every text file of the book. */
  files: Map<string, string>;
  book: BookInfo;
  chapters: ChapterInfo[];
  canon: CanonInfo[];
  personaPaths: string[];
  ghostwriterSlugs: string[];
  hasDirector: boolean;
  /**
   * The files of the outline (`outline/book.md`, `outline/chapters/<NNN>.md`) with their hashes, from the list of the files: none
   * is read until something needs what it says (`OutlineReader`). Absent from a snapshot made by hand: it is then made from `files`.
   */
  outline?: OutlineIndex;
}

interface CachedHeader {
  hash: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** The fingerprint of the text of a chapter.md or of a scene. */
  digest?: string;
  /** The whole document of a chapter.md. */
  document?: MarkdownDocument;
}

/** What a file is to the snapshot: a chapter.md and a scene keep the fingerprint of their text, a chapter.md its whole document too. */
type HeaderKind = "chapter" | "scene";

/** Parsed frontmatter cache keyed by path and content hash, reused across autopilot steps. */
export class SnapshotCache {
  private readonly entries = new Map<string, CachedHeader>();

  async header(store: BookStore, path: string, hash: string, kind?: HeaderKind): Promise<CachedHeader | null> {
    const cached = this.entries.get(path);
    if (cached && cached.hash === hash) return cached;
    const file = await store.read(path);
    if (!file) return null;
    const document = parseMarkdown(file.content);
    // The fingerprints are taken when the file is read, which happens once for each content: telling a change of a frozen chapter reads nothing.
    const entry: CachedHeader = {
      hash: file.hash,
      frontmatter: document.frontmatter,
      body: clipText(document.body, 600),
      ...(kind === "chapter" ? { digest: chapterBodyDigest(document.body), document } : kind === "scene" ? { digest: sceneBodyDigest(document.body) } : {}),
    };
    this.entries.set(path, entry);
    return entry;
  }
}

const CANON_PREFIXES = Object.entries(CANON_DIRECTORIES) as Array<[CanonKind, string]>;

function canonKindOf(path: string): CanonKind | null {
  if (!path.endsWith(".md")) return null;
  for (const [kind, directory] of CANON_PREFIXES) {
    if (path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/")) return kind;
  }
  return null;
}

function firstLine(body: string): string | undefined {
  const line = body.split(/\r?\n/).map((entry) => entry.replace(/^#+\s*/, "").trim()).find((entry) => entry && !entry.startsWith("---"));
  return line ? clipText(line, 240) : undefined;
}

export async function loadBookSnapshot(store: BookStore, cache = new SnapshotCache()): Promise<BookSnapshot> {
  const entries = await store.list();
  const files = new Map(entries.map((entry) => [entry.path, entry.hash]));

  const bookHash = files.get(BOOK_FILE);
  const bookHeader = bookHash ? await cache.header(store, BOOK_FILE, bookHash) : null;
  const bookFrontmatter = bookHeader?.frontmatter ?? {};
  const book: BookInfo = {
    title: frontmatterString(bookFrontmatter, "title") ?? "Untitled book",
    language: frontmatterString(bookFrontmatter, "language") ?? "en",
    author: frontmatterString(bookFrontmatter, "author"),
    ghostwriter: frontmatterString(bookFrontmatter, "ghostwriter"),
    description: bookHeader?.body ?? "",
  };

  const chapters = new Map<string, ChapterInfo>();
  const ensureChapter = (slug: string): ChapterInfo => {
    let chapter = chapters.get(slug);
    if (!chapter) {
      chapter = { slug, number: chapterNumberFromSlug(slug) ?? 0, title: slugToTitle(slug), pov: [], path: `chapters/${slug}/chapter.md`, paragraphs: [] };
      chapters.set(slug, chapter);
    }
    return chapter;
  };

  const canon: CanonInfo[] = [];
  const personaPaths: string[] = [];
  const ghostwriterSlugs: string[] = [];

  await Promise.all(entries.map(async ({ path, hash }) => {
    const chapterFile = parseChapterFilePath(path);
    if (chapterFile) {
      const header = await cache.header(store, path, hash, "chapter");
      const chapter = ensureChapter(chapterFile.chapter);
      const frontmatter = header?.frontmatter ?? {};
      chapter.hash = hash;
      chapter.number = frontmatterNumber(frontmatter, "number") ?? chapter.number;
      chapter.title = frontmatterString(frontmatter, "title") ?? chapter.title;
      chapter.summary = frontmatterString(frontmatter, "summary");
      chapter.pov = frontmatterList(frontmatter, "pov");
      chapter.ghostwriter = frontmatterString(frontmatter, "ghostwriter");
      if (header?.digest) chapter.bodyDigest = header.digest;
      if (header?.document) chapter.document = header.document;
      // A record is read only from a frontmatter that can be read: after an error of the YAML every value is a guess.
      const freeze = header?.document?.error ? (frontmatter.frozen === undefined ? {} : { problem: "the frontmatter of chapter.md cannot be read, so neither can its freeze record: the chapter counts as not frozen" }) : parseChapterFreeze(frontmatter.frozen);
      if (freeze.freeze) chapter.frozen = freeze.freeze;
      if (freeze.problem) chapter.frozenProblem = freeze.problem;
      return;
    }
    const paragraphFile = parseParagraphFilePath(path);
    if (paragraphFile) {
      const header = await cache.header(store, path, hash, "scene");
      const frontmatter = header?.frontmatter ?? {};
      ensureChapter(paragraphFile.chapter).paragraphs.push({
        chapter: paragraphFile.chapter,
        slug: paragraphFile.paragraph,
        number: frontmatterNumber(frontmatter, "number") ?? paragraphFile.number,
        title: frontmatterString(frontmatter, "title") ?? slugToTitle(paragraphFile.paragraph),
        summary: frontmatterString(frontmatter, "summary"),
        viewpoint: frontmatterString(frontmatter, "viewpoint"),
        ghostwriter: frontmatterString(frontmatter, "ghostwriter"),
        path,
        hash,
        ...(header?.digest ? { bodyDigest: header.digest } : {}),
      });
      return;
    }
    const kind = canonKindOf(path);
    if (kind) {
      const header = await cache.header(store, path, hash);
      const frontmatter = header?.frontmatter ?? {};
      const slug = path.split("/").pop()!.replace(/\.md$/i, "");
      canon.push({
        kind,
        slug,
        name: frontmatterString(frontmatter, "name") ?? frontmatterString(frontmatter, "title") ?? slugToTitle(slug),
        summary: frontmatterString(frontmatter, "summary")
          ?? frontmatterString(frontmatter, "background_summary")
          ?? frontmatterString(frontmatter, "function_in_book")
          ?? (header ? firstLine(header.body) : undefined),
        aliases: frontmatterList(frontmatter, "aliases"),
        knownFrom: frontmatterString(frontmatter, "known_from"),
        revealIn: frontmatterString(frontmatter, "reveal_in"),
        path,
        hash,
      });
      return;
    }
    if (/^personas\/[^/]+\.md$/.test(path)) personaPaths.push(path);
    else if (/^ghostwriters\/[^/]+\.md$/.test(path)) ghostwriterSlugs.push(path.slice("ghostwriters/".length, -3));
  }));

  const orderedChapters = [...chapters.values()]
    .map((chapter) => ({ ...chapter, paragraphs: chapter.paragraphs.sort((left, right) => left.number - right.number || left.slug.localeCompare(right.slug)) }))
    .sort((left, right) => left.number - right.number || left.slug.localeCompare(right.slug));

  return {
    files,
    book,
    chapters: orderedChapters,
    canon: canon.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)),
    personaPaths: personaPaths.sort(),
    ghostwriterSlugs: ghostwriterSlugs.sort(),
    hasDirector: files.has(DIRECTOR_FILE),
    outline: outlineIndex(files),
  };
}

export function findChapter(snapshot: BookSnapshot, slug: string): ChapterInfo | undefined {
  return snapshot.chapters.find((chapter) => chapter.slug === slug);
}

export function findParagraph(snapshot: BookSnapshot, chapter: string, paragraph: string): ParagraphInfo | undefined {
  return findChapter(snapshot, chapter)?.paragraphs.find((entry) => entry.slug === paragraph);
}

/** Whether a chapter has at least one paragraph with real prose (not just the scaffold placeholder). */
export function chapterHasProse(chapter: ChapterInfo): boolean {
  return chapter.paragraphs.length > 0;
}
