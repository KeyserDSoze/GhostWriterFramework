import { loadFileContent } from "@/github/githubClient";
import { locateInChapter } from "@/annotations/anchoring";
import { fixTarget, type FixTarget } from "@/annotations/fix";
import type { Annotation } from "@/annotations/model";
import { sceneTextOfMarkdown } from "@/annotations/sceneText";
import { sceneSlugOfPath } from "@/components/annotations/reader/useLocatedAnnotations";
import type { BookEntry } from "@/types/settings";
import type { Chapter } from "@/types/book";

/** The scene of a passage as the working copy has it: the file, the blocks that hold the passage and where it is. */
export interface PassageContext {
  path: string;
  raw: string;
  target: FixTarget;
  chapterTitle: string;
  sceneTitle: string;
  sceneNumber: string;
}

export type PassageProblem = "orphaned" | "read";

/**
 * Reads the scenes of the chapter of an annotation from the working copy (never from GitHub) and finds its passage in them, also when it moved to another
 * scene of the chapter. `orphaned`: the passage is nowhere in the text any more; `read`: a file could not be read (`detail` says what the reader said).
 */
export async function loadPassageContext(input: { token: string; book: BookEntry; branch: string; chapter: Chapter | undefined; annotation: Annotation }): Promise<{ context: PassageContext } | { problem: PassageProblem; detail?: string }> {
  const { chapter, annotation } = input;
  if (!chapter) return { problem: "read" };
  try {
    const scenes = await Promise.all(chapter.paragraphs.map(async (paragraph) => {
      const raw = await loadFileContent(input.token, input.book.owner, input.book.repo, paragraph.path, input.branch);
      return { paragraph: sceneSlugOfPath(paragraph.path), text: sceneTextOfMarkdown(raw, paragraph.path), raw, path: paragraph.path, title: paragraph.title, number: paragraph.number };
    }));
    const match = locateInChapter(annotation, scenes);
    if (match.state === "orphaned") return { problem: "orphaned" };
    const scene = scenes.find((entry) => entry.paragraph === match.paragraph);
    const target = scene ? fixTarget(scene.raw, scene.text, { start: match.start, end: match.end }, (block) => sceneTextOfMarkdown(block, scene.path)) : null;
    if (!scene || !target) return { problem: "orphaned" };
    return { context: { path: scene.path, raw: scene.raw, target, chapterTitle: chapter.title, sceneTitle: scene.title, sceneNumber: scene.number } };
  } catch (error) {
    return { problem: "read", detail: error instanceof Error ? error.message : String(error) };
  }
}
