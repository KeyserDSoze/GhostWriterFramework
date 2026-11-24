import { normalizeReaderPassword } from "./reader-protocol.js";
import { parseReaderPasswordSecretNames } from "./reader-secret-names.js";

/**
 * Which passwords protect this build, read from the environment of the build step:
 *  - `READER_PASSWORD_SECRETS`: the names of the repository secrets that hold the passwords (a repository variable in the Pages workflow:
 *    `READER_PASSWORD_SECRETS: ${{ vars.READER_PASSWORD_SECRETS }}`), for example `READER_PASSWORD_001,READER_PASSWORD_002`;
 *  - `NARRARIUM_READER_SECRETS`: the JSON of the repository's secrets (`${{ toJSON(secrets) }}`, given to the build step only). Only the
 *    names listed above are read from it; every other secret, `GITHUB_TOKEN` included, is never looked at;
 *  - `NARRARIUM_READER_PASSWORD`: the single password of the books published before the list existed, still one slot.
 * No name and no single password: the book is public and nothing is encrypted.
 *
 * Nothing here ever puts a value in a message: errors and summaries name the secrets, never what they hold.
 */

export const READER_PASSWORD_LIST_ENV = "READER_PASSWORD_SECRETS";
export const READER_SECRETS_JSON_ENV = "NARRARIUM_READER_SECRETS";
export const READER_LEGACY_PASSWORD_ENV = "NARRARIUM_READER_PASSWORD";

export interface ReaderPassword {
  /** The secret it came from (or `NARRARIUM_READER_PASSWORD`): what the build log may say. */
  name: string;
  password: string;
}

export interface PickedReaderPasswords {
  passwords: ReaderPassword[];
  /** The names the list asked for. */
  listed: string[];
  /** Listed names that the secrets do not have, or have empty. */
  missing: string[];
  /** True when `NARRARIUM_READER_PASSWORD` gave a slot. */
  legacy: boolean;
}

export class ReaderPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaderPasswordError";
  }
}

type Env = Record<string, string | undefined>;

function readSecretsJson(raw: string | undefined): Map<string, unknown> | null {
  if (raw === undefined || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // V8 quotes the start of the text in a JSON error: the text is the secrets, so the message must not carry it.
    throw new ReaderPasswordError(`${READER_SECRETS_JSON_ENV} is not valid JSON; the workflow must pass \${{ toJSON(secrets) }}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReaderPasswordError(`${READER_SECRETS_JSON_ENV} is not a JSON object of secrets; the workflow must pass \${{ toJSON(secrets) }}.`);
  }
  const secrets = new Map<string, unknown>();
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) secrets.set(name.toUpperCase(), value);
  return secrets;
}

/** The passwords of this build; throws `ReaderPasswordError` (names only) when the list asks for passwords the build cannot have. */
export function pickReaderPasswords(env: Env = process.env): PickedReaderPasswords {
  const list = parseReaderPasswordSecretNames(env[READER_PASSWORD_LIST_ENV]);
  if (list.invalid.length > 0) {
    throw new ReaderPasswordError(
      `${READER_PASSWORD_LIST_ENV} has ${list.invalid.length === 1 ? "an entry that is" : `${list.invalid.length} entries that are`} not a secret name (entry ${list.invalid.map((entry) => entry.position).join(", ")}): use letters, digits and underscores, not starting with a digit or GITHUB_.`,
    );
  }

  const passwords: ReaderPassword[] = [];
  const missing: string[] = [];
  if (list.names.length > 0) {
    const secrets = readSecretsJson(env[READER_SECRETS_JSON_ENV]);
    if (!secrets) {
      throw new ReaderPasswordError(
        `${READER_PASSWORD_LIST_ENV} lists ${list.names.length} password secret${list.names.length === 1 ? "" : "s"} (${list.names.join(", ")}) but the build received no secrets: the Pages workflow must pass ${READER_SECRETS_JSON_ENV}: \${{ toJSON(secrets) }} to this step. The book was not built, so that it is not published without its passwords.`,
      );
    }
    for (const name of list.names) {
      const value = secrets.get(name.toUpperCase());
      const password = typeof value === "string" ? normalizeReaderPassword(value) : "";
      if (password) passwords.push({ name, password });
      else missing.push(name);
    }
  }

  const legacyPassword = normalizeReaderPassword(env[READER_LEGACY_PASSWORD_ENV] ?? "");
  if (legacyPassword) passwords.push({ name: READER_LEGACY_PASSWORD_ENV, password: legacyPassword });

  if (list.names.length > 0 && passwords.length === 0) {
    throw new ReaderPasswordError(
      `None of the password secrets listed in ${READER_PASSWORD_LIST_ENV} exists or has a value (${missing.join(", ")}). The book was not built, so that it is not published without its passwords.`,
    );
  }

  return { passwords, listed: list.names, missing, legacy: Boolean(legacyPassword) };
}

/** One line for the build log: how many passwords, and the names of their secrets. */
export function describeReaderPasswords(picked: PickedReaderPasswords): string {
  if (picked.passwords.length === 0) return "[narrarium-reader] No reader password: the book is published without encryption.";
  const names = picked.passwords.map((entry) => entry.name).join(", ");
  const missing = picked.missing.length > 0 ? ` Listed but missing or empty, so left out: ${picked.missing.join(", ")}.` : "";
  return `[narrarium-reader] Protected with ${picked.passwords.length} password${picked.passwords.length === 1 ? "" : "s"} (${names}).${missing}`;
}
