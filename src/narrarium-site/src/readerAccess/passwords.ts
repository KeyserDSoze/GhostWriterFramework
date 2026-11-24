/** Passwords for the reader: the generator, what is accepted, and how strong a typed one is. No password is ever written to a log or an error message from here. */

/** No look-alikes (0/O, 1/l/I): a password is read aloud and copied by hand. 57 symbols. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const GROUP = 5;
const GROUPS = 5;

/** A random integer in [0, limit) with no bias: values that would skew the result are thrown away. */
function randomBelow(limit: number, random: (array: Uint8Array) => Uint8Array): number {
  const max = Math.floor(256 / limit) * limit;
  const buffer = new Uint8Array(1);
  for (;;) {
    random(buffer);
    if (buffer[0] < max) return buffer[0] % limit;
  }
}

/** Five groups of five symbols from a 57-symbol alphabet, joined by dashes: about 146 bits, typed or copied without trouble. */
export function generateReaderPassword(random: (array: Uint8Array) => Uint8Array = (array) => crypto.getRandomValues(array)): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let part = "";
    for (let index = 0; index < GROUP; index += 1) part += ALPHABET[randomBelow(ALPHABET.length, random)];
    groups.push(part);
  }
  return groups.join("-");
}

export const READER_PASSWORD_MIN = 8;
export const READER_PASSWORD_MAX = 256;

export type PasswordProblem = "empty" | "too-short" | "too-long" | "edge-space";

/** Whether a typed password can be used at all. Spaces inside are fine; at either end they are a mistake that would make the password fail to match. */
export function readerPasswordProblem(value: string): PasswordProblem | null {
  if (!value) return "empty";
  if (value !== value.trim()) return "edge-space";
  if (value.length < READER_PASSWORD_MIN) return "too-short";
  if (value.length > READER_PASSWORD_MAX) return "too-long";
  return null;
}

export type PasswordStrength = "weak" | "fair" | "strong";

/**
 * A rough upper bound of the guesses a password costs, in bits: its length times the size of the character classes it draws from, less a deduction for
 * repeats. The published bundle is public, so whoever downloads it can try passwords offline: what counts is how many guesses it takes, not a rule.
 */
export function readerPasswordBits(value: string): number {
  let pool = 0;
  if (/[a-z]/.test(value)) pool += 26;
  if (/[A-Z]/.test(value)) pool += 26;
  if (/\d/.test(value)) pool += 10;
  if (/[^A-Za-z0-9]/.test(value)) pool += 33;
  if (!pool) return 0;
  const distinct = new Set(value).size;
  const effectiveLength = Math.min(value.length, distinct * 2);
  return Math.round(effectiveLength * Math.log2(pool));
}

export function readerPasswordStrength(value: string): PasswordStrength {
  const bits = readerPasswordBits(value);
  return bits >= 75 ? "strong" : bits >= 55 ? "fair" : "weak";
}
