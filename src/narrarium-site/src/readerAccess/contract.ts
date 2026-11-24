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
/**
 * The names are the reader package's (`PAGES_WORKFLOW_FILE`, `PAGES_WORKFLOW_PATH`, `READER_PASSWORD_SECRETS_VARIABLE`, `LEGACY_READER_PASSWORD_SECRET`), written
 * out here because this file is read by code that loads with every page, which must not carry the package's workflow and Pages code with it. A test holds
 * each of them equal to the package's, so a rename there breaks the build here (`readerAccessContract.test.ts`). The helpers that do something with them (the
 * list of passwords, Pages, the workflow, the next name) are the package's and are imported where they are used, in the screens that load on demand.
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
