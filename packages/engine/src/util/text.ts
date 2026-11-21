/** Shorten text to at most `max` characters, cutting at a word boundary when possible. */
export function truncate(text: string, max: number, marker = "…"): string {
  const value = text ?? "";
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const cut = value.slice(0, Math.max(0, max - marker.length));
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > max * 0.6 ? cut.slice(0, boundary) : cut}${marker}`;
}

/** Keep the last `max` characters, starting at a word boundary when possible. */
export function tail(text: string, max: number, marker = "…"): string {
  const value = text ?? "";
  if (value.length <= max) return value;
  const cut = value.slice(value.length - max);
  const boundary = cut.indexOf(" ");
  return `${marker}${boundary >= 0 && boundary < max * 0.3 ? cut.slice(boundary + 1) : cut}`;
}

export function countWords(text: string): number {
  const matches = (text ?? "").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

export function collapseWhitespace(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Human title from a Narrarium slug such as `001-the-arrival` (same rule as the web app). */
export function slugToTitle(slug: string): string {
  return slug
    .replace(/^\d{3}-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Remove a leading YAML frontmatter block the same way the web app does before reading prose. */
export function stripFrontmatter(raw: string): string {
  return (raw ?? "").replace(/^---[\s\S]*?---\s*/, "").trim();
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  it: "Italian",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  ro: "Romanian",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
  el: "Greek",
  ru: "Russian",
  uk: "Ukrainian",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  tr: "Turkish",
  ar: "Arabic",
  he: "Hebrew",
};

const LANGUAGE_ALIASES: Record<string, string> = {
  english: "en",
  inglese: "en",
  italian: "it",
  italiano: "it",
  spanish: "es",
  español: "es",
  french: "fr",
  français: "fr",
  german: "de",
  deutsch: "de",
  portuguese: "pt",
  português: "pt",
};

/** Normalize a book language value (`it`, `it-IT`, `Italiano`) to a two-letter code. */
export function languageCode(value: string | undefined, fallback = "en"): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (LANGUAGE_ALIASES[raw]) return LANGUAGE_ALIASES[raw];
  const code = raw.split(/[-_\s]/)[0];
  return code.length >= 2 && code.length <= 3 ? code : fallback;
}

/** English name of a language, used inside prompts ("Write in Italian"). */
export function languageName(value: string | undefined): string {
  const code = languageCode(value);
  return LANGUAGE_NAMES[code] ?? (value?.trim() || "English");
}

export function isItalian(value: string | undefined): boolean {
  return languageCode(value) === "it";
}

export function bulletList(items: string[], empty = "-"): string {
  const values = items.map((item) => item.trim()).filter(Boolean);
  return values.length ? values.map((item) => `- ${item}`).join("\n") : empty;
}
