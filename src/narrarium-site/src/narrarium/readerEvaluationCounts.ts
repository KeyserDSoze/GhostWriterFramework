import type { BookStructure } from "@/types/book";

/** Filename basename without the .md extension, matching reader-evaluation path leaves. */
function paragraphSlugFromPath(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

/**
 * Count saved reader-evaluation markdown files (excluding summaries) for a
 * specific chapter. Only per-chapter target evaluations are counted here, not
 * the paragraph-level ones nested under the same chapter.
 */
export function countChapterReaderEvaluations(structure: BookStructure | undefined, chapterSlug: string): number {
  if (!structure) return 0;
  const prefix = `evaluations/readers/chapters/${chapterSlug}/`;
  return structure.readerEvaluationFiles.filter((file) => file.path.startsWith(prefix)).length;
}

/** Count saved reader-evaluation files for a specific paragraph inside a chapter. */
export function countParagraphReaderEvaluations(
  structure: BookStructure | undefined,
  chapterSlug: string,
  paragraphPath: string,
): number {
  if (!structure) return 0;
  const paragraphSlug = paragraphSlugFromPath(paragraphPath);
  const prefix = `evaluations/readers/paragraphs/${chapterSlug}/${paragraphSlug}/`;
  return structure.readerEvaluationFiles.filter((file) => file.path.startsWith(prefix)).length;
}
