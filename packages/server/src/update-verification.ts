import path from "node:path";
import { isExactSemver } from "./npm-release.js";

/**
 * What an update verified, written down by the supervisor that did it (`private/update-verification.json`, next to the `update-result.json` it always wrote and whose format is
 * not changed): which checks were made, in the order they were made, and how each went. The admin panel's history shows it. It never holds what npm printed, a path, or what a
 * registry said: only the name of a check, its outcome, the server's own words for a refusal of a signature or a provenance, and the code npm gave for a refused audit.
 */

export const UPDATE_VERIFICATION_FILE = path.join("private", "update-verification.json");

/** The checks of an install, in the order of the install: the version is not older than the highest one, the registry's metadata, who signed (the provenance), the registry's own signature, npm's install, the integrity of what npm installed, `npm audit signatures`, and the installed files. */
export const UPDATE_CHECKS = ["rollback", "metadata", "provenance", "registry-signature", "install", "integrity", "audit-signatures", "package"] as const;
export type UpdateCheckName = (typeof UPDATE_CHECKS)[number];

/**
 * `passed`; `tolerated` (npm's audit could not finish and the server's own checks passed: see `failedOnlyForMissingAttestationKeys`); `refused` (the check looked and said no);
 * `unreadable` (what it checks against could not be read: nothing was proved); `failed` (something went wrong that is not a verdict: npm could not install).
 */
export const UPDATE_CHECK_RESULTS = ["passed", "tolerated", "refused", "unreadable", "failed"] as const;
export type UpdateCheckResult = (typeof UPDATE_CHECK_RESULTS)[number];

export interface UpdateCheckRecord {
  check: UpdateCheckName;
  result: UpdateCheckResult;
  /** The server's own words for a refused signature or provenance, a version that is too old, or a registry that could not be read (printable ASCII, at most 300 characters). */
  reason?: string;
  /** The code npm gave (`EMISSINGSIGNATUREKEY`) for an audit it refused or could not finish. */
  code?: string;
}

export interface UpdateVerification {
  schemaVersion: 1;
  /** The update request it is about. */
  requestId: string;
  version: string;
  fromVersion: string;
  at: string;
  checks: UpdateCheckRecord[];
}

export const MAX_UPDATE_CHECKS = 24;
export const MAX_REASON_CHARACTERS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

const isPlain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const isTime = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
};

/** A text the server composes, kept as it may be shown: printable ASCII, cut. */
export function reasonText(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, MAX_REASON_CHARACTERS);
}

function parseCheck(value: unknown): UpdateCheckRecord {
  if (!isPlain(value) || !onlyKeys(value, ["check", "result", "reason", "code"])) throw new Error("Not a valid update verification.");
  const { check, result, reason, code } = value;
  if (!(UPDATE_CHECKS as readonly unknown[]).includes(check) || !(UPDATE_CHECK_RESULTS as readonly unknown[]).includes(result)) throw new Error("Not a valid update verification.");
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_CHARACTERS || !/^[\x20-\x7e]*$/.test(reason))) throw new Error("Not a valid update verification.");
  if (code !== undefined && (typeof code !== "string" || !CODE.test(code))) throw new Error("Not a valid update verification.");
  return { check: check as UpdateCheckName, result: result as UpdateCheckResult, ...(reason ? { reason } : {}), ...(code ? { code } : {}) };
}

/** What the supervisor wrote, read strictly: anything else is no verification at all (it throws). */
export function parseUpdateVerification(value: unknown): UpdateVerification {
  if (!isPlain(value) || !onlyKeys(value, ["schemaVersion", "requestId", "version", "fromVersion", "at", "checks"]) || Object.keys(value).length !== 6) throw new Error("Not a valid update verification.");
  if (value.schemaVersion !== 1 || typeof value.requestId !== "string" || !UUID.test(value.requestId) || !isExactSemver(value.version) || !isExactSemver(value.fromVersion) || !isTime(value.at)) throw new Error("Not a valid update verification.");
  if (!Array.isArray(value.checks) || value.checks.length > MAX_UPDATE_CHECKS) throw new Error("Not a valid update verification.");
  return { schemaVersion: 1, requestId: value.requestId, version: value.version, fromVersion: value.fromVersion, at: value.at, checks: value.checks.map(parseCheck) };
}

const RANK: Record<UpdateCheckResult, number> = { passed: 1, tolerated: 2, refused: 3, unreadable: 3, failed: 3 };

/** One record for each check that was made, in the order of the install, with the worst of its results (a check that is made twice, before the download and again on what was installed). */
export function reduceChecks(checks: readonly UpdateCheckRecord[]): UpdateCheckRecord[] {
  const worst = new Map<UpdateCheckName, UpdateCheckRecord>();
  for (const record of checks) {
    const known = worst.get(record.check);
    if (!known || RANK[record.result] > RANK[known.result]) worst.set(record.check, record);
  }
  return UPDATE_CHECKS.filter((check) => worst.has(check)).map((check) => worst.get(check) as UpdateCheckRecord);
}

/** The first check that did not pass (what stopped the update), in the order the checks were made. `tolerated` is a pass. */
export function firstRefusal(checks: readonly UpdateCheckRecord[]): UpdateCheckRecord | undefined {
  return checks.find((record) => record.result === "refused" || record.result === "unreadable" || record.result === "failed");
}
