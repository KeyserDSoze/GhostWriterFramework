/**
 * Where the annotations of a book are (docs/repository-spec.md, «Annotations»). Kept apart from `format.ts` so that the sync of the working copy
 * can tell a file of annotations without loading the YAML code.
 */

export const ANNOTATIONS_DIRECTORY = "annotations";
export const ANNOTATIONS_CHAPTERS_DIRECTORY = `${ANNOTATIONS_DIRECTORY}/chapters`;
export const ANNOTATION_TAGS_PATH = `${ANNOTATIONS_DIRECTORY}/tags.yml`;

export function annotationsChapterPath(chapterSlug: string): string {
  return `${ANNOTATIONS_CHAPTERS_DIRECTORY}/${chapterSlug}.yml`;
}

/** The chapter of a file of annotations (`annotations/chapters/001-the-gate.yml` → `001-the-gate`), or null for any other path. */
export function chapterSlugOfAnnotationsPath(path: string): string | null {
  const match = /^annotations\/chapters\/([^/]+)\.yml$/.exec(path);
  return match ? match[1] : null;
}

/** A file the app writes for the annotations: one of a chapter, or the tags of the book. */
export function isAnnotationsPath(path: string): boolean {
  return path === ANNOTATION_TAGS_PATH || chapterSlugOfAnnotationsPath(path) !== null;
}
