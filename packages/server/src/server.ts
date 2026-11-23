import http, { Agent, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  AUTOPILOT_PUBLISH_MODES,
  AiProviderError,
  AiUnavailableError,
  AutopilotBusyError,
  AutopilotRuleError,
  AutopilotStateCorruptError,
  DEFAULT_ADMIN_PORT,
  ENGINE_VERSION,
  FrontmatterError,
  LIVE_AUTOPILOT_OPTIONS,
  PAUSE_AUTOPILOT_MODES,
  SERVER_API_VERSION,
  SERVER_FEATURE_AUTOPILOT_CONTROLS,
  SERVER_FEATURE_AUTOPILOT_RETRY,
  SERVER_FEATURE_AUTOPILOT_RULES,
  SERVER_FEATURE_GITHUB_CONFLICTS,
  SERVER_PACKAGE_NAME,
  encodeServerSentEvent,
  isBookConflictError,
  longRetryProblem,
  normalizeRuleText,
  pickAiRuntimeConfig,
  redactAiRuntimeConfig,
  type AiPort,
  type AutopilotEvent,
  type AutopilotLiveOptions,
  type AutopilotLongRetry,
  type AutopilotRunLimits,
  type BookFileContent,
  type EvaluationTarget,
  type PauseAutopilotMode,
  type ServerAiStatus,
  type ServerInfo,
  type ServerScope,
  type ServerStreamMessage,
  type ServerUpdateInfo,
  type ServerUpdateResult,
} from "narrarium-engine";
import { clientAction, approvedBases, mcpChanges, networkChanges, refusalIsLogged, spendChanges } from "./admin-actions.js";
import { ERROR_ATTENTION_MS, buildHealth, diskSpace, errorKind, routeShape, type HealthReport, type LastServerError } from "./admin-health.js";
import { ADMIN_ACTION_TYPES, AdminLog, type AdminActionType, type AdminActor, type AdminLogInput } from "./admin-log.js";
import type { AdminPanelOptions } from "./admin-options.js";
import { buildRisks } from "./admin-risks.js";
import { DEFAULT_STALLED_AFTER_MS, MAX_RUNS_PER_PAGE, RunBoard, runsPage } from "./admin-runs.js";
import { AiNotApprovedError, approvalCovers, baseIsApproved, normalizeAiBase, unapprovedAiBases } from "./ai-approval.js";
import { Auth, assertScope, isScope, parseScopes, type ClientRecord } from "./auth.js";
import { BookRegistry, type AutopilotTuning, type BookRuntime } from "./books.js";
import { DEFAULT_ORIGINS, DataDirectory, normalizeOrigin, publicLabel } from "./config.js";
import { HttpError, retryAfter } from "./errors.js";
import { MAX_COMMIT_CHANGES } from "./fs-store.js";
import { lockDataRoot, unsafeKeys } from "./files.js";
import { bridgeToApi } from "./gateway.js";
import { gitVersion } from "./git.js";
import { asConflictPage, asResolveRequest } from "./github-conflicts.js";
import { ConcurrencyLimiter, WindowLimiter, sourceOf, type LimitVerdict } from "./limits.js";
import { authenticateMcp, challenge, clientTokenAuthenticator, type McpAuthenticator, type McpPrincipal } from "./mcp-access.js";
import { McpAudit } from "./mcp-audit.js";
import { McpBooks, assertSlug, type McpBookState } from "./mcp-books.js";
import { McpEndpoint, describeMcp, mcpAddress, type McpLimits } from "./mcp.js";
import { OAuthServer, assertPasskeyLabel, isOAuthPath } from "./oauth.js";
import { OAuthStore } from "./oauth-store.js";
import { checkNpmServerRelease, isExactSemver, type NpmReleaseCheck } from "./npm-release.js";
import { RuntimeInstaller, SUPERVISED_ENV, type UpdateResult } from "./runtime-install.js";
import { UPDATE_HISTORY_MAX, UpdateHistory } from "./update-history.js";
import { SpendLedger, SpendLimitError, applySpendChanges, pausedError, spendSettingsOf, type ServerSpendStatus } from "./spend.js";
import { CloudflareTunnelManager, type CloudflareTunnelManagerOptions } from "./tunnel.js";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "./ui.js";
import { SERVER_VERSION } from "./version.js";
import { FROZEN_ACTIONS, FROZEN_EDITS_MODES, FrozenChapterError, SERVER_FEATURE_AUTOPILOT_FROZEN, type FrozenAction, type FrozenChangeKind, type FrozenEditsMode } from "narrarium-engine";

/** Tuning of the server's own limits (the defaults are the ones to run with; tests shorten them). */
export interface ServerLimits {
  /** Silence in the middle of a request body, in milliseconds, after which the request is answered with 408 (default 20 000). */
  bodyIdleMs?: number;
  /** The MCP endpoint of the books: calls of tools per client per minute, of those the ones that change a book or run its autopilot, how long a call may take, tools per page of `tools/list`. */
  mcpCallsPerMinute?: McpLimits["callsPerMinute"];
  mcpWritesPerMinute?: McpLimits["writesPerMinute"];
  mcpCallMs?: McpLimits["callMs"];
  mcpToolsPerPage?: McpLimits["toolsPerPage"];
  /** The largest answer of a tool, in bytes (default 512 KiB). */
  mcpResultBytes?: McpLimits["resultBytes"];
  /** The OAuth server of the books' MCP endpoints: apps one source may register an hour (default 20), requests to its addresses one source may make a minute (default 120), apps kept at most (default 500). */
  oauthRegistrationsPerHour?: number;
  oauthRequestsPerMinute?: number;
  oauthMaxClients?: number;
}

export interface NarrariumServerOptions {
  dataDir: string;
  /** API port (default from config.json, 24242; 0 picks a free port). */
  port?: number;
  /** Admin panel port (default from config.json, 24243; 0 picks a free port). */
  adminPort?: number;
  label?: string;
  /** Extra browser origins allowed to call the API (saved in config.json). */
  origins?: string[];
  /** Inject an AI port (tests and demos). */
  ai?: AiPort;
  /** Override the GitHub clone URL (tests). */
  githubRemoteUrl?: (owner: string, repo: string) => string;
  /** Running under the npx supervisor (default: the NARRARIUM_SUPERVISED environment variable). */
  supervised?: boolean;
  /** npm release check (tests inject a fake registry). */
  checkRelease?: (installedVersion: string) => Promise<NpmReleaseCheck>;
  /** Cloudflare connector overrides (tests). */
  tunnel?: Omit<CloudflareTunnelManagerOptions, "root">;
  /** Limits of the listeners (tests). */
  limits?: ServerLimits;
  /** The clock that decides the UTC day of the spending record (tests move it). */
  now?: () => Date;
  /** How the autopilot sessions wait and beat (tests shorten it). */
  autopilot?: AutopilotTuning;
  /** What the admin panel's own views may be told by a test (how long a run is silent before it looks stalled, the free space of the disk…). */
  admin?: AdminPanelOptions;
  /** Take the lock of the data folder (tests; default: `lockDataRoot`). Its second argument is what to call when the lock is lost. */
  lock?: typeof lockDataRoot;
  /** Called once a server that lost its data folder lock has stopped (the process should exit: another server may have the folder now). */
  onLockLost?: () => void;
  log?: (line: string) => void;
}

export interface RunningNarrariumServer {
  url: string;
  port: number;
  adminUrl: string;
  adminPort: number;
  data: DataDirectory;
  books: BookRegistry;
  auth: Auth;
  tunnel: CloudflareTunnelManager;
  /** What the server spent on AI (the owner's caps are checked against it), for tests and diagnostics. */
  spend: SpendLedger;
  /** The switches and slugs of the books' MCP endpoints, and the audit of what was called through them (the admin panel shows it), for tests and diagnostics. */
  mcp: { books: McpBooks; audit: McpAudit };
  /** The OAuth server that lets apps (ChatGPT, Claude.ai…) connect to a book's MCP endpoint by themselves, for tests and diagnostics. */
  oauth: OAuthServer;
  /** The two listeners, for tests and diagnostics. */
  servers: { api: http.Server; admin: http.Server };
  /** AI origins the outbound network guard may reach. */
  allowedBases(): string[];
  close(): Promise<void>;
}

const SMALL_BODY = 2 * 1024 * 1024;
const LARGE_BODY = 64 * 1024 * 1024;
const MAX_STREAMS = 50;
/** Live streams one client holds at most: the tabs and devices of one author (they share a token), not a way to take every slot. */
const MAX_STREAMS_PER_CLIENT = 10;
/** Bodies of the large kind (64 MiB) read at the same time: each one is buffered several times over. */
const MAX_LARGE_BODIES = 2;
/** Requests one source may have in flight before it has shown a valid token. */
const ANONYMOUS_IN_FLIGHT = 16;
/** A request body that goes quiet for this long is dropped. */
const BODY_IDLE_MS = 20_000;
/** Time a client has to send a whole request (uploads of big books are legitimate; streams and long answers are not limited by it). */
const REQUEST_TIMEOUT_MS = 300_000;
const MINUTE_MS = 60_000;
const INFO_PER_MINUTE = 120;
const PAIRING_RESULTS_PER_MINUTE = 120;
/** Identity challenges of the local command line, per source: one per command, so this is generous. */
const ADMIN_IDENTITY_PER_MINUTE = 60;
const FAILED_AUTHENTICATIONS_PER_MINUTE = 60;
/** Per client, and generous: the web app reads a book with one request per file. */
const AUTHENTICATED_PER_MINUTE = 6000;
const RELEASE_CACHE_MS = 10 * MINUTE_MS;
/** An npm that could not be reached is asked again sooner. */
const RELEASE_UNREACHABLE_CACHE_MS = MINUTE_MS;
/** The health report waits this long for the release check (the first one after a start asks the registry); a slow npm is told as "no answer yet". */
const HEALTH_RELEASE_WAIT_MS = 4000;

function readJsonBody(request: IncomingMessage, limit: number, idleMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = String(request.headers["content-type"] ?? "");
    if (type && !/^application\/json\b/i.test(type)) {
      reject(new HttpError(415, "unsupported_media_type", "Send JSON."));
      return;
    }
    const encoding = request.headers["content-encoding"];
    if (encoding && encoding !== "identity") {
      reject(new HttpError(415, "unsupported_encoding", "Compressed requests are not accepted."));
      return;
    }
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      reject(new HttpError(413, "payload_too_large", "The request is too large."));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let quiet: NodeJS.Timeout | undefined;
    // Whatever ends the read, the listeners go: a body that is no longer wanted just flows past and is dropped.
    const stop = (finish: () => void) => {
      clearTimeout(quiet);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onAbort);
      request.off("close", onAbort);
      finish();
    };
    const waitForData = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => stop(() => reject(new HttpError(408, "request_timeout", "The request body stopped arriving."))), idleMs);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stop(() => reject(new HttpError(413, "payload_too_large", "The request is too large.")));
        return;
      }
      chunks.push(chunk);
      waitForData();
    };
    const onEnd = () => stop(() => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (unsafeKeys(parsed)) throw new Error("unsafe");
        resolve(parsed ?? {});
      } catch {
        reject(new HttpError(400, "invalid_json", "The request body is not valid JSON."));
      }
    });
    const onAbort = () => stop(() => reject(new HttpError(400, "request_aborted", "The request was interrupted before its body arrived.")));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onAbort);
    request.once("close", onAbort);
    waitForData();
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers });
  response.end(body);
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
  /** Headers of the answer (for example `Retry-After`). */
  headers?: Readonly<Record<string, string>>;
  /** What the answer says besides its code and its message (`HttpError.data`). */
  data?: Readonly<Record<string, unknown>>;
  /** Set for the errors that are not understood: the short id that links the answer to the log line. */
  requestId?: string;
  /** What the log says about an error that is not understood; never sent to the client. */
  detail?: string;
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    const frame = (error.stack ?? "").split("\n").find((line) => /^\s+at /.test(line))?.trim();
    return `${error.name}: ${error.message.slice(0, 500)}${frame ? ` (${frame})` : ""}`;
  }
  let text: string;
  try {
    text = typeof error === "object" && error !== null ? JSON.stringify(error) : String(error);
  } catch {
    text = String(error);
  }
  return `Not an Error: ${text.slice(0, 500)}`;
}

/** A rule that cannot be saved is the author's to fix (400), unless it is not there (404) or changed under them (409). */
const RULE_ERROR_STATUS: Record<string, number> = { rule_empty: 400, rule_too_long: 400, rule_duplicate: 400, rule_not_found: 404, rule_changed: 409 };
/** A decision about a frozen chapter that cannot be taken: the chapter is not there (404), nothing waits for a decision (409), the action does not fit (400). */
const FROZEN_ERROR_STATUS: Record<string, number> = { chapter_not_found: 404, not_changed: 409, invalid_action: 400 };

/**
 * What a failure is answered with. Only errors this server knows keep their meaning: its own HttpError, the engine's
 * errors and a few explicit cases. A `status` or `code` that some other library put on its error says nothing about this
 * request (an AI provider's 401 must not read as "your server token is invalid"), so the rest is an internal error:
 * the client gets a generic message and a short id, and the id is what the log line carries together with the real error.
 */
export function errorStatus(error: unknown): MappedError {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message, headers: error.headers, ...(error.data ? { data: error.data } : {}) };
  if (error instanceof AiUnavailableError) return { status: 412, code: "ai_not_configured", message: error.message };
  // What the owner decided (a cap, the switch, an endpoint not approved) is a refusal to say as it is, not a failure of the AI provider.
  if (error instanceof SpendLimitError) return { status: 429, code: "spend_limit", message: error.message };
  if (error instanceof AiNotApprovedError) return { status: 412, code: "ai_not_approved", message: error.message };
  if (error instanceof AutopilotRuleError) return { status: RULE_ERROR_STATUS[error.code] ?? 400, code: error.code, message: error.message };
  if (error instanceof FrozenChapterError) return { status: FROZEN_ERROR_STATUS[error.code] ?? 400, code: error.code, message: error.message };
  if (error instanceof FrontmatterError) return { status: 422, code: "frontmatter_invalid", message: error.message };
  if (error instanceof AutopilotBusyError) return { status: 409, code: "busy", message: error.message };
  if (isBookConflictError(error)) return { status: 409, code: "conflict", message: (error as Error).message };
  if (error instanceof AutopilotStateCorruptError) return { status: 409, code: "state_corrupt", message: error.message };
  if (error instanceof AiProviderError) return { status: 502, code: "ai_provider", message: error.message };
  if (error instanceof Error && error.message.startsWith("Unsafe book path")) return { status: 400, code: "invalid_path", message: error.message };
  return { status: 500, code: "internal", message: "The server could not complete the request.", requestId: randomBytes(4).toString("hex"), detail: describeUnknown(error) };
}

/** Whether an answer is a failure worth a log line: a 5xx that is not a 503 (busy, maintenance: refusals on purpose). */
function isFailure(mapped: MappedError): boolean {
  return mapped.status >= 500 && mapped.status !== 503;
}

function sendError(response: ServerResponse, mapped: MappedError): void {
  sendJson(
    response,
    mapped.status,
    { ...mapped.data, code: mapped.code, message: mapped.message, ...(mapped.requestId ? { requestId: mapped.requestId } : {}) },
    { ...mapped.headers, ...(mapped.requestId ? { "x-request-id": mapped.requestId } : {}) },
  );
}

/** A limiter's refusal as the error that answers it. */
function refuseOver(verdict: LimitVerdict): void {
  if (!verdict.allowed) throw new HttpError(429, "rate_limit", "Too many requests: wait a moment and try again.", retryAfter(verdict.retryAfterMs));
}

function lockLostError(): HttpError {
  return new HttpError(503, "lock_lost", "This server lost the lock of its data folder and is stopping: another server may be using the folder now.");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request", "Expected a JSON object.");
  return value as Record<string, unknown>;
}

/** What a promise says, or `undefined` when it has not said it within `ms`: a slow registry must not hold up a report that is mostly about this computer. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A whole number (from 1, or from `from`) in the address of a request (`?limit=20`): the fallback when it is not there, a refusal when it is not one. */
function wholeNumber(query: URLSearchParams, name: string, fallback: number | undefined, from = 1): number | undefined {
  const text = query.get(name);
  if (text === null) return fallback;
  if (!/^\d{1,12}$/.test(text) || Number(text) < from) throw new HttpError(400, "invalid_request", `\`${name}\` must be a whole number from ${from}.`);
  return Number(text);
}

/** What a start may carry to bound its run: an object (`{ steps?, chapters? }`) or nothing. The engine reads the numbers: only a whole number above zero is a limit. */
function asLimits(value: unknown): AutopilotRunLimits | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request", "`limits` must be an object such as { \"steps\": 3, \"chapters\": 1 }.");
  return value as AutopilotRunLimits;
}

/** How a pause is asked for: one of the engine's `PAUSE_AUTOPILOT_MODES`; no `mode` at all is `after-step`, as it always was. */
function asPauseMode(value: unknown): PauseAutopilotMode {
  if (value === undefined) return "after-step";
  if (typeof value === "string" && (PAUSE_AUTOPILOT_MODES as readonly string[]).includes(value)) return value as PauseAutopilotMode;
  throw new HttpError(400, "invalid_request", `The pause \`mode\` must be one of: ${PAUSE_AUTOPILOT_MODES.join(", ")}.`);
}

/**
 * The settings that can change while a run goes on (the engine's `LIVE_AUTOPILOT_OPTIONS`) and what each may be. At least one, and nothing else:
 * a request that asks for more than that is refused whole, so that nothing of it is applied by surprise.
 */
function asLiveOptions(body: Record<string, unknown>): AutopilotLiveOptions {
  const refuse = (problem: string): never => {
    throw new HttpError(400, "invalid_request", `${problem} Only these can change here: publishEvery (${[...AUTOPILOT_PUBLISH_MODES, "null"].join(", ")}), pauseAfterEachChapter (true or false), frozenEdits (${FROZEN_EDITS_MODES.join(", ")}) and longRetry ({ "everyMinutes": 1 to 10080, "cycles": 1 to 1000 or "unlimited" }, or null to turn it off).`);
  };
  const keys = Object.keys(body);
  if (!keys.length) refuse("There is nothing to change.");
  // What the engine lets change during a run and this server checks: a setting it would not check is refused, never dropped in silence.
  const checked = ["publishEvery", "pauseAfterEachChapter", "frozenEdits", "longRetry"].filter((key) => (LIVE_AUTOPILOT_OPTIONS as readonly string[]).includes(key));
  const unknown = keys.filter((key) => !checked.includes(key));
  if (unknown.length) refuse(`${unknown.slice(0, 3).map((key) => key.slice(0, 40)).join(", ")} cannot be changed here.`);
  const options: AutopilotLiveOptions = {};
  if (Object.hasOwn(body, "publishEvery")) {
    const value = body.publishEvery;
    if (value !== null && !(typeof value === "string" && (AUTOPILOT_PUBLISH_MODES as readonly string[]).includes(value))) refuse("publishEvery is not one of the ways to publish.");
    options.publishEvery = value as AutopilotLiveOptions["publishEvery"];
  }
  if (Object.hasOwn(body, "pauseAfterEachChapter")) {
    if (typeof body.pauseAfterEachChapter !== "boolean") refuse("pauseAfterEachChapter must be true or false.");
    options.pauseAfterEachChapter = body.pauseAfterEachChapter as boolean;
  }
  if (Object.hasOwn(body, "frozenEdits")) {
    if (!(typeof body.frozenEdits === "string" && (FROZEN_EDITS_MODES as readonly string[]).includes(body.frozenEdits))) refuse("frozenEdits is not one of the ways to handle a change of a frozen chapter.");
    options.frozenEdits = body.frozenEdits as FrozenEditsMode;
  }
  if (Object.hasOwn(body, "longRetry")) {
    // «Retry later» as the engine writes it, and nothing it would have to guess: a whole number of minutes, a whole number of cycles or the word "unlimited", and no other field.
    const problem = longRetryProblem(body.longRetry);
    if (problem) refuse(problem);
    options.longRetry = body.longRetry as AutopilotLongRetry | null;
  }
  return options;
}

/**
 * The most characters of the text the author saw in a rule (`expectedText`) that a request may carry. A rule is at most 800 characters now, but an
 * older engine kept rules of up to 8000, so the limit leaves room for those and for spaces around the text. (The address of a request is also
 * limited, to 16 KB, by Node: a longer one never gets here.)
 */
const MAX_EXPECTED_TEXT_CHARACTERS = 10_000;

/** The number of a rule in the address (`…/rules/:index`): a whole number from 0, written as an address writes one (no sign, no fraction, no leading zero). */
function asRuleIndex(value: string): number {
  const index = /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(index)) throw new HttpError(400, "invalid_request", "The rule number in the address must be a whole number from 0 (the first rule is 0).");
  return index;
}

/** What a request may change in a book's MCP: `{ enabled?, slug? }`, at least one of them, and nothing else is read. */
function asMcpChange(body: Record<string, unknown>): { enabled?: boolean; slug?: string } {
  const change: { enabled?: boolean; slug?: string } = {};
  if (Object.hasOwn(body, "enabled")) {
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "invalid_request", "`enabled` must be true or false.");
    change.enabled = body.enabled;
  }
  if (Object.hasOwn(body, "slug")) change.slug = assertSlug(body.slug);
  if (change.enabled === undefined && change.slug === undefined) throw new HttpError(400, "invalid_request", "Send `enabled` (true or false) and/or `slug`.");
  return change;
}

/** A name that a client sent, as a message may say it: short, and on one line. */
function named(key: string): string {
  return JSON.stringify(key.slice(0, 40));
}

/**
 * The body of a change of a rule, `{ text, expectedText? }`: the new text, which the engine judges (empty, too long, a copy of another rule: never cut here,
 * so that it tells how long the text was), and the text the author saw in the rule's place, which keeps a rule that changed since from being overwritten.
 * Nothing else is read, and a field that is misspelt is refused, not ignored: a guard that goes unread is no guard.
 */
function asRuleChange(body: Record<string, unknown>): { text: string; expectedText?: string } {
  const refuse = (problem: string): never => {
    throw new HttpError(400, "invalid_request", `${problem} A rule is changed with { "text": string, "expectedText"?: string }.`);
  };
  const unknown = Object.keys(body).filter((key) => key !== "text" && key !== "expectedText");
  if (unknown.length) refuse(`${unknown.slice(0, 3).map(named).join(", ")} cannot be sent here.`);
  if (typeof body.text !== "string") refuse("`text`, the new text of the rule, must be a string.");
  const expectedText = body.expectedText;
  if (expectedText !== undefined && typeof expectedText !== "string") refuse("`expectedText`, the rule as the author saw it, must be a string.");
  if (typeof expectedText === "string" && expectedText.length > MAX_EXPECTED_TEXT_CHARACTERS) refuse(`\`expectedText\` is longer than a rule can be (at most ${MAX_EXPECTED_TEXT_CHARACTERS} characters).`);
  return { text: body.text as string, ...(expectedText === undefined ? {} : { expectedText: expectedText as string }) };
}

/** The text the author saw in the rule, in the address of a DELETE (`?expectedText=…`, decoded as every parameter is): the one parameter it takes, once. `undefined` when there is none. */
function asExpectedText(url: URL): string | undefined {
  const refuse = (problem: string): never => {
    throw new HttpError(400, "invalid_request", `${problem} Send the rule as the author saw it as \`expectedText\`, or nothing.`);
  };
  const other = [...new Set(url.searchParams.keys())].filter((key) => key !== "expectedText");
  if (other.length) refuse(`${other.slice(0, 3).map(named).join(", ")} cannot be sent here.`);
  const given = url.searchParams.getAll("expectedText");
  if (given.length > 1) refuse("`expectedText` is given more than once.");
  if (given.length === 1 && given[0].length > MAX_EXPECTED_TEXT_CHARACTERS) refuse(`\`expectedText\` is longer than a rule can be (at most ${MAX_EXPECTED_TEXT_CHARACTERS} characters).`);
  return given[0];
}

/** The number of a chapter in the address (`…/autopilot/frozen/:number`): a whole number from 1, written as an address writes one. */
function asChapterNumber(value: string): number {
  const number = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) throw new HttpError(400, "invalid_request", "The chapter number in the address must be a whole number from 1.");
  return number;
}

/** The longest note of the author that goes with a decision about a change: as long as the note of an answer (a longer one is cut, as there). */
const MAX_DECISION_NOTE_CHARACTERS = 8000;

/**
 * The body of a decision about a change of a chapter, `{ action, kind?, note? }`: the action, which the engine judges (one that is not an action, or does
 * not fit the change, is its `invalid_action`), the kind of change (`frozen` or `outline`) for a chapter that has both, and the author's words for the
 * director. Nothing else is read, and a field that is misspelt is refused, not ignored: the wrong change would be decided.
 */
function asFrozenDecision(body: Record<string, unknown>): { action: FrozenAction; kind?: FrozenChangeKind; note?: string } {
  const refuse = (problem: string): never => {
    throw new HttpError(400, "invalid_request", `${problem} A change is decided with { "action": ${FROZEN_ACTIONS.join(" | ")}, "kind"?: frozen | outline, "note"?: string }.`);
  };
  const unknown = Object.keys(body).filter((key) => key !== "action" && key !== "kind" && key !== "note");
  if (unknown.length) refuse(`${unknown.slice(0, 3).map(named).join(", ")} cannot be sent here.`);
  if (typeof body.action !== "string") refuse("`action`, what to do with the change, must be a string.");
  if (body.kind !== undefined && body.kind !== "frozen" && body.kind !== "outline") refuse("`kind` must be frozen or outline.");
  if (body.note !== undefined && typeof body.note !== "string") refuse("`note`, the author's words for the director, must be a string.");
  return {
    action: body.action as FrozenAction,
    ...(body.kind === undefined ? {} : { kind: body.kind as FrozenChangeKind }),
    ...(typeof body.note === "string" ? { note: body.note.slice(0, MAX_DECISION_NOTE_CHARACTERS) } : {}),
  };
}

/** The folder of a chapter in the address (`…/chapters/:slug/freeze`): a name in `chapters/`, not a path (no separator, no control character), and short. */
function asChapterFolder(value: string): string {
  if (!value || value.length > 200 || value === "." || value === ".." || /[/\\\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, "invalid_request", "The chapter in the address must be the name of its folder in chapters/.");
  return value;
}

/** The body of a freeze, `{ frozen: boolean }`, and nothing else. */
function asFreezeRequest(body: Record<string, unknown>): boolean {
  const unknown = Object.keys(body).filter((key) => key !== "frozen");
  if (unknown.length || typeof body.frozen !== "boolean") {
    throw new HttpError(400, "invalid_request", `${unknown.length ? `${unknown.slice(0, 3).map(named).join(", ")} cannot be sent here. ` : ""}A chapter is frozen with { "frozen": true } and unfrozen with { "frozen": false }.`);
  }
  return body.frozen;
}

/** The routes of the permanent rules: `…/autopilot/rules/:index`, whose DELETE carries the text of a rule in its address. */
const RULES_ADDRESS = /^\/api\/v1\/books\/[^/]+\/autopilot\/rules\/[^/]+$/;

/** The addresses of the MCP endpoints of the books: a client that puts its token in the query (it should not) must not see it in the log. */
const MCP_ADDRESS = /^\/mcp(?:\/|$)/;

/** The addresses of the OAuth server: the query of an authorization request holds the state, the PKCE challenge and the app's address, and of a callback a code. None of it is logged. */
const OAUTH_ADDRESS = /^\/(?:oauth(?:\/|$)|\.well-known\/)/;

/**
 * A request address as the log says it. The text of a rule is the author's: a DELETE carries it in the query of its address (`?expectedText=…`), so for
 * the routes of the rules the log says that there was a query, not what it said (whatever the name of a parameter, spelt as it may be). The same for the
 * MCP endpoints, where a query is whatever a client chose to send, and for the OAuth server, where it holds the secrets of an authorization.
 */
function loggable(address: string | undefined): string {
  const text = address ?? "/";
  try {
    const { pathname } = new URL(text, "http://127.0.0.1");
    return (RULES_ADDRESS.test(pathname) || MCP_ADDRESS.test(pathname) || OAUTH_ADDRESS.test(pathname)) && text.includes("?") ? `${text.slice(0, text.indexOf("?"))}?***` : text;
  } catch {
    return text;
  }
}

/** The path of a request address, as the server reads it (dot segments resolved); empty when the address is not one. */
function pathOf(address: string | undefined): string {
  try {
    return new URL(address ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function asTarget(value: unknown): EvaluationTarget {
  const target = asObject(value);
  if (target.kind === "book") return { kind: "book" };
  if (target.kind === "chapter" && typeof target.chapter === "string") return { kind: "chapter", chapter: target.chapter };
  if (target.kind === "paragraph" && typeof target.chapter === "string" && typeof target.paragraph === "string") return { kind: "paragraph", chapter: target.chapter, paragraph: target.paragraph };
  throw new HttpError(400, "invalid_target", "The director target must be the book, a chapter or a paragraph.");
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function toUpdateResult(result: UpdateResult | undefined): ServerUpdateResult | undefined {
  if (!result) return undefined;
  return { requestId: result.requestId, state: result.state, outcome: result.outcome, version: result.version, fromVersion: result.fromVersion, at: result.at, message: result.message };
}

type Handler = (context: { request: IncomingMessage; response: ServerResponse; params: string[]; url: URL; client: ClientRecord }) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  scope: ServerScope;
  handler: Handler;
}

async function listen(server: http.Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

/**
 * Start the API (127.0.0.1:24242) and the admin panel (127.0.0.1:24243) for one data folder.
 * Both listen on loopback only; remote access goes through an HTTPS tunnel such as Cloudflare.
 */
export async function startNarrariumServer(options: NarrariumServerOptions): Promise<RunningNarrariumServer> {
  const log = options.log ?? (() => undefined);
  // A server that lost its lock may now be one of two on the same folder: it stops serving and writing at once, closes, and says so.
  let lockLost = false;
  let stopForLostLock: (() => Promise<void>) | undefined;
  const releaseLock = await (options.lock ?? lockDataRoot)(options.dataDir, () => {
    if (lockLost) return;
    lockLost = true;
    log("The data folder lock was lost: stopping.");
    if (stopForLostLock) void stopForLostLock().catch(() => undefined).finally(() => options.onLockLost?.());
  });
  const closers: Array<() => Promise<void> | void> = [];
  try {
    const data = await DataDirectory.open(options.dataDir, { label: options.label, origins: options.origins });
    const auth = await Auth.open(data.root, data.vault);
    const supervised = options.supervised ?? process.env[SUPERVISED_ENV] === "1";
    const installer = new RuntimeInstaller({ dataRoot: data.root });
    // Nothing below the highest version ever installed here is offered (the supervisor refuses it as well).
    const checkRelease = options.checkRelease ?? ((version: string) => checkNpmServerRelease(version, undefined, { highestInstalled: () => installer.highestVersion() }));
    const gitAvailable = Boolean(await gitVersion());

    const bodyIdleMs = typeof options.limits?.bodyIdleMs === "number" && options.limits.bodyIdleMs > 0 ? options.limits.bodyIdleMs : BODY_IDLE_MS;
    const readBody = (request: IncomingMessage, limit: number) => readJsonBody(request, limit, bodyIdleMs);
    // Every limit is counted per source (or per client), never for everybody at once.
    const infoLimit = new WindowLimiter({ max: INFO_PER_MINUTE, windowMs: MINUTE_MS });
    const pairingResultLimit = new WindowLimiter({ max: PAIRING_RESULTS_PER_MINUTE, windowMs: MINUTE_MS });
    const adminIdentityLimit = new WindowLimiter({ max: ADMIN_IDENTITY_PER_MINUTE, windowMs: MINUTE_MS });
    const failedAuthenticationLimit = new WindowLimiter({ max: FAILED_AUTHENTICATIONS_PER_MINUTE, windowMs: MINUTE_MS });
    const clientLimit = new WindowLimiter({ max: AUTHENTICATED_PER_MINUTE, windowMs: MINUTE_MS });
    const anonymousApi = new ConcurrencyLimiter(ANONYMOUS_IN_FLIGHT);
    const anonymousAdmin = new ConcurrencyLimiter(ANONYMOUS_IN_FLIGHT);
    const largeBodies = new ConcurrencyLimiter(MAX_LARGE_BODIES);
    /** The connections of the admin gateway to the API: never reused, so closing a request really closes its connection. */
    const gatewayAgent = new Agent({ keepAlive: false });
    closers.push(() => gatewayAgent.destroy());
    /** Cloudflare's `cf-connecting-ip` is believed once the owner has configured a public address or runs the server's own connector. */
    const tunnelTrusted = () => Boolean(data.config.publicUrl) || Boolean(data.config.allowRemoteAdmin && data.config.adminPublicUrl) || tunnel.status().enabled;
    const anonymousRefusal = () => new HttpError(429, "rate_limit", "Too many simultaneous requests from this address: wait a moment and try again.", { "retry-after": "1" });
    const streams = new Map<ServerResponse, ClientRecord>();
    /** Director questions in flight: the owner's switch abandons them (a question can run for minutes, and costs money all along). */
    const asking = new Set<AbortController>();
    /** Close the live streams of clients whose token was revoked or replaced. */
    const dropStaleStreams = () => {
      for (const [stream, client] of streams) {
        if (auth.isCurrent(client)) continue;
        stream.end();
        streams.delete(stream);
      }
    };
    const broadcast = (message: ServerStreamMessage, id?: number) => {
      const frame = encodeServerSentEvent(message, id);
      for (const [stream, client] of streams) {
        if (stream.writableLength > 4 * 1024 * 1024 || !auth.isCurrent(client)) {
          stream.end();
          streams.delete(stream);
          continue;
        }
        stream.write(frame);
      }
    };
    /** What the server spends on AI: the owner's caps are checked against it before every call. Flushed after the books are closed. */
    const spend = await SpendLedger.open({ file: data.file("private", "spend.json"), now: options.now, log });
    closers.push(() => spend.flush());
    const pendingBookUpdates = new Set<string>();
    let bookTimer: NodeJS.Timeout | null = null;
    /** Summaries being built (each asks git for a revision): closing waits for them, so no git process outlives the server. */
    const summariesInFlight = new Set<Promise<unknown>>();
    const books = new BookRegistry(data, {
      gitAvailable,
      ai: options.ai,
      spend,
      autopilot: options.autopilot,
      githubRemoteUrl: options.githubRemoteUrl,
      log,
      onEvent: (event: AutopilotEvent) => broadcast({ event: "autopilot", data: event }, event.seq),
      onBookChanged: (bookId) => {
        pendingBookUpdates.add(bookId);
        if (bookTimer) return;
        bookTimer = setTimeout(() => {
          bookTimer = null;
          const ids = [...pendingBookUpdates];
          pendingBookUpdates.clear();
          for (const id of ids) {
            if (!books.has(id)) continue;
            const task: Promise<unknown> = books.summary(books.get(id)).then((summary) => broadcast({ event: "book", data: summary })).catch(() => undefined).finally(() => summariesInFlight.delete(task));
            summariesInFlight.add(task);
          }
        }, 300);
      },
    });
    await books.load();
    closers.push(() => books.close());

    // The MCP endpoint of every book (off until the owner switches a book on): which books are on and at which slug, and what was called through them.
    const mcpBooks = await McpBooks.open(data.file("mcp.json"), log);
    const mcpAudit = new McpAudit(data.file("mcp-audit.jsonl"), log);
    closers.push(() => mcpAudit.flush());
    // What the owner and the clients change (the admin panel's action log): one line each, never a secret or a text of a book.
    const adminLog = new AdminLog(data.file("admin-log.jsonl"), { now: options.now, log });
    closers.push(() => adminLog.flush());
    // The updates that were asked for and how each went: what the supervisor answered, joined with who asked and what it verified (a small, bounded file, written by this server alone).
    const updateHistory = await UpdateHistory.open({
      file: data.file("update-history.json"),
      installer,
      currentVersion: SERVER_VERSION,
      now: options.now,
      max: options.admin?.historyMax,
      log: (line) => log(line),
      onFinished: (entry) => adminLog.record({ action: "update.finish", actor: { kind: "system" }, ok: entry.state === "completed", ...(entry.state === "completed" ? {} : { code: entry.state }), object: entry.to, detail: entry.from }),
    });
    // An update that finished while the server was down (the one that is starting is the result of it) is told now.
    await updateHistory.sync();
    const mcp = new McpEndpoint({
      books,
      state: mcpBooks,
      audit: mcpAudit,
      readBody: (request, limit) => readBody(request, limit),
      mapError: (error) => errorStatus(error),
      log,
      limits: { callsPerMinute: options.limits?.mcpCallsPerMinute, writesPerMinute: options.limits?.mcpWritesPerMinute, callMs: options.limits?.mcpCallMs, toolsPerPage: options.limits?.mcpToolsPerPage, resultBytes: options.limits?.mcpResultBytes },
      serverVersion: SERVER_VERSION,
    });

    // The OAuth server that lets ChatGPT, Claude.ai and the like connect to a book's endpoint by themselves: what the owner allowed is kept in private/oauth.json.
    const clock = options.now ?? (() => new Date());
    /** The books as the panel lists them: the state of each autopilot, read from its session (never from the whole book). */
    const runBoard = new RunBoard({ books, spend, now: clock, stalledAfterMs: options.admin?.stalledAfterMs ?? DEFAULT_STALLED_AFTER_MS, serverId: () => data.config.serverId });
    /** When this server started, by its own clock: the uptime of the health report is counted from here. */
    const startedAt = clock().getTime();
    /** The last error nobody expected (the kind that gets a request id): the health report tells when, which request and where, and never what it said. */
    let lastServerError: LastServerError | undefined;
    const noteServerError = (where: LastServerError["where"], request: IncomingMessage, mapped: MappedError, error: unknown) => {
      if (!mapped.requestId) return;
      lastServerError = { at: clock().toISOString(), requestId: mapped.requestId, where, route: routeShape(request.method, request.url), name: errorKind(error) };
    };
    const oauthStore = await OAuthStore.open(data.file("private", "oauth.json"), { now: clock, log });
    const oauth = new OAuthServer({
      store: oauthStore,
      books: mcpBooks,
      hasBook: (bookId) => books.has(bookId),
      verifyAdminCode: (code, source) => auth.verifyAdminCode(code, source),
      onAction: (event) => adminLog.record({ action: event.action, actor: { kind: event.actor }, ok: event.ok, object: event.object, label: event.label, detail: event.detail, code: event.code, source: event.source }),
      publicUrl: () => data.config.publicUrl,
      localUrl: () => `http://127.0.0.1:${apiPort}`,
      readJson: (request, limit) => readBody(request, limit),
      bodyIdleMs,
      now: clock,
      log,
      limits: { registrationsPerHour: options.limits?.oauthRegistrationsPerHour, requestsPerMinute: options.limits?.oauthRequestsPerMinute, maxClients: options.limits?.oauthMaxClients },
    });
    closers.push(() => oauth.close());
    // What ran out (grants that ended, apps nobody used for 30 days) is forgotten when the server starts and every hour after.
    const forgetStale = () => oauth.sweep().catch((error) => log(`The OAuth state could not be cleaned: ${error instanceof Error ? error.message : String(error)}`));
    await forgetStale();
    const staleTimer = setInterval(() => void forgetStale(), 60 * 60_000);
    staleTimer.unref();
    closers.push(() => clearInterval(staleTimer));
    /** The ways of proving who calls an MCP endpoint, tried in order: the client tokens of this server, then the OAuth access tokens (each bound to one book and to what the owner allowed). */
    const mcpAuthenticators: McpAuthenticator[] = [clientTokenAuthenticator(auth), oauth.authenticator()];

    const tunnel = new CloudflareTunnelManager({ root: data.root, vault: data.vault, ...options.tunnel });
    closers.push(() => tunnel.close());
    // A connector problem is shown in the admin panel; it never prevents the server from starting.
    await tunnel.start().catch(() => undefined);

    const info = (nonce?: string): ServerInfo => ({
      name: SERVER_PACKAGE_NAME,
      apiVersion: SERVER_API_VERSION,
      serverVersion: SERVER_VERSION,
      engineVersion: ENGINE_VERSION,
      serverId: data.config.serverId,
      label: publicLabel(data.config.label),
      git: gitAvailable,
      features: ["autopilot", "director", "sync", "pairing", "updates", "spend", SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES, SERVER_FEATURE_AUTOPILOT_FROZEN, SERVER_FEATURE_AUTOPILOT_RETRY, "mcp", "mcp-oauth", ...(gitAvailable ? ["github", SERVER_FEATURE_GITHUB_CONFLICTS] : [])],
      publicKey: data.publicKey,
      fingerprint: data.fingerprint,
      supervised,
      ...(nonce ? { nonce, signature: data.signIdentity(nonce) } : {}),
    });

    const spendStatus = (): ServerSpendStatus => spend.status(spendSettingsOf(data.config));
    /** The same status for the owner, with what only the owner is told (a record that was damaged and started again from zero). */
    const adminSpend = () => ({ ...spendStatus(), ...(spend.warning ? { warning: spend.warning } : {}) });

    /**
     * What the AI configuration says, without its keys: the endpoints that wait are the bases every integration sends requests to (the providers'
     * defaults included) that no approval of the owner covers.
     */
    const aiStatus = async (): Promise<ServerAiStatus & { spend: ServerSpendStatus }> => {
      const { config: aiConfig, updatedAt } = await data.aiConfig();
      const redacted = redactAiRuntimeConfig(aiConfig);
      const pending = unapprovedAiBases(aiConfig, data.config.allowedAiBases);
      return { configured: options.ai ? true : aiConfig.aiIntegrations.length > 0, integrations: redacted.integrations, routedTasks: redacted.routedTasks, toolsOnly: redacted.toolsOnly, taskRouting: redacted.taskRouting, updatedAt, ...(pending.length && !options.ai ? { pendingApproval: pending } : {}), spend: spendStatus() };
    };

    /**
     * A configuration saved by an earlier version never listed the providers' default bases for approval (and listed origins, not bases): the
     * owner must see what the saved configuration needs, so what no approval covers is added to the waiting list when the server starts.
     */
    const listPendingAiBases = async () => {
      if (options.ai) return;
      const { config: aiConfig } = await data.aiConfig();
      const merged = (config: { allowedAiBases: string[]; pendingAiBases: string[] }) => {
        const missing = unapprovedAiBases(aiConfig, config.allowedAiBases);
        const kept = config.pendingAiBases.filter((base) => !baseIsApproved(base, config.allowedAiBases) && !missing.some((entry) => approvalCovers(base, entry)));
        return [...new Set([...kept, ...missing])].slice(-50);
      };
      if (JSON.stringify(merged(data.config)) === JSON.stringify(data.config.pendingAiBases)) return;
      await data.updateConfig((next) => {
        next.pendingAiBases = merged(next);
      });
    };
    await listPendingAiBases().catch((error) => log(`The AI endpoints waiting for approval could not be listed: ${error instanceof Error ? error.message : String(error)}`));

    /** The update request still waiting for the supervisor (one it already answered is not pending). */
    const pendingRequest = async () => {
      const [request, result] = await Promise.all([installer.readUpdateRequest().catch(() => undefined), installer.readUpdateResult().catch(() => undefined)]);
      return request && result?.requestId !== request.requestId ? request : undefined;
    };

    // While an accepted update waits, watch for the supervisor giving up on it (for example when the
    // server did not stop in time): the server then accepts work again instead of staying latched.
    let maintenanceRequestId: string | undefined;
    let maintenanceTimer: NodeJS.Timeout | undefined;
    const watchMaintenance = (requestId: string) => {
      maintenanceRequestId = requestId;
      if (maintenanceTimer) return;
      maintenanceTimer = setInterval(() => {
        // The supervisor may have answered (a refusal that leaves this server running): the history and the owner's log say so.
        void updateHistory.sync();
        void installer.readUpdateResult().then((result) => {
          if (!maintenanceRequestId || result?.requestId !== maintenanceRequestId || result.state !== "failed") return;
          maintenanceRequestId = undefined;
          clearInterval(maintenanceTimer);
          maintenanceTimer = undefined;
          books.leaveMaintenance();
          log(`Update to ${result.version} not installed: ${result.message}`);
        }).catch(() => undefined);
      }, 1000);
      maintenanceTimer.unref();
    };

    let cachedRelease: { version: string; expiresAt: number; check: Promise<NpmReleaseCheck> } | undefined;
    /**
     * The npm release check. Reading it is cached for ten minutes per installed version (and an unreachable npm for one
     * minute), so the update pages do not ask the registry on every visit. `fresh` always asks again: an update request
     * must not rest on an old answer. A check that throws is never kept.
     */
    const releaseCheck = (fresh: boolean): Promise<NpmReleaseCheck> => {
      if (!fresh && cachedRelease && cachedRelease.version === SERVER_VERSION && cachedRelease.expiresAt > Date.now()) return cachedRelease.check;
      const entry = { version: SERVER_VERSION, expiresAt: Number.POSITIVE_INFINITY, check: checkRelease(SERVER_VERSION) };
      cachedRelease = entry;
      entry.check.then(
        (result) => {
          entry.expiresAt = Date.now() + (result.reason === "unavailable" ? RELEASE_UNREACHABLE_CACHE_MS : RELEASE_CACHE_MS);
          // A release npm announces and the server refuses to offer is worth a line in the log: it is either a mistake or an attack.
          if (result.reason === "no_trusted_release") log(`Update not offered: ${result.message}`);
          void updateHistory.noteOffer(result);
        },
        () => {
          if (cachedRelease === entry) cachedRelease = undefined;
        },
      );
      return entry.check;
    };

    const updateInfo = async (client?: ClientRecord): Promise<ServerUpdateInfo> => {
      const [release, lastUpdate, pending] = await Promise.all([
        releaseCheck(false),
        installer.readUpdateResult().catch(() => undefined),
        pendingRequest(),
      ]);
      const hasUpdateScope = client ? client.scopes.includes("update") : true;
      const base: ServerUpdateInfo = {
        packageName: SERVER_PACKAGE_NAME,
        installedVersion: SERVER_VERSION,
        ...(release.latestVersion ? { latestVersion: release.latestVersion } : {}),
        available: release.available,
        canRequest: release.available && supervised && hasUpdateScope && !books.inMaintenance,
        signed: release.signed,
        supervised,
        hasUpdateScope,
        ...(release.reason ? { reason: release.reason } : {}),
        message: release.message,
        ...(toUpdateResult(lastUpdate) ? { lastUpdate: toUpdateResult(lastUpdate) } : {}),
        ...(pending ? { pending: { version: pending.version, requestedAt: pending.requestedAt } } : {}),
      };
      if (release.available && !supervised) return { ...base, reason: "no_supervisor", message: "Start the server with `npx narrarium-server start` (the supervisor) to install updates remotely." };
      if (release.available && !hasUpdateScope) return { ...base, reason: "missing_scope", message: "This client may not update the server. In the admin panel, issue it a token that also allows updates." };
      return base;
    };

    const requestUpdate = async (body: Record<string, unknown>, source: "client" | "admin", actor?: string) => {
      if (!supervised) throw new HttpError(409, "no_supervisor", "Remote updates need the supervisor: start the server with `npx narrarium-server start`.");
      const version = body.version;
      if (!isExactSemver(version) || body.confirmed !== true) throw new HttpError(400, "invalid_request", "Send the exact version to install and confirm it.");
      if (body.installedVersion !== undefined && body.installedVersion !== SERVER_VERSION) throw new HttpError(412, "version", "The server version changed: reload before trying again.");
      const release = await releaseCheck(true);
      if (!release.available || !release.signed || release.latestVersion !== version) throw new HttpError(409, "release", "The requested version is not the latest signed and attested npm release: no update was started.");
      await books.requestUpdate(async () => {
        const previous = await pendingRequest();
        if (previous && previous.version !== version) throw new HttpError(409, "update_pending", "A different update is already waiting for the supervisor.");
        const requestId = previous?.requestId ?? randomUUID();
        if (!previous) {
          await installer.writeUpdateRequest({ schemaVersion: 1, packageName: SERVER_PACKAGE_NAME, version, requestedAt: new Date().toISOString(), requestId, source });
          await updateHistory.noteRequest({ id: requestId, version, by: source, actor });
        }
        watchMaintenance(requestId);
      });
      log(`Update to ${version} requested by ${source}.`);
      return { accepted: true as const, version, message: "Update requested: the supervisor stops the server cleanly, verifies the npm package and restarts the server only after a valid installation." };
    };

    /** The day's caps, as the server itself would refuse a call over them (the switch is not a cap: it is told on its own). */
    const dayCapReached = (): "tokens-per-day" | "cost-per-day" | undefined => {
      try {
        spend.assertAllowed({ ...spendSettingsOf(data.config), paused: false });
      } catch (error) {
        if (error instanceof SpendLimitError && (error.reason === "tokens-per-day" || error.reason === "cost-per-day")) return error.reason;
      }
      return undefined;
    };

    /** The health of the server now: what is true of this computer and of the books, found out at the moment of asking and never kept. */
    const healthReport = async (): Promise<HealthReport> => {
      const now = clock().getTime();
      const [views, release, disk, refused24h] = await Promise.all([
        runBoard.collect().catch(() => undefined),
        within(updateInfo().catch(() => undefined), options.admin?.releaseWaitMs ?? HEALTH_RELEASE_WAIT_MS),
        (options.admin?.disk ?? (() => diskSpace(data.root)))().catch(() => undefined),
        // Starts that were turned away for lack of a place: the log of the clients' calls is where that is written (a log that was cut counts less, never more).
        adminLog.count({ action: "run.start", ok: false, code: "too_many_runs", since: now - ERROR_ATTENTION_MS }).catch(() => 0),
      ]);
      const connector = tunnel.status();
      const capReached = dayCapReached();
      return buildHealth({
        now,
        startedAt,
        maintenance: books.inMaintenance,
        serverVersion: SERVER_VERSION,
        engineVersion: ENGINE_VERSION,
        ...(release ? { update: { available: release.available, ...(release.reason ? { reason: release.reason } : {}), ...(release.latestVersion ? { latestVersion: release.latestVersion } : {}), pending: Boolean(release.pending) } } : {}),
        ...(disk ? { disk } : {}),
        git: { available: gitAvailable, githubBooks: books.all().filter(({ book }) => book.storage.kind === "github").length },
        tunnel: { enabled: connector.enabled, process: connector.process, binaryAvailable: connector.binaryAvailable, ...(connector.lastErrorCode ? { lastErrorCode: connector.lastErrorCode } : {}) },
        runs: { running: books.runningCount(), max: data.config.maxConcurrentRuns, refused24h },
        spend: { paused: spendSettingsOf(data.config).paused, damaged: Boolean(spend.warning), ...(capReached ? { capReached } : {}) },
        ...(views ? { books: { total: views.length, unreadable: views.filter((view) => view.state === "unreadable").length, error: views.filter((view) => view.state === "error").length, stalled: views.filter((view) => view.state === "stalled").length } } : {}),
        ...(lastServerError ? { lastError: lastServerError } : {}),
      });
    };

    /** The risks of this server's set-up now: each is a fact of it, so one goes when its fact does. */
    const riskReport = async () => {
      const hosted = books.all();
      const settings = spendSettingsOf(data.config);
      const adminAddress = data.config.allowRemoteAdmin ? (data.config.adminPublicUrl ?? data.config.publicUrl) : undefined;
      const aiConfigured = options.ai ? true : (await data.aiConfig()).config.aiIntegrations.length > 0;
      return buildRisks({
        remoteAdmin: { on: data.config.allowRemoteAdmin, ...(adminAddress ? { address: adminAddress } : {}) },
        clients: auth.list().clients.filter((client) => !client.revoked).map((client) => ({ label: client.label, scopes: client.scopes })),
        apps: hosted.flatMap(({ book }) => oauth.grantsOf(book.bookId).map((grant) => ({ name: grant.name, bookId: book.bookId, scopes: grant.scopes }))),
        mcp: { booksOn: hosted.filter(({ book }) => mcpBooks.peek(book.bookId)?.enabled === true).length, passkeys: oauth.passkeyViews().filter((key) => key.usable).length, publicUrl: data.config.publicUrl, canAddPasskey: oauth.canAddPasskey },
        aiBases: data.config.allowedAiBases,
        spend: { unlimited: settings.maxTokensPerDay === 0 && settings.maxCostPerDay === 0 && settings.maxTokensPerRun === 0 && settings.maxCostPerRun === 0, paused: settings.paused },
        aiConfigured,
      });
    };

    /** Where a book's MCP address is: the public address of the API when the owner set one, else this computer's own. */
    const mcpAddresses = () => ({ publicUrl: data.config.publicUrl, localUrl: `http://127.0.0.1:${apiPort}` });

    /** What the status of a book's MCP says: its address (see `describeMcp`), how many apps are connected through OAuth, and where the OAuth server is. */
    const mcpStatus = (state: McpBookState) => ({ ...describeMcp(state, mcpAddresses()), connections: oauth.countGrants(state.bookId), oauth: oauth.describe(state.slug) });

    /** What the admin log reads of the server before a call changes it. */
    const loggedWorld = { mcpState: (bookId: string) => mcpBooks.peek(bookId), grant: (grantId: string) => oauth.grantInfo(grantId) };

    /**
     * Switch a book's MCP on or off or give it another address: the one way it is done, for the API and the admin panel. What the owner allowed to apps on that address ends with it:
     * a book that is switched off, or moved, or removed, has no connected apps (and they do not come back when it is switched on again: the owner allows them again).
     */
    const setMcp = async (runtime: BookRuntime, change: { enabled?: boolean; slug?: string }): Promise<McpBookState> => {
      books.assertNotInMaintenance();
      const previous = mcpBooks.peek(runtime.book.bookId);
      const state = await mcpBooks.update(runtime.book.bookId, runtime.book.title, change);
      if (!state.enabled || (previous !== undefined && previous.slug !== state.slug)) await oauth.revokeBook(state.bookId);
      return state;
    };

    const routes: Route[] = [
      { method: "GET", pattern: /^\/api\/v1\/session$/, scope: "read", handler: async ({ client }) => ({ serverId: data.config.serverId, label: data.config.label, clientLabel: client.label, clientId: client.id, scopes: client.scopes }) },
      { method: "GET", pattern: /^\/api\/v1\/ai$/, scope: "read", handler: aiStatus },
      {
        method: "PUT", pattern: /^\/api\/v1\/ai$/, scope: "write", handler: async ({ request }) => {
          const body = asObject(await readBody(request, SMALL_BODY));
          const config = pickAiRuntimeConfig(body.config);
          await data.saveAiConfig(config);
          const unapproved = unapprovedAiBases(config, data.config.allowedAiBases);
          if (unapproved.length) await data.updateConfig((next) => {
            next.pendingAiBases = [...new Set([...next.pendingAiBases, ...unapproved])].slice(-50);
          });
          return aiStatus();
        },
      },
      { method: "GET", pattern: /^\/api\/v1\/books$/, scope: "read", handler: async () => ({ books: await books.summaries() }) },
      {
        method: "PUT", pattern: /^\/api\/v1\/books\/([^/]+)$/, scope: "write", handler: async ({ request, params }) => {
          const body = asObject(await readBody(request, SMALL_BODY));
          return books.register(params[0], {
            title: String(body.title ?? ""),
            storage: body.storage as never,
            ...(body.githubToken === null || typeof body.githubToken === "string" ? { githubToken: body.githubToken as string | null } : {}),
          });
        },
      },
      {
        method: "DELETE", pattern: /^\/api\/v1\/books\/([^/]+)$/, scope: "write", handler: async ({ params }) => {
          await books.remove(params[0]);
          // A book that is gone has no address, and its slug is free again.
          await mcpBooks.forget(params[0]).catch((error) => log(`The MCP address of a removed book could not be forgotten: ${error instanceof Error ? error.message : String(error)}`));
          await oauth.revokeBook(params[0]).catch((error) => log(`The apps connected to a removed book could not be disconnected: ${error instanceof Error ? error.message : String(error)}`));
          return { removed: true };
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/mcp$/, scope: "read", handler: async ({ params }) => {
          const runtime = books.get(params[0]);
          return mcpStatus(await mcpBooks.state(runtime.book.bookId, runtime.book.title));
        },
      },
      {
        method: "PUT", pattern: /^\/api\/v1\/books\/([^/]+)\/mcp$/, scope: "write", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const change = asMcpChange(asObject(await readBody(request, 4096)));
          return mcpStatus(await setMcp(runtime, change));
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/mcp\/clients$/, scope: "write", handler: async ({ params }) => {
          const runtime = books.get(params[0]);
          return { clients: oauth.grantsOf(runtime.book.bookId) };
        },
      },
      {
        method: "DELETE", pattern: /^\/api\/v1\/books\/([^/]+)\/mcp\/clients\/([^/]+)$/, scope: "write", handler: async ({ params }) => {
          const runtime = books.get(params[0]);
          if (!(await oauth.revokeGrant(params[1], runtime.book.bookId))) throw new HttpError(404, "client_missing", "No app with this id is connected to this book.");
          return { revoked: true };
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/manifest$/, scope: "read", handler: async ({ params }) => {
          const runtime = books.get(params[0]);
          return { revision: (await books.summary(runtime)).revision, files: await runtime.store.list() };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/files\/read$/, scope: "read", handler: async ({ request, params }) => {
          const maxPaths = 100;
          const maxBytes = 16 * 1024 * 1024;
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const paths = [...new Set(Array.isArray(body.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string") : [])];
          if (paths.length > maxPaths) throw new HttpError(400, "too_many_paths", `Read at most ${maxPaths} different files per request.`);
          // One file at a time, so the answer can be refused as soon as it would be too big, before more is read.
          const files: BookFileContent[] = [];
          let total = 0;
          for (const filePath of paths) {
            const file = await runtime.store.read(filePath);
            if (!file) continue;
            total += Buffer.byteLength(file.content, "utf8");
            if (total > maxBytes) throw new HttpError(413, "payload_too_large", "These files are too large to be read in one request: ask for fewer of them.");
            files.push(file);
          }
          return { files };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/files\/commit$/, scope: "write", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          // Each large body is buffered several times over (chunks, text, parsed value): only a few are read at once.
          const releaseBody = largeBodies.enter("commit");
          if (!releaseBody) throw new HttpError(503, "busy", "The server is already receiving large uploads: try again in a moment.", { "retry-after": "2" });
          let body: Record<string, unknown>;
          try {
            body = asObject(await readBody(request, LARGE_BODY));
          } finally {
            releaseBody();
          }
          if (Array.isArray(body.changes) && body.changes.length > MAX_COMMIT_CHANGES) throw new HttpError(413, "too_many_changes", `A commit may change at most ${MAX_COMMIT_CHANGES} files: send the rest in another commit.`);
          const changes = Array.isArray(body.changes) ? body.changes.map((entry) => {
            const change = asObject(entry);
            if (typeof change.path !== "string" || (change.content !== null && typeof change.content !== "string")) throw new HttpError(400, "invalid_change", "Every change needs a path and a text content (or null).");
            return {
              path: change.path,
              content: change.content as string | null,
              ...(change.expectedHash === null || typeof change.expectedHash === "string" ? { expectedHash: change.expectedHash as string | null } : {}),
            };
          }) : [];
          if (!changes.length) throw new HttpError(400, "invalid_request", "No changes to commit.");
          await books.commitFiles(runtime, changes, typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 300) : "Sync from Narrarium");
          return { revision: (await books.summary(runtime)).revision };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/sync$/, scope: "write", handler: async ({ params }) => {
          books.assertNotInMaintenance();
          return books.syncGitHub(params[0]);
        },
      },
      // The conflicts of a GitHub book with GitHub: the list (a fetch, and a merge that writes nothing) and their resolution (one merge commit, pushed).
      { method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/github-conflicts$/, scope: "read", handler: async ({ params, url }) => books.githubConflicts(params[0], asConflictPage(url)) },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/github-conflicts\/resolve$/, scope: "write", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          books.get(params[0]);
          const resolution = asResolveRequest(asObject(await readBody(request, SMALL_BODY)));
          return books.resolveGithubConflicts(params[0], resolution);
        },
      },
      { method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot$/, scope: "read", handler: async ({ params }) => books.get(params[0]).session.snapshot() },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/start$/, scope: "run", handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          // A request that is wrong in itself is refused before anything else is asked of the server, and starts nothing.
          const limits = asLimits(body.limits);
          await books.startRun(runtime, { brief: body.brief as never, options: body.options as never, limits, force: body.force === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/pause$/, scope: "run", handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const mode = asPauseMode(body.mode);
          // `cancel` takes back a pause that waits and stops nothing; with nothing to pause or to take back the answer is the snapshot all the same.
          if (mode === "cancel") runtime.session.cancelPause();
          else runtime.session.pause(mode);
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/retry-now$/, scope: "run", handler: async ({ request, params }) => {
          // It sets the run going again at once: while an update is about to start it is refused, like every command that makes the autopilot work (a pause is not).
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          if (Object.keys(body).length) throw new HttpError(400, "invalid_request", "\"Retry now\" takes no body: send nothing, or {}.");
          // With nothing waiting it changes nothing, and the answer is the snapshot all the same.
          const skipped = runtime.session.retryNow();
          return { ...(await runtime.session.snapshot()), skipped };
        },
      },
      {
        method: "PUT", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/options$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const options = asLiveOptions(asObject(await readBody(request, SMALL_BODY)));
          // Saved at once, also while a run goes on: the step in flight is not repeated, and the run reads the new value at the end of the step or of the chapter.
          await runtime.session.updateOptions(options);
          return runtime.session.snapshot();
        },
      },
      {
        method: "PUT", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/rules\/([^/]+)$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const index = asRuleIndex(params[1]);
          const { text, expectedText } = asRuleChange(asObject(await readBody(request, SMALL_BODY)));
          // The text goes to the engine as it is: it decides what a rule is, and also while a run goes on (the step in flight is not repeated, and the next one has the rule as it is now).
          await runtime.session.updateRule(index, text, expectedText);
          return runtime.session.snapshot();
        },
      },
      {
        method: "DELETE", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/rules\/([^/]+)$/, scope: "run", handler: async ({ params, url }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const index = asRuleIndex(params[1]);
          await runtime.session.removeRule(index, asExpectedText(url));
          return runtime.session.snapshot();
        },
      },
      // The frozen chapters: what changed in them and what can be done with it, a decision about a change, and the author's freeze by hand.
      { method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/frozen$/, scope: "read", handler: async ({ params }) => books.get(params[0]).session.frozenStatus() },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/frozen\/([^/]+)$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const number = asChapterNumber(params[1]);
          const { action, kind, note } = asFrozenDecision(asObject(await readBody(request, SMALL_BODY)));
          // Also while a run goes on: what needs no model is done at once, a review is recorded for the run's next step. What cannot be done is the engine's refusal.
          return runtime.session.resolveFrozenChange(number, action, { ...(kind ? { kind } : {}), ...(note === undefined ? {} : { note }) });
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/chapters\/([^/]+)\/freeze$/, scope: "write", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const slug = asChapterFolder(params[1]);
          const frozen = asFreezeRequest(asObject(await readBody(request, SMALL_BODY)));
          return frozen ? runtime.session.freezeChapter(slug) : runtime.session.unfreezeChapter(slug);
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/intervene$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const scope = body.scope === "from_now" || body.scope === "rewrite" ? body.scope : "next_step";
          const text = String(body.text ?? "");
          // A note is cut at 8000 characters. A rule is never cut: the engine refuses one that is empty or over its limit and the answer says so
          // (400 with the engine's code), so the length it reports is the length of what the author sent.
          if (scope === "next_step") {
            if (!text.trim()) throw new HttpError(400, "invalid_request", "The intervention is empty.");
          } else normalizeRuleText(text);
          await runtime.session.intervene({ scope, text: scope === "next_step" ? text.slice(0, 8000) : text, interrupt: body.interrupt === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/answer$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const questionId = String(body.questionId ?? "");
          const asRule = body.asRule === true;
          const answer = String(body.answer ?? "");
          // An answer that another device gave already is a conflict, not an internal error.
          if (!runtime.session.running) {
            const open = (await runtime.session.snapshot()).state?.question;
            if (!open || open.id !== questionId) throw new HttpError(409, "question_closed", "This question is no longer open.");
          }
          // A note is cut at 8000 characters; an answer that becomes a rule is not (the engine refuses one over its limit and says so).
          await runtime.session.answer({ questionId, answer: asRule ? answer : answer.slice(0, 8000), accept: body.accept === true, asRule });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/configure$/, scope: "write", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          await runtime.session.configure({ brief: body.brief as never, options: body.options as never });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/reset$/, scope: "write", handler: async ({ params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          await runtime.session.reset();
          return runtime.session.snapshot();
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/events$/, scope: "read", handler: async ({ params, url }) => {
          const runtime = books.get(params[0]);
          const since = Number(url.searchParams.get("since") ?? "0");
          return { events: runtime.session.recentEvents(Number.isFinite(since) ? since : 0), lastSeq: runtime.session.lastSeq };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/director\/ask$/, scope: "run", handler: async ({ request, response, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const controller = new AbortController();
          asking.add(controller);
          // The question may run for minutes and costs money: it stops with the connection. (The request's own `close`
          // event fires as soon as its body is read, so only the response tells that the caller left.)
          response.once("close", () => {
            asking.delete(controller);
            if (!response.writableEnded) controller.abort();
          });
          return runtime.session.askDirector({ target: asTarget(body.target), question: typeof body.question === "string" ? body.question.slice(0, 4000) : undefined, save: body.save === true, signal: controller.signal });
        },
      },
      { method: "GET", pattern: /^\/api\/v1\/updates$/, scope: "read", handler: async ({ client }) => updateInfo(client) },
      { method: "POST", pattern: /^\/api\/v1\/updates$/, scope: "update", handler: async ({ request, client }) => requestUpdate(asObject(await readBody(request, 4096)), "client", client.label) },
    ];

    const common = (response: ServerResponse) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
    };
    let apiPort = options.port ?? data.config.apiPort;
    let adminPort = options.adminPort ?? data.config.adminPort ?? DEFAULT_ADMIN_PORT;
    const allowedOrigins = () => new Set([...DEFAULT_ORIGINS, ...data.config.origins].map((origin) => origin.replace(/\/+$/, "")));

    const api = http.createServer((request, response) => {
      const started = Date.now();
      void (async () => {
        common(response);
        response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
        if (lockLost) throw lockLostError();
        const hosts = new Set([`127.0.0.1:${apiPort}`, `localhost:${apiPort}`, `[::1]:${apiPort}`, ...(hostOf(data.config.publicUrl) ? [hostOf(data.config.publicUrl)!] : [])]);
        if (!hosts.has(String(request.headers.host ?? "").toLowerCase())) throw new HttpError(421, "host_not_allowed", "Unexpected Host header. Set the public address of the server in its admin panel (Approved network).");
        const origin = typeof request.headers.origin === "string" ? request.headers.origin.replace(/\/+$/, "") : "";
        if (origin) {
          if (allowedOrigins().has(origin)) {
            response.setHeader("access-control-allow-origin", origin);
            response.setHeader("vary", "Origin");
            response.setHeader("access-control-expose-headers", "etag, retry-after, x-request-id");
          } else if (!(isOAuthPath(pathOf(request.url)) && origin === oauth.baseOf(request))) {
            // The pages of the OAuth server call it from the address they were served on: that origin is the server's own, so it needs no approval (and gets no CORS: nobody else may use it).
            throw new HttpError(403, "origin_not_allowed", `The origin ${origin} is not allowed. Add it in the server's admin panel (Approved network).`);
          }
        }
        if (request.method === "OPTIONS") {
          response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
          response.setHeader("access-control-allow-headers", "authorization, content-type, accept, if-match, last-event-id");
          response.setHeader("access-control-max-age", "600");
          if (request.headers["access-control-request-private-network"] === "true") response.setHeader("access-control-allow-private-network", "true");
          response.writeHead(204);
          response.end();
          return;
        }
        let url: URL;
        try {
          url = new URL(request.url ?? "/", "http://127.0.0.1");
        } catch {
          throw new HttpError(400, "invalid_request", "The request address is not valid.");
        }
        // Who is calling, for every limit below. Until a valid token is shown the caller is anonymous, and one
        // source may have only a few anonymous requests in flight (a stalled one frees its slot when it ends).
        const source = sourceOf(request, tunnelTrusted());
        const releaseAnonymous = anonymousApi.enter(source);
        if (!releaseAnonymous) throw anonymousRefusal();
        response.once("close", releaseAnonymous);
        if (request.method === "GET" && (url.pathname === "/api/v1/info" || url.pathname === "/")) {
          refuseOver(infoLimit.hit(source));
          const nonce = url.searchParams.get("nonce");
          if (nonce !== null && !/^[a-f0-9]{64}$/.test(nonce)) throw new HttpError(400, "invalid_nonce", "The nonce must be 64 hexadecimal characters.");
          sendJson(response, 200, url.pathname === "/" ? { ...info(), message: "Narrarium personal server. Connect it from Narrarium → Settings → Personal server." } : info(nonce ?? undefined));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/pairings") {
          try {
            auth.admitPairingAttempt(source);
            const body = asObject(await readBody(request, 4096));
            const code = typeof body.code === "string" ? body.code : "";
            const nonce = typeof body.nonce === "string" ? body.nonce : "";
            const label = typeof body.label === "string" ? body.label.trim() : "";
            if (!/^\d{9}$/.test(code) || !/^[a-f0-9]{64}$/.test(nonce) || !label || label.length > 80) throw new HttpError(400, "invalid_request", "Send the nine-digit code, a nonce and a client name.");
            const requested = await auth.requestPairing(code, nonce, label, source, header(request, "user-agent"));
            // Nobody waits for the file: the entry is queued before the answer goes (so it is there when the log is asked for) and written while it travels.
            const written = adminLog.record({ action: "pairing.request", actor: { kind: "device", label }, source });
            sendJson(response, 200, requested);
            await written;
          } catch (error) {
            // A code that is wrong, or too many tries: the owner is told (a run of them from anywhere is one entry). A request that is wrong in itself is not an event.
            if (error instanceof HttpError && (error.status === 401 || error.status === 429)) void adminLog.record({ action: "pairing.attempt", actor: { kind: "anonymous" }, ok: false, code: error.code, source });
            throw error;
          }
          return;
        }
        const pairing = /^\/api\/v1\/pairings\/([0-9a-f-]{36})\/result$/.exec(url.pathname);
        if (request.method === "POST" && pairing) {
          refuseOver(pairingResultLimit.hit(source));
          const body = asObject(await readBody(request, 4096));
          if (typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce)) throw new HttpError(400, "invalid_request", "Send the pairing nonce.");
          sendJson(response, 200, await auth.pollPairing(pairing[1], body.nonce));
          return;
        }
        // The OAuth server (discovery, registration, the consent page, tokens): nobody has shown a token yet, which is what it is for.
        if (isOAuthPath(url.pathname)) {
          await oauth.handle({ request, response, url, source });
          return;
        }
        const token = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? ""))?.[1];
        // The address of a book's MCP endpoint says who is calling in its own way (a client token, or an OAuth token bound to one book), and answers a refusal the
        // way MCP clients look for it: `WWW-Authenticate: Bearer`, with the address of the metadata that tells an app how to get a token. Everything else about
        // the request is what every route has: the host, the origin, the limits per source and per client.
        const mcpTarget = mcpAddress(url.pathname);
        if (mcpTarget) {
          const resourceMetadata = `${oauth.baseOf(request)}/.well-known/oauth-protected-resource/mcp/${mcpTarget.slug}`;
          let principal: McpPrincipal;
          try {
            principal = authenticateMcp(mcpAuthenticators, token);
          } catch (error) {
            if (!(error instanceof HttpError) || error.status !== 401) throw error;
            refuseOver(failedAuthenticationLimit.hit(source));
            throw new HttpError(401, error.code, error.message, { ...error.headers, ...challenge(token === undefined ? undefined : "invalid_token", { resourceMetadata }) });
          }
          releaseAnonymous();
          refuseOver(clientLimit.hit(principal.id));
          const answer = await mcp.handle({ request, slug: mcpTarget.slug, principal, resourceMetadata });
          if (!principal.current()) throw new HttpError(401, "revoked", "This client token was revoked.", challenge("invalid_token", { resourceMetadata }));
          if (answer.body === undefined) {
            response.writeHead(answer.status, { "content-length": "0" });
            response.end();
          } else sendJson(response, answer.status, answer.body);
          return;
        }
        let client: ClientRecord;
        try {
          client = auth.authenticate(token);
        } catch (error) {
          // A failed authentication is counted for its source; a valid token is never throttled by the failures of others.
          if (error instanceof HttpError && error.status === 401) refuseOver(failedAuthenticationLimit.hit(source));
          throw error;
        }
        releaseAnonymous();
        refuseOver(clientLimit.hit(client.id));
        // Disconnecting a device revokes the token it presented, whatever its permissions, and no other client's (nothing the
        // caller sends names a client). A token that was replaced after this request started revokes nothing.
        if (request.method === "DELETE" && url.pathname === "/api/v1/session") {
          const revoked = await auth.revokeOwn(client);
          dropStaleStreams();
          const written = revoked ? adminLog.record({ action: "client.disconnect", actor: { kind: "client", id: client.id, label: client.label }, source }) : undefined;
          sendJson(response, 200, { revoked });
          await written;
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/v1/events") {
          assertScope(client, "read");
          if (streams.size >= MAX_STREAMS) throw new HttpError(429, "too_many_streams", "Too many live connections to this server.");
          if ([...streams.values()].filter((entry) => entry.id === client.id).length >= MAX_STREAMS_PER_CLIENT) {
            throw new HttpError(429, "too_many_streams", `This client already holds ${MAX_STREAMS_PER_CLIENT} live connections: close one before opening another.`);
          }
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" });
          // A device that vanished without closing (sleep, a network change) is noticed by the operating system's probes, and its slot freed.
          request.socket.setKeepAlive(true, 15_000);
          response.write(encodeServerSentEvent({ event: "hello", data: { serverId: data.config.serverId, at: new Date().toISOString() } }));
          streams.set(response, client);
          // The slot is free the moment the connection is: the response closes when the client leaves or the stream ends.
          const forget = () => {
            streams.delete(response);
          };
          response.once("close", forget);
          response.once("error", forget);
          return;
        }
        for (const route of routes) {
          if (route.method !== request.method) continue;
          const match = route.pattern.exec(url.pathname);
          if (!match) continue;
          // What this call is in the admin log, if it is an event at all, read before the call changes it.
          const logged = clientAction(request.method, url.pathname, loggedWorld);
          const doer: AdminActor = { kind: "client", id: client.id, label: client.label };
          let payload: unknown;
          try {
            assertScope(client, route.scope);
            const params = match.slice(1).map((value) => {
              try {
                return decodeURIComponent(value);
              } catch {
                throw new HttpError(400, "invalid_path", "The address contains an invalid escape sequence.");
              }
            });
            payload = await route.handler({ request, response, params, url, client });
          } catch (error) {
            // A client that was let in and told no (a permission it does not have, a limit, a state of the server) leaves a line; a request that is wrong in itself does not.
            const mapped = logged ? errorStatus(error) : undefined;
            if (logged && mapped && refusalIsLogged(mapped.status)) void adminLog.record({ action: logged.failure, actor: doer, ok: false, code: mapped.code, object: logged.object, label: logged.label, source });
            throw error;
          }
          // Nobody waits for the file: the entries are queued before the answer goes (so they are there when the log is asked for) and written while it travels.
          const written = logged ? logged.done(payload).map((entry) => adminLog.record({ ...entry, actor: doer, source })) : [];
          if (!auth.isCurrent(client)) throw new HttpError(401, "revoked", "This client token was revoked.");
          sendJson(response, url.pathname === "/api/v1/updates" && request.method === "POST" ? 202 : 200, payload);
          await Promise.all(written);
          return;
        }
        throw new HttpError(404, "not_found", "Unknown endpoint.");
      })().catch((error) => {
        const mapped = errorStatus(error);
        if (isFailure(mapped)) log(`Error${mapped.requestId ? ` ${mapped.requestId}` : ""} on ${request.method} ${loggable(request.url)}: ${mapped.detail ?? mapped.message}`);
        noteServerError("api", request, mapped, error);
        if (!response.headersSent) {
          response.setHeader("connection", "close");
          sendError(response, mapped);
        } else response.end();
      }).finally(() => {
        if (request.url !== "/api/v1/events") log(`${request.method} ${loggable(request.url)} ${response.statusCode} ${Date.now() - started}ms`);
      });
    });

    const admin = http.createServer((request, response) => {
      void (async () => {
        common(response);
        if (lockLost) throw lockLostError();
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const localOrigins = [`http://127.0.0.1:${adminPort}`, `http://localhost:${adminPort}`];
        const publicAdmin = data.config.allowRemoteAdmin ? (data.config.adminPublicUrl ?? data.config.publicUrl) : undefined;
        const publicAdminOrigin = publicAdmin ? normalizeOrigin(publicAdmin, false) : undefined;
        const adminOrigins = [...localOrigins, ...(publicAdminOrigin ? [publicAdminOrigin] : [])];
        const host = String(request.headers.host ?? "").toLowerCase();
        const remote = Boolean(publicAdminOrigin) && host === hostOf(publicAdminOrigin);
        const local = localOrigins.some((origin) => hostOf(origin) === host);
        const path = request.url ?? "/";
        const bridge = remote && /^\/(?:api\/v1|mcp|oauth|\.well-known)\//.test(path);
        if ((!local && !remote) || (request.headers.origin && !bridge && !adminOrigins.includes(request.headers.origin))) {
          throw new HttpError(403, "admin_origin", "The admin panel is available only from this computer or from its approved public address.");
        }
        // One public hostname can point to the admin port: the panel is served on / and /api/v1/* (and the MCP addresses of the books, /mcp/*, and the OAuth
        // server, /oauth/* and /.well-known/*) are bridged to the loopback API, which still checks Host, Origin and the client token.
        if (bridge) {
          bridgeToApi(request, response, { port: apiPort, host: hostOf(data.config.publicUrl) ?? `127.0.0.1:${apiPort}` }, gatewayAgent);
          return;
        }
        if (request.method === "GET" && (path === "/" || path === "/admin.js" || path === "/admin.css")) {
          response.writeHead(200, { "content-type": path === "/" ? "text/html; charset=utf-8" : path === "/admin.css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
          response.end(path === "/" ? ADMIN_HTML : path === "/admin.css" ? ADMIN_CSS : ADMIN_JS);
          return;
        }
        // The command line proves it talks to this server before it sends the admin code: it brings a nonce, this signs it.
        if (request.method === "GET" && path.split("?")[0] === "/admin/api/identity") {
          const source = sourceOf(request, tunnelTrusted());
          const releaseAnonymous = anonymousAdmin.enter(source);
          if (!releaseAnonymous) throw anonymousRefusal();
          response.once("close", releaseAnonymous);
          refuseOver(adminIdentityLimit.hit(source));
          const nonce = new URL(path, "http://127.0.0.1").searchParams.get("nonce");
          if (nonce === null || !/^[a-f0-9]{64}$/.test(nonce)) throw new HttpError(400, "invalid_nonce", "The nonce must be 64 hexadecimal characters.");
          sendJson(response, 200, { name: SERVER_PACKAGE_NAME, serverId: data.config.serverId, publicKey: data.publicKey, fingerprint: data.fingerprint, nonce, signature: data.signIdentity(nonce) });
          return;
        }
        if (request.method === "POST" && !adminOrigins.includes(header(request, "origin") ?? "")) throw new HttpError(403, "admin_csrf", "This admin request does not come from the admin panel.");
        // Cookies are shared by every port of a host: one name per admin port keeps two servers apart.
        const cookieName = `nrs_admin_${adminPort}`;
        if (path === "/admin/api/login" && request.method === "POST") {
          // Nobody has shown a session yet: one source may have only a few sign-ins (and half-sent bodies) in flight.
          const source = sourceOf(request, tunnelTrusted());
          const releaseAnonymous = anonymousAdmin.enter(source);
          if (!releaseAnonymous) throw anonymousRefusal();
          response.once("close", releaseAnonymous);
          const body = asObject(await readBody(request, 4096));
          let session: Awaited<ReturnType<typeof auth.login>>;
          try {
            session = await auth.login(typeof body.code === "string" ? body.code.trim() : "", source);
          } catch (error) {
            // Wrong codes in a run are counted in one entry; the code that was typed is never written.
            void adminLog.record({ action: "admin.login", actor: { kind: "anonymous" }, ok: false, code: errorStatus(error).code, source });
            throw error;
          }
          const written = adminLog.record({ action: "admin.login", actor: { kind: "admin" }, source });
          const secure = header(request, "origin")?.startsWith("https://") ? "; Secure" : "";
          response.setHeader("set-cookie", `${cookieName}=${session.cookie}; HttpOnly; SameSite=Strict; Path=/admin/; Max-Age=1800${secure}`);
          sendJson(response, 200, { csrf: session.csrf });
          await written;
          return;
        }
        const cookie = new RegExp(`(?:^|;\\s*)${cookieName}=([A-Za-z0-9_-]+)`).exec(header(request, "cookie") ?? "")?.[1];
        auth.adminSession(cookie, request.method === "POST" ? header(request, "x-csrf-token") ?? "" : undefined);
        const body = request.method === "POST" ? asObject(await readBody(request, 16_384)) : {};
        // What the owner does here is logged under his name, with where he came from.
        const ownerSource = sourceOf(request, tunnelTrusted());
        const note = (action: AdminLogInput["action"], fields: Omit<AdminLogInput, "action" | "actor" | "source"> = {}) => adminLog.record({ action, actor: { kind: "admin" }, source: ownerSource, ...fields });
        if (path === "/admin/api/logout" && request.method === "POST") {
          auth.logout(cookie);
          response.setHeader("set-cookie", `${cookieName}=; HttpOnly; SameSite=Strict; Path=/admin/; Max-Age=0`);
          sendJson(response, 200, { ok: true });
          return;
        }
        if (path === "/admin/api/status" && request.method === "GET") {
          // The books come from the autopilot's own state, never from reading the whole book (what `books.summaries()` does when git is not there to say a revision).
          const hosted = await runBoard.collect().catch(() => []);
          sendJson(response, 200, {
            serverId: data.config.serverId,
            label: data.config.label,
            fingerprint: data.fingerprint,
            serverVersion: SERVER_VERSION,
            engineVersion: ENGINE_VERSION,
            apiPort,
            adminPort,
            apiUrl: `http://127.0.0.1:${apiPort}`,
            dataRoot: data.root,
            supervised,
            maintenance: books.inMaintenance,
            git: gitAvailable,
            defaultOrigins: DEFAULT_ORIGINS,
            origins: data.config.origins,
            allowedAiBases: data.config.allowedAiBases,
            pendingAiBases: data.config.pendingAiBases.filter((base) => !baseIsApproved(base, data.config.allowedAiBases)),
            spend: adminSpend(),
            publicUrl: data.config.publicUrl ?? "",
            adminPublicUrl: data.config.adminPublicUrl ?? "",
            allowRemoteAdmin: data.config.allowRemoteAdmin,
            tunnel: tunnel.status(),
            books: hosted.map((book) => ({ bookId: book.bookId, title: book.title, storage: book.storage, running: book.live, status: book.status, phase: book.phase, error: book.error })),
            ...auth.list(),
          });
          return;
        }
        if (path === "/admin/api/admin-code/rotate" && request.method === "POST") {
          const code = await auth.rotateAdminCode();
          await note("admin.code.rotate");
          sendJson(response, 200, { code });
          return;
        }
        if (path === "/admin/api/admin-code/set" && request.method === "POST") {
          await auth.replaceAdminCode(typeof body.code === "string" ? body.code : "");
          await note("admin.code.set");
          sendJson(response, 200, { changed: true });
          return;
        }
        if (path === "/admin/api/token" && request.method === "POST") {
          const replaceId = typeof body.replaceId === "string" ? body.replaceId : undefined;
          const origin = { source: sourceOf(request, tunnelTrusted()), userAgent: header(request, "user-agent") };
          const label = typeof body.label === "string" ? body.label : "";
          const scopes = parseScopes(body.scopes);
          const issued = await auth.issue(label, scopes, replaceId, origin);
          await note(replaceId ? "token.replace" : "token.issue", { object: issued.clientId, label, detail: scopes.join(",") });
          sendJson(response, 200, issued);
          if (replaceId) dropStaleStreams();
          return;
        }
        if (path === "/admin/api/revoke" && request.method === "POST") {
          if (typeof body.id !== "string") throw new HttpError(400, "invalid_request", "Which client?");
          const label = auth.list().clients.find((entry) => entry.id === body.id)?.label;
          const revoked = await auth.revoke(body.id);
          if (revoked) await note("token.revoke", { object: body.id, label });
          sendJson(response, 200, { revoked });
          dropStaleStreams();
          return;
        }
        if (path === "/admin/api/pairing" && request.method === "POST") {
          const started = await auth.startPairing();
          await note("pairing.start");
          sendJson(response, 200, started);
          return;
        }
        if (path === "/admin/api/pairing/approve" && request.method === "POST") {
          if (typeof body.id !== "string") throw new HttpError(400, "invalid_request", "Which pairing?");
          const known = new Set(auth.list().clients.map((entry) => entry.id));
          await auth.approvePairing(body.id, { allowUpdate: body.allowUpdate === true });
          const added = auth.list().clients.find((entry) => !known.has(entry.id));
          await note("pairing.approve", { object: added?.id, label: added?.label, detail: added?.scopes.join(",") });
          sendJson(response, 200, { approved: true });
          return;
        }
        if (path === "/admin/api/pairing/cancel" && request.method === "POST") {
          const open = auth.list().pairing !== null;
          await auth.cancelPairing();
          if (open) await note("pairing.reject");
          sendJson(response, 200, { cancelled: true });
          return;
        }
        if (path === "/admin/api/network" && request.method === "POST") {
          const list = (value: unknown, max: number) => (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, max);
          const origins = list(body.origins, 20).map((origin) => normalizeOrigin(origin));
          const allowedAiBases = list(body.allowedAiBases, 50).map((base) => normalizeAiBase(base));
          const publicUrl = typeof body.publicUrl === "string" && body.publicUrl.trim() ? normalizeOrigin(body.publicUrl, false) : undefined;
          const adminPublicUrl = typeof body.adminPublicUrl === "string" && body.adminPublicUrl.trim() ? normalizeOrigin(body.adminPublicUrl, false) : undefined;
          const before = data.config;
          await data.updateConfig((next) => {
            next.origins = [...new Set(origins)];
            next.allowedAiBases = [...new Set(allowedAiBases)];
            next.pendingAiBases = next.pendingAiBases.filter((base) => !baseIsApproved(base, next.allowedAiBases));
            if (publicUrl) next.publicUrl = publicUrl;
            else delete next.publicUrl;
            if (adminPublicUrl) next.adminPublicUrl = adminPublicUrl;
            else delete next.adminPublicUrl;
            if (typeof body.allowRemoteAdmin === "boolean") next.allowRemoteAdmin = body.allowRemoteAdmin;
          });
          // What the form changed, not what it said: a form saved as it was leaves no line.
          for (const entry of networkChanges(before, data.config)) await note(entry.action, entry);
          // An approval that was taken out leaves what it covered waiting again: the next run would stop on it.
          await listPendingAiBases().catch(() => undefined);
          sendJson(response, 200, { saved: true });
          return;
        }
        if ((path === "/admin/api/ai/approve" || path === "/admin/api/ai/dismiss") && request.method === "POST") {
          // The owner approves what the panel shows: an origin or an origin and a path, kept as it is (in a canonical spelling).
          const bases = (Array.isArray(body.bases) ? body.bases : []).filter((entry): entry is string => typeof entry === "string").slice(0, 50).map((base) => normalizeAiBase(base));
          const before = data.config;
          await data.updateConfig((next) => {
            if (path.endsWith("approve")) {
              next.allowedAiBases = [...new Set([...next.allowedAiBases, ...bases])].slice(0, 50);
              next.pendingAiBases = next.pendingAiBases.filter((base) => !baseIsApproved(base, next.allowedAiBases));
            } else {
              next.pendingAiBases = next.pendingAiBases.filter((base) => !bases.some((dismissed) => approvalCovers(dismissed, base) && approvalCovers(base, dismissed)));
            }
          });
          if (path.endsWith("approve")) for (const entry of approvedBases(before.allowedAiBases, bases)) await note(entry.action, entry);
          else for (const base of before.pendingAiBases.filter((pending) => !data.config.pendingAiBases.includes(pending)).slice(0, 10)) await note("ai.dismiss", { object: base });
          sendJson(response, 200, { saved: true });
          return;
        }
        // The owner's switch and caps on what the server spends on AI: only this panel (and the command line, through it) changes them.
        if (path === "/admin/api/spend" && request.method === "GET") {
          sendJson(response, 200, adminSpend());
          return;
        }
        if (path === "/admin/api/spend" && request.method === "POST") {
          const before = spendSettingsOf(data.config);
          await data.updateConfig((next) => {
            next.spend = applySpendChanges(spendSettingsOf(next), body);
          });
          for (const entry of spendChanges(before, spendSettingsOf(data.config))) await note(entry.action, entry);
          // Switched off: every autopilot stops at once, the call in flight included, and is paused (not failed); a director question in
          // flight is abandoned and answered with the switch's refusal.
          if (body.paused === true) {
            books.stopAll();
            for (const controller of asking) controller.abort(pausedError());
          }
          sendJson(response, 200, adminSpend());
          return;
        }
        if (path === "/admin/api/tunnel/configure" && request.method === "POST") {
          try {
            await tunnel.configure({ token: typeof body.token === "string" ? body.token : "", hostname: typeof body.hostname === "string" ? body.hostname : undefined });
          } catch (error) {
            throw new HttpError(422, "tunnel", error instanceof Error ? error.message : String(error));
          }
          const started = await tunnel.start();
          await note("tunnel.start");
          sendJson(response, 200, started);
          return;
        }
        if (path === "/admin/api/tunnel/restart" && request.method === "POST") {
          const restarted = await tunnel.restart();
          await note("tunnel.restart");
          sendJson(response, 200, restarted);
          return;
        }
        if (path === "/admin/api/tunnel/remove" && request.method === "POST") {
          const removed = await tunnel.remove();
          await note("tunnel.remove");
          sendJson(response, 200, removed);
          return;
        }
        if (path === "/admin/api/updates" && request.method === "GET") {
          sendJson(response, 200, await updateInfo());
          return;
        }
        // The last updates: how each ended, what the supervisor verified, and why one was refused.
        if (path === "/admin/api/updates/history" && request.method === "GET") {
          sendJson(response, 200, { max: UPDATE_HISTORY_MAX, entries: await updateHistory.list() });
          return;
        }
        if (path === "/admin/api/updates" && request.method === "POST") {
          const wanted = typeof body.version === "string" ? body.version : undefined;
          let accepted: Awaited<ReturnType<typeof requestUpdate>>;
          try {
            accepted = await requestUpdate({ ...body, confirmed: true }, "admin");
          } catch (error) {
            const mapped = errorStatus(error);
            if (refusalIsLogged(mapped.status)) await note("update.request", { ok: false, code: mapped.code, object: wanted, detail: SERVER_VERSION });
            throw error;
          }
          await note("update.request", { object: accepted.version, detail: SERVER_VERSION });
          sendJson(response, 202, accepted);
          return;
        }
        if (path === "/admin/api/scopes" && request.method === "GET") {
          sendJson(response, 200, { scopes: ["read", "write", "run", "update"].filter(isScope) });
          return;
        }
        // The owner's view of the books' MCP endpoints: the switches, the apps connected through OAuth, the passkeys, and what was called.
        const adminPath = path.split("?")[0];
        if (adminPath === "/admin/api/mcp" && request.method === "GET") {
          sendJson(response, 200, {
            publicUrl: data.config.publicUrl ?? "",
            canAddPasskey: oauth.canAddPasskey,
            passkeys: oauth.passkeyViews(),
            books: books.all().map(({ book }) => {
              // A book that has no MCP state yet is listed with the slug it would get: looking at the panel gives no book an address.
              const state: McpBookState = mcpBooks.peek(book.bookId) ?? { bookId: book.bookId, slug: mcpBooks.propose(book.bookId, book.title), enabled: false, updatedAt: new Date(0).toISOString() };
              return { ...describeMcp(state, mcpAddresses()), title: book.title, apps: oauth.grantsOf(book.bookId) };
            }),
          });
          return;
        }
        if (adminPath === "/admin/api/mcp/audit" && request.method === "GET") {
          const query = new URL(path, "http://127.0.0.1").searchParams;
          const whole = (name: string, fallback: number | undefined) => wholeNumber(query, name, fallback);
          const wanted = query.get("book");
          sendJson(response, 200, await mcpAudit.page({ limit: Math.min(whole("limit", 20) as number, 200), before: whole("before", undefined), ...(wanted ? { bookId: wanted.slice(0, 120) } : {}) }));
          return;
        }
        // The books in progress: the state of each autopilot, a page at a time (what is going on first), with the totals of all the books.
        if (adminPath === "/admin/api/runs" && request.method === "GET") {
          const query = new URL(path, "http://127.0.0.1").searchParams;
          const limit = Math.min(wholeNumber(query, "limit", 10) as number, MAX_RUNS_PER_PAGE);
          const offset = wholeNumber(query, "offset", 0, 0) as number;
          const views = await runBoard.collect();
          sendJson(response, 200, {
            now: clock().toISOString(),
            maxConcurrentRuns: data.config.maxConcurrentRuns,
            running: views.filter((view) => view.live).length,
            spendToday: spendStatus().today,
            ...runsPage(views, { limit, offset }),
          });
          return;
        }
        // How the server is (one line, and the checks it is made of) and what its set-up risks: each from a fact of the server, found out when asked.
        if (adminPath === "/admin/api/health" && request.method === "GET") {
          sendJson(response, 200, await healthReport());
          return;
        }
        if (adminPath === "/admin/api/risks" && request.method === "GET") {
          sendJson(response, 200, await riskReport());
          return;
        }
        // What the owner and the clients changed, a page at a time, newest first; `type` limits it to one kind of action and `ok` to what worked or what failed.
        if (adminPath === "/admin/api/log" && request.method === "GET") {
          const query = new URL(path, "http://127.0.0.1").searchParams;
          const type = query.get("type");
          if (type !== null && !(ADMIN_ACTION_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "invalid_request", `\`type\` must be one of: ${ADMIN_ACTION_TYPES.join(", ")}.`);
          const ok = query.get("ok");
          if (ok !== null && ok !== "true" && ok !== "false") throw new HttpError(400, "invalid_request", "`ok` must be true or false.");
          sendJson(response, 200, await adminLog.page({ limit: Math.min(wholeNumber(query, "limit", 20) as number, 200), before: wholeNumber(query, "before", undefined), ...(type ? { type: type as AdminActionType } : {}), ...(ok !== null ? { ok: ok === "true" } : {}) }));
          return;
        }
        if (adminPath === "/admin/api/mcp/book" && request.method === "POST") {
          if (typeof body.bookId !== "string" || !body.bookId) throw new HttpError(400, "invalid_request", "Which book?");
          const runtime = books.get(body.bookId);
          const before = mcpBooks.peek(runtime.book.bookId);
          const state = await setMcp(runtime, asMcpChange(body));
          for (const entry of mcpChanges(runtime.book.bookId, before, state)) await note(entry.action, entry);
          sendJson(response, 200, mcpStatus(state));
          return;
        }
        if (adminPath === "/admin/api/mcp/revoke" && request.method === "POST") {
          if (typeof body.id !== "string" || !body.id) throw new HttpError(400, "invalid_request", "Which app?");
          const grant = oauth.grantInfo(body.id);
          const revoked = await oauth.revokeGrant(body.id);
          if (revoked) await note("oauth.revoke", { object: grant?.bookId, label: grant?.name });
          sendJson(response, 200, { revoked });
          return;
        }
        if (adminPath === "/admin/api/passkeys/link" && request.method === "POST") {
          const link = oauth.passkeyLink();
          await note("passkey.link");
          sendJson(response, 200, link);
          return;
        }
        if (adminPath === "/admin/api/passkeys/rename" && request.method === "POST") {
          await oauth.renamePasskey(body.id, body.label);
          await note("passkey.rename", { object: typeof body.id === "string" ? body.id : undefined, label: typeof body.label === "string" ? body.label : undefined });
          sendJson(response, 200, { renamed: true });
          return;
        }
        if (adminPath === "/admin/api/passkeys/remove" && request.method === "POST") {
          const passkeys = oauth.passkeyViews();
          const target = passkeys.find((key) => key.id === body.id);
          await oauth.removePasskey(body.id, body.confirmLast === true);
          await note("passkey.remove", { object: typeof body.id === "string" ? body.id : undefined, label: target?.label, ...(passkeys.length === 1 ? { detail: "last" } : {}) });
          sendJson(response, 200, { removed: true });
          return;
        }
        throw new HttpError(404, "not_found", "Unknown admin endpoint.");
      })().catch((error) => {
        const mapped = errorStatus(error);
        if (isFailure(mapped)) log(`Admin error${mapped.requestId ? ` ${mapped.requestId}` : ""} on ${request.method} ${request.url}: ${mapped.detail ?? mapped.message}`);
        noteServerError("admin", request, mapped, error);
        if (!response.headersSent) {
          response.setHeader("connection", "close");
          sendError(response, mapped);
        } else response.end();
      });
    });

    for (const server of [api, admin]) {
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.headersTimeout = 20_000;
      server.keepAliveTimeout = 5_000;
      server.maxHeadersCount = 60;
      server.maxConnections = 256;
    }
    try {
      apiPort = await listen(api, apiPort);
      adminPort = await listen(admin, adminPort);
    } catch (error) {
      api.close();
      admin.close();
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === "EADDRINUSE" ? `Port ${apiPort} or ${adminPort} is already in use: is another narrarium-server running? Change the ports with --port and --admin-port.` : `The server could not listen: ${error instanceof Error ? error.message : String(error)}`);
    }
    const heartbeat = setInterval(() => broadcast({ event: "heartbeat", data: { at: new Date().toISOString() } }), 15_000);
    heartbeat.unref();

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      if (bookTimer) clearTimeout(bookTimer);
      for (const stream of streams.keys()) stream.end();
      for (const stop of closers.reverse()) await stop();
      await Promise.allSettled([...summariesInFlight]);
      await Promise.all([api, admin].map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      })));
      await releaseLock();
    };
    stopForLostLock = close;
    if (lockLost) {
      await close();
      throw new Error("The data folder lock was lost while the server was starting.");
    }
    return {
      url: `http://127.0.0.1:${apiPort}`,
      port: apiPort,
      adminUrl: `http://127.0.0.1:${adminPort}`,
      adminPort,
      data,
      books,
      auth,
      tunnel,
      spend,
      servers: { api, admin },
      mcp: { books: mcpBooks, audit: mcpAudit },
      oauth,
      allowedBases: () => [...data.config.allowedAiBases],
      close,
    };
  } catch (error) {
    for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => undefined);
    await releaseLock();
    throw error;
  }
}
