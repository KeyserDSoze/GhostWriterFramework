import { redactSecrets } from "../ai/redact.js";
import { endpointOrigin } from "../ai/request.js";
import { AiFallbackBlockedError, AiProviderError, AiPromptTooLargeError, AiReplyRejectedError, AiRoutingBudgetError, AiUnavailableError } from "../ai/types.js";
import { isBookConflictError } from "../book/store.js";
import { FrontmatterError } from "../markdown/frontmatter.js";
import { StructuredReplyError } from "../util/json.js";
import { clipText } from "../util/text.js";
import { AUTOPILOT_ERROR_KINDS, type AutopilotErrorDetail, type AutopilotErrorKind } from "./types.js";

/** Characters of one text of an error's detail (a model, a provider, an integration): they are names, not messages. */
const MAX_DETAIL_CHARACTERS = 160;
/** Retries are counted up to this, far above any the engine grants: a number from a file can never be bigger. */
const MAX_RETRY_COUNT = 99;

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
  if (source.code === "frontmatter_invalid" || isA(error, "FrontmatterError", FrontmatterError)) return "profile";
  if (isA(error, "AiPromptTooLargeError", AiPromptTooLargeError)) return "limit";
  if (isA(error, "AiRoutingBudgetError", AiRoutingBudgetError)) return "budget";
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

function detailOf(error: unknown): AutopilotErrorDetail {
  const source = record(error);
  const target = record(source.target);
  const status = httpStatus(source.status);
  const endpoint = endpointOrigin(target.endpoint ?? source.endpoint);
  const model = shortText(source.model) ?? shortText(target.model);
  const provider = shortText(source.provider) ?? shortText(target.provider);
  const integration = shortText(source.integrationId) ?? shortText(target.integrationId);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(integration ? { integration } : {}),
  };
}

/**
 * What kind of failure an error is, and where it happened, from what the engine knows of its own errors: a status (401 and 403 are
 * `auth`, 429 `rate_limit`, 408 `timeout`, any other 4xx or 5xx `provider`), the flags of `AiProviderError` (`timedOut`, `truncated`,
 * `transient`), its subclasses (`AiPromptTooLargeError` is `limit`, `AiRoutingBudgetError` `budget`, `AiFallbackBlockedError` and
 * `AiUnavailableError` `refused`), `FrontmatterError` (`profile`) and a file conflict (`conflict`); an error that says none of these
 * is read by its words (a provider that does not say `timedOut` still says "timed out"), and what is still nothing is `unknown`.
 * A class, a status or a flag always decides before the words do. The detail holds the status, the origin of the integration's address
 * (never its path or query), the model, the provider and the integration, with no credential in any of them: whatever the error carries
 * is redacted, and the endpoint is cut down to its origin. It is empty for an error that knows none of this.
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
  const model = shortText(source.model);
  const provider = shortText(source.provider);
  const integration = shortText(source.integration);
  const attempt = retryCount(source.attempt);
  const retries = retryCount(source.retries);
  const detail: AutopilotErrorDetail = {
    ...(status !== undefined ? { status } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(integration ? { integration } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(retries !== undefined ? { retries } : {}),
  };
  return Object.keys(detail).length ? detail : undefined;
}
