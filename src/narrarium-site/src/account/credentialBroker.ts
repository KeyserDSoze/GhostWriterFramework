/**
 * Client of the stateless OAuth token broker (the Cloudflare Worker, see src/auth-proxy/README.md).
 *
 * The browser keeps the refresh token; the Worker keeps the client secrets, swaps authorization codes and renews
 * access tokens. This module only speaks the broker's documented contract and checks every answer strictly.
 *
 * Nothing in here ever logs: there is no console call on purpose. Error messages are built from fixed text, the HTTP
 * status and the broker's own error code; what the broker says in prose is cut down and scrubbed of anything that
 * looks like a token, and of the very values that were sent, before it is quoted.
 */
import { authBrokerBase } from "@/config/authBroker";

export type BrokerProvider = "google" | "microsoft" | "github";
/** invalid_grant: the refresh token or code no longer works (reconnect). Everything else is about the broker itself. */
export type BrokerErrorCode = "invalid_grant" | "not_configured" | "rate_limited" | "upstream" | "network";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly status?: number;
  /** How long the broker asked to wait (rate limit). */
  readonly retryAfterMs?: number;
  /** Why the provider refused the request, as the broker quotes it: a plain error code and numeric provider codes ("invalid_request AADSTS9002327"). */
  readonly providerDetail?: string;

  constructor(code: BrokerErrorCode, message: string, details: { status?: number; retryAfterMs?: number; providerDetail?: string } = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.providerDetail !== undefined) this.providerDetail = details.providerDetail;
  }
}

export interface BrokerTokens {
  accessToken: string;
  /** Whole seconds the access token stays valid. */
  expiresIn: number;
  /** Google sends one only on (re)consent; Microsoft and GitHub rotate it on every refresh. */
  refreshToken?: string;
  /** GitHub: whole seconds the refresh token stays valid (about six months), when the broker says. */
  refreshTokenExpiresIn?: number;
  scope?: string;
  /** Microsoft's client_info (base64url JSON with uid and utid), passed through untouched. */
  clientInfo?: string;
}

export interface BrokerCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ExchangeCodeRequest =
  | { provider: "google"; code: string }
  | { provider: "microsoft"; code: string; codeVerifier: string; redirectUri: string }
  | { provider: "github"; code: string; codeVerifier: string; redirectUri: string };

const STATUS_TIMEOUT_MS = 4_000;
const TOKEN_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 8_000;
/** A broker that failed to answer the status question is not asked again for this long. */
const UNAVAILABLE_RETRY_MS = 5 * 60_000;
const MAX_RESPONSE_CHARS = 64 * 1024;
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const MAX_MESSAGE_CHARS = 200;

const PROVIDER_NAMES: Record<BrokerProvider, string> = { google: "Google", microsoft: "Microsoft", github: "GitHub" };

const NOT_AVAILABLE: Record<BrokerProvider, boolean> = { google: false, microsoft: false, github: false };

interface Availability {
  base: string;
  flags?: Record<BrokerProvider, boolean>;
  failedAt?: number;
  pending?: Promise<void>;
}

let availability: Availability | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function recentlyFailed(entry: Availability): boolean {
  return entry.failedAt !== undefined && Date.now() - entry.failedAt < UNAVAILABLE_RETRY_MS;
}

/** What is already known about the broker, without any request: undefined while nobody asked yet. */
export function brokerAvailabilitySnapshot(provider: BrokerProvider): boolean | undefined {
  const base = authBrokerBase();
  if (!base) return false;
  const entry = availability;
  if (!entry || entry.base !== base) return undefined;
  if (entry.flags) return entry.flags[provider];
  return recentlyFailed(entry) ? false : undefined;
}

export function resetBrokerAvailabilityForTests(): void {
  availability = null;
}

class ResponseTooLarge extends Error {}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) throw new ResponseTooLarge();
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new ResponseTooLarge();
  return text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function requestStatus(base: string): Promise<Record<BrokerProvider, boolean>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/oauth/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error("unexpected status");
    const body = parseJson(await readLimited(response));
    if (!isRecord(body) || typeof body.google !== "boolean" || typeof body.microsoft !== "boolean") throw new Error("unexpected answer");
    // A Worker that predates GitHub sign-in answers two booleans: that is `github: false`. A `github` that is not a boolean is not an answer.
    if (body.github !== undefined && typeof body.github !== "boolean") throw new Error("unexpected answer");
    return { google: body.google, microsoft: body.microsoft, github: body.github === true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the broker there and configured for this provider? Asked once per session (kept in memory); any error means
 * "not available". An answer that failed is asked again only after a few minutes, so a hiccup at start-up does not
 * switch the feature off for the whole session and a dead Worker is not hammered.
 */
export async function brokerAvailable(provider: BrokerProvider): Promise<boolean> {
  const base = authBrokerBase();
  if (!base) return false;
  if (availability?.base !== base) availability = { base };
  const entry = availability;
  if (entry.flags) return entry.flags[provider];
  if (!entry.pending) {
    if (recentlyFailed(entry)) return false;
    entry.pending = requestStatus(base).then(
      (flags) => { entry.flags = flags; entry.failedAt = undefined; },
      () => { entry.failedAt = Date.now(); },
    ).finally(() => { entry.pending = undefined; });
  }
  await entry.pending;
  return (entry.flags ?? NOT_AVAILABLE)[provider];
}

/** The broker's own explanation, cut short, with printable characters only and no token-like text or sent value. */
function scrub(raw: string, secrets: readonly string[]): string {
  let text = raw.replace(/[^\x20-\x7e]+/g, " ");
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  text = text.replace(/[A-Za-z0-9._~+/=-]{24,}/g, "[redacted]").replace(/\s+/g, " ").trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.round(seconds * 1_000), MAX_RETRY_AFTER_MS) : undefined;
}

/** The provider's plain error code and its numeric codes (AADSTS), when the broker names them; nothing else of the provider's is ever shown. */
function providerDetailOf(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.providerError !== "string" || !/^[a-z_]{1,40}$/.test(body.providerError)) return undefined;
  const numbers = Array.isArray(body.providerCodes)
    ? body.providerCodes.filter((number): number is number => typeof number === "number" && Number.isSafeInteger(number) && number > 0 && number < 100_000_000).slice(0, 3)
    : [];
  return [body.providerError, ...numbers.map((number) => `AADSTS${number}`)].join(" ");
}

function failure(provider: BrokerProvider, what: string, response: Response, text: string, secrets: readonly string[]): BrokerError {
  const body = parseJson(text);
  const brokerCode = isRecord(body) && typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
  const detail = isRecord(body) && typeof body.message === "string" ? scrub(body.message, secrets) : "";
  const { status } = response;
  const code: BrokerErrorCode = status === 400 && brokerCode === "invalid_grant" ? "invalid_grant" : status === 501 ? "not_configured" : status === 429 ? "rate_limited" : "upstream";
  const message = `${PROVIDER_NAMES[provider]} ${what} through the credential broker failed (HTTP ${status}${brokerCode ? `, ${brokerCode}` : ""})${detail ? `: ${detail}` : "."}`;
  const providerDetail = providerDetailOf(body);
  return new BrokerError(code, message, { status, ...(providerDetail ? { providerDetail } : {}), ...(code === "rate_limited" && retryAfterMs(response) !== undefined ? { retryAfterMs: retryAfterMs(response) } : {}) });
}

interface Answer { response: Response; text: string }

async function post(provider: BrokerProvider, action: "token" | "refresh" | "revoke", what: string, body: Record<string, string>, options: BrokerCallOptions = {}, defaultTimeoutMs = TOKEN_TIMEOUT_MS): Promise<Answer> {
  const base = authBrokerBase();
  if (!base) throw new BrokerError("not_configured", "The credential broker is not configured for this build.");
  if (options.signal?.aborted) throw abortError();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs);
  try {
    const response = await fetch(`${base}/oauth/${provider}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    return { response, text: await readLimited(response) };
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (error instanceof ResponseTooLarge) throw new BrokerError("upstream", `${PROVIDER_NAMES[provider]} ${what} through the credential broker returned more data than expected.`);
    // Nothing of the underlying error is passed on: its text could hold what was sent.
    const timedOut = controller.signal.aborted;
    throw new BrokerError("network", `${PROVIDER_NAMES[provider]} ${what} could not reach the credential broker${timedOut ? " (timed out)" : ""}.`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function optionalText(data: Record<string, unknown>, key: string, maxLength: number): string | undefined | null {
  const value = data[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

/** Exactly the documented shape, or nothing: wrong types, empty strings, absurd lifetimes are all refused. */
function parseTokens(data: unknown): BrokerTokens | null {
  if (!isRecord(data)) return null;
  const { accessToken, expiresIn } = data;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > 16_384) return null;
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_IN_SECONDS) return null;
  const refreshToken = optionalText(data, "refreshToken", 4_096);
  const refreshTokenExpiresIn = data.refreshTokenExpiresIn;
  if (refreshTokenExpiresIn !== undefined && (typeof refreshTokenExpiresIn !== "number" || !Number.isInteger(refreshTokenExpiresIn) || refreshTokenExpiresIn < 1 || refreshTokenExpiresIn > 5 * 365 * 24 * 60 * 60)) return null;
  const scope = optionalText(data, "scope", 2_048);
  const idToken = optionalText(data, "idToken", 16_384);
  const clientInfo = optionalText(data, "clientInfo", 2_048);
  if (refreshToken === null || scope === null || idToken === null || clientInfo === null) return null;
  // The ID token is checked like the rest but not handed on: the site reads the profile from the provider's own API.
  return { accessToken, expiresIn, ...(refreshToken ? { refreshToken } : {}), ...(typeof refreshTokenExpiresIn === "number" ? { refreshTokenExpiresIn } : {}), ...(scope ? { scope } : {}), ...(clientInfo ? { clientInfo } : {}) };
}

async function tokensFrom(provider: BrokerProvider, what: string, answer: Answer, secrets: readonly string[]): Promise<BrokerTokens> {
  if (answer.response.status !== 200) throw failure(provider, what, answer.response, answer.text, secrets);
  const tokens = parseTokens(parseJson(answer.text));
  if (!tokens) throw new BrokerError("upstream", `${PROVIDER_NAMES[provider]} ${what} through the credential broker returned an unexpected answer.`, { status: 200 });
  return tokens;
}

/** Swaps an authorization code for tokens: Google's code from the popup flow, or Microsoft's and GitHub's with their PKCE verifier. */
export async function exchangeCode(request: ExchangeCodeRequest, options?: BrokerCallOptions): Promise<BrokerTokens> {
  const body: Record<string, string> = request.provider === "google"
    ? { code: request.code }
    : { code: request.code, codeVerifier: request.codeVerifier, redirectUri: request.redirectUri };
  const secrets = request.provider === "google" ? [request.code] : [request.code, request.codeVerifier];
  const answer = await post(request.provider, "token", "code exchange", body, options);
  return tokensFrom(request.provider, "code exchange", answer, secrets);
}

/** Renews an access token. Microsoft and GitHub rotate the refresh token: the answer then carries the new one to keep, and the old one is dead. */
export async function refresh(provider: BrokerProvider, refreshToken: string, options?: BrokerCallOptions): Promise<BrokerTokens> {
  const answer = await post(provider, "refresh", "token refresh", { refreshToken }, options);
  return tokensFrom(provider, "token refresh", answer, [refreshToken]);
}

/** Revokes a token at the provider (Google; GitHub deletes the app's whole authorization of the user, so it wants a fresh access token). Microsoft's route only acknowledges. */
export async function revoke(provider: BrokerProvider, token: string, options?: BrokerCallOptions): Promise<void> {
  const answer = await post(provider, "revoke", "revocation", { token }, options, REVOKE_TIMEOUT_MS);
  if (answer.response.status < 200 || answer.response.status > 299) throw failure(provider, "revocation", answer.response, answer.text, [token]);
}
