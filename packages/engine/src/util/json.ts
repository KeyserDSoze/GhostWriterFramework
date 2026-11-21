export class StructuredReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredReplyError";
  }
}

/** Index of the bracket closing the one at `start`, aware of JSON strings and escapes. */
function matchingBracket(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Parse the JSON value contained in a model reply. Accepts code fences and leading prose,
 * and tries a bounded number of candidate start brackets before giving up.
 */
export function parseJsonReply(raw: string): unknown {
  const text = (raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  if (!text) throw new StructuredReplyError("The model returned an empty reply where JSON was expected.");
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to candidate scanning.
  }
  let attempts = 0;
  for (let index = 0; index < text.length && attempts < 40; index += 1) {
    const character = text[index];
    if (character !== "{" && character !== "[") continue;
    attempts += 1;
    const end = matchingBracket(text, index);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(index, end + 1));
    } catch {
      // Try the next candidate.
    }
  }
  throw new StructuredReplyError("The model reply is not valid JSON.");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asStringList(value: unknown, max = 40): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""))
      : [];
  const output: string[] = [];
  for (const entry of source) {
    const text = typeof entry === "string" ? entry.trim() : typeof entry === "number" ? String(entry) : "";
    if (text && !output.includes(text)) output.push(text);
    if (output.length >= max) break;
  }
  return output;
}

export function asNumber(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function asInteger(value: unknown, fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  return Math.round(asNumber(value, fallback, min, max));
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function asOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(text) ? text as T : fallback;
}
