import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { HttpError, retryAfter } from "./errors.js";
import { WindowLimiter } from "./limits.js";
import type { McpAuthenticator, McpScope } from "./mcp-access.js";
import type { McpBooks } from "./mcp-books.js";
import { mcpAddress } from "./mcp.js";
import { PAGE_CSP, PAGE_CSS, PAGE_JS, negotiateLanguage, renderConsent, renderErrorPage, renderRegisterPage, type Lang, type PageScope } from "./oauth-pages.js";
import { OAuthProblem, type GrantView, type OAuthClient, type OAuthStore, type StoredPasskey } from "./oauth-store.js";
import { PASSKEY_ALGORITHMS, WebAuthnError, verifyAssertion, verifyRegistration } from "./webauthn.js";

/**
 * The OAuth 2.1 authorization server of the personal server: what ChatGPT, Claude.ai and the other apps that speak MCP's authorization (the 2025-06-18 specification) need to
 * connect to `/mcp/<slug>` by themselves. The owner is asked on a page that the server serves; he proves it is him with a passkey or the admin code, and chooses what the app
 * may do with that book. Everything here is served on the API's listener, under the host the request came to.
 *
 * Standards: protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591), the authorization code flow with PKCE S256
 * (RFC 7636), resource indicators (RFC 8707), token revocation (RFC 7009), the issuer in the authorization response (RFC 9207). Public clients only.
 */

export const OAUTH_SCOPE_NAMES = ["mcp:read", "mcp:write", "mcp:run"] as const;
const SCOPES: readonly McpScope[] = ["read", "write", "run"];
const PUBLIC_NAME: Record<McpScope, string> = { read: "mcp:read", write: "mcp:write", run: "mcp:run" };
const INTERNAL_NAME: Record<string, McpScope> = { "mcp:read": "read", "mcp:write": "write", "mcp:run": "run" };
const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"];
/** Scopes of OpenID Connect that apps ask for out of habit: they mean nothing here (there is no profile, and a refresh token is always given), so they are left out instead of failing the app. */
const HABITUAL_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

const CODE_MS = 60_000;
const REQUEST_MS = 10 * 60_000;
const ASSERTION_CHALLENGE_MS = 120_000;
const REGISTRATION_CHALLENGE_MS = 5 * 60_000;
const TICKET_MS = 10 * 60_000;
const SPENT_CODE_MS = 10 * 60_000;
const MAX_PENDING = 500;
const MAX_CODES = 1000;
const MAX_TICKETS = 50;
const REGISTER_BODY = 16 * 1024;
const FORM_BODY = 8 * 1024;
const PAGE_BODY = 8 * 1024;
const MAX_STATE_CHARACTERS = 1024;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_CHARACTERS = 2048;
const MAX_NAME_CHARACTERS = 80;
const MAX_LABEL_CHARACTERS = 40;
export const DEFAULT_REGISTRATIONS_PER_HOUR = 20;
export const DEFAULT_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_MAX_CLIENTS = 500;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface OAuthLimits {
  registrationsPerHour?: number;
  requestsPerMinute?: number;
  maxClients?: number;
}

/** What the owner's consent page and passkey page do that the admin log keeps (never a code, a token or a credential). */
export interface OAuthAction {
  action: "oauth.approve" | "oauth.deny" | "passkey.add";
  ok: boolean;
  /** `admin`: the owner proved who he is (a passkey, the admin code); `anonymous`: nobody did. */
  actor: "admin" | "anonymous";
  /** The book (for an approval) or the passkey's id. */
  object?: string;
  /** The app's name, or the passkey's. */
  label?: string;
  /** What proved it and what was allowed: `admin-code read,write`. */
  detail?: string;
  /** Why it did not work. */
  code?: string;
  source?: string;
}

export interface OAuthServerOptions {
  store: OAuthStore;
  books: McpBooks;
  hasBook(bookId: string): boolean;
  /** The admin login's own check: the same attempts and the same lockout. Throws `HttpError` 401 or 429. */
  verifyAdminCode(code: string, source: string): Promise<void>;
  publicUrl(): string | undefined;
  localUrl(): string;
  readJson(request: IncomingMessage, limit: number): Promise<unknown>;
  bodyIdleMs: number;
  now(): Date;
  log(line: string): void;
  limits?: OAuthLimits;
  /** Told of what the owner decided on the pages of this server. Awaited, and never allowed to fail what it is told about. */
  onAction?(action: OAuthAction): void | Promise<void>;
}

interface Decision {
  scopes: McpScope[];
  book?: string;
}

interface Pending {
  id: string;
  clientId: string;
  redirectUri: string;
  redirectHost: string;
  state: string | undefined;
  challenge: string;
  /** The book's address as the app gave it (already looked at for its shape, not for the book). */
  resource: string | undefined;
  requested: McpScope[];
  base: string;
  csrf: string;
  expiresAt: number;
  passkey?: { challenge: string; expiresAt: number; decision: Decision };
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  redirectHost: string;
  challenge: string;
  resource: string;
  bookId: string;
  scopes: McpScope[];
  expiresAt: number;
}

interface Ticket {
  expiresAt: number;
  challenge?: { value: string; expiresAt: number };
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const random = (): string => randomBytes(32).toString("base64url");
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const sortScopes = (scopes: Iterable<McpScope>): McpScope[] => {
  const wanted = new Set(scopes);
  return SCOPES.filter((scope) => wanted.has(scope));
};
const publicScope = (scopes: readonly McpScope[]): string => scopes.map((scope) => PUBLIC_NAME[scope]).join(" ");
const isMcpScope = (value: unknown): value is McpScope => value === "read" || value === "write" || value === "run";

/** The permissions that a `scope` parameter asks for: `undefined` when it asks for none (omitted, empty, or only habitual names), `null` when it names a scope the server does not have. */
function parseScope(value: string | null | undefined): McpScope[] | undefined | null {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const names = value.trim().split(/\s+/);
  if (names.length > 10) return null;
  const named = names.filter((name) => !HABITUAL_SCOPES.has(name));
  if (!named.every((name) => INTERNAL_NAME[name] !== undefined)) return null;
  return named.length ? sortScopes(named.map((name) => INTERNAL_NAME[name])) : undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Why a redirect address cannot be registered, or `undefined` when it can: https, or http on this computer; no fragment, wildcard or credentials. */
function redirectProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return "A redirect address must be a text.";
  if (value.length > MAX_REDIRECT_CHARACTERS) return `A redirect address has at most ${MAX_REDIRECT_CHARACTERS} characters.`;
  if (/[*\s\u0000-\u001f]/.test(value)) return "A redirect address holds no wildcard, space or control character: it is written out exactly.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "A redirect address must be an absolute address.";
  }
  if (value.includes("#")) return "A redirect address holds no fragment.";
  if (url.username || url.password) return "A redirect address holds no credentials.";
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) return undefined;
  return "A redirect address is https, or http on this computer (localhost, 127.0.0.1 or [::1]).";
}

/** What an app calls itself, as the owner may be shown it: no control or direction-changing characters, one line, at most 80 characters. */
function cleanName(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu, " ").replace(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, MAX_NAME_CHARACTERS).join("").trim() || "Unnamed app";
}

function cleanLabel(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu, " ").replace(/\s+/gu, " ").trim() : "";
  return Array.from(text).slice(0, MAX_LABEL_CHARACTERS).join("").trim() || "Passkey";
}

/** A name the owner types for a passkey: not corrected into one, so what the panel shows is what is kept. */
export function assertPasskeyLabel(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (!text || Array.from(text).length > MAX_LABEL_CHARACTERS || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(text)) {
    throw new HttpError(422, "label", `A passkey's name has 1 to ${MAX_LABEL_CHARACTERS} characters, without control characters.`);
  }
  return text;
}

/** The book's address in its one written form (`<origin>/mcp/<slug>`), or the refusal of RFC 8707 when it is not an MCP address of this server. */
function normalizeResource(value: string, base: string): string {
  const refuse = (): never => {
    throw new OAuthProblem(400, "invalid_target", "The resource must be the MCP address of a book on this server.");
  };
  if (value.length > MAX_REDIRECT_CHARACTERS || value.includes("#") || value.includes("?")) return refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  if (url.username || url.password || url.origin !== base) return refuse();
  const address = mcpAddress(url.pathname);
  return address ? `${base}/mcp/${address.slug}` : refuse();
}

const slugOf = (resource: string): string => mcpAddress(new URL(resource).pathname)?.slug ?? "";

/** Read a form (`application/x-www-form-urlencoded`, RFC 6749 §3.2) with a size limit and a limit on how long the sender may be quiet. */
function readForm(request: IncomingMessage, limit: number, idleMs: number): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    if (!/^application\/x-www-form-urlencoded\b/i.test(String(request.headers["content-type"] ?? ""))) {
      reject(new HttpError(415, "unsupported_media_type", "Send the request as application/x-www-form-urlencoded, as RFC 6749 says."));
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
      try {
        resolve(new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      } catch {
        reject(new HttpError(400, "invalid_request", "The request body is not valid text."));
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

function writeJson(response: ServerResponse, status: number, payload: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers });
  response.end(body);
}

function writeText(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

/** Where a request that is OAuth's own goes: `/oauth/...` and the well-known documents. */
export function isOAuthPath(pathname: string): boolean {
  return pathname === "/oauth" || pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/");
}

/** The answers of the token, registration and revocation endpoints are in the words of RFC 6749 (`error`, `error_description`); the pages' own calls answer `{ code, message }`. */
const PROTOCOL_ENDPOINT = /^\/oauth\/(?:register|token|revoke)$/;

export class OAuthServer {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly spentCodes = new Map<string, { grantId?: string; until: number }>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly requests: WindowLimiter;
  private readonly registrations: WindowLimiter;
  private readonly maxClients: number;

  constructor(private readonly options: OAuthServerOptions) {
    const positive = (value: number | undefined, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
    this.requests = new WindowLimiter({ max: positive(options.limits?.requestsPerMinute, DEFAULT_REQUESTS_PER_MINUTE), windowMs: MINUTE_MS });
    this.registrations = new WindowLimiter({ max: positive(options.limits?.registrationsPerHour, DEFAULT_REGISTRATIONS_PER_HOUR), windowMs: HOUR_MS });
    this.maxClients = positive(options.limits?.maxClients, DEFAULT_MAX_CLIENTS);
  }

  private get now(): number {
    return this.options.now().getTime();
  }

  // -------------------------------------------------------------------------------------------
  // Where the server is reached
  // -------------------------------------------------------------------------------------------

  private publicOrigin(): string | undefined {
    const publicUrl = this.options.publicUrl();
    if (!publicUrl) return undefined;
    try {
      return new URL(publicUrl).origin;
    } catch {
      return undefined;
    }
  }

  /**
   * The address a request was made to, as the issuer and the resource are written: the server's public address when the request came to its host, else the address on this
   * computer that it came to. The metadata an app reads, the address it is sent back to and the origin a passkey is made for are all this one.
   */
  baseOf(request: IncomingMessage): string {
    const host = String(request.headers.host ?? "").toLowerCase();
    const publicUrl = this.options.publicUrl();
    if (publicUrl) {
      try {
        const url = new URL(publicUrl);
        if (url.host.toLowerCase() === host) return url.origin;
      } catch {
        // A public address that is not an address names no host.
      }
    }
    return `http://${host}`;
  }

  /**
   * The relying party of a passkey for pages served on `base`: the host of the public address, when `base` is it, it is https and it is a name (an IP address cannot be a relying
   * party). On this computer's own address there is none: the admin code does it there.
   */
  private rpIdOf(base: string): string | undefined {
    const origin = this.publicOrigin();
    if (!origin || origin !== base) return undefined;
    const url = new URL(origin);
    return url.protocol === "https:" && !isIP(url.hostname) && !url.hostname.startsWith("[") ? url.hostname.toLowerCase() : undefined;
  }

  private passkeyState(base: string): { available: boolean; canRegister: boolean; reason?: "address" | "none" } {
    const rpId = this.rpIdOf(base);
    if (!rpId) return { available: false, canRegister: false, reason: "address" };
    return this.options.store.passkeys().some((key) => key.rpId === rpId) ? { available: true, canRegister: true } : { available: false, canRegister: true, reason: "none" };
  }

  /** What the status of a book's MCP says of its OAuth server. */
  describe(slug: string): { issuer: string; metadataUrl: string; resourceMetadataUrl: string; scopes: string[] } {
    const base = this.publicOrigin() ?? this.options.localUrl();
    return { issuer: base, metadataUrl: `${base}/.well-known/oauth-authorization-server`, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp/${slug}`, scopes: [...OAUTH_SCOPE_NAMES] };
  }

  // -------------------------------------------------------------------------------------------
  // The way in of every request
  // -------------------------------------------------------------------------------------------

  async handle(context: { request: IncomingMessage; response: ServerResponse; url: URL; source: string }): Promise<void> {
    const { request, response, url, source } = context;
    // Nothing this server renders can be framed, whatever it is: pages, scripts and answers alike.
    response.setHeader("content-security-policy", PAGE_CSP);
    response.setHeader("x-frame-options", "DENY");
    const path = url.pathname;
    const protocol = PROTOCOL_ENDPOINT.test(path);
    try {
      const verdict = this.requests.hit(source);
      if (!verdict.allowed) throw new HttpError(429, "rate_limit", "Too many requests: wait a moment and try again.", retryAfter(verdict.retryAfterMs));
      const base = this.baseOf(request);
      const method = request.method === "HEAD" ? "GET" : request.method ?? "GET";
      const only = (...allowed: string[]) => {
        if (!allowed.includes(method)) throw new HttpError(405, "method_not_allowed", `This address answers ${allowed.join(" or ")} only.`, { allow: allowed.join(", ") });
      };
      this.purge();
      const resource = /^\/\.well-known\/oauth-protected-resource\/mcp\/([^/]+)$/.exec(path);
      if (resource) {
        only("GET");
        return this.resourceMetadata(response, base, resource[1]);
      }
      switch (path) {
        case "/.well-known/oauth-authorization-server":
        case "/.well-known/openid-configuration":
          only("GET");
          return this.serverMetadata(response, base);
        case "/oauth/register":
          only("POST");
          return await this.register(request, response, source);
        case "/oauth/authorize":
          only("GET");
          return this.authorize(request, response, url, base);
        case "/oauth/authorize/challenge":
          only("POST");
          return await this.challenge(request, response, base);
        case "/oauth/authorize/approve":
          only("POST");
          return await this.approve(request, response, source, base);
        case "/oauth/authorize/deny":
          only("POST");
          return await this.deny(request, response, base);
        case "/oauth/token":
          only("POST");
          return await this.token(request, response, base);
        case "/oauth/revoke":
          only("POST");
          return await this.revoke(request, response);
        case "/oauth/passkeys/add":
          only("GET");
          return writeText(response, 200, "text/html; charset=utf-8", renderRegisterPage(this.languageOf(request), this.rpIdOf(base) !== undefined));
        case "/oauth/passkeys/options":
          only("POST");
          return await this.passkeyOptions(request, response, base);
        case "/oauth/passkeys/register":
          only("POST");
          return await this.passkeyRegister(request, response, base);
        case "/oauth/assets/page.js":
          only("GET");
          return writeText(response, 200, "text/javascript; charset=utf-8", PAGE_JS);
        case "/oauth/assets/page.css":
          only("GET");
          return writeText(response, 200, "text/css; charset=utf-8", PAGE_CSS);
        default:
          throw new HttpError(404, "not_found", "Unknown endpoint.");
      }
    } catch (error) {
      this.fail(response, error, protocol);
    }
  }

  private fail(response: ServerResponse, error: unknown, protocol: boolean): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof OAuthProblem) {
      writeJson(response, error.status, { error: error.error, error_description: error.description }, { pragma: "no-cache", ...error.headers });
      return;
    }
    if (error instanceof HttpError) {
      if (protocol) {
        const code = error.status === 429 || error.status === 503 ? "temporarily_unavailable" : error.status >= 500 ? "server_error" : "invalid_request";
        writeJson(response, error.status, { error: code, error_description: error.message }, { pragma: "no-cache", ...error.headers });
      } else writeJson(response, error.status, { code: error.code, message: error.message }, error.headers);
      return;
    }
    throw error;
  }

  private languageOf(request: IncomingMessage): Lang {
    const header = request.headers["accept-language"];
    return negotiateLanguage(Array.isArray(header) ? header.join(",") : header);
  }

  /** Forget what ran out: requests that were not answered, codes, challenges and tickets. */
  private purge(): void {
    const at = this.now;
    // Each of these ends a fixed time after it was made, so the ones that ran out are the oldest: the first that has not is the end of them.
    const drop = <T>(entries: Map<string, T>, endOf: (entry: T) => number) => {
      for (const [key, entry] of entries) {
        if (endOf(entry) > at) break;
        entries.delete(key);
      }
    };
    drop(this.pending, (pending) => pending.expiresAt);
    drop(this.codes, (code) => code.expiresAt);
    drop(this.spentCodes, (spent) => spent.until);
    drop(this.tickets, (ticket) => ticket.expiresAt);
  }

  // -------------------------------------------------------------------------------------------
  // Discovery (RFC 9728 and RFC 8414)
  // -------------------------------------------------------------------------------------------

  /** The same for every well-formed address: nobody who asks learns which books exist, which are on, or what they are called. */
  private resourceMetadata(response: ServerResponse, base: string, slug: string): void {
    if (!mcpAddress(`/mcp/${slug}`)) throw new HttpError(404, "not_found", "Unknown endpoint.");
    writeJson(response, 200, { resource: `${base}/mcp/${slug}`, authorization_servers: [base], scopes_supported: [...OAUTH_SCOPE_NAMES], bearer_methods_supported: ["header"] });
  }

  private serverMetadata(response: ServerResponse, base: string): void {
    writeJson(response, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: [...OAUTH_SCOPE_NAMES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: [...SUPPORTED_GRANTS],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Dynamic client registration (RFC 7591): public clients, exact redirect addresses
  // -------------------------------------------------------------------------------------------

  private async register(request: IncomingMessage, response: ServerResponse, source: string): Promise<void> {
    const verdict = this.registrations.hit(source);
    if (!verdict.allowed) throw new OAuthProblem(429, "temporarily_unavailable", "Too many apps were registered from this address: try again later.", retryAfter(verdict.retryAfterMs));
    let body: unknown;
    try {
      body = await this.options.readJson(request, REGISTER_BODY);
    } catch (error) {
      if (error instanceof HttpError && error.code === "invalid_json") throw new OAuthProblem(400, "invalid_client_metadata", "The body is not valid JSON.");
      throw error;
    }
    if (!isObject(body)) throw new OAuthProblem(400, "invalid_client_metadata", "The body must be a JSON object.");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS) throw new OAuthProblem(400, "invalid_redirect_uri", `Send 1 to ${MAX_REDIRECT_URIS} redirect addresses.`);
    for (const uri of uris) {
      const problem = redirectProblem(uri);
      if (problem) throw new OAuthProblem(400, "invalid_redirect_uri", problem);
    }
    if (new Set(uris).size !== uris.length) throw new OAuthProblem(400, "invalid_redirect_uri", "A redirect address is given once.");
    const metadata = (problem: string): never => {
      throw new OAuthProblem(400, "invalid_client_metadata", problem);
    };
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") metadata('Only public clients are registered: token_endpoint_auth_method must be "none".');
    let grantTypes = ["authorization_code"];
    if (body.grant_types !== undefined) {
      const given = body.grant_types;
      if (!Array.isArray(given) || !given.length || !given.every((grant) => typeof grant === "string" && SUPPORTED_GRANTS.includes(grant)) || !given.includes("authorization_code")) metadata("grant_types must be authorization_code, with refresh_token if the app refreshes.");
      grantTypes = SUPPORTED_GRANTS.filter((grant) => (given as string[]).includes(grant));
    }
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || !body.response_types.length || !body.response_types.every((type) => type === "code"))) metadata('response_types must be ["code"].');
    if (body.client_name !== undefined && typeof body.client_name !== "string") metadata("client_name must be a text.");
    if (body.scope !== undefined && typeof body.scope !== "string") metadata("scope must be a text.");
    const asked = typeof body.scope === "string" ? body.scope.split(/\s+/).filter((name) => INTERNAL_NAME[name]) : [];
    const scope = asked.length ? [...new Set(asked)].join(" ") : OAUTH_SCOPE_NAMES.join(" ");
    const client = await this.options.store.registerClient({ name: cleanName(typeof body.client_name === "string" ? body.client_name : ""), redirectUris: [...(uris as string[])], grantTypes, scope }, this.maxClients);
    writeJson(response, 201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: client.scope,
    }, { pragma: "no-cache" });
  }

  // -------------------------------------------------------------------------------------------
  // Authorization (RFC 6749 §4.1, RFC 7636, RFC 8707, RFC 9207): the consent page
  // -------------------------------------------------------------------------------------------

  private redirectTo(redirectUri: string, parameters: Record<string, string | undefined>): string {
    const target = new URL(redirectUri);
    for (const [name, value] of Object.entries(parameters)) if (value !== undefined) target.searchParams.append(name, value);
    return target.toString();
  }

  private authorize(request: IncomingMessage, response: ServerResponse, url: URL, base: string): void {
    const lang = this.languageOf(request);
    const params = url.searchParams;
    const single = (name: string): { value: string | undefined; repeated: boolean } => {
      const all = params.getAll(name);
      return { value: all[0], repeated: all.length > 1 };
    };
    // An app or an address that cannot be trusted is never sent anyone: it is a page that says so (RFC 6749 §4.1.2.1).
    const refuse = () => writeText(response, 400, "text/html; charset=utf-8", renderErrorPage(lang));
    const clientParam = single("client_id");
    const redirectParam = single("redirect_uri");
    const client = clientParam.value && !clientParam.repeated ? this.options.store.client(clientParam.value) : undefined;
    if (!client || redirectParam.repeated || !redirectParam.value || !client.redirectUris.includes(redirectParam.value)) return refuse();
    const redirectUri = redirectParam.value;
    this.options.store.touchClient(client.id);

    const stateParam = single("state");
    const state = stateParam.value !== undefined && stateParam.value.length <= MAX_STATE_CHARACTERS && !stateParam.repeated ? stateParam.value : undefined;
    const reject = (error: string, description: string) => {
      response.writeHead(302, { location: this.redirectTo(redirectUri, { error, error_description: description, state, iss: base }), "content-length": "0" });
      response.end();
    };
    for (const name of ["response_type", "state", "scope", "resource", "code_challenge", "code_challenge_method"]) if (single(name).repeated) return reject("invalid_request", `The parameter ${name} is given more than once.`);
    if (stateParam.value !== undefined && stateParam.value.length > MAX_STATE_CHARACTERS) return reject("invalid_request", `The state has at most ${MAX_STATE_CHARACTERS} characters.`);
    const responseType = single("response_type").value;
    if (!responseType) return reject("invalid_request", "response_type is required: it must be code.");
    if (responseType !== "code") return reject("unsupported_response_type", "Only the authorization code flow is supported.");
    const challenge = single("code_challenge").value;
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return reject("invalid_request", "PKCE is required: send a code_challenge (the unpadded base64url of the SHA-256 of the code verifier).");
    if (single("code_challenge_method").value !== "S256") return reject("invalid_request", "PKCE is required with the method S256.");

    const asked = parseScope(single("scope").value);
    if (asked === null) return reject("invalid_scope", `The scope is made of: ${OAUTH_SCOPE_NAMES.join(", ")}.`);
    const requested: McpScope[] = asked ?? [...SCOPES];
    const resourceText = single("resource").value;
    let resource: string | undefined;
    if (resourceText !== undefined && resourceText !== "") {
      try {
        resource = normalizeResource(resourceText, base);
      } catch (error) {
        if (error instanceof OAuthProblem) return reject(error.error, error.description);
        throw error;
      }
    }

    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const redirect = new URL(redirectUri);
    const pending: Pending = { id: random(), clientId: client.id, redirectUri, redirectHost: redirect.host, state, challenge, resource, requested, base, csrf: random(), expiresAt: this.now + REQUEST_MS };
    this.pending.set(pending.id, pending);
    const toggles: Array<{ scope: PageScope; requested: boolean; locked: boolean; checked: boolean }> = [{ scope: "read", requested: requested.includes("read"), locked: true, checked: true }];
    for (const scope of ["write", "run"] as const) if (requested.includes(scope)) toggles.push({ scope, requested: true, locked: false, checked: false });
    writeText(response, 200, "text/html; charset=utf-8", renderConsent({
      lang,
      requestId: pending.id,
      csrf: pending.csrf,
      client: { name: client.name, redirectHost: redirect.host },
      resource: resource ?? null,
      scopes: toggles,
      passkeys: this.passkeyState(base),
      bookInput: resource === undefined,
      loopback: isLoopbackHost(redirect.hostname),
    }));
  }

  /** The request that a page's call is about: still open, from the page's own origin, with the token of that page. */
  private pendingFor(request: IncomingMessage, body: Record<string, unknown>, base: string): Pending {
    const id = typeof body.requestId === "string" ? body.requestId : "";
    const pending = this.pending.get(id);
    if (!pending || pending.expiresAt <= this.now) {
      this.pending.delete(id);
      throw new HttpError(404, "request_expired", "This request has expired or was already answered. Start again from the app.");
    }
    this.assertOwnOrigin(request, pending.base);
    const sent = request.headers["x-csrf-token"];
    if (typeof sent !== "string" || !sameText(sent, pending.csrf)) throw new HttpError(403, "csrf", "This page is not the one that made the request: open it again from the app.");
    if (pending.base !== base) throw new HttpError(403, "origin", "This request was made on another address of the server.");
    return pending;
  }

  /** A browser says where a page came from: when it says, it must be this server's address (the others are refused before, unless the owner approved them for the API). */
  private assertOwnOrigin(request: IncomingMessage, base: string): void {
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin.replace(/\/+$/, "") !== base) throw new HttpError(403, "origin", "This request does not come from the server's own page.");
  }

  private decisionOf(pending: Pending, body: Record<string, unknown>): Decision {
    const given = body.scopes === undefined ? [] : body.scopes;
    if (!Array.isArray(given) || given.length > SCOPES.length || !given.every((scope) => typeof scope === "string")) throw new HttpError(400, "scope", "Choose permissions among read, write and run.");
    const allowed = new Set<McpScope>(["read", ...pending.requested]);
    const chosen = new Set<McpScope>(["read"]);
    for (const scope of given as string[]) {
      if (!isMcpScope(scope) || !allowed.has(scope)) throw new HttpError(400, "scope", "The page can allow less than the app asked for, never more.");
      chosen.add(scope);
    }
    return { scopes: sortScopes(chosen), ...(typeof body.book === "string" ? { book: body.book } : {}) };
  }

  private async challenge(request: IncomingMessage, response: ServerResponse, base: string): Promise<void> {
    const body = this.asObject(await this.options.readJson(request, PAGE_BODY));
    const pending = this.pendingFor(request, body, base);
    const rpId = this.rpIdOf(base);
    const credentials = rpId ? this.options.store.passkeys().filter((key) => key.rpId === rpId) : [];
    if (!rpId || !credentials.length) throw new HttpError(409, "passkey_unavailable", "A passkey cannot be used here: use the admin code.");
    // One challenge for a request, the latest: it is used once, whatever the answer, and it lives two minutes.
    pending.passkey = { challenge: random(), expiresAt: this.now + ASSERTION_CHALLENGE_MS, decision: this.decisionOf(pending, body) };
    writeJson(response, 200, {
      publicKey: {
        challenge: pending.passkey.challenge,
        rpId,
        timeout: ASSERTION_CHALLENGE_MS,
        userVerification: "required",
        allowCredentials: credentials.map((key) => ({ type: "public-key", id: key.id, ...(key.transports.length ? { transports: key.transports } : {}) })),
      },
    });
  }

  private async verifyPasskey(pending: Pending, credential: unknown, base: string): Promise<Decision> {
    const challenge = pending.passkey;
    pending.passkey = undefined;
    if (!challenge || challenge.expiresAt <= this.now) throw new HttpError(409, "challenge_expired", "That took too long: try again.");
    const refused = () => new HttpError(401, "passkey_invalid", "That passkey was not accepted. Try again, or use the admin code.");
    if (!isObject(credential) || typeof credential.id !== "string") throw refused();
    const rpId = this.rpIdOf(base);
    const stored = this.options.store.passkey(credential.id);
    if (!rpId || !stored || stored.rpId !== rpId) throw refused();
    let result: { counter: number };
    try {
      result = verifyAssertion({ response: credential.response, challenge: challenge.challenge, origin: base, rpId, publicKey: stored.publicKey, alg: stored.alg, counter: stored.counter });
    } catch (error) {
      if (error instanceof WebAuthnError) throw refused();
      throw error;
    }
    await this.options.store.recordPasskeyUse(stored.id, result.counter);
    return challenge.decision;
  }

  /** The book the owner is allowing, if it is on: the app's resource, or what the owner typed when the app named none. */
  private openBook(pending: Pending, decision: Decision, base: string): { resource: string; bookId: string } {
    let resource = pending.resource;
    if (resource === undefined) {
      const named = decision.book?.trim();
      if (!named) throw new HttpError(400, "book_required", "Say which book: paste its MCP address.");
      const candidate = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(named) ? `${base}/mcp/${named}` : named;
      try {
        resource = normalizeResource(candidate, base);
      } catch {
        throw new HttpError(422, "invalid_target", "No book with MCP switched on has this address.");
      }
    }
    const entry = this.options.books.resolve(slugOf(resource));
    if (!entry?.enabled || !this.options.hasBook(entry.bookId)) throw new HttpError(422, "invalid_target", "No book with MCP switched on has this address.");
    return { resource, bookId: entry.bookId };
  }

  private async approve(request: IncomingMessage, response: ServerResponse, source: string, base: string): Promise<void> {
    const body = this.asObject(await this.options.readJson(request, PAGE_BODY));
    const pending = this.pendingFor(request, body, base);
    const proof = body.proof;
    if (!isObject(proof)) throw new HttpError(400, "invalid_request", "Send the proof that it is you: a passkey or the admin code.");
    const app = this.options.store.client(pending.clientId)?.name;
    let decision: Decision;
    let byCode = false;
    try {
      if (proof.type === "admin-code") {
        decision = this.decisionOf(pending, body);
        await this.options.verifyAdminCode(typeof proof.code === "string" ? proof.code.trim() : "", source);
        byCode = true;
      } else if (proof.type === "passkey") decision = await this.verifyPasskey(pending, proof.credential, base);
      else throw new HttpError(400, "invalid_request", "The proof is a passkey or the admin code.");
    } catch (error) {
      // Somebody who could not prove who they are, or who tried too often: the owner is told. A request that is wrong in itself is not an event.
      if (error instanceof HttpError && (error.status === 401 || error.status === 429)) await this.tell({ action: "oauth.approve", ok: false, actor: "anonymous", label: app, code: error.code, source });
      throw error;
    }

    // Who it is is known now: only now is the book looked at, so that nobody who has not proved it learns which books are on.
    const book = this.openBook(pending, decision, base);
    const code = random();
    this.codes.set(sha256(code), { clientId: pending.clientId, redirectUri: pending.redirectUri, redirectHost: pending.redirectHost, challenge: pending.challenge, resource: book.resource, bookId: book.bookId, scopes: decision.scopes, expiresAt: this.now + CODE_MS });
    if (this.codes.size > MAX_CODES) {
      const oldest = this.codes.keys().next();
      if (!oldest.done) this.codes.delete(oldest.value);
    }
    this.pending.delete(pending.id);
    await this.tell({ action: "oauth.approve", ok: true, actor: "admin", object: book.bookId, label: app, detail: `${byCode ? "admin-code" : "passkey"} ${decision.scopes.join(",")}`, source });
    const offer = byCode && this.rpIdOf(base) ? { passkeyOffer: { ticket: this.newTicket() } } : {};
    writeJson(response, 200, { redirect: this.redirectTo(pending.redirectUri, { code, state: pending.state, iss: base }), ...offer });
  }

  private async deny(request: IncomingMessage, response: ServerResponse, base: string): Promise<void> {
    const body = this.asObject(await this.options.readJson(request, PAGE_BODY));
    const pending = this.pendingFor(request, body, base);
    this.pending.delete(pending.id);
    await this.tell({ action: "oauth.deny", ok: true, actor: "anonymous", label: this.options.store.client(pending.clientId)?.name });
    writeJson(response, 200, { redirect: this.redirectTo(pending.redirectUri, { error: "access_denied", error_description: "The owner did not allow it.", state: pending.state, iss: base }) });
  }

  /** Tell the admin log what the owner decided. A log that fails never fails the flow it records. */
  private async tell(action: OAuthAction): Promise<void> {
    try {
      await this.options.onAction?.(action);
    } catch {
      // Nothing else to tell it to.
    }
  }

  private asObject(value: unknown): Record<string, unknown> {
    if (!isObject(value)) throw new HttpError(400, "invalid_request", "Expected a JSON object.");
    return value;
  }

  // -------------------------------------------------------------------------------------------
  // Tokens (RFC 6749 §4.1.3, §6; RFC 7009)
  // -------------------------------------------------------------------------------------------

  private async readTokenForm(request: IncomingMessage): Promise<URLSearchParams> {
    const form = await readForm(request, FORM_BODY, this.options.bodyIdleMs);
    for (const name of new Set(form.keys())) if (form.getAll(name).length > 1) throw new OAuthProblem(400, "invalid_request", `The parameter ${name.slice(0, 40)} is given more than once.`);
    return form;
  }

  private clientOf(form: URLSearchParams): OAuthClient {
    const id = form.get("client_id");
    if (!id) throw new OAuthProblem(400, "invalid_request", "client_id is required.");
    const client = this.options.store.client(id);
    if (!client) throw new OAuthProblem(400, "invalid_client", "This app is not registered.");
    return client;
  }

  private tokenResponse(response: ServerResponse, tokens: { accessToken: string; refreshToken?: string; expiresIn: number; scopes: McpScope[] }): void {
    writeJson(response, 200, { access_token: tokens.accessToken, token_type: "Bearer", expires_in: tokens.expiresIn, ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}), scope: publicScope(tokens.scopes) }, { pragma: "no-cache" });
  }

  private resourceParameter(form: URLSearchParams, base: string): string | undefined {
    const value = form.get("resource");
    return value === null || value === "" ? undefined : normalizeResource(value, base);
  }

  /** Whether the book of a grant is still on at its address (the switch, a new slug and a deleted book all end it). */
  private stillOpen(bookId: string, resource: string): boolean {
    const entry = this.options.books.resolve(slugOf(resource));
    return Boolean(entry?.enabled && entry.bookId === bookId && this.options.hasBook(bookId));
  }

  private async token(request: IncomingMessage, response: ServerResponse, base: string): Promise<void> {
    const form = await this.readTokenForm(request);
    const grantType = form.get("grant_type");
    if (!grantType) throw new OAuthProblem(400, "invalid_request", "grant_type is required.");
    if (grantType === "authorization_code") return this.exchangeCode(response, form, base);
    if (grantType === "refresh_token") return this.refreshTokens(response, form, base);
    throw new OAuthProblem(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  private async exchangeCode(response: ServerResponse, form: URLSearchParams, base: string): Promise<void> {
    const client = this.clientOf(form);
    if (!client.grantTypes.includes("authorization_code")) throw new OAuthProblem(400, "unauthorized_client", "This app is not registered for the authorization code flow.");
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    if (!code) throw new OAuthProblem(400, "invalid_request", "code is required.");
    if (!verifier || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) throw new OAuthProblem(400, "invalid_request", "code_verifier is required: 43 to 128 characters of A-Z a-z 0-9 - . _ ~");
    if (!redirectUri) throw new OAuthProblem(400, "invalid_request", "redirect_uri is required.");
    const invalid = () => new OAuthProblem(400, "invalid_grant", "The code is not valid, was already used, or has expired.");

    const digest = sha256(code);
    const record = this.codes.get(digest);
    if (!record) {
      // A code that is shown again says that somebody has it who should not: what it gave is revoked (RFC 6749 §4.1.2).
      const spent = this.spentCodes.get(digest);
      if (spent?.grantId) await this.options.store.revokeGrant(spent.grantId);
      throw invalid();
    }
    // The code is spent by being presented, right or wrong: it cannot be tried again.
    this.codes.delete(digest);
    this.spentCodes.set(digest, { until: this.now + SPENT_CODE_MS });
    if (record.expiresAt <= this.now || record.clientId !== client.id || record.redirectUri !== redirectUri) throw invalid();
    const computed = createHash("sha256").update(verifier).digest("base64url");
    if (!sameText(computed, record.challenge)) throw invalid();
    const resource = this.resourceParameter(form, base);
    if (resource !== undefined && resource !== record.resource) throw new OAuthProblem(400, "invalid_target", "The resource is not the book the owner allowed.");

    const tokens = await this.options.store.createGrant(
      { clientId: client.id, bookId: record.bookId, resource: record.resource, scopes: record.scopes, redirectHost: record.redirectHost, withRefresh: client.grantTypes.includes("refresh_token") },
      () => this.stillOpen(record.bookId, record.resource),
    );
    this.spentCodes.set(digest, { grantId: tokens.grantId, until: this.now + SPENT_CODE_MS });
    this.options.store.touchClient(client.id);
    this.tokenResponse(response, tokens);
  }

  private async refreshTokens(response: ServerResponse, form: URLSearchParams, base: string): Promise<void> {
    const client = this.clientOf(form);
    if (!client.grantTypes.includes("refresh_token")) throw new OAuthProblem(400, "unauthorized_client", "This app is not registered to refresh tokens.");
    const refreshToken = form.get("refresh_token");
    if (!refreshToken) throw new OAuthProblem(400, "invalid_request", "refresh_token is required.");
    const invalid = () => new OAuthProblem(400, "invalid_grant", "The refresh token is not valid, has expired, or was already used.");
    const found = this.options.store.findRefresh(refreshToken);
    if (!found || found.grant.clientId !== client.id) throw invalid();
    if (found.spent) {
      await this.options.store.revokeGrant(found.grant.id);
      throw invalid();
    }
    const { grant } = found;
    // What is wrong with the request is said before the token is spent: a request that is refused does not use it up.
    let scopes = grant.scopes;
    const asked = parseScope(form.get("scope"));
    if (asked === null || asked?.some((scope) => !grant.scopes.includes(scope))) throw new OAuthProblem(400, "invalid_scope", "A refresh can ask for less than was allowed, never for more.");
    if (asked) scopes = asked;
    const resource = this.resourceParameter(form, base);
    if (resource !== undefined && resource !== grant.resource) throw new OAuthProblem(400, "invalid_target", "The resource is not the book the owner allowed.");
    if (!this.stillOpen(grant.bookId, grant.resource)) {
      await this.options.store.revokeGrant(grant.id);
      throw invalid();
    }
    const tokens = await this.options.store.rotate(grant.id, refreshToken, scopes);
    if (!tokens) throw invalid();
    this.options.store.touchClient(client.id);
    this.tokenResponse(response, tokens);
  }

  private async revoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await this.readTokenForm(request);
    const client = this.clientOf(form);
    const token = form.get("token");
    if (!token) throw new OAuthProblem(400, "invalid_request", "token is required.");
    const grant = this.options.store.grantOfToken(token, client.id);
    if (grant) await this.options.store.revokeGrant(grant.id);
    // RFC 7009: the answer is 200 whether the token was known or not.
    writeJson(response, 200, {}, { pragma: "no-cache" });
  }

  // -------------------------------------------------------------------------------------------
  // Passkeys: a ticket (from the offer after the admin code, or from the admin panel) lets one device register one
  // -------------------------------------------------------------------------------------------

  private newTicket(): string {
    if (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next();
      if (!oldest.done) this.tickets.delete(oldest.value);
    }
    const ticket = random();
    this.tickets.set(sha256(ticket), { expiresAt: this.now + TICKET_MS });
    return ticket;
  }

  private ticketFor(value: unknown): { digest: string; ticket: Ticket } {
    if (typeof value !== "string" || !value) throw new HttpError(400, "invalid_request", "Send the ticket.");
    const digest = sha256(value.slice(0, 200));
    const ticket = this.tickets.get(digest);
    if (!ticket || ticket.expiresAt <= this.now) {
      this.tickets.delete(digest);
      throw new HttpError(404, "ticket_invalid", "This link is not valid any more: ask for a new one in the admin panel.");
    }
    return { digest, ticket };
  }

  private async passkeyOptions(request: IncomingMessage, response: ServerResponse, base: string): Promise<void> {
    this.assertOwnOrigin(request, base);
    const body = this.asObject(await this.options.readJson(request, 2048));
    const { ticket } = this.ticketFor(body.ticket);
    const rpId = this.rpIdOf(base);
    if (!rpId) throw new HttpError(409, "passkey_unavailable", "A passkey can be added only on the public address of the server.");
    ticket.challenge = { value: random(), expiresAt: this.now + REGISTRATION_CHALLENGE_MS };
    writeJson(response, 200, {
      publicKey: {
        rp: { id: rpId, name: "Narrarium personal server" },
        user: { id: this.options.store.userHandle, name: "owner", displayName: "Narrarium owner" },
        challenge: ticket.challenge.value,
        pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
        timeout: REGISTRATION_CHALLENGE_MS,
        attestation: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        excludeCredentials: this.options.store.passkeys().filter((key) => key.rpId === rpId).map((key) => ({ type: "public-key", id: key.id })),
      },
    });
  }

  private async passkeyRegister(request: IncomingMessage, response: ServerResponse, base: string): Promise<void> {
    this.assertOwnOrigin(request, base);
    const body = this.asObject(await this.options.readJson(request, PAGE_BODY));
    const { digest, ticket } = this.ticketFor(body.ticket);
    const rpId = this.rpIdOf(base);
    if (!rpId) throw new HttpError(409, "passkey_unavailable", "A passkey can be added only on the public address of the server.");
    const challenge = ticket.challenge;
    ticket.challenge = undefined;
    if (!challenge || challenge.expiresAt <= this.now) throw new HttpError(409, "challenge_expired", "That took too long: try again.");
    const credential = this.asObject(body.credential);
    let registered;
    try {
      registered = verifyRegistration({ response: credential.response, challenge: challenge.value, origin: base, rpId });
    } catch (error) {
      if (error instanceof WebAuthnError) throw new HttpError(400, "passkey_invalid", "That passkey was not accepted.");
      throw error;
    }
    if (credential.id !== registered.credentialId) throw new HttpError(400, "passkey_invalid", "That passkey was not accepted.");
    const label = cleanLabel(body.label);
    await this.options.store.addPasskey({ id: registered.credentialId, label, publicKey: registered.publicKey, alg: registered.alg, counter: registered.counter, transports: registered.transports, rpId });
    this.tickets.delete(digest);
    await this.tell({ action: "passkey.add", ok: true, actor: "admin", object: registered.credentialId, label });
    writeJson(response, 200, { id: registered.credentialId, label });
  }

  /** Whether the server can make a passkey link now: it needs a public address that is a name. */
  get canAddPasskey(): boolean {
    const origin = this.publicOrigin();
    return origin !== undefined && this.rpIdOf(origin) !== undefined;
  }

  /** A link that adds a passkey, for the owner to open on the device that will keep it: valid ten minutes, works once, and the ticket is after the `#`. */
  passkeyLink(): { url: string; expiresAt: number } {
    const origin = this.publicOrigin();
    if (!origin || !this.rpIdOf(origin)) throw new HttpError(409, "public_url_needed", "A passkey needs the public address of the server (an https address with a name): set it in Approved network first.");
    const ticket = this.newTicket();
    return { url: `${origin}/oauth/passkeys/add#${ticket}`, expiresAt: this.now + TICKET_MS };
  }

  async renamePasskey(id: unknown, label: unknown): Promise<void> {
    const text = assertPasskeyLabel(label);
    if (typeof id !== "string" || !(await this.options.store.renamePasskey(id, text))) throw new HttpError(404, "passkey_missing", "No passkey has this id.");
  }

  /** Remove a passkey. The last one goes only when the owner has confirmed that the admin code is then the only way to approve an app. */
  async removePasskey(id: unknown, confirmLast: boolean): Promise<void> {
    if (typeof id !== "string" || !this.options.store.passkey(id)) throw new HttpError(404, "passkey_missing", "No passkey has this id.");
    if (this.options.store.passkeys().length === 1 && !confirmLast) throw new HttpError(409, "last_passkey", "This is the last passkey: once it is removed only the admin code can approve an app. Confirm to remove it.");
    await this.options.store.removePasskey(id);
  }

  /** The passkeys as the owner sees them; one made for another address than the current public one is listed and cannot be used. */
  passkeyViews(): Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null; transports: string[]; rpId: string; usable: boolean }> {
    const origin = this.publicOrigin();
    const current = origin ? this.rpIdOf(origin) : undefined;
    return this.options.store.passkeys().map((key: StoredPasskey) => ({ id: key.id, label: key.label, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, transports: key.transports, rpId: key.rpId, usable: current !== undefined && key.rpId === current }));
  }

  // -------------------------------------------------------------------------------------------
  // What the rest of the server asks of it
  // -------------------------------------------------------------------------------------------

  /** An OAuth access token as a way of proving who calls a book's endpoint: bound to its book and to the permissions the owner chose. */
  authenticator(): McpAuthenticator {
    return (token) => {
      const found = token ? this.options.store.authenticate(token) : undefined;
      if (!found) throw new HttpError(401, "unauthorized", "This access token is not valid, has expired, or was revoked.");
      const { grant } = found;
      this.options.store.touchGrant(grant.id);
      return { id: `oauth:${grant.id}`, label: this.options.store.client(grant.clientId)?.name ?? "OAuth app", scopes: found.scopes, bookId: grant.bookId, current: () => this.options.store.hasGrant(grant.id) };
    };
  }

  /** The book and the app of a grant, for the admin log; `undefined` when there is no such grant. */
  grantInfo(id: string): { bookId: string; name: string } | undefined {
    const grant = this.options.store.grant(id);
    if (!grant) return undefined;
    return { bookId: grant.bookId, name: this.options.store.client(grant.clientId)?.name ?? "OAuth app" };
  }

  grantsOf(bookId?: string): GrantView[] {
    return this.options.store.grantsOf(bookId);
  }

  countGrants(bookId: string): number {
    return this.options.store.grantsOf(bookId).length;
  }

  /** Revoke one app's access to a book; `false` when that book has no such grant. */
  async revokeGrant(id: string, bookId?: string): Promise<boolean> {
    const grant = this.options.store.grant(id);
    if (!grant || (bookId !== undefined && grant.bookId !== bookId)) return false;
    return this.options.store.revokeGrant(id);
  }

  /** The book was switched off, got another address or was removed: everything that was allowed on it ends, and does not come back when it is switched on again. */
  revokeBook(bookId: string): Promise<number> {
    return this.options.store.revokeBook(bookId);
  }

  async sweep(): Promise<void> {
    this.purge();
    await this.options.store.sweep();
  }

  async close(): Promise<void> {
    await this.options.store.close();
  }
}
