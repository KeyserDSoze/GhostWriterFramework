import { normalizeErrorBody } from "../ai/provider-error.js";
import { redactSecrets } from "../ai/redact.js";
import { endpointOrigin } from "../ai/request.js";
import { AiFallbackBlockedError, AiProviderError, AiPromptTooLargeError, AiReplyRejectedError, AiRoutingBudgetError, AiToolsRequiredError, AiUnavailableError, TRANSPORT_TAIL_CHARACTERS, type AiLeftOutReason, type AiStreamEnd, type AiTimeoutPhase, type AiUnusableWhy } from "../ai/types.js";
import { isBookConflictError } from "../book/store.js";
import { FrontmatterError } from "../markdown/frontmatter.js";
import { GITHUB_CONFLICT_CODE } from "../server/protocol.js";
import { StructuredReplyError } from "../util/json.js";
import { clipText } from "../util/text.js";
import { AUTOPILOT_ERROR_KINDS, MAX_ROUTE_STEPS, type AutopilotErrorDetail, type AutopilotErrorKind, type AutopilotRouteStep, type AutopilotTransportDetail } from "./types.js";

/** Characters of one text of an error's detail (a model, a provider, an integration): they are names, not messages. */
const MAX_DETAIL_CHARACTERS = 160;
/** Retries are counted up to this, far above any the engine grants: a number from a file can never be bigger. */
const MAX_RETRY_COUNT = 99;
/** The longest deadline or wait a detail read from a file can name: a day, far above the four hours and the five minutes the engine allows. */
const MAX_TIMEOUT_MS = 86_400_000;
/** The most files a conflict with GitHub is said to have: a book holds far fewer. */
const MAX_CONFLICT_FILES = 1_000_000;
const TIMEOUT_PHASES: readonly AiTimeoutPhase[] = ["start", "idle", "total"];

const TIMEOUT_WORDS = /\btime[ds]?[ -]?out\b|deadline exceeded/i;
const RATE_LIMIT_WORDS = /\brate[ _-]?limit|too many requests/i;
const NETWORK_WORDS = /fetch failed|failed to fetch|\bnetwork\b|connection (?:error|reset|refused|closed|lost|aborted|failed)|\beconn\w*|\benotfound\b|\beai_again\b|\betimedout\b|\bsocket\b|getaddrinfo|\bdns\b|\boffline\b|unreachable|not reachable|stream ended|could not be read|empty stream|other side closed/i;
const OVERLOAD_WORDS = /overload|temporar|unavailable|capacity|\bbusy\b|try again/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Whether an error is of a class, also when it comes from another copy of the engine (a bundle can hold two): by the class, or by the name its constructor gives it (a literal: a bundler may rename the class). */
function isA(error: unknown, name: string, type: abstract new (...args: never[]) => unknown): boolean {
  return error instanceof type || record(error).name === name;
}

function kindOfStatus(status: unknown): AutopilotErrorKind | undefined {
  if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  return status >= 400 && status <= 599 ? "provider" : undefined;
}

/** The words an error says, its message and its codes, to read what its status and its flags do not say. */
function wordsOf(error: unknown): string {
  if (typeof error === "string") return error;
  const source = record(error);
  const cause = record(source.cause);
  return [source.message, source.code, cause.code].filter((entry): entry is string => typeof entry === "string").join(" ");
}

function kindOf(error: unknown): AutopilotErrorKind {
  if (isBookConflictError(error)) return "conflict";
  const source = record(error);
  // The server's commits and GitHub's changed the same files: the author chooses, and repeating the step cannot settle it.
  if (source.code === GITHUB_CONFLICT_CODE) return "conflict";
  if (source.code === "frontmatter_invalid" || isA(error, "FrontmatterError", FrontmatterError)) return "profile";
  if (isA(error, "AiPromptTooLargeError", AiPromptTooLargeError)) return "limit";
  if (isA(error, "AiRoutingBudgetError", AiRoutingBudgetError)) return "budget";
  if (isA(error, "AiToolsRequiredError", AiToolsRequiredError)) return "config";
  if (isA(error, "AiFallbackBlockedError", AiFallbackBlockedError) || isA(error, "AiUnavailableError", AiUnavailableError)) return "refused";
  if (source.truncated === true) return "truncated";
  if (source.timedOut === true) return "timeout";
  const byStatus = kindOfStatus(source.status);
  if (byStatus) return byStatus;
  const words = wordsOf(error);
  if (TIMEOUT_WORDS.test(words)) return "timeout";
  if (RATE_LIMIT_WORDS.test(words)) return "rate_limit";
  if (NETWORK_WORDS.test(words)) return "network";
  if (!isA(error, "AiProviderError", AiProviderError) && !isA(error, "AiReplyRejectedError", AiReplyRejectedError) && !isA(error, "StructuredReplyError", StructuredReplyError)) return "unknown";
  // The engine marks a failure that depends on the moment `transient`: a connection that dropped is the likeliest, an overloaded provider the other.
  return source.transient === true && !OVERLOAD_WORDS.test(words) ? "network" : "provider";
}

/** A name or an id for the detail: without a credential, on one line, short. `undefined` for anything that is not a text. */
function shortText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Cut first, so that a text of any size costs the same to redact; a credential cut in two is left in the part that is cut away, or is shorter than what the pattern knows.
  const text = clipText(redactSecrets(clipText(value, MAX_DETAIL_CHARACTERS * 4)).replace(/\s+/g, " ").trim(), MAX_DETAIL_CHARACTERS).trim();
  return text || undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** A deadline in milliseconds: a whole number from one up to a day (a fraction is rounded). */
function timeoutMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = Math.round(value);
  return milliseconds >= 1 && milliseconds <= MAX_TIMEOUT_MS ? milliseconds : undefined;
}

/** A wait in milliseconds, as a provider's `Retry-After` says it: a whole number from zero (a provider that says "now" says a value) up to a day; a fraction is rounded. */
function waitMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = Math.round(value) || 0;
  return milliseconds >= 0 && milliseconds <= MAX_TIMEOUT_MS ? milliseconds : undefined;
}

function timeoutPhase(value: unknown): AiTimeoutPhase | undefined {
  return TIMEOUT_PHASES.find((phase) => phase === value);
}

/** How many files a conflict with GitHub has: a whole number from one. */
function conflictFiles(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CONFLICT_FILES ? value : undefined;
}

const STREAM_ENDS: readonly AiStreamEnd[] = ["done", "closed", "reset", "error", "timeout"];
/** The most a count of bytes, chunks, events or characters can be in a detail read from a file: far above what a call may carry (`MAX_STREAM_TRANSPORT_BYTES`), so that a number from a file is never bigger. */
const MAX_TRANSPORT_COUNT = 10_000_000_000;
/** The longest request id a detail keeps: letters, digits and a few signs. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;

function transportCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TRANSPORT_COUNT ? Math.round(value) : undefined;
}

/**
 * The end of a stream as a detail keeps it: the last `TRANSPORT_TAIL_CHARACTERS` characters of a longer text, with credentials replaced. It is cut to a window longer than what is kept before
 * the credentials are replaced and to what is kept after, so that a credential that the cut would divide is replaced whole and no fragment of one is left.
 */
function tailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = redactSecrets(value.slice(-TRANSPORT_TAIL_CHARACTERS * 3)).slice(-TRANSPORT_TAIL_CHARACTERS);
  return text.trim() ? text : undefined;
}

/**
 * What the transport saw, from what an error of the engine's client carries (`transport`, `partialText`) or from a detail read from a file (`transport`, with `partialCharacters`): only the known fields
 * that are valid, no credential in any of them. `undefined` when nothing is left.
 */
function transportDetailOf(transport: unknown, partialText: unknown, partialCount?: unknown): AutopilotTransportDetail | undefined {
  const source = record(transport);
  const status = httpStatus(source.status);
  const bytes = transportCount(source.bytes);
  const chunks = transportCount(source.chunks);
  const events = transportCount(source.events);
  const lastChunkAfterMs = transportCount(source.lastChunkAfterMs);
  const silentMs = transportCount(source.silentMs);
  const end = STREAM_ENDS.find((entry) => entry === source.end);
  const finishReason = shortText(source.finishReason)?.slice(0, 60);
  const tail = tailText(source.tail);
  const requestId = typeof source.requestId === "string" && REQUEST_ID.test(source.requestId) ? source.requestId : undefined;
  const partialCharacters = typeof partialText === "string" ? partialText.length : transportCount(partialCount);
  const detail: AutopilotTransportDetail = {
    ...(status !== undefined ? { status } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(chunks !== undefined ? { chunks } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(lastChunkAfterMs !== undefined ? { lastChunkAfterMs } : {}),
    ...(silentMs !== undefined ? { silentMs } : {}),
    ...(end ? { end } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(typeof source.usageReceived === "boolean" ? { usageReceived: source.usageReceived } : {}),
    ...(typeof source.usageRequested === "boolean" ? { usageRequested: source.usageRequested } : {}),
    ...(tail ? { tail } : {}),
    ...(requestId ? { requestId } : {}),
    ...(partialCharacters ? { partialCharacters } : {}),
  };
  // A response that carried nothing (a refusal: its status is the detail's own) says nothing more; a request id, or anything that arrived, does.
  const says = (detail.bytes ?? 0) > 0 || detail.end || detail.finishReason || detail.tail || detail.requestId || detail.partialCharacters;
  return says ? detail : undefined;
}

const ROUTE_OUTCOMES: ReadonlyArray<AutopilotRouteStep["outcome"]> = ["ok", "failed", "timeout", "cancelled", "left-out"];
const LEFT_OUT_REASONS: readonly AiLeftOutReason[] = ["unusable", "no-tool-calls", "boundary", "context-window", "budget", "not-acknowledged", "out-of-time"];
const UNUSABLE_WHYS: readonly AiUnusableWhy[] = ["integration-missing", "provider-unsupported", "model-missing", "task-not-allowed"];
/** The most characters of what a provider said that a step of a route keeps. */
const MAX_STEP_MESSAGE_CHARACTERS = 240;
/** The most tokens a step can say a prompt or a window has: far above any window, so that a number from a file is never bigger. */
const MAX_STEP_TOKENS = 100_000_000;

function wholeNumber(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined;
}

/** What a provider said, for a step of a route: on one line, without a credential, short. */
function stepMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = clipText(redactSecrets(clipText(value, MAX_STEP_MESSAGE_CHARACTERS * 4)).replace(/\s+/g, " ").trim(), MAX_STEP_MESSAGE_CHARACTERS).trim();
  return text || undefined;
}

/** An API version as a detail keeps it: a short word of letters, digits and `-._` (`2025-01-01-preview`, `v1`), nothing else. */
function versionOf(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(text) ? text : undefined;
}

/** One step of a route, from what an error of the engine's client carries or from a detail read from a file: only the known fields that are valid, no credential in any of them. */
function routeStepOf(value: unknown): AutopilotRouteStep | undefined {
  const source = record(value);
  const position = wholeNumber(source.position, 99);
  const model = shortText(source.model);
  const outcome = ROUTE_OUTCOMES.find((entry) => entry === source.outcome);
  if (position === undefined || !model || !outcome) return undefined;
  const integrationId = shortText(source.integrationId) ?? "";
  const endpoint = endpointOrigin(source.endpoint);
  const apiVersion = versionOf(source.apiVersion);
  const body = normalizeErrorBody(source.body, redactSecrets);
  const status = httpStatus(source.status);
  const durationMs = wholeNumber(source.durationMs, MAX_TIMEOUT_MS);
  const message = stepMessage(source.message);
  const phase = timeoutPhase(source.timeoutPhase);
  const timeoutMs = timeoutMilliseconds(source.timeoutMs);
  const leftOut = LEFT_OUT_REASONS.find((entry) => entry === source.leftOut);
  const why = UNUSABLE_WHYS.find((entry) => entry === source.why);
  const promptTokens = wholeNumber(source.promptTokens, MAX_STEP_TOKENS);
  const windowTokens = wholeNumber(source.windowTokens, MAX_STEP_TOKENS);
  return {
    position,
    integrationId,
    integrationName: shortText(source.integrationName) ?? integrationId,
    provider: shortText(source.provider) ?? "",
    model,
    outcome,
    ...(endpoint ? { endpoint } : {}),
    ...(apiVersion ? { apiVersion } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(body ? { body } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(message ? { message } : {}),
    ...(phase ? { timeoutPhase: phase } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(source.routing === true ? { routing: true } : {}),
    ...(leftOut ? { leftOut } : {}),
    ...(why ? { why } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(windowTokens !== undefined ? { windowTokens } : {}),
  };
}

/** The route of a failed call as a detail keeps it: every step that is valid, in order, at most `MAX_ROUTE_STEPS`. `undefined` when none is. */
function routeDetailOf(value: unknown): AutopilotRouteStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value.slice(0, MAX_ROUTE_STEPS).map(routeStepOf).filter((step): step is AutopilotRouteStep => step !== undefined);
  return steps.length ? steps : undefined;
}

function detailOf(error: unknown): AutopilotErrorDetail {
  const source = record(error);
  const target = record(source.target);
  const status = httpStatus(source.status);
  const endpoint = endpointOrigin(target.endpoint ?? source.endpoint);
  const apiVersion = versionOf(target.apiVersion ?? source.apiVersion);
  const body = normalizeErrorBody(source.body, redactSecrets);
  const model = shortText(source.model) ?? shortText(target.model);
  const provider = shortText(source.provider) ?? shortText(target.provider);
  const integration = shortText(source.integrationId) ?? shortText(target.integrationId);
  // What the provider asked to wait, when it said: a 429 or a 503 with `Retry-After`. The client folds the wait of an earlier candidate into the error it ends with, so that the run waits
  // long enough; for any other status it is not what this failure says, and is left out.
  const retryAfterMs = status === 429 || status === 503 ? waitMilliseconds(source.retryAfterMs) : undefined;
  // The deadline that ran out, for a request of the engine's client that timed out.
  const timeout = record(source.timeout);
  const timeoutMs = timeoutMilliseconds(timeout.ms);
  const phase = timeoutPhase(timeout.phase);
  // A conflict with GitHub says how many files the author has to decide about.
  const githubConflicts = source.code === GITHUB_CONFLICT_CODE ? conflictFiles(source.total) : undefined;
  // What the transport saw of a call that failed after the provider answered, and how much of the reply had arrived.
  const transport = transportDetailOf(source.transport, source.partialText);
  // Every candidate of the route of the call, the ones asked and the ones left out: the fields above are the last one's.
  const route = routeDetailOf(source.route);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(apiVersion ? { apiVersion } : {}),
    ...(body ? { body } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(integration ? { integration } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(phase ? { timeoutPhase: phase } : {}),
    ...(githubConflicts !== undefined ? { githubConflicts } : {}),
    ...(transport ? { transport } : {}),
    ...(route ? { route } : {}),
  };
}

/**
 * What kind of failure an error is, and where it happened, from what the engine knows of its own errors: a status (401 and 403 are
 * `auth`, 429 `rate_limit`, 408 `timeout`, any other 4xx or 5xx `provider`), the flags of `AiProviderError` (`timedOut`, `truncated`,
 * `transient`), its subclasses (`AiPromptTooLargeError` is `limit`, `AiRoutingBudgetError` `budget`, `AiToolsRequiredError` `config`,
 * `AiFallbackBlockedError` and `AiUnavailableError` `refused`), `FrontmatterError` (`profile`), a file conflict and a conflict with GitHub (`conflict`, the second with
 * `githubConflicts`, the number of files); an error that says none of these
 * is read by its words (a provider that does not say `timedOut` still says "timed out"), and what is still nothing is `unknown`.
 * A class, a status or a flag always decides before the words do. The detail holds the status, the origin of the integration's address
 * (never its path or query), the model, the provider and the integration, with no credential in any of them: whatever the error carries
 * is redacted, and the endpoint is cut down to its origin. For a timeout of the engine's client it also says which deadline ran out
 * (`timeoutPhase`) and how long it was (`timeoutMs`), and for a 429 or a 503 whose provider said when to come back, the wait (`retryAfterMs`).
 * It is empty for an error that knows none of this.
 */
export function classifyAutopilotError(error: unknown): { kind: AutopilotErrorKind; detail: AutopilotErrorDetail } {
  // It runs where a run has just failed: whatever the error is (a getter that throws, a proxy), it must not fail again.
  let kind: AutopilotErrorKind = "unknown";
  let detail: AutopilotErrorDetail = {};
  try {
    kind = kindOf(error);
  } catch {
    // An error nobody can read is of no kind.
  }
  try {
    detail = detailOf(error);
  } catch {
    // And says nothing of where it happened.
  }
  return { kind, detail };
}

/**
 * The fields a failure adds to its activity and to `lastError`: `errorKind`, and `errorDetail` when there is any (the detail of
 * `classifyAutopilotError`, with the retry the failure belongs to when it was retried).
 */
export function autopilotErrorFields(error: unknown, retry?: { attempt: number; retries: number }): { errorKind: AutopilotErrorKind; errorDetail?: AutopilotErrorDetail } {
  const { kind, detail } = classifyAutopilotError(error);
  const full: AutopilotErrorDetail = { ...detail, ...(retry ? { attempt: retry.attempt, retries: retry.retries } : {}) };
  return { errorKind: kind, ...(Object.keys(full).length ? { errorDetail: full } : {}) };
}

/** A kind read from a file: one of the closed list, or nothing. */
export function normalizeErrorKind(value: unknown): AutopilotErrorKind | undefined {
  return typeof value === "string" && (AUTOPILOT_ERROR_KINDS as readonly string[]).includes(value) ? value as AutopilotErrorKind : undefined;
}

function retryCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_RETRY_COUNT ? value : undefined;
}

/** A detail read from a file (also a hand-edited one): only the known fields that are valid, the endpoint only as an origin, no credential. `undefined` when nothing is left. */
export function normalizeErrorDetail(value: unknown): AutopilotErrorDetail | undefined {
  const source = record(value);
  const status = httpStatus(source.status);
  const endpoint = endpointOrigin(source.endpoint);
  const apiVersion = versionOf(source.apiVersion);
  const body = normalizeErrorBody(source.body, redactSecrets);
  const model = shortText(source.model);
  const provider = shortText(source.provider);
  const integration = shortText(source.integration);
  const retryAfterMs = waitMilliseconds(source.retryAfterMs);
  const attempt = retryCount(source.attempt);
  const retries = retryCount(source.retries);
  const timeoutMs = timeoutMilliseconds(source.timeoutMs);
  const phase = timeoutPhase(source.timeoutPhase);
  const githubConflicts = conflictFiles(source.githubConflicts);
  const transport = transportDetailOf(source.transport, undefined, record(source.transport).partialCharacters);
  const route = routeDetailOf(source.route);
  const detail: AutopilotErrorDetail = {
    ...(status !== undefined ? { status } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(apiVersion ? { apiVersion } : {}),
    ...(body ? { body } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(integration ? { integration } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(phase ? { timeoutPhase: phase } : {}),
    ...(githubConflicts !== undefined ? { githubConflicts } : {}),
    ...(transport ? { transport } : {}),
    ...(route ? { route } : {}),
  };
  return Object.keys(detail).length ? detail : undefined;
}
