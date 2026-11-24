/**
 * THE contract with the reader's publishing workflow (the package `narrarium-astro-reader` and `create-narrarium-book` own the other side). Every name the
 * site and the workflow have to agree on is here and nowhere else, so that adjusting one is a one-file change.
 *
 *  - the workflow that runs in a book's repository, and the way it is started (`workflow_dispatch` on that file);
 *  - the repository variable that lists the secrets that hold a password, as a comma-separated list of secret names;
 *  - the secret names: `READER_PASSWORD_001`, `READER_PASSWORD_002`, … (zero-padded). A new password gets one past the highest number any place holds, so a
 *    name that was in use is never given again;
 *  - the older single secret `NARRARIUM_READER_PASSWORD`, which still counts as one password (it can be seen to exist, never read).
 */
import {
  LEGACY_READER_PASSWORD_SECRET,
  PAGES_WORKFLOW_FILE,
  PAGES_WORKFLOW_PATH,
  READER_PASSWORD_SECRETS_VARIABLE,
  nextReaderPasswordSecretName,
} from "narrarium-astro-reader/github-pages";

export const READER_WORKFLOW_PATH = PAGES_WORKFLOW_PATH;
export const READER_WORKFLOW_FILE = PAGES_WORKFLOW_FILE;
export const READER_PASSWORDS_VARIABLE = READER_PASSWORD_SECRETS_VARIABLE;
export const READER_SECRET_PREFIX = "READER_PASSWORD_";
export const READER_SECRET_DIGITS = 3;
export const LEGACY_READER_SECRET = LEGACY_READER_PASSWORD_SECRET;

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

/**
 * The name for a new password, from the reader package (`nextReaderPasswordSecretName`): one past the highest number that any place holds — the variable,
 * the secrets that exist in the repository, and the passwords Narrarium keeps — so a name that was in use is never given again.
 */
export function allocateReaderSecretName(taken: Iterable<string>): string {
  return nextReaderPasswordSecretName([...taken]);
}
