import type { BookStructure } from "@/types/book";

export const REWRITE_FROM_READER_FEEDBACK_ROOT = "operations/rewrite-from-reader-feedback";

export type RewriteOperationScope = "chapter" | "paragraph";

export interface ParsedRewriteOperationPath {
  scope: RewriteOperationScope;
  chapterSlug: string;
  paragraphSlug?: string;
  operationId: string;
  kind: "manifest" | "beforeSnapshot" | "generatedSnapshot";
  snapshotParagraphSlug?: string;
}

function segment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function chapterRewriteOperationDirectory(chapterSlug: string, operationId: string): string {
  return `${REWRITE_FROM_READER_FEEDBACK_ROOT}/chapters/${segment(chapterSlug, "chapter slug")}/${segment(operationId, "operation id")}`;
}

export function paragraphRewriteOperationDirectory(chapterSlug: string, paragraphSlug: string, operationId: string): string {
  return `${REWRITE_FROM_READER_FEEDBACK_ROOT}/paragraphs/${segment(chapterSlug, "chapter slug")}/${segment(paragraphSlug, "paragraph slug")}/${segment(operationId, "operation id")}`;
}

export function rewriteOperationManifestPath(scope: RewriteOperationScope, chapterSlug: string, operationId: string, paragraphSlug?: string): string {
  const directory = scope === "chapter"
    ? chapterRewriteOperationDirectory(chapterSlug, operationId)
    : paragraphRewriteOperationDirectory(chapterSlug, segment(paragraphSlug ?? "", "paragraph slug"), operationId);
  return `${directory}/manifest.md`;
}

export function rewriteOperationSnapshotPath(
  scope: RewriteOperationScope,
  chapterSlug: string,
  operationId: string,
  snapshotParagraphSlug: string,
  version: "before" | "generated",
  paragraphSlug?: string,
): string {
  const directory = scope === "chapter"
    ? chapterRewriteOperationDirectory(chapterSlug, operationId)
    : paragraphRewriteOperationDirectory(chapterSlug, segment(paragraphSlug ?? "", "paragraph slug"), operationId);
  return `${directory}/snapshots/${segment(snapshotParagraphSlug, "snapshot paragraph slug")}-${version}.md`;
}

export function parseRewriteOperationPath(path: string): ParsedRewriteOperationPath | null {
  const chapter = new RegExp(`^${REWRITE_FROM_READER_FEEDBACK_ROOT}/chapters/([^/]+)/([^/]+)/(manifest\\.md|snapshots/([^/]+)-(before|generated)\\.md)$`).exec(path);
  if (chapter) {
    return {
      scope: "chapter",
      chapterSlug: chapter[1],
      operationId: chapter[2],
      kind: chapter[3] === "manifest.md" ? "manifest" : chapter[5] === "before" ? "beforeSnapshot" : "generatedSnapshot",
      snapshotParagraphSlug: chapter[4],
    };
  }
  const paragraph = new RegExp(`^${REWRITE_FROM_READER_FEEDBACK_ROOT}/paragraphs/([^/]+)/([^/]+)/([^/]+)/(manifest\\.md|snapshots/([^/]+)-(before|generated)\\.md)$`).exec(path);
  if (!paragraph) return null;
  return {
    scope: "paragraph",
    chapterSlug: paragraph[1],
    paragraphSlug: paragraph[2],
    operationId: paragraph[3],
    kind: paragraph[4] === "manifest.md" ? "manifest" : paragraph[6] === "before" ? "beforeSnapshot" : "generatedSnapshot",
    snapshotParagraphSlug: paragraph[5],
  };
}

export function isRewriteOperationManifestPath(path: string): boolean {
  return parseRewriteOperationPath(path)?.kind === "manifest";
}

export function findOrphanRewriteOperationPaths(structure: BookStructure): string[] {
  const chapters = new Map(structure.chapters.map((chapter) => [
    chapter.slug,
    new Set(chapter.paragraphs.map((paragraph) => (paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, ""))),
  ]));
  return structure.operationManifestFiles.map((file) => file.path).filter((path) => {
    const parsed = parseRewriteOperationPath(path);
    if (!parsed) return true;
    const paragraphs = chapters.get(parsed.chapterSlug);
    return !paragraphs || (parsed.scope === "paragraph" && !paragraphs.has(parsed.paragraphSlug ?? ""));
  });
}
