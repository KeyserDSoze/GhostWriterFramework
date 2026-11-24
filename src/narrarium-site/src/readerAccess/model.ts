import type { AppSettings, ReaderPasswordRecord, ReaderPasswordStatus } from "@/types/settings";
import { LEGACY_READER_SECRET, isReaderSecretName, readerSecretNumber } from "@/readerAccess/contract";

/** `owner/repo`, lower case: the key a repository's passwords are kept under. */
export function readerRepositoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

const STATUSES: readonly ReaderPasswordStatus[] = ["pending", "active", "removing"];

function validRecord(value: unknown): value is ReaderPasswordRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id !== ""
    && typeof record.label === "string"
    && typeof record.value === "string" && record.value !== ""
    && typeof record.createdAt === "string"
    && typeof record.secretName === "string" && isReaderSecretName(record.secretName)
    && STATUSES.includes(record.status as ReaderPasswordStatus);
}

/** The passwords kept for a repository. Anything that does not have the shape of a record is left out of the list (and is not touched in the settings). */
export function readerRecordsOf(settings: Pick<AppSettings, "readerAccess">, owner: string, repo: string): ReaderPasswordRecord[] {
  const list = settings.readerAccess?.[readerRepositoryKey(owner, repo)];
  return Array.isArray(list) ? list.filter(validRecord) : [];
}

/**
 * The map of every repository with one repository's list replaced. Entries of other repositories, and the entries of this one that this client does not
 * understand (a newer client's), are kept exactly as they are; an empty result removes the key.
 */
export function withReaderRecords(map: AppSettings["readerAccess"], owner: string, repo: string, records: readonly ReaderPasswordRecord[]): AppSettings["readerAccess"] {
  const key = readerRepositoryKey(owner, repo);
  const existing = map?.[key];
  const foreign = Array.isArray(existing) ? existing.filter((entry) => !validRecord(entry)) : [];
  const next = { ...(map ?? {}) };
  const list = [...records, ...foreign];
  if (list.length) next[key] = list;
  else delete next[key];
  return Object.keys(next).length ? next : undefined;
}

/** What GitHub holds, as far as it could be read. `null` for a part that could not be read (a missing permission, no network): it is not the same as empty. */
export interface RemoteReaderState {
  /** The names of every secret of the repository. */
  secrets: string[] | null;
  /** The names listed in the variable (empty when there is no variable). */
  listed: string[] | null;
}

export type ReaderRowState =
  /** Stored, secret on GitHub, listed in the variable: this password opens the book. */
  | "active"
  /** Saved here, not yet fully on GitHub (an interrupted add): it can be tried again. */
  | "pending"
  /** A removal that did not finish: it can be tried again. */
  | "removing"
  /** Stored as published, but GitHub does not have it (the secret or its place in the list is gone): it can be published again. */
  | "out-of-sync"
  /** On GitHub with no value kept here (made elsewhere, or before the passwords were kept): the value cannot be read, only removed. */
  | "unknown-value"
  /** The older single secret. */
  | "legacy"
  /** Listed in the variable but with no secret behind it: it can only be taken off the list. */
  | "dangling";

export interface ReaderPasswordRow {
  secretName: string;
  state: ReaderRowState;
  record?: ReaderPasswordRecord;
  hasSecret: boolean | null;
  listed: boolean | null;
}

function orderOf(name: string): number {
  return name === LEGACY_READER_SECRET ? Number.MAX_SAFE_INTEGER : readerSecretNumber(name) ?? Number.MAX_SAFE_INTEGER - 1;
}

/** One row for every password the repository or Narrarium knows of, in number order (the legacy secret last). */
export function reconcileReaderPasswords(records: readonly ReaderPasswordRecord[], remote: RemoteReaderState): ReaderPasswordRow[] {
  const secrets = remote.secrets ? new Set(remote.secrets) : null;
  const listed = remote.listed ? new Set(remote.listed) : null;
  const byName = new Map(records.map((record) => [record.secretName, record]));
  const names = new Set<string>([...byName.keys(), ...(remote.listed ?? []).filter(isReaderSecretName), ...(remote.secrets ?? []).filter((name) => isReaderSecretName(name) || name === LEGACY_READER_SECRET)]);
  const rows: ReaderPasswordRow[] = [];
  for (const secretName of names) {
    const record = byName.get(secretName);
    const hasSecret = secrets ? secrets.has(secretName) : null;
    const isListed = listed ? listed.has(secretName) : null;
    let state: ReaderRowState;
    if (secretName === LEGACY_READER_SECRET) state = "legacy";
    else if (record?.status === "pending") state = "pending";
    else if (record?.status === "removing") state = "removing";
    else if (record) state = hasSecret === false || isListed === false ? "out-of-sync" : "active";
    else state = hasSecret === false ? "dangling" : "unknown-value";
    rows.push({ secretName, state, ...(record ? { record } : {}), hasSecret, listed: isListed });
  }
  return rows.sort((left, right) => orderOf(left.secretName) - orderOf(right.secretName) || left.secretName.localeCompare(right.secretName));
}

/** Every name that is taken: stored (in any state), listed in the variable, or an existing secret. A new password's name is picked outside of all of them. */
export function takenReaderNames(records: readonly ReaderPasswordRecord[], remote: RemoteReaderState): string[] {
  return [...records.map((record) => record.secretName), ...(remote.listed ?? []), ...(remote.secrets ?? [])];
}

export type ReaderProtection = "protected" | "public" | "unknown";

/**
 * Whether the published reader asks for a password. It does when the variable lists a secret that exists, or the older secret exists; when GitHub could not
 * be read it is not claimed either way.
 */
export function readerProtection(remote: RemoteReaderState): ReaderProtection {
  if (!remote.secrets || !remote.listed) return "unknown";
  const secrets = new Set(remote.secrets);
  return secrets.has(LEGACY_READER_SECRET) || remote.listed.some((name) => secrets.has(name)) ? "protected" : "public";
}

/** The passwords of a repository that the account data holds, for a place that has to hide them from every text it writes (a record of a call, a log). */
export function allReaderPasswordValues(settings: Pick<AppSettings, "readerAccess">): string[] {
  const values: string[] = [];
  for (const list of Object.values(settings.readerAccess ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) if (entry && typeof entry === "object" && typeof (entry as { value?: unknown }).value === "string" && (entry as { value: string }).value) values.push((entry as { value: string }).value);
  }
  return values;
}
