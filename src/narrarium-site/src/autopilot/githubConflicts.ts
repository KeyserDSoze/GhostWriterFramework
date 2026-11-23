import { ServerRequestError, type AutopilotErrorDetail, type AutopilotErrorKind, type GithubConflict, type GithubConflictChoice, type GithubConflictsResponse, type ResolveGithubConflictsRequest, type ServerBookSync } from "narrarium-engine";

/**
 * The conflicts of a book on the personal server with GitHub, as the page tells them. Pure: the components draw what is here.
 *
 * The files the server and GitHub both changed are read from the server a page at a time, and the author chooses which version of each to keep (the server's or
 * GitHub's), for a file or, with a default, for all the others. Nothing is written until the author resolves; the choices are held here, not by the page that shows them.
 */

/** The conflicts are read from the server, and shown, this many at a time: a book of thousands of files can have thousands of them. */
export const CONFLICTS_PAGE = 50;
/** The most choices one request may carry: the server refuses more (a large resolution is a default and a few exceptions). */
export const MAX_CHOICES = 5_000;

export type Version = GithubConflictChoice;

const wholeFromOne = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** How many files the run stopped on, when it stopped on a conflict with GitHub (the engine says it in `errorDetail.githubConflicts`); `null` for any other failure. */
export function githubConflictsOfError(kind: AutopilotErrorKind | undefined, detail: AutopilotErrorDetail | undefined): number | null {
  if (kind !== "conflict") return null;
  const count = detail?.githubConflicts;
  return wholeFromOne(count) ? count : null;
}

/** How many files the server's last sync says conflict with GitHub (`lastSync.conflicts`, which only a sync that failed on a conflict has); `null` when it says none. */
export function githubConflictsOfSync(sync: ServerBookSync | null | undefined): number | null {
  if (!sync || sync.ok === true) return null;
  return wholeFromOne(sync.conflicts) ? sync.conflicts : null;
}

/**
 * Whether the conflicts the run stopped on (`failedAt`, the time of the error) have been settled since: the server's last sync worked after it. A resolution is a sync that
 * worked, and so is any later one (the author put the files back on GitHub, or a publish went through): git no longer has a conflict to settle. A sync that failed, or met
 * conflicts again, or is not later than the error (it is the one that failed), settles nothing; and when the server's last sync is not known (it forgets it when it restarts) neither does it.
 */
export function githubConflictsSettled(failedAt: string | null | undefined, sync: ServerBookSync | null | undefined): boolean {
  if (!sync || sync.ok !== true || wholeFromOne(sync.conflicts)) return false;
  const stopped = Date.parse(failedAt ?? "");
  const synced = Date.parse(sync.at);
  return Number.isFinite(stopped) && Number.isFinite(synced) && synced > stopped;
}

/** How many pages the list has. */
export const pageCount = (total: number): number => (total > 0 ? Math.ceil(total / CONFLICTS_PAGE) : 0);

/** Which files of the list a page shows, counted from one: the page that starts at `offset` and holds `count` of the `total` (never past the total the server says). */
export function pageRange(offset: number, count: number, total: number): { from: number; to: number } {
  if (count <= 0) return { from: 0, to: 0 };
  const from = offset + 1;
  return { from, to: Math.max(from, Math.min(offset + count, total)) };
}

/** What the author has chosen: the version of the files they chose one by one, and the version of all the others (`null`: none, every file has to be chosen). */
export interface Draft {
  readonly chosen: Readonly<Record<string, Version>>;
  readonly rest: Version | null;
}

export const emptyDraft: Draft = { chosen: {}, rest: null };

/** The version chosen for a file, by its own path (a file may be called anything, `constructor` or `__proto__` included). */
function versionOf(draft: Draft, path: string): Version | undefined {
  return Object.prototype.hasOwnProperty.call(draft.chosen, path) ? draft.chosen[path] : undefined;
}

export const choose = (draft: Draft, path: string, version: Version): Draft => ({ ...draft, chosen: { ...draft.chosen, [path]: version } });
export const chooseRest = (draft: Draft, rest: Version | null): Draft => ({ ...draft, rest });

/** What the author has seen of the list: the conflicts of the pages that were read, by path, and how many there are in all (the server's `total`). */
export interface Known {
  readonly total: number;
  readonly conflicts: ReadonlyMap<string, GithubConflict>;
}

/** A page that was read joins what was seen: a page read again replaces its files. */
export function knownOf(total: number, page: readonly GithubConflict[], previous?: Known): Known {
  const conflicts = new Map(previous?.conflicts);
  for (const conflict of page) conflicts.set(conflict.path, conflict);
  return { total, conflicts };
}

export interface Readiness {
  /** Every file has a version, or the author chose one for all the others: «Resolve» may be pressed. */
  ready: boolean;
  /** Files of the pages that were read that the author chose one by one. */
  chosen: number;
  /** Files without a version yet (those on pages not read count: the server's total says how many there are). */
  left: number;
  /** Files the version for all the others would take, when the author chose one. */
  covered: number;
}

/**
 * Whether the choices are enough. The files the server cannot choose for need none (a resolution keeps the server's version of them), and a file on a page the author did
 * not read has none, so a list of several pages is ready only when every page was read and every file chosen, or when there is a version for all the others.
 */
export function readiness(draft: Draft, known: Known): Readiness {
  let resolvable = 0;
  let chosen = 0;
  for (const conflict of known.conflicts.values()) {
    if (conflict.resolvable === false) continue;
    resolvable += 1;
    if (versionOf(draft, conflict.path)) chosen += 1;
  }
  const fixed = known.conflicts.size - resolvable;
  const left = Math.max(0, known.total - fixed - chosen);
  return { ready: draft.rest !== null || left === 0, chosen, left, covered: draft.rest !== null ? left : 0 };
}

export type ResolutionRequest = { ok: true; request: ResolveGithubConflictsRequest } | { ok: false; reason: "too-many-choices" };

/**
 * What is sent to resolve: the fingerprint of the list the author chose from (so that a choice made on a list that GitHub has changed since is refused, and never
 * applied to what the author did not see), the version of the files chosen one by one that differs from the default, and the default. Only files that were seen, and that the
 * server can choose for, are named. With more choices than the server takes, the version most files have becomes the default and the others are the exceptions.
 */
export function resolutionRequest(draft: Draft, known: Known, fingerprint: string): ResolutionRequest {
  const entries: Array<[string, Version]> = [];
  for (const conflict of known.conflicts.values()) {
    if (conflict.resolvable === false) continue;
    const version = versionOf(draft, conflict.path);
    if (version && version !== draft.rest) entries.push([conflict.path, version]);
  }
  if (entries.length <= MAX_CHOICES) {
    return { ok: true, request: { fingerprint, ...(draft.rest ? { default: draft.rest } : {}), ...(entries.length ? { choices: Object.fromEntries(entries) } : {}) } };
  }
  if (draft.rest !== null) return { ok: false, reason: "too-many-choices" };
  const servers = entries.filter(([, version]) => version === "server").length;
  const majority: Version = servers > entries.length - servers ? "server" : "github";
  const exceptions = entries.filter(([, version]) => version !== majority);
  if (exceptions.length > MAX_CHOICES) return { ok: false, reason: "too-many-choices" };
  return { ok: true, request: { fingerprint, default: majority, ...(exceptions.length ? { choices: Object.fromEntries(exceptions) } : {}) } };
}

/** Why a call to the server about the conflicts did not go through. */
export type Failure =
  | { kind: "busy" | "not-conflicted" | "no-remote" | "unrelated-histories" | "maintenance" | "feature-unavailable" | "book-missing" | "forbidden" | "unreachable" }
  /** Not a refusal of the server: more files were chosen one by one than a request may carry, even with the version most of them have as the default. */
  | { kind: "too-many" }
  /** The conflicts are not the ones the author chose from: GitHub moved again. The first page of the list as it is now (`null` if the server did not give it). */
  | { kind: "changed"; listing: GithubConflictsResponse | null }
  /** Files without a version: the first of them, and how many in all. */
  | { kind: "choice-missing"; paths: string[]; missing: number }
  /** GitHub holds a file whose name no working copy can hold; the server's sentence names it. */
  | { kind: "invalid-path"; detail: string }
  /** The server could not run git (GitHub cannot be reached): what it said. */
  | { kind: "git-failed"; detail: string }
  /** Anything else: what the error says; `server` when they are the server's words (English, whatever the language of the app). */
  | { kind: "other"; message: string; server?: true };

const isListing = (value: Record<string, unknown>): value is Record<string, unknown> & GithubConflictsResponse =>
  Array.isArray(value.conflicts) && typeof value.total === "number" && Number.isInteger(value.total) && typeof value.fingerprint === "string";

/** What a refusal of the server means for the author: the answer of the server is a `ServerRequestError` whose `code` says why, and whose `details` carry what else it said. */
export function failureOf(error: unknown): Failure {
  if (error instanceof ServerRequestError) {
    const { details } = error;
    switch (error.code) {
      case "busy": return { kind: "busy" };
      case "not_conflicted": return { kind: "not-conflicted" };
      case "no_remote": return { kind: "no-remote" };
      case "unrelated_histories": return { kind: "unrelated-histories" };
      case "maintenance": return { kind: "maintenance" };
      case "feature_unavailable": return { kind: "feature-unavailable" };
      case "book_not_found": return { kind: "book-missing" };
      case "scope":
      case "unauthorized": return { kind: "forbidden" };
      case "unreachable": return { kind: "unreachable" };
      case "conflicts_changed": return { kind: "changed", listing: isListing(details) ? details : null };
      case "choice_missing": {
        const paths = Array.isArray(details.paths) ? details.paths.filter((path): path is string => typeof path === "string") : [];
        const missing = typeof details.missing === "number" && Number.isInteger(details.missing) && details.missing >= 0 ? details.missing : paths.length;
        return { kind: "choice-missing", paths, missing };
      }
      case "invalid_github_path": return { kind: "invalid-path", detail: error.message };
      case "git_failed": return { kind: "git-failed", detail: error.message };
    }
  }
  if (error instanceof ServerRequestError) return { kind: "other", message: error.message, server: true };
  return { kind: "other", message: error instanceof Error ? error.message : typeof error === "string" ? error : "" };
}
