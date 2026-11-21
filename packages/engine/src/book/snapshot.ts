import { frontmatterList, frontmatterNumber, frontmatterString, parseMarkdown } from "../markdown/frontmatter.js";
import { slugToTitle } from "../util/text.js";
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
}

interface CachedHeader {
  hash: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Parsed frontmatter cache keyed by path and content hash, reused across autopilot steps. */
export class SnapshotCache {
  private readonly entries = new Map<string, CachedHeader>();

  async header(store: BookStore, path: string, hash: string): Promise<CachedHeader | null> {
    const cached = this.entries.get(path);
    if (cached && cached.hash === hash) return cached;
    const file = await store.read(path);
    if (!file) return null;
    const document = parseMarkdown(file.content);
    const entry = { hash: file.hash, frontmatter: document.frontmatter, body: document.body.slice(0, 600) };
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
  return line ? line.slice(0, 240) : undefined;
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
      const header = await cache.header(store, path, hash);
      const chapter = ensureChapter(chapterFile.chapter);
      const frontmatter = header?.frontmatter ?? {};
      chapter.hash = hash;
      chapter.number = frontmatterNumber(frontmatter, "number") ?? chapter.number;
      chapter.title = frontmatterString(frontmatter, "title") ?? chapter.title;
      chapter.summary = frontmatterString(frontmatter, "summary");
      chapter.pov = frontmatterList(frontmatter, "pov");
      chapter.ghostwriter = frontmatterString(frontmatter, "ghostwriter");
      return;
    }
    const paragraphFile = parseParagraphFilePath(path);
    if (paragraphFile) {
      const header = await cache.header(store, path, hash);
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
