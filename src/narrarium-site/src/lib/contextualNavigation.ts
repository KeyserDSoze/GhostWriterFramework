import { buildChapterAuditPath, buildParagraphAuditPath, extractParagraphSlug } from "@/narrarium/auditPaths";
import type { BookStructure, Chapter, Paragraph } from "@/types/book";

export interface ContextualNavigationTarget {
  previousHref?: string;
  nextHref?: string;
  currentFilePaths: string[];
  currentLabel?: string;
}

function canonicalParagraphDraftPath(chapterSlug: string, paragraph: Paragraph): string {
  return `drafts/${chapterSlug}/${extractParagraphSlug(paragraph.path)}.md`;
}

function canonicalChapterDraftPath(chapterSlug: string): string {
  return `drafts/${chapterSlug}/chapter.md`;
}

function paragraphHref(bookId: string, chapterSlug: string, paragraphNumber: string, suffix = ""): string {
  return `/app/books/${bookId}/chapters/${chapterSlug}/paragraphs/${paragraphNumber}${suffix}`;
}

function chapterHref(bookId: string, chapterSlug: string, suffix = ""): string {
  return `/app/books/${bookId}/chapters/${chapterSlug}${suffix}`;
}

function chapterAndParagraph(structure: BookStructure, chapterSlug: string, paragraphNumber: string): { chapter: Chapter; paragraph: Paragraph; chapterIndex: number; paragraphIndex: number } | null {
  const chapterIndex = structure.chapters.findIndex((entry) => entry.slug === chapterSlug);
  if (chapterIndex < 0) return null;
  const chapter = structure.chapters[chapterIndex];
  const paragraphIndex = chapter.paragraphs.findIndex((entry) => entry.number === paragraphNumber);
  if (paragraphIndex < 0) return null;
  return { chapter, paragraph: chapter.paragraphs[paragraphIndex], chapterIndex, paragraphIndex };
}

function chapterOnly(structure: BookStructure, chapterSlug: string): { chapter: Chapter; chapterIndex: number } | null {
  const chapterIndex = structure.chapters.findIndex((entry) => entry.slug === chapterSlug);
  if (chapterIndex < 0) return null;
  return { chapter: structure.chapters[chapterIndex], chapterIndex };
}

function previousParagraph(structure: BookStructure, chapterIndex: number, paragraphIndex: number): { chapter: Chapter; paragraph: Paragraph } | null {
  const chapter = structure.chapters[chapterIndex];
  if (paragraphIndex > 0) return { chapter, paragraph: chapter.paragraphs[paragraphIndex - 1] };
  if (chapterIndex === 0) return null;
  const previousChapter = structure.chapters[chapterIndex - 1];
  const previousParagraph = previousChapter.paragraphs[previousChapter.paragraphs.length - 1];
  return previousParagraph ? { chapter: previousChapter, paragraph: previousParagraph } : null;
}

function nextParagraph(structure: BookStructure, chapterIndex: number, paragraphIndex: number): { chapter: Chapter; paragraph: Paragraph } | null {
  const chapter = structure.chapters[chapterIndex];
  if (paragraphIndex < chapter.paragraphs.length - 1) return { chapter, paragraph: chapter.paragraphs[paragraphIndex + 1] };
  if (chapterIndex >= structure.chapters.length - 1) return null;
  const nextChapter = structure.chapters[chapterIndex + 1];
  const nextParagraph = nextChapter.paragraphs[0];
  return nextParagraph ? { chapter: nextChapter, paragraph: nextParagraph } : null;
}

/**
 * Resolve contextual previous/next navigation and current file ownership while
 * preserving the current view mode (final, draft, script, evaluation, split,
 * audit, reader evaluations, chapter indexes).
 */
export function resolveContextualNavigation(structure: BookStructure | undefined, pathname: string, bookId: string | undefined): ContextualNavigationTarget {
  if (!structure || !bookId) return { currentFilePaths: [] };
  const clean = pathname.replace(/\/+$/, "") || "/";

  let match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)\/paragraphs\/([^/]+)(\/workspace\/[^/]+|\/reader-evaluations|\/audit|\/split)?$/.exec(clean);
  if (match) {
    const chapterSlug = decodeURIComponent(match[2]);
    const paragraphNumber = decodeURIComponent(match[3]);
    const suffix = match[4] ?? "";
    const resolved = chapterAndParagraph(structure, chapterSlug, paragraphNumber);
    if (!resolved) return { currentFilePaths: [] };
    const previous = previousParagraph(structure, resolved.chapterIndex, resolved.paragraphIndex);
    const next = nextParagraph(structure, resolved.chapterIndex, resolved.paragraphIndex);
    const paragraphSlug = extractParagraphSlug(resolved.paragraph.path);
    const currentFilePaths = suffix === ""
      ? [resolved.paragraph.path]
      : suffix === "/split"
        ? [resolved.paragraph.path, resolved.paragraph.draftPath ?? canonicalParagraphDraftPath(resolved.chapter.slug, resolved.paragraph)]
        : suffix === "/reader-evaluations"
          ? []
          : suffix === "/audit"
            ? [resolved.paragraph.auditPath ?? buildParagraphAuditPath(resolved.chapter.slug, paragraphSlug)]
            : suffix === "/workspace/draft"
              ? [resolved.paragraph.draftPath ?? canonicalParagraphDraftPath(resolved.chapter.slug, resolved.paragraph)]
              : suffix === "/workspace/script"
                ? [resolved.paragraph.scriptPath ?? `scripts/${resolved.chapter.slug}/${paragraphSlug}.md`]
                : suffix === "/workspace/evaluation"
                  ? [resolved.paragraph.evaluationPath ?? `evaluations/paragraphs/${resolved.chapter.slug}/${paragraphSlug}.md`]
                  : [];
    return {
      previousHref: previous ? paragraphHref(bookId, previous.chapter.slug, previous.paragraph.number, suffix) : undefined,
      nextHref: next ? paragraphHref(bookId, next.chapter.slug, next.paragraph.number, suffix) : undefined,
      currentFilePaths,
      currentLabel: resolved.paragraph.title,
    };
  }

  match = /^\/app\/books\/([^/]+)\/chapters\/([^/]+)(\/workspace\/[^/]+|\/reader-evaluations|\/audit|\/drafts|\/scripts)?$/.exec(clean);
  if (match) {
    const chapterSlug = decodeURIComponent(match[2]);
    const suffix = match[3] ?? "";
    const resolved = chapterOnly(structure, chapterSlug);
    if (!resolved) return { currentFilePaths: [] };
    const previous = resolved.chapterIndex > 0 ? structure.chapters[resolved.chapterIndex - 1] : null;
    const next = resolved.chapterIndex < structure.chapters.length - 1 ? structure.chapters[resolved.chapterIndex + 1] : null;
    const currentFilePaths = suffix === ""
      ? [`${resolved.chapter.path}/chapter.md`]
      : suffix === "/reader-evaluations"
        ? []
        : suffix === "/audit"
          ? [resolved.chapter.auditPath ?? buildChapterAuditPath(resolved.chapter.slug)]
          : suffix === "/workspace/draft"
            ? [resolved.chapter.draftPath ?? canonicalChapterDraftPath(resolved.chapter.slug)]
            : suffix === "/workspace/resume"
              ? [`resumes/chapters/${resolved.chapter.slug}.md`]
              : suffix === "/workspace/evaluation"
                ? [`evaluations/chapters/${resolved.chapter.slug}.md`]
                : [];
    return {
      previousHref: previous ? chapterHref(bookId, previous.slug, suffix) : undefined,
      nextHref: next ? chapterHref(bookId, next.slug, suffix) : undefined,
      currentFilePaths,
      currentLabel: resolved.chapter.title,
    };
  }

  return { currentFilePaths: [] };
}
