/**
 * THE contract with the reader's publishing workflow (the package `narrarium-astro-reader` and `create-narrarium-book` own the other side). Every name the
 * site and the workflow have to agree on is here and nowhere else, so that adjusting one is a one-file change.
 *
 *  - the workflow that runs in a book's repository, and the way it is started (`workflow_dispatch` on that file);
 *  - the repository variable that lists the secrets that hold a password, as a comma-separated list of secret names;
 *  - the secret names: `READER_PASSWORD_001`, `READER_PASSWORD_002`, … (zero-padded). A name that is in the list is never reused; a number that was
 *    removed may be reused only once its secret is deleted;
 *  - the older single secret `NARRARIUM_READER_PASSWORD`, which still counts as one password (it can be seen to exist, never read).
 */
export const READER_WORKFLOW_PATH = ".github/workflows/deploy-reader-pages.yml";
export const READER_WORKFLOW_FILE = "deploy-reader-pages.yml";
export const READER_PASSWORDS_VARIABLE = "READER_PASSWORD_SECRETS";
export const READER_SECRET_PREFIX = "READER_PASSWORD_";
export const READER_SECRET_DIGITS = 3;
export const LEGACY_READER_SECRET = "NARRARIUM_READER_PASSWORD";

const NAME_PATTERN = new RegExp(`^${READER_SECRET_PREFIX}(\\d{${READER_SECRET_DIGITS},})$`);

export function readerSecretName(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("A reader secret number is a positive integer.");
  return `${READER_SECRET_PREFIX}${String(number).padStart(READER_SECRET_DIGITS, "0")}`;
}

/** The number in a reader secret name, or `null` for anything else (the legacy secret included). */
export function readerSecretNumber(name: string): number | null {
  const match = NAME_PATTERN.exec(name);
  return match ? Number(match[1]) : null;
}

export function isReaderSecretName(name: string): boolean {
  return readerSecretNumber(name) !== null;
}

/** The names in the variable's value: split on commas, trimmed, empty entries and repeats dropped, order kept. */
export function parseReaderVariable(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** The value of the variable for these names: the reader secrets in number order, no repeats. An empty list has no value (the variable is deleted). */
export function formatReaderVariable(names: Iterable<string>): string {
  const unique = [...new Set(names)];
  return unique.sort((left, right) => (readerSecretNumber(left) ?? Number.MAX_SAFE_INTEGER) - (readerSecretNumber(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)).join(",");
}

/**
 * The name for a new password: the smallest number that is in none of the places a name can be held in — the variable, the secrets that exist in the
 * repository, and the passwords Narrarium keeps (whatever their state). A name still listed is never reused; a number whose secret is gone and that nothing
 * lists is free again.
 */
export function allocateReaderSecretName(taken: Iterable<string>): string {
  const used = new Set<number>();
  for (const name of taken) {
    const number = readerSecretNumber(name);
    if (number !== null) used.add(number);
  }
  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return readerSecretName(candidate);
}
