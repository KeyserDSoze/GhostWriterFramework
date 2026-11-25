import { parseDocument } from "yaml";
import { isApprovedRepositoryAssetPath, renderRepositoryMarkdownHtml } from "@/markdown/safeMarkdown";
import type { ReaderSettings } from "@/types/settings";

/**
 * How the reader of the app turns the Markdown of a scene into what it shows: its frontmatter apart, its images out of the text, its lines regrouped by
 * the line-break mode. Shared by the reader and by what reads the text of a scene as the reader shows it (the annotations: `@/annotations/sceneText`).
 */

export interface MarkdownParts {
  frontmatter: string;
  frontmatterRecord: Record<string, unknown>;
  body: string;
}

export function normalizeReaderLineBreaks(markdown: string, mode: ReaderSettings["lineBreakMode"]): string {
  if (mode === "source") return markdown.trim();
  const blocks = markdown.replace(/\r\n/g, "\n").split(/\n\s*\n+/);
  const output: string[] = [];
  const prose: string[] = [];

  function flushProse() {
    const text = prose.join(" ").replace(/\s+/g, " ").trim();
    if (text) output.push(text);
    prose.length = 0;
  }

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (isPreservedMarkdownBlock(trimmed)) {
      flushProse();
      output.push(trimmed);
      continue;
    }
    const compact = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!compact) continue;
    if (mode === "dialogue" && isDialogueParagraph(compact)) {
      flushProse();
      output.push(compact);
      continue;
    }
    prose.push(compact);
  }
  flushProse();
  return output.join("\n\n").trim();
}

function isPreservedMarkdownBlock(block: string): boolean {
  return /^(#{1,6}\s+|```|~~~|>\s+|[-*+]\s+|\d+\.\s+|---+$|\*\*\*+$)/m.test(block.trim());
}

function isDialogueParagraph(text: string): boolean {
  const trimmed = text.trim();
  return /^[«“"—–]/.test(trimmed);
}

export function splitMarkdown(raw: string): MarkdownParts {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", frontmatterRecord: {}, body: raw.trim() };
  let frontmatterRecord: Record<string, unknown> = {};
  try {
    const parsed = parseDocument(match[1]).toJSON();
    if (parsed && typeof parsed === "object") frontmatterRecord = parsed as Record<string, unknown>;
  } catch {
    frontmatterRecord = {};
  }
  return { frontmatter: match[1] ?? "", frontmatterRecord, body: (match[2] ?? "").trim() };
}

export function extractMarkdownImages(body: string, filePath: string): { body: string; images: Array<{ path: string; alt: string }> } {
  const images: Array<{ path: string; alt: string }> = [];
  const cleaned = body.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_full, alt: string, src: string) => {
    if (isApprovedRepositoryAssetPath(src)) images.push({ path: resolveMarkdownAssetPath(src, filePath), alt });
    return "";
  });
  return { body: cleaned, images };
}

export function resolveMarkdownAssetPath(src: string, filePath: string): string {
  const clean = src.replace(/^['"]|['"]$/g, "");
  if (!clean.startsWith(".")) return clean.replace(/^\/+/, "");
  const parts = filePath.split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** The HTML of a scene's text without its images, as the reader shows it before it links the names of the canon. */
export function readerSceneHtml(raw: string, filePath: string, mode: ReaderSettings["lineBreakMode"] = "book"): string {
  const parts = splitMarkdown(raw);
  return renderRepositoryMarkdownHtml(normalizeReaderLineBreaks(extractMarkdownImages(parts.body, filePath).body, mode));
}
