import { parseDocument, stringify } from "yaml";

export interface MarkdownDocument {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseMarkdown(raw: string): MarkdownDocument {
  const text = raw ?? "";
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) return { frontmatter: {}, body: text.trim(), hasFrontmatter: false };
  let data: unknown = {};
  try {
    data = parseDocument(match[1]).toJSON();
  } catch {
    data = {};
  }
  const frontmatter = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  return { frontmatter, body: text.slice(match[0].length).trim(), hasFrontmatter: true };
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

/** Return the body with the frontmatter replaced (or added). */
export function withFrontmatter(raw: string, patch: Record<string, unknown>): string {
  const document = parseMarkdown(raw);
  return renderMarkdown(mergeFrontmatter(document.frontmatter, patch), document.body);
}
