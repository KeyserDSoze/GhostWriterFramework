import { parseMarkdown } from "../markdown/frontmatter.js";

/** What reading a profile file found: its frontmatter and body, and the problems that make the profile differ from what the file says. */
export interface ProfileFile {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Problems found so far, each one naming the file. Add to it with `warn`. */
  warnings: string[];
  /** The YAML could not be read: what was read of it is a guess, and every value that is missing is a consequence, not a mistake of its own. */
  invalid: boolean;
  warn(message: string): void;
}

/**
 * The frontmatter and the body of a profile file (`director.md`, `ghostwriters/<slug>.md`, `personas/<slug>.md`). It never
 * throws: YAML that cannot be read is a warning that says where, and the profile is read as far as it can be.
 */
export function readProfileFile(file: string, raw: string): ProfileFile {
  const document = parseMarkdown(raw ?? "");
  const warnings: string[] = [];
  const invalid = Boolean(document.error);
  if (document.error) warnings.push(`${file}: the frontmatter is not valid YAML (${document.errorLine ? `line ${document.errorLine}: ` : ""}${document.error}): the profile could not be read as the file says; correct the file.`);
  return {
    frontmatter: document.frontmatter,
    body: document.body,
    warnings,
    invalid,
    // After an error in the YAML every value is a guess: one warning says it all.
    warn: (message) => {
      if (!invalid) warnings.push(`${file}: ${message}`);
    },
  };
}

/** A key left without a value (`red_lines:`), or with text that is only spaces. */
export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The value as the author may have written it, for a message. */
export function quoted(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (isMapping(value)) return "a mapping";
  const text = String(value);
  return `«${text.length > 40 ? `${text.slice(0, 40)}…` : text}»`;
}

/** A number, or text that is one (`7`, `7.5`, `7,5`, with spaces around it); `undefined` for anything else. */
export function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^[+-]?\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(",", ".")) : undefined;
}

export function clampNumber(value: number, min: number, max: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.min(max, Math.max(min, Math.round(value * factor) / factor));
}

/** A switch: a boolean, or `yes`/`no`, `on`/`off`, `true`/`false`, `1`/`0` in any case; `undefined` for anything else. */
export function switchValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(text)) return true;
  if (["false", "no", "off", "0"].includes(text)) return false;
  return undefined;
}

/** A value from a closed list, whatever its case, spacing or separators (`Ask On Critical`, `ask_on_critical`); `null` when it is none of them. */
export function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return (allowed as readonly string[]).includes(text) ? text as T : null;
}

/**
 * One entry of a list as text: text, a number or a boolean as they are; a line with a colon in it that YAML read as a one-key
 * mapping (`- No gore: at all`) as the line it was; `null` for an entry with nothing in it, and `undefined` for what cannot be text.
 */
export function listEntry(entry: unknown): string | null | undefined {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  if (isMapping(entry)) {
    const keys = Object.keys(entry);
    const only = keys.length === 1 ? entry[keys[0]] : undefined;
    if (keys.length === 1 && (typeof only === "string" || typeof only === "number" || typeof only === "boolean")) return `${keys[0]}: ${only}`;
  }
  return undefined;
}
