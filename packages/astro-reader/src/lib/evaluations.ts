import path from "node:path";
import { readFile } from "node:fs/promises";
import { marked } from "marked";
import { parseNarrariumMarkdownDocument } from "narrarium";
import { getBookRoot } from "./book.js";

export interface EvaluationData {
  id: string;
  title: string;
  htmlContent: string;
}

/**
 * Load the chapter-level evaluation from
 * `evaluations/chapters/<chapterSlug>.md`, or return null if the file does
 * not exist (evaluation has not been run yet).
 */
export async function loadChapterEvaluation(chapterSlug: string): Promise<EvaluationData | null> {
  const root = getBookRoot();
  const filePath = path.join(root, "evaluations", "chapters", `${chapterSlug}.md`);
  const raw = await readFile(filePath, "utf8").catch(() => null);
  if (!raw) return null;

  const doc = parseNarrariumMarkdownDocument(`evaluations/chapters/${chapterSlug}.md`, raw);
  const fm = doc.frontmatter as Record<string, unknown>;
  const htmlContent = await marked.parse(doc.body ?? "");

  return {
    id: String(fm.id ?? `evaluation:chapter:${chapterSlug}`),
    title: String(fm.title ?? "Chapter Evaluation"),
    htmlContent,
  };
}

/**
 * Load the paragraph-level evaluation from
 * `evaluations/paragraphs/<chapterSlug>/<paragraphSlug>.md`, or return null.
 */
export async function loadParagraphEvaluation(
  chapterSlug: string,
  paragraphSlug: string,
): Promise<EvaluationData | null> {
  const root = getBookRoot();
  const filePath = path.join(
    root,
    "evaluations",
    "paragraphs",
    chapterSlug,
    `${paragraphSlug}.md`,
  );
  const raw = await readFile(filePath, "utf8").catch(() => null);
  if (!raw) return null;

  const doc = parseNarrariumMarkdownDocument(
    `evaluations/paragraphs/${chapterSlug}/${paragraphSlug}.md`,
    raw,
  );
  const fm = doc.frontmatter as Record<string, unknown>;
  const htmlContent = await marked.parse(doc.body ?? "");

  return {
    id: String(fm.id ?? `evaluation:paragraph:${chapterSlug}:${paragraphSlug}`),
    title: String(fm.title ?? "Scene Evaluation"),
    htmlContent,
  };
}
