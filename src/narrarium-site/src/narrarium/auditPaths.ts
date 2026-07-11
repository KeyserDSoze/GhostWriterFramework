import type { BookStructure } from "@/types/book";

export const BOOK_AUDIT_PATH = "audit/book.md";

export function buildBookAuditPath(): string {
  return BOOK_AUDIT_PATH;
}

export function buildChapterAuditPath(chapterSlug: string): string {
  return `audit/chapters/${chapterSlug}/chapter.md`;
}

export function buildParagraphAuditPath(chapterSlug: string, paragraphSlug: string): string {
  return `audit/chapters/${chapterSlug}/paragraphs/${paragraphSlug}.md`;
}

export function extractParagraphSlug(path: string): string {
  return /(?:^|\/)([^/]+)\.md$/i.exec(path)?.[1] ?? "";
}

export function findOrphanAuditPaths(structure: BookStructure): string[] {
  const chapters = new Map(
    structure.chapters.map((chapter) => [
      chapter.slug,
      new Set(chapter.paragraphs.map((paragraph) => extractParagraphSlug(paragraph.path))),
    ]),
  );

  return structure.auditFiles
    .map((file) => file.path)
    .filter((path) => {
      if (path === BOOK_AUDIT_PATH) return false;

      const chapterMatch = /^audit\/chapters\/([^/]+)\/chapter\.md$/.exec(path);
      if (chapterMatch) return !chapters.has(chapterMatch[1]);

      const paragraphMatch = /^audit\/chapters\/([^/]+)\/paragraphs\/([^/]+)\.md$/.exec(path);
      if (paragraphMatch) return !chapters.get(paragraphMatch[1])?.has(paragraphMatch[2]);

      return true;
    })
    .sort((left, right) => left.localeCompare(right));
}
