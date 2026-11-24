/**
 * Stateless OAuth token broker for Google Drive, Microsoft OneDrive and GitHub.
 *
 * A browser-only app cannot keep a client secret, and without one Google gives a web
 * client no refresh token while Microsoft caps the refresh token of a single-page app at
 * 24 hours. The secrets therefore live in the Worker environment: this module swaps
 * authorization codes for tokens and renews them on the site's behalf, and answers
 * with plain JSON. It remembers nothing (no KV, no logging of any kind); the browser
 * keeps the refresh token.
 *
 * CORS is not authentication. The Origin check only stops other websites from driving a
 * visitor's browser to this Worker; a caller without an Origin header (curl, a server)
 * is served as well. What protects the secret is that it never leaves the Worker. A
 * stolen refresh token stays exactly as dangerous as it always was, which is why the site
 * treats it as a secret.
 */

import { allowedRedirectUris, resolveAllowedOrigin } from "./config.js";
import { createRateLimiter } from "./rate-limit.js";

/** Largest request body accepted, in bytes. */
export const MAX_REQUEST_BYTES = 8 * 1024;
/** Largest provider response read, in bytes. */
export const MAX_UPSTREAM_BYTES = 64 * 1024;
/** Time allowed for one provider call, reading its answer included. */
export const UPSTREAM_TIMEOUT_MS = 10_000;
/** Best-effort limit: this many POST requests per address in each window. */
export const RATE_LIMIT_MAX_REQUESTS = 30;
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Distinct addresses remembered at once; the oldest are forgotten beyond this. */
const RATE_LIMIT_MAX_TRACKED = 5_000;

const MAX_CREDENTIAL_LENGTH = 4096;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CODE_VERIFIER_LENGTH = 128;
const MAX_SHORT_FIELD_LENGTH = 2048;

/** Name of the optional Workers Rate Limiting binding (wrangler.toml [[ratelimits]]). */
export const RATE_LIMIT_BINDING = "OAUTH_RATE_LIMITER";
/** The binding counts in fixed windows of unknown phase; this is the longest wait a client can need. */
const RATE_LIMIT_BINDING_RETRY_AFTER_SECONDS = 60;

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "narrarium-oauth-broker";

/** Fixed scope of the Microsoft requests; never taken from the caller. */
const MICROSOFT_SCOPE = "User.Read Files.ReadWrite offline_access";

const PROVIDERS = {
  google: {
    name: "Google",
    clientIdVariable: "GOOGLE_CLIENT_ID",
    clientSecretVariable: "GOOGLE_CLIENT_SECRET",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
  },
  microsoft: {
    name: "Microsoft",
    clientIdVariable: "MICROSOFT_CLIENT_ID",
    clientSecretVariable: "MICROSOFT_CLIENT_SECRET",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  },
  github: {
    name: "GitHub",
    clientIdVariable: "GITHUB_APP_CLIENT_ID",
    clientSecretVariable: "GITHUB_APP_CLIENT_SECRET",
    tokenUrl: "https://github.com/login/oauth/access_token",
    grantUrl: (clientId) => `https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`,
  },
};

const ACTIONS = new Set(["token", "refresh", "revoke"]);

// Provider errors that mean the user has to sign in again.
const REAUTHENTICATION_ERRORS = new Set(["invalid_grant", "interaction_required", "consent_required", "login_required"]);

// The only provider error codes ever quoted in a message; anything else stays out.
const KNOWN_PROVIDER_ERRORS = new Set([
  "invalid_request",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "redirect_uri_mismatch",
  "access_denied",
  "invalid_token",
  "temporarily_unavailable",
  "server_error",
]);

// RFC 6749: codes and tokens are printable ASCII.
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

const rateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
  maxTracked: RATE_LIMIT_MAX_TRACKED,
});

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function oauthHeaders(allowedOrigin, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return headers;
}

function jsonResponse(status, payload, allowedOrigin, extraHeaders) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: oauthHeaders(allowedOrigin, extraHeaders),
  });
}

function errorResponse(error, allowedOrigin) {
  return jsonResponse(error.status, { error: error.code, message: error.message }, allowedOrigin, error.headers);
}

// Only the Content-Type request header is ever granted, echoed as the browser spelled it.
function grantedRequestHeaders(request) {
  const requested = (request.headers.get("Access-Control-Request-Headers") || "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.toLowerCase() === "content-type");
  return requested.length > 0 ? requested.join(", ") : "Content-Type";
}

function preflightResponse(request, allowedOrigin) {
  const headers = oauthHeaders(allowedOrigin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", grantedRequestHeaders(request));
  headers.set("Access-Control-Max-Age", "600");
  return new Response(null, { status: 204, headers });
}

export function isOAuthPath(pathname) {
  return pathname === "/oauth" || pathname.startsWith("/oauth/");
}

function matchRoute(pathname) {
  if (pathname === "/oauth/status") return { status: true };
  const parts = pathname.split("/");
  if (parts.length === 4 && parts[1] === "oauth" && Object.hasOwn(PROVIDERS, parts[2]) && ACTIONS.has(parts[3])) {
    return { provider: parts[2], action: parts[3] };
  }
  return null;
}

function readConfigured(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readCredentials(env, provider) {
  const clientId = readConfigured(env[provider.clientIdVariable]);
  const clientSecret = readConfigured(env[provider.clientSecretVariable]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function rateLimited(retryAfter) {
  return new HttpError(429, "rate_limited", "Too many requests. Try again in a moment.", { "Retry-After": String(retryAfter) });
}

// The optional Workers Rate Limiting binding adds a limit shared by the isolates of a data centre.
// A missing or failing binding never blocks a request: the in-memory limit above still applies.
async function enforceBindingRateLimit(env, address) {
  const binding = env[RATE_LIMIT_BINDING];
  if (!binding || typeof binding.limit !== "function") return;
  let verdict;
  try {
    verdict = await binding.limit({ key: address });
  } catch {
    return;
  }
  if (verdict && verdict.success === false) throw rateLimited(RATE_LIMIT_BINDING_RETRY_AFTER_SECONDS);
}

async function enforceRateLimit(request, env) {
  // Cloudflare always sets cf-connecting-ip; without it (local dev, tests) there is nothing to key on.
  const address = request.headers.get("cf-connecting-ip")?.trim();
  if (!address) return;
  const { limited, retryAfter } = rateLimiter.check(address);
  if (limited) throw rateLimited(retryAfter);
  await enforceBindingRateLimit(env, address);
}

function payloadTooLarge() {
  return new HttpError(413, "payload_too_large", `The request body is larger than ${MAX_REQUEST_BYTES} bytes.`);
}

// Reads at most maxBytes; returns null (and stops reading) as soon as the stream exceeds them.
async function readLimited(stream, maxBytes) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonBody(request) {
  const mediaType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(400, "invalid_request", "Content-Type must be application/json.");
  }
  if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) throw payloadTooLarge();

  const bytes = await readLimited(request.body, MAX_REQUEST_BYTES);
  if (bytes === null) throw payloadTooLarge();

  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_request", "The body must be valid UTF-8 JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "The body must be a JSON object.");
  }
  return value;
}

// Unknown fields are never read, so nothing but the documented ones can reach a provider.
function readField(body, name, maxLength = MAX_CREDENTIAL_LENGTH) {
  const value = Object.hasOwn(body, name) ? body[name] : undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength || !PRINTABLE_ASCII.test(value)) {
    throw new HttpError(400, "invalid_request", `"${name}" must be a non-empty string of printable ASCII, at most ${maxLength} characters.`);
  }
  return value;
}

function oversizedResponse(provider) {
  return new HttpError(502, "upstream_error", `${provider.name} answered with more data than the broker reads.`);
}

async function readUpstreamText(response, provider) {
  if (Number(response.headers?.get?.("Content-Length")) > MAX_UPSTREAM_BYTES) throw oversizedResponse(provider);
  if (response.body && typeof response.body.getReader === "function") {
    const bytes = await readLimited(response.body, MAX_UPSTREAM_BYTES);
    if (bytes === null) throw oversizedResponse(provider);
    return new TextDecoder().decode(bytes);
  }
  const text = typeof response.text === "function" ? await response.text() : "";
  if (text.length > MAX_UPSTREAM_BYTES) throw oversizedResponse(provider);
  return text;
}

function toUpstreamError(provider, error) {
  if (error instanceof HttpError) return error;
  if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new HttpError(504, "upstream_timeout", `${provider.name} did not answer in time.`);
  }
  return new HttpError(502, "upstream_error", `${provider.name} could not be reached.`);
}

// One call to a fixed provider endpoint. Nothing of the caller's request is forwarded.
async function callUpstream(provider, url, init) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HttpError(504, "upstream_timeout", `${provider.name} did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`));
    }, UPSTREAM_TIMEOUT_MS);
  });
  const exchange = (async () => {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    return { status: response.status, text: await readUpstreamText(response, provider) };
  })();
  try {
    return await Promise.race([exchange, timeout]);
  } catch (error) {
    throw toUpstreamError(provider, error);
  } finally {
    clearTimeout(timer);
  }
}

function postForm(provider, url, fields) {
  return callUpstream(provider, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The provider's error code is quoted only if it is a known one; its description never is.
function describeFailure(provider, status, data, { reauthenticate }) {
  const code = data !== null && typeof data === "object" && typeof data.error === "string" ? data.error : "";
  if (reauthenticate && status >= 400 && status < 500 && REAUTHENTICATION_ERRORS.has(code)) {
    return new HttpError(400, "invalid_grant", `${provider.name} rejected the authorization code or refresh token. Connect again.`);
  }
  if (KNOWN_PROVIDER_ERRORS.has(code)) {
    return new HttpError(502, "upstream_error", `${provider.name} rejected the request (${code}).`);
  }
  return new HttpError(502, "upstream_error", `${provider.name} answered with an unexpected error (HTTP ${status}).`);
}

function optionalString(value, maxLength = Infinity) {
  return typeof value === "string" && value !== "" && value.length <= maxLength ? value : undefined;
}

function parseExpiresIn(value) {
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  const whole = Math.floor(seconds);
  return Number.isFinite(whole) && whole > 0 ? whole : null;
}

function normalizeTokens(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  if (typeof data.access_token !== "string" || data.access_token === "") return null;
  const expiresIn = parseExpiresIn(data.expires_in);
  if (expiresIn === null) return null;
  return {
    accessToken: data.access_token,
    expiresIn,
    refreshToken: optionalString(data.refresh_token),
    scope: optionalString(data.scope, MAX_SHORT_FIELD_LENGTH),
    idToken: optionalString(data.id_token),
    // Microsoft's client_info (base64url JSON with the account's uid and utid) is relayed
    // untouched: it is never decoded here.
    clientInfo: optionalString(data.client_info, MAX_SHORT_FIELD_LENGTH),
  };
}

async function requestTokens(provider, fields) {
  const { status, text } = await postForm(provider, provider.tokenUrl, fields);
  const data = parseJson(text);
  if (status === 200) {
    const tokens = normalizeTokens(data);
    if (!tokens) throw new HttpError(502, "upstream_error", `${provider.name} answered with an unexpected response.`);
    return tokens;
  }
  throw describeFailure(provider, status, data, { reauthenticate: true });
}

function tokenAnswer(tokens, keys) {
  const body = {};
  for (const key of keys) {
    if (tokens[key] !== undefined) body[key] = tokens[key];
  }
  return { status: 200, body };
}

const noContent = () => ({ status: 204, body: null });

async function googleToken(body, { provider, credentials, origin }) {
  const code = readField(body, "code");
  const exchange = (redirectUri) =>
    requestTokens(provider, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
  let tokens;
  try {
    tokens = await exchange("postmessage");
  } catch (error) {
    // Google's guide to the popup flow says the exchange uses the origin of the page that asked for the code as redirect_uri, while the way
    // that has always worked with it is «postmessage». «postmessage» goes first; only when Google says the redirect URI does not match is the
    // origin tried, and only one that this Worker already allows (the request's own, checked by the caller) is ever sent.
    const mismatch = error instanceof HttpError && error.status === 502 && error.message.includes("(redirect_uri_mismatch)");
    if (!mismatch || !origin) throw error;
    tokens = await exchange(origin);
  }
  return tokenAnswer(tokens, ["accessToken", "expiresIn", "refreshToken", "scope", "idToken"]);
}

async function googleRefresh(body, { provider, credentials }) {
  const refreshToken = readField(body, "refreshToken");
  const tokens = await requestTokens(provider, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  return tokenAnswer(tokens, ["accessToken", "expiresIn", "scope"]);
}

async function googleRevoke(body, { provider }) {
  const token = readField(body, "token");
  const { status, text } = await postForm(provider, provider.revokeUrl, { token });
  if (status >= 200 && status < 300) return noContent();
  const data = parseJson(text);
  // Google answers 400 invalid_token for a token it already considers revoked or expired.
  if (status === 400 && data !== null && typeof data === "object" && data.error === "invalid_token") return noContent();
  throw describeFailure(provider, status, data, { reauthenticate: false });
}

function readRedirectUri(body, env) {
  const redirectUri = readField(body, "redirectUri", MAX_REDIRECT_URI_LENGTH);
  if (!allowedRedirectUris(env).includes(redirectUri)) {
    throw new HttpError(400, "invalid_request", "redirectUri is not on the list of allowed redirect URIs.");
  }
  return redirectUri;
}

async function microsoftToken(body, { provider, credentials, env }) {
  const code = readField(body, "code");
  const codeVerifier = readField(body, "codeVerifier", MAX_CODE_VERIFIER_LENGTH);
  const redirectUri = readRedirectUri(body, env);
  const tokens = await requestTokens(provider, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    scope: MICROSOFT_SCOPE,
    client_info: "1",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  if (!tokens.refreshToken) {
    throw new HttpError(502, "upstream_error", "Microsoft did not return a refresh token. Check that offline_access is granted.");
  }
  return tokenAnswer(tokens, ["accessToken", "expiresIn", "refreshToken", "scope", "idToken", "clientInfo"]);
}

async function microsoftRefresh(body, { provider, credentials }) {
  const refreshToken = readField(body, "refreshToken");
  const tokens = await requestTokens(provider, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPE,
    client_info: "1",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  return tokenAnswer(tokens, ["accessToken", "expiresIn", "refreshToken", "clientInfo"]);
}

// Microsoft offers no revocation endpoint the broker could use for these clients: the site
// forgets its local token and the user revokes the grant from their Microsoft account page.
async function microsoftRevoke(body) {
  readField(body, "token");
  return noContent();
}

// GitHub reports OAuth errors inside an HTTP 200 JSON body ({"error": "bad_verification_code"}), so the
// body is read for an error before the status is trusted. Only these codes, never GitHub's description, are quoted.
const GITHUB_REAUTHENTICATION_ERRORS = new Set(["bad_verification_code", "bad_refresh_token", "invalid_grant"]);

function wrongGithubCredentials() {
  return new HttpError(501, "not_configured", "GitHub sign-in is configured with a wrong client id or secret on this server.");
}

function describeGithubError(provider, status, data) {
  const code = data !== null && typeof data === "object" && typeof data.error === "string" ? data.error : "";
  if (GITHUB_REAUTHENTICATION_ERRORS.has(code)) {
    return new HttpError(400, "invalid_grant", "GitHub rejected the authorization code or refresh token. Connect again.");
  }
  if (code === "unverified_user_email") {
    return new HttpError(400, "invalid_grant", "GitHub says the primary email address of the account is not verified. Verify it on GitHub, then connect again.");
  }
  if (code === "incorrect_client_credentials") return wrongGithubCredentials();
  return describeFailure(provider, status, data, { reauthenticate: false });
}

function nonExpiringGithubToken() {
  return new HttpError(
    502,
    "upstream_error",
    'GitHub returned a token without expiry or refresh token. Turn on "Expire user authorization tokens" in the GitHub App settings.',
  );
}

async function requestGithubTokens(provider, fields) {
  const { status, text } = await postForm(provider, provider.tokenUrl, fields);
  const data = parseJson(text);
  if ((data !== null && typeof data === "object" && typeof data.error === "string") || status !== 200) {
    throw describeGithubError(provider, status, data);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.access_token !== "string" || data.access_token === "") {
    throw new HttpError(502, "upstream_error", `${provider.name} answered with an unexpected response.`);
  }
  const expiresIn = parseExpiresIn(data.expires_in);
  const refreshToken = optionalString(data.refresh_token);
  // A GitHub App without token expiry would hand out a token that lives forever: refuse it.
  if (expiresIn === null || !refreshToken) throw nonExpiringGithubToken();
  return {
    accessToken: data.access_token,
    expiresIn,
    refreshToken,
    refreshTokenExpiresIn: parseExpiresIn(data.refresh_token_expires_in) ?? undefined,
    // GitHub Apps always report an empty scope: it is left out.
    scope: optionalString(data.scope, MAX_SHORT_FIELD_LENGTH),
  };
}

const GITHUB_TOKEN_KEYS = ["accessToken", "expiresIn", "refreshToken", "refreshTokenExpiresIn", "scope"];

async function githubToken(body, { provider, credentials, env }) {
  const code = readField(body, "code");
  const codeVerifier = readField(body, "codeVerifier", MAX_CODE_VERIFIER_LENGTH);
  const redirectUri = readRedirectUri(body, env);
  const tokens = await requestGithubTokens(provider, {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
  return tokenAnswer(tokens, GITHUB_TOKEN_KEYS);
}

// GitHub rotates the refresh token on every use: the answer always carries the new one.
async function githubRefresh(body, { provider, credentials }) {
  const refreshToken = readField(body, "refreshToken");
  const tokens = await requestGithubTokens(provider, {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return tokenAnswer(tokens, GITHUB_TOKEN_KEYS);
}

function basicAuthorization(clientId, clientSecret) {
  let binary = "";
  for (const byte of new TextEncoder().encode(`${clientId}:${clientSecret}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

// Deleting the grant revokes every token the app holds for that user, on every device.
async function githubRevoke(body, { provider, credentials }) {
  const token = readField(body, "token");
  const { status, text } = await callUpstream(provider, provider.grantUrl(credentials.clientId), {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      Authorization: basicAuthorization(credentials.clientId, credentials.clientSecret),
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": GITHUB_USER_AGENT,
    },
    body: JSON.stringify({ access_token: token }),
  });
  // 404: there is no such grant (already revoked, or a token GitHub no longer knows): nothing is left to revoke.
  if ((status >= 200 && status < 300) || status === 404) return noContent();
  if (status === 401) throw wrongGithubCredentials();
  throw describeFailure(provider, status, parseJson(text), { reauthenticate: false });
}

const HANDLERS = {
  "google/token": googleToken,
  "google/refresh": googleRefresh,
  "google/revoke": googleRevoke,
  "microsoft/token": microsoftToken,
  "microsoft/refresh": microsoftRefresh,
  "microsoft/revoke": microsoftRevoke,
  "github/token": githubToken,
  "github/refresh": githubRefresh,
  "github/revoke": githubRevoke,
};

async function handleProviderRoute(request, env, route, allowedOrigin) {
  await enforceRateLimit(request, env);
  const provider = PROVIDERS[route.provider];
  const credentials = readCredentials(env, provider);
  if (!credentials) {
    throw new HttpError(501, "not_configured", `${provider.name} sign-in is not configured on this server.`);
  }
  const body = await readJsonBody(request);
  const result = await HANDLERS[`${route.provider}/${route.action}`](body, { provider, credentials, env, origin: allowedOrigin });
  return jsonResponse(result.status, result.body, allowedOrigin);
}

export async function handleOAuth(request, env) {
  const config = env ?? {};
  const allowedOrigin = resolveAllowedOrigin(request, config);
  try {
    if (request.headers.get("Origin") && !allowedOrigin) {
      throw new HttpError(403, "forbidden_origin", "This origin is not allowed to use the OAuth broker.");
    }
    if (request.method === "OPTIONS") {
      if (!allowedOrigin) throw new HttpError(403, "forbidden_origin", "A preflight request needs an allowed Origin.");
      return preflightResponse(request, allowedOrigin);
    }

    const route = matchRoute(new URL(request.url).pathname);
    if (!route) throw new HttpError(404, "not_found", "Unknown OAuth route.");
    const method = route.status ? "GET" : "POST";
    if (request.method !== method) {
      throw new HttpError(405, "method_not_allowed", `Use ${method} for this route.`, { Allow: `${method}, OPTIONS` });
    }
    if (route.status) {
      const configured = (provider) => readCredentials(config, provider) !== null;
      const flags = {
        google: configured(PROVIDERS.google),
        microsoft: configured(PROVIDERS.microsoft),
        github: configured(PROVIDERS.github),
      };
      return jsonResponse(200, flags, allowedOrigin);
    }
    return await handleProviderRoute(request, config, route, allowedOrigin);
  } catch (error) {
    // Anything that is not one of ours is reported without its message, which could hold a secret.
    return errorResponse(error instanceof HttpError ? error : new HttpError(500, "internal_error", "Unexpected error."), allowedOrigin);
  }
}
