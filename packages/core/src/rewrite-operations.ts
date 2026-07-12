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

function segment(value: string): string {
  if (!value || value.includes("/") || value === "." || value === "..") throw new Error(`Invalid operation path segment: ${value}`);
  return value;
}

export function rewriteOperationManifestPath(scope: RewriteOperationScope, chapterSlug: string, operationId: string, paragraphSlug?: string): string {
  const base = scope === "chapter"
    ? `${REWRITE_FROM_READER_FEEDBACK_ROOT}/chapters/${segment(chapterSlug)}/${segment(operationId)}`
    : `${REWRITE_FROM_READER_FEEDBACK_ROOT}/paragraphs/${segment(chapterSlug)}/${segment(paragraphSlug ?? "")}/${segment(operationId)}`;
  return `${base}/manifest.md`;
}

export function parseRewriteOperationPath(value: string): ParsedRewriteOperationPath | null {
  const chapter = /^operations\/rewrite-from-reader-feedback\/chapters\/([^/]+)\/([^/]+)\/(manifest\.md|snapshots\/([^/]+)-(before|generated)\.md)$/.exec(value);
  if (chapter) return {
    scope: "chapter",
    chapterSlug: chapter[1],
    operationId: chapter[2],
    kind: chapter[3] === "manifest.md" ? "manifest" : chapter[5] === "before" ? "beforeSnapshot" : "generatedSnapshot",
    snapshotParagraphSlug: chapter[4],
  };
  const paragraph = /^operations\/rewrite-from-reader-feedback\/paragraphs\/([^/]+)\/([^/]+)\/([^/]+)\/(manifest\.md|snapshots\/([^/]+)-(before|generated)\.md)$/.exec(value);
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
