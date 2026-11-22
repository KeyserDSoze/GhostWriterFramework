/**
 * The files of a chapter's folder that its freeze fingerprints: `chapter.md` and the scenes (`001-the-pier.md`, the shape of a scene's file in the
 * engine's record). Nothing else in the folder is the text of the chapter. No import of the engine: the Copilot panel checks a proposal with it
 * before loading anything.
 */
const CHAPTER_TEXT_FILE = /^chapters\/([^/]+)\/(chapter\.md|\d{3}(?:-[^/]*)?\.md)$/;

export function chapterTextFile(path: string): { slug: string; name: string } | null {
  const match = CHAPTER_TEXT_FILE.exec(path);
  return match ? { slug: match[1], name: match[2] } : null;
}
