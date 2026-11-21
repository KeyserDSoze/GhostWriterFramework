const OTHER_SCRIPT_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const LATIN_SEPARATORS = /[^a-z0-9]+/g;
const LATIN_PATH_SEPARATORS = /[^a-z0-9/.-]+/g;
const OTHER_SEPARATORS = /[^\p{L}\p{M}\p{N}]+/gu;
const OTHER_PATH_SEPARATORS = /[^\p{L}\p{M}\p{N}/.-]+/gu;

/**
 * Text reduced to what tells it apart from other text when names are compared: no case, accents or punctuation, and
 * words set apart by one space. Latin text is reduced to a-z and 0-9, as the matching rules always did; text that has
 * letters of another script keeps its own letters, marks and digits, so two Chinese or Russian titles are never both
 * reduced to nothing (and so equal). With `paths`, the characters of a file path (`/`, `.`, `-`) stay.
 */
export function matchKey(value: string, paths = false): string {
  const text = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const separators = OTHER_SCRIPT_LETTER.test(text) ? (paths ? OTHER_PATH_SEPARATORS : OTHER_SEPARATORS) : (paths ? LATIN_PATH_SEPARATORS : LATIN_SEPARATORS);
  return text.replace(separators, " ").trim();
}
