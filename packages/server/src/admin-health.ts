import { statfs } from "node:fs/promises";
import { cleanText } from "./admin-log.js";

/**
 * The health of the server, for the admin panel: one line that says whether all is well or what to look at, and under it the checks it is made of. Each check is a fact of the
 * server (the version, the free space, the connector, the runs that were turned away, the spending switch, the books that stopped, the last error) with a status, and carries
 * only ids, numbers and times: the sentences are in the page (both languages). Nothing here is a secret or a text of a book, and the last error is told by when, which request and
 * where, never by what it said (that is in the server's log, under the request id).
 */

export const HEALTH_CHECKS = ["server", "versions", "disk", "git", "tunnel", "runs", "spend", "books", "error"] as const;
export type HealthCheckId = (typeof HEALTH_CHECKS)[number];

/**
 * `ok`: nothing to do. `info`: good to know. `warn` and `bad`: something to look at (`bad` first). `off`: not used. `unknown`: it could not be found out, which is not a cause
 * for attention by itself.
 */
export type HealthStatus = "ok" | "info" | "warn" | "bad" | "off" | "unknown";

export interface HealthCheck {
  id: HealthCheckId;
  status: HealthStatus;
  facts: Record<string, unknown>;
}

export interface HealthReport {
  /** When this was seen, by the server's clock. */
  at: string;
  overall: "ok" | "attention";
  /** The checks that need a look (`warn` or `bad`), in the order of the checks. */
  attention: HealthCheckId[];
  checks: HealthCheck[];
}

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
/** Under this much free space the owner is warned; under the second, the next commit of a book may not fit. */
export const DISK_WARN_BELOW = GIB;
export const DISK_BAD_BELOW = 256 * MIB;
/** An error of the server is a cause for attention for a day, and a remark after. */
export const ERROR_ATTENTION_MS = 24 * 60 * 60_000;

/** The last error that nobody expected: when, which request (the id that finds it in the log), where, which route (without what is in it) and what kind. */
export interface LastServerError {
  at: string;
  requestId: string;
  where: "api" | "admin";
  route: string;
  name: string;
}

export interface HealthInput {
  /** Milliseconds since 1970, by the server's clock. */
  now: number;
  startedAt: number;
  maintenance?: boolean;
  serverVersion: string;
  engineVersion: string;
  /** What the release check says (`undefined`: it has not answered). */
  update?: { available?: boolean; reason?: string; latestVersion?: string; pending?: boolean };
  disk?: { free?: number; total?: number };
  /**
   * What the records of the AI calls keep, all books together (bytes of text, the files are smaller): told with the disk, because it is what they take of it. `hold`: the disk is under the floor the
   * records keep free, so none is written until it is over it again. `failed`: the records of this many books stopped in the last day, the last of them for this reason (`disk`: no room; `error`: a
   * write failed) and at this time.
   */
  aiCalls?: { bytes?: number; hold?: { freeBytes?: number; minFreeBytes?: number }; failed?: { books?: number; kind?: string; at?: string } };
  git?: { available?: boolean; githubBooks?: number };
  tunnel?: { enabled?: boolean; process?: string; binaryAvailable?: boolean; lastErrorCode?: string; hostname?: string };
  runs?: { running?: unknown; max?: unknown; refused24h?: unknown };
  spend?: { paused?: boolean; damaged?: boolean; capReached?: string };
  books?: { total?: unknown; unreadable?: unknown; error?: unknown; stalled?: unknown };
  lastError?: Partial<LastServerError>;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);
const size = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const iso = (ms: number): string | undefined => {
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
};
const word = (value: unknown, pattern: RegExp): string | undefined => (typeof value === "string" && pattern.test(value) ? value : undefined);

type Facts = Record<string, unknown>;
const check = (id: HealthCheckId, status: HealthStatus, facts: Facts = {}): HealthCheck => ({ id, status, facts });

function serverCheck(input: Facts, now: number): HealthCheck {
  const started = size(input.startedAt);
  const startedAt = started === undefined ? undefined : iso(started);
  const maintenance = input.maintenance === true;
  return check("server", maintenance ? "info" : "ok", { ...(startedAt ? { startedAt } : {}), uptimeMs: started === undefined ? 0 : Math.max(0, now - started), maintenance });
}

function versionsCheck(input: Facts): HealthCheck {
  const update = record(input.update);
  const latest = word(update.latestVersion, /^[0-9A-Za-z.+-]{1,40}$/);
  const base = { server: cleanText(input.serverVersion, 40) ?? "", engine: cleanText(input.engineVersion, 40) ?? "" };
  if (input.update === undefined) return check("versions", "ok", { ...base, update: "unknown" });
  if (update.pending === true) return check("versions", "info", { ...base, update: "pending", ...(latest ? { latest } : {}) });
  if (update.available === true) return check("versions", "info", { ...base, update: "available", ...(latest ? { latest } : {}) });
  if (update.reason === "no_trusted_release") return check("versions", "warn", { ...base, update: "refused", ...(latest ? { latest } : {}) });
  if (update.reason === "unavailable") return check("versions", "info", { ...base, update: "unreachable" });
  return check("versions", "ok", { ...base, update: "none" });
}

function diskCheck(input: Facts): HealthCheck {
  const disk = record(input.disk);
  const free = size(disk.free);
  const total = size(disk.total);
  if (free === undefined || total === undefined) return check("disk", "unknown");
  const calls = record(input.aiCalls);
  const bytes = size(calls.bytes);
  const floor = size(record(calls.hold).minFreeBytes);
  const failed = record(calls.failed);
  const failedBooks = whole(failed.books);
  const failedKind = word(failed.kind, /^(?:disk|error)$/);
  const failedAt = typeof failed.at === "string" && Number.isFinite(Date.parse(failed.at)) ? new Date(failed.at).toISOString() : undefined;
  const space = free < DISK_BAD_BELOW ? "bad" : free < DISK_WARN_BELOW ? "warn" : "ok";
  // Records that are not being kept are a cause to look, also when the free space is not (the floor they keep can be higher than the warning).
  const stopped = floor !== undefined || (failedBooks > 0 && failedKind !== undefined);
  return check("disk", space === "ok" && stopped ? "warn" : space, {
    freeBytes: free,
    totalBytes: total,
    warnBelowBytes: DISK_WARN_BELOW,
    badBelowBytes: DISK_BAD_BELOW,
    ...(bytes ? { aiCallBytes: bytes } : {}),
    ...(floor !== undefined ? { aiCallsMinFreeBytes: floor } : {}),
    ...(failedBooks > 0 && failedKind ? { aiCallsFailedBooks: failedBooks, aiCallsFailedKind: failedKind, ...(failedAt ? { aiCallsFailedAt: failedAt } : {}) } : {}),
  });
}

function gitCheck(input: Facts): HealthCheck {
  if (input.git === undefined) return check("git", "unknown");
  const git = record(input.git);
  const available = git.available === true;
  const githubBooks = whole(git.githubBooks);
  return check("git", available ? "ok" : githubBooks > 0 ? "warn" : "info", { available, githubBooks });
}

function tunnelCheck(input: Facts): HealthCheck {
  if (input.tunnel === undefined) return check("tunnel", "unknown");
  const tunnel = record(input.tunnel);
  const enabled = tunnel.enabled === true;
  const state = word(tunnel.process, /^[a-z]{1,20}$/) ?? "stopped";
  const errorCode = word(tunnel.lastErrorCode, /^[a-z_]{1,30}$/);
  const facts = { enabled, process: state, binaryAvailable: tunnel.binaryAvailable === true, ...(errorCode ? { errorCode } : {}) };
  if (!enabled) return check("tunnel", "off", facts);
  return check("tunnel", state === "running" ? "ok" : state === "failed" ? "bad" : "warn", facts);
}

function runsCheck(input: Facts): HealthCheck {
  if (input.runs === undefined) return check("runs", "unknown");
  const runs = record(input.runs);
  const running = whole(runs.running);
  const max = whole(runs.max);
  const refused24h = whole(runs.refused24h);
  return check("runs", refused24h > 0 ? "warn" : max > 0 && running >= max ? "info" : "ok", { running, max, refused24h });
}

function spendCheck(input: Facts): HealthCheck {
  if (input.spend === undefined) return check("spend", "unknown");
  const spend = record(input.spend);
  const paused = spend.paused === true;
  const damaged = spend.damaged === true;
  const capReached = spend.capReached === "tokens-per-day" || spend.capReached === "cost-per-day" ? spend.capReached : undefined;
  return check("spend", paused || damaged || capReached ? "warn" : "ok", { paused, ...(capReached ? { capReached } : {}), damaged });
}

function booksCheck(input: Facts): HealthCheck {
  if (input.books === undefined) return check("books", "unknown");
  const books = record(input.books);
  const counts = { total: whole(books.total), unreadable: whole(books.unreadable), error: whole(books.error), stalled: whole(books.stalled) };
  return check("books", counts.unreadable + counts.error + counts.stalled > 0 ? "warn" : "ok", counts);
}

function errorCheck(input: Facts, now: number): HealthCheck {
  const last = record(input.lastError);
  const at = typeof last.at === "string" && last.at.length <= 40 ? Date.parse(last.at) : Number.NaN;
  const when = Number.isFinite(at) ? iso(at) : undefined;
  if (!when) return check("error", "ok");
  const requestId = word(last.requestId, /^[a-f0-9]{4,32}$/);
  const route = cleanText(last.route, 120);
  const name = cleanText(last.name, 60);
  return check("error", now - at < ERROR_ATTENTION_MS ? "warn" : "info", {
    at: when,
    ...(requestId ? { requestId } : {}),
    ...(last.where === "api" || last.where === "admin" ? { where: last.where } : {}),
    ...(route ? { route } : {}),
    ...(name ? { name } : {}),
  });
}

/** The report from what is known of the server. Pure, and never throws: a fact that is missing is `unknown`, one that is odd is read as far as it goes. */
export function buildHealth(input: HealthInput): HealthReport {
  const facts = record(input);
  const given = size(facts.now);
  const now = given ?? Date.now();
  const checks = [
    serverCheck(facts, now),
    versionsCheck(facts),
    diskCheck(facts),
    gitCheck(facts),
    tunnelCheck(facts),
    runsCheck(facts),
    spendCheck(facts),
    booksCheck(facts),
    errorCheck(facts, now),
  ];
  const attention = checks.filter((entry) => entry.status === "warn" || entry.status === "bad").map((entry) => entry.id);
  return { at: iso(now) ?? new Date(0).toISOString(), overall: attention.length ? "attention" : "ok", attention, checks };
}

/** The free and the whole space of the file system a folder is on (`undefined` when the system does not say). */
export async function diskSpace(directory: string): Promise<{ free: number; total: number } | undefined> {
  try {
    const stats = await statfs(directory);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const total = Number(stats.blocks) * Number(stats.bsize);
    return Number.isFinite(free) && Number.isFinite(total) && total > 0 ? { free, total } : undefined;
  } catch {
    return undefined;
  }
}

/** What a request asked for, without what is in it: no query, and no book, rule, chapter, client or slug (a name only this server knows is `:id`). */
const KNOWN_SEGMENTS = new Set([
  "api", "v1", "books", "session", "ai", "mcp", "clients", "manifest", "files", "read", "commit", "sync", "autopilot", "start", "pause", "options", "rules", "frozen", "chapters", "freeze",
  "intervene", "answer", "configure", "reset", "events", "director", "ask", "updates", "pairings", "info", "admin", "identity", "login", "logout", "status", "admin-code", "rotate", "set",
  "token", "revoke", "pairing", "approve", "cancel", "network", "dismiss", "spend", "tunnel", "restart", "remove", "history", "scopes", "audit", "book", "passkeys", "link", "rename",
  "runs", "log", "health", "risks", "calls", "tasks", "text", "keep", "oauth", "register", "authorize", "challenge", "deny", "add", "assets", "page.js", "page.css", ".well-known", "oauth-authorization-server",
  "oauth-protected-resource", "openid-configuration",
]);
/** After one of these comes a name (a book, a rule, a chapter, a client). */
const NAMED_AFTER = new Set(["books", "rules", "frozen", "chapters", "clients"]);

export function routeShape(method: string | undefined, address: string | undefined): string {
  let pathname = "";
  try {
    pathname = new URL(address ?? "/", "http://127.0.0.1").pathname;
  } catch {
    pathname = "";
  }
  const segments = pathname.split("/").filter(Boolean).slice(0, 10);
  const shaped = segments.map((segment, index) => {
    const before = segments[index - 1];
    if (before !== undefined && NAMED_AFTER.has(before)) return ":id";
    return KNOWN_SEGMENTS.has(segment) ? segment : ":id";
  });
  const verb = typeof method === "string" && /^[A-Za-z]{1,10}$/.test(method) ? method.toUpperCase() : "?";
  return `${verb} /${shaped.join("/")}`;
}

/** The name of an error (`TypeError`, a custom one), and nothing else of it. */
export function errorKind(error: unknown): string {
  if (error instanceof Error) return /^[A-Za-z][A-Za-z0-9_.]{0,59}$/.test(error.name) ? error.name : "Error";
  return "NotAnError";
}
