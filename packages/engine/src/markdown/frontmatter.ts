import { parseDocument, stringify } from "yaml";
import { isItalian, splitFrontmatter } from "../util/text.js";

export interface MarkdownDocument {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  /**
   * Why the frontmatter cannot be read: it is not valid YAML, or not a mapping of keys and values. `frontmatter` then holds
   * what could be read (often little, sometimes wrong), so a file must never be rewritten from it. Absent when the
   * frontmatter is good, empty, or missing.
   */
  error?: string;
  /** The line of the file `error` is on (1 is the opening `---`), when the parser says. */
  errorLine?: number;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** What the parser says without where it says it: `Nested mappings are not allowed in compact mappings at line 1, column 8:` becomes the first part. */
function reasonOf(message: string): string {
  return (message ?? "").split("\n")[0].replace(/\s+at line \d+, column \d+:?\s*$/, "").trim() || "the YAML cannot be read";
}

function readYaml(yaml: string): { data: Record<string, unknown>; error?: string; line?: number } {
  let document: ReturnType<typeof parseDocument>;
  let value: unknown;
  try {
    document = parseDocument(yaml);
    value = document.toJSON();
  } catch (error) {
    // An alias bomb and the like: the library refuses to expand it.
    return { data: {}, error: reasonOf(error instanceof Error ? error.message : String(error)) };
  }
  const first = document.errors[0];
  if (first) {
    const line = first.linePos?.[0]?.line;
    return { data: isMapping(value) ? value : {}, error: reasonOf(first.message), ...(typeof line === "number" ? { line: line + 1 } : {}) };
  }
  if (value === null || value === undefined) return { data: {} };
  if (!isMapping(value)) return { data: {}, error: "the frontmatter must be a YAML mapping of keys and values", line: 2 };
  return { data: value };
}

export function parseMarkdown(raw: string): MarkdownDocument {
  const text = raw ?? "";
  const split = splitFrontmatter(text);
  if (!split) return { frontmatter: {}, body: text.trim(), hasFrontmatter: false };
  const reading = readYaml(split.yaml);
  return {
    frontmatter: reading.data,
    body: split.body.trim(),
    hasFrontmatter: true,
    ...(reading.error ? { error: reading.error, ...(reading.line !== undefined ? { errorLine: reading.line } : {}) } : {}),
  };
}

/**
 * A file whose frontmatter cannot be read is never rewritten: what it holds would be replaced by what could be read of it,
 * and the author's keys would be lost without a word. The message names the file and the line, in the language of the book.
 */
export class FrontmatterError extends Error {
  readonly code = "frontmatter_invalid";

  constructor(readonly path: string | undefined, readonly reason: string, readonly line?: number, language?: string) {
    super(frontmatterRefusal(path, reason, line, language));
    this.name = "FrontmatterError";
  }
}

function frontmatterRefusal(path: string | undefined, reason: string, line: number | undefined, language: string | undefined): string {
  if (isItalian(language)) {
    return `Correggi il frontmatter di ${path ?? "questo file"} (${line ? `riga ${line}: ` : ""}${reason}): l'autopilot non riscrive un file di cui non riesce a leggere il YAML, perché le chiavi che contiene andrebbero perse.`;
  }
  return `Correct the frontmatter of ${path ?? "this file"} (${line ? `line ${line}: ` : ""}${reason}): the autopilot will not rewrite a file whose YAML it cannot read, because the keys it holds would be lost.`;
}

/** Throws a `FrontmatterError` naming `path` when the document's frontmatter has an error. Call it before rewriting a file. */
export function assertFrontmatterReadable(path: string | undefined, document: MarkdownDocument, language?: string): void {
  if (document.error) throw new FrontmatterError(path, document.error, document.errorLine, language);
}

/** Drop empty values so generated frontmatter stays readable. */
export function cleanFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
}

export function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringify(cleanFrontmatter(frontmatter)).trimEnd();
  const content = (body ?? "").replace(/^\n+/, "").trimEnd();
  return `---\n${yaml}\n---\n\n${content}\n`;
}

/** Replace only the managed keys, preserving every other frontmatter value the author added. */
export function mergeFrontmatter(existing: Record<string, unknown>, managed: Record<string, unknown>): Record<string, unknown> {
  return { ...existing, ...managed };
}

export function frontmatterString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function frontmatterNumber(frontmatter: Record<string, unknown>, key: string): number | undefined {
  const value = frontmatter[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function frontmatterList(frontmatter: Record<string, unknown>, key: string): string[] {
  const value = frontmatter[key];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

/** Return the body with the frontmatter replaced (or added); a file whose frontmatter cannot be read is refused (`FrontmatterError`). */
export function withFrontmatter(raw: string, patch: Record<string, unknown>): string {
  const document = parseMarkdown(raw);
  assertFrontmatterReadable(undefined, document);
  return renderMarkdown(mergeFrontmatter(document.frontmatter, patch), document.body);
}
