import { parse, stringify as stringifyYaml } from "yaml";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

type MatterFunction = {
  (raw: string): ParsedFrontmatter;
  stringify: (content: string, data?: Record<string, unknown>) => string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const matter = ((raw: string): ParsedFrontmatter => {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { data: {}, content: raw };

  const parsed = parse(match[1]) as unknown;
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return {
    data,
    content: raw.slice(match[0].length),
  };
}) as MatterFunction;

matter.stringify = (content: string, data: Record<string, unknown> = {}): string => {
  const yaml = stringifyYaml(data).trimEnd();
  const normalizedContent = content.startsWith("\n") ? content.slice(1) : content;
  return `---\n${yaml}\n---\n\n${normalizedContent}`;
};

export default matter;
