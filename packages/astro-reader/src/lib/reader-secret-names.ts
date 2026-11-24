/**
 * The repository variable `READER_PASSWORD_SECRETS`: the names of the secrets that hold the reader's passwords. The build reads it
 * (`reader-passwords.ts`) and the Narrarium site writes it, both through these functions, so that both agree on what a list is.
 */

export const READER_PASSWORD_SECRETS_VARIABLE = "READER_PASSWORD_SECRETS";
export const READER_PASSWORD_SECRET_PREFIX = "READER_PASSWORD_";

/** What GitHub accepts as a secret name, minus the `GITHUB_` prefix it reserves. */
export function isReaderPasswordSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^GITHUB_/i.test(name);
}

/** The names of a list (commas, spaces, semicolons or new lines between them; the same name twice is one), and the entries that are not names. */
export function parseReaderPasswordSecretNames(value: string | null | undefined): { names: string[]; invalid: Array<{ position: number }> } {
  const names: string[] = [];
  const seen = new Set<string>();
  const invalid: Array<{ position: number }> = [];
  const entries = String(value ?? "").split(/[\s,;]+/).filter(Boolean);
  entries.forEach((entry, index) => {
    if (!isReaderPasswordSecretName(entry)) {
      invalid.push({ position: index + 1 });
      return;
    }
    const key = entry.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(entry.toUpperCase());
  });
  return { names, invalid };
}

/** The value of the variable for these names, as the build reads it back. */
export function formatReaderPasswordSecretNames(names: string[]): string {
  const parsed = parseReaderPasswordSecretNames(names.join(","));
  if (parsed.invalid.length > 0) throw new Error("Every reader password secret needs a valid secret name.");
  return parsed.names.join(",");
}

/** The next free `READER_PASSWORD_NNN` (never a number already used by a listed name, so a removed name is not reused right away). */
export function nextReaderPasswordSecretName(existing: string[]): string {
  let highest = 0;
  for (const name of existing) {
    const match = new RegExp(`^${READER_PASSWORD_SECRET_PREFIX}(\\d+)$`, "i").exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${READER_PASSWORD_SECRET_PREFIX}${String(highest + 1).padStart(3, "0")}`;
}
