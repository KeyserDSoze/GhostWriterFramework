import {
  GITHUB_CONNECTION_ERROR_CODES,
  type GitHubConnectionProblemCode,
  type ServerGitHubConnection,
} from "narrarium-engine";
import { HttpError } from "./errors.js";
import { unsafeKeys } from "./files.js";
import { KeyedMutex } from "./fs-store.js";

/**
 * The server's own connection to GitHub, made once with the GitHub App's device authorization and renewed by the server itself, with no browser open.
 *
 * The owner types a code on github.com; the server polls GitHub for the answer in the background and keeps a pair of tokens that nobody else shares (the browser has its own pair: GitHub
 * rotates a refresh token at every use, so sharing one would sign one of the two out). The access token lasts eight hours; the refresh token is kept in the protected data folder
 * (`private/github-connection.json`, encrypted by the vault like the other secrets) and is exchanged for a new pair through the broker (the Cloudflare Worker, which holds the app's client
 * secret) a few minutes before the access token ends, one renewal at a time. A renewed pair is saved before the new access token is used, so a crash never loses the refresh token GitHub just
 * rotated.
 *
 * What the owner can see of it (`status`) is public: the code to type, where to type it, the dates, the account's login, and a problem in words. The device code, the access token and the refresh
 * token never leave this file: not in an answer, a log line, a message of an error or a stream.
 */

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_URL = "https://api.github.com";
const DEFAULT_VERIFICATION_URI = "https://github.com/login/device";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const USER_AGENT = "narrarium-server";

/** A call to GitHub or to the broker is given up after this long, and what it answers is not read past `MAX_RESPONSE_BYTES`. */
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** The revocation is a courtesy at the end of a disconnect: it never holds the owner up for long. */
const REVOKE_TIMEOUT_MS = 8_000;
/** A token is renewed when it ends in less than this (GitHub's lasts eight hours). */
const DEFAULT_RENEW_MARGIN_MS = 10 * 60_000;
/** After a renewal fails, the next attempt waits 30 s, then twice as long each time, never more than ten minutes; a caller that finds the token ended may try again after 5 s. */
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const EXPIRED_RETRY_MS = 5_000;
/** The background renewal wakes up at least this often, so that a refresh token is used (and its six months restarted) on a server that runs no book. */
const LONGEST_SLEEP_MS = 6 * 60 * 60_000;
const MAX_TIMER_MS = 2_147_483_647;
/** How many times the account's name is asked for once the owner has typed the code. */
const LOGIN_ATTEMPTS = 3;
/** The shortest and the longest wait between two questions of the device flow that is believed (GitHub asks five seconds), what `slow_down` adds, and the longest a code lives. */
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 3600;
const SLOW_DOWN_SECONDS = 5;
const MAX_FLOW_SECONDS = 3600;
/** The longest lives that are believed of a refresh token (about six months in practice) and of an access token (eight hours in practice). */
const MAX_LIFETIME_SECONDS = 5 * 365 * 24 * 60 * 60;
const MAX_ACCESS_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const CLIENT_ID = /^[A-Za-z0-9._-]{8,64}$/;
const USER_CODE = /^[A-Za-z0-9-]{4,20}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

const GITHUB_MESSAGES: Record<GitHubConnectionProblemCode, string> = {
  "device-flow-disabled": 'Device flow is switched off in the GitHub App. In GitHub open Settings → Developer settings → GitHub Apps → your app → General, turn on "Enable Device Flow", save, and connect again.',
  "expiring-tokens-off": 'The GitHub App issues tokens that never expire, which the server will not keep. In the GitHub App settings turn on "Expire user authorization tokens", save, and connect again. Nothing was stored.',
  "access-denied": "The request was refused on github.com. Connect again and approve it.",
  "code-expired": "The code expired before it was entered on github.com. Connect again to get a new one.",
  "renewal-failed": "GitHub no longer accepts the server's connection (it was revoked, it expired, or it was used twice). Connect again.",
  "broker-unreachable": "The broker could not be reached. The server tries again, and keeps using the current token until it expires.",
  "broker-not-configured": "The broker cannot be used for GitHub: GitHub sign-in is not configured on it (the GitHub App's client id and secret are not set in the Worker), or its address is not on the owner's list of brokers.",
  "github-unreachable": "GitHub could not be reached. The server tries again until the code expires.",
  "client-id-rejected": "GitHub does not know this Client ID. Check the Client ID of the GitHub App and connect again.",
  "github-rejected": "GitHub refused the request.",
};

/** What is kept of the connection, in one file. Only `connected` holds tokens: a connection GitHub refused to renew keeps what it was pinned to (and nothing usable). */
interface StoredConnection {
  version: 1;
  state: "connected" | "needs-reconnect";
  clientId: string;
  /** The broker's base address, as it was pinned: its origin and the path (no trailing slash) the Worker answers under. */
  broker: string;
  login?: string;
  connectedAt?: string;
  renewedAt?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  problem?: Problem;
}

interface Problem {
  code: GitHubConnectionProblemCode;
  message: string;
}

/** A connection that is being made: from the request for a code until the owner has typed it (or it ended). */
interface Flow {
  clientId: string;
  broker: string;
  /** Set once GitHub has given a code: until then the flow only reserves the place, and the status says nothing of it. */
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  /** Seconds between two questions to GitHub. */
  interval: number;
  /** Something that went wrong on the way, while it is still being tried again. */
  problem?: Problem;
  abort: AbortController;
}

export interface GitHubConnectionOptions {
  /** The address that gives a device code (tests; default GitHub's). */
  deviceUrl?: string;
  /** The address that exchanges a device code for tokens (tests; default GitHub's). */
  tokenUrl?: string;
  /** GitHub's API (tests; default https://api.github.com): the account's name is read from `/user`. */
  apiUrl?: string;
  /** How the calls go out (tests; default the global `fetch`, read at each call: the server's outbound guard replaces it). */
  fetch?: typeof fetch;
  /** The clock (tests move it). */
  now?: () => Date;
  /** A token that ends in less than this is renewed (default ten minutes). */
  renewMarginMs?: number;
  /** How the device flow waits between two questions (tests answer at once and remember how long it asked to wait). */
  sleep?: (ms: number) => Promise<void>;
  /** How long a call may take (default 15 s). */
  timeoutMs?: number;
}

/** What the connection keeps in the data folder: the whole file is one text, replaced at once. */
export interface GitHubConnectionStore {
  readGitHubConnection(): Promise<string | undefined>;
  writeGitHubConnection(text: string | null): Promise<void>;
}

export interface GitHubConnectionDependencies {
  store: GitHubConnectionStore;
  /** The owner's list of acceptable broker origins, asked at each use (`undefined`: no list, any acceptable broker). */
  allowedBrokerOrigins: () => readonly string[] | undefined;
  log: (line: string) => void;
}

/** What a book of the server asks of the connection. */
export interface GitHubTokenSource {
  /** The access token, renewed first when it ends soon. Throws `412 github_connection_required` (not connected, or to be connected again) or `502 github_connection_unavailable` (ended, and the broker cannot renew it). */
  accessToken(): Promise<string>;
}

class Transport extends Error {
  constructor(readonly kind: "network" | "timeout" | "size" | "redirect") {
    super(kind);
  }
}

/** Why a renewal did not give a new pair. `lost`: GitHub refuses the refresh token for good. `retry`: it is tried again. */
class RenewalFailure extends Error {
  constructor(readonly kind: "lost" | "retry", readonly problem: Problem) {
    super(problem.message);
  }
}

/** What ended a connection that was being made: the problem, as the status tells it. */
class FlowProblem extends Error {
  readonly problem: Problem;

  constructor(code: GitHubConnectionProblemCode, detail?: string) {
    super(code);
    this.problem = { code, message: detail ?? GITHUB_MESSAGES[code] };
  }
}

const isLoopback = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

function invalidUrl(message: string): HttpError {
  return new HttpError(422, "invalid_url", message);
}

/**
 * A broker's address that may be trusted with a refresh token: https (plain http only on this computer), no credentials, no query, no fragment. Its origin, and its base (the origin and the path the
 * Worker answers under, with no trailing slash).
 */
export function parseBrokerAddress(value: unknown): { base: string; origin: string } {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new HttpError(400, "invalid_request", "Send the address of the broker as `broker`.");
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalidUrl("The broker address is not a valid address.");
  }
  if (url.username || url.password) throw invalidUrl("The broker address may not carry a user name or a password.");
  if (url.search || url.hash || text.includes("?") || text.includes("#")) throw invalidUrl("The broker address may not have a query or a fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw invalidUrl("The broker must be reached over https (plain http only on this computer).");
  return { base: `${url.origin}${url.pathname}`.replace(/\/+$/, ""), origin: url.origin };
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Transport("size");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Transport("size");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A short code from a provider's answer (`slow_down`, `invalid_grant`): letters, digits and underscores only, so that nothing else of what it said is ever quoted. */
function codeOf(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "";
}

function wholeSeconds(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function token(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && PRINTABLE.test(value) ? value : undefined;
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function parseStored(text: string): StoredConnection {
  const value = record(JSON.parse(text));
  const state = value.state;
  const field = (name: string, max: number): string | undefined => (typeof value[name] === "string" && (value[name] as string).length > 0 && (value[name] as string).length <= max ? (value[name] as string) : undefined);
  const clientId = field("clientId", 64);
  const broker = field("broker", 600);
  if (value.version !== 1 || (state !== "connected" && state !== "needs-reconnect") || !clientId || !CLIENT_ID.test(clientId) || !broker) throw new Error("The stored GitHub connection is not valid.");
  parseBrokerAddress(broker);
  const stored: StoredConnection = { version: 1, state, clientId, broker };
  for (const name of ["login", "connectedAt", "renewedAt", "accessTokenExpiresAt", "refreshTokenExpiresAt"] as const) {
    const entry = field(name, 100);
    if (entry) stored[name] = entry;
  }
  if (state === "connected") {
    const accessToken = field("accessToken", 16_384);
    const refreshToken = field("refreshToken", 4096);
    if (!accessToken || !refreshToken || !stored.accessTokenExpiresAt) throw new Error("The stored GitHub connection is not valid.");
    stored.accessToken = accessToken;
    stored.refreshToken = refreshToken;
  } else {
    const problem = record(value.problem);
    if (typeof problem.code === "string" && typeof problem.message === "string") stored.problem = { code: problem.code as GitHubConnectionProblemCode, message: problem.message.slice(0, 500) };
  }
  return stored;
}

export class GitHubConnection implements GitHubTokenSource {
  private readonly lock = new KeyedMutex();
  private stored: StoredConnection | undefined;
  /** The stored file could not be read or understood: said as a connection to make again, until one is made. */
  private unreadable: string | undefined;
  private flow: Flow | undefined;
  /** What went wrong the last time a connection was tried, for as long as nothing else has happened. */
  private lastProblem: Problem | undefined;
  /** A pair that was renewed but could not be saved: it is used from memory, and saved again at the next chance. */
  private unsaved = false;
  private renewing: Promise<void> | undefined;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastAttemptAt = 0;
  /** Why the last renewal did not happen, while the old token still works. */
  private renewalProblem: Problem | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly closing = new AbortController();

  constructor(private readonly dependencies: GitHubConnectionDependencies, private readonly options: GitHubConnectionOptions = {}) {}

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  private get marginMs(): number {
    return this.options.renewMarginMs ?? DEFAULT_RENEW_MARGIN_MS;
  }

  /** Read what was saved, and start renewing it. A file that cannot be read does not stop the server: the connection is said to need making again. */
  async load(): Promise<void> {
    try {
      const text = await this.dependencies.store.readGitHubConnection();
      if (text !== undefined) this.stored = parseStored(text);
    } catch {
      this.unreadable = "The saved connection to GitHub cannot be read (the file is damaged, or the vault key is not the one that wrote it). Disconnect and connect again.";
      this.dependencies.log("The server's GitHub connection could not be read: it has to be connected again.");
    }
    this.schedule();
  }

  /** Stop what runs in the background: the wait for the owner on github.com and the renewal timer; a renewal that is in the middle of its save is let finish. */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort();
    this.flow?.abort.abort();
    this.flow = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.renewing?.catch(() => undefined);
  }

  /** The origins the outbound network guard must let this connection reach besides GitHub's: the broker it is pinned to, or is being made with. */
  brokerOrigins(): string[] {
    const bases = [this.stored?.broker, this.flow?.broker].filter((base): base is string => Boolean(base));
    return [...new Set(bases.map((base) => new URL(base).origin))];
  }

  /** The pinned broker and client id of a connection that exists (connected, or lost and waiting to be made again). */
  get pinned(): { broker: string; clientId: string } | undefined {
    return this.stored ? { broker: new URL(this.stored.broker).origin, clientId: this.stored.clientId } : undefined;
  }

  /** What the owner and the app may see: public things only. */
  status(): ServerGitHubConnection {
    const { flow, stored } = this;
    if (flow?.deviceCode && flow.userCode && flow.verificationUri && flow.expiresAt !== undefined) {
      return {
        state: "pending",
        broker: new URL(flow.broker).origin,
        pending: { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: new Date(flow.expiresAt).toISOString(), interval: flow.interval },
        ...(flow.problem ? { problem: flow.problem } : {}),
      };
    }
    if (stored?.state === "connected") {
      const problem = this.renewalProblem ?? this.lastProblem;
      return {
        state: "connected",
        ...(stored.login ? { login: stored.login } : {}),
        ...(stored.connectedAt ? { connectedAt: stored.connectedAt } : {}),
        ...(stored.renewedAt ? { renewedAt: stored.renewedAt } : {}),
        ...(stored.accessTokenExpiresAt ? { accessTokenExpiresAt: stored.accessTokenExpiresAt } : {}),
        ...(stored.refreshTokenExpiresAt ? { refreshTokenExpiresAt: stored.refreshTokenExpiresAt } : {}),
        broker: new URL(stored.broker).origin,
        ...(problem ? { problem } : {}),
      };
    }
    if (stored) {
      return {
        state: "needs-reconnect",
        ...(stored.login ? { login: stored.login } : {}),
        ...(stored.connectedAt ? { connectedAt: stored.connectedAt } : {}),
        broker: new URL(stored.broker).origin,
        problem: this.lastProblem ?? stored.problem ?? { code: "renewal-failed", message: GITHUB_MESSAGES["renewal-failed"] },
      };
    }
    if (this.unreadable) return { state: "needs-reconnect", problem: { code: "renewal-failed", message: this.unreadable } };
    return { state: "disconnected", ...(this.lastProblem ? { problem: this.lastProblem } : {}) };
  }

  // ---------------------------------------------------------------------------------------------
  // Connecting: the device flow
  // ---------------------------------------------------------------------------------------------

  /**
   * Ask GitHub for a code the owner types on github.com, and wait for the owner in the background. Answers the status: `pending` with the code, or `disconnected` with the problem when GitHub
   * refused (the app has no device flow, the client id is wrong, GitHub cannot be reached). The client id and the broker are pinned: while a connection is connected or waiting, or when the
   * broker or the client id differ from the pinned ones of a lost one, `409 github_connection_exists`.
   */
  async start(body: unknown): Promise<ServerGitHubConnection> {
    const request = record(body);
    const clientId = typeof request.clientId === "string" ? request.clientId.trim() : "";
    if (!CLIENT_ID.test(clientId)) throw new HttpError(400, "invalid_request", "Send the Client ID of the GitHub App as `clientId` (letters, digits, dots, dashes and underscores).");
    const { base, origin } = parseBrokerAddress(request.broker);
    this.assertAllowed(origin);
    if (this.flow) throw new HttpError(409, GITHUB_CONNECTION_ERROR_CODES.exists, "The server is already waiting for a code to be entered on github.com. Disconnect first to start again.");
    const { stored } = this;
    if (stored?.state === "connected") throw new HttpError(409, GITHUB_CONNECTION_ERROR_CODES.exists, "The server is already connected to GitHub. Disconnect first to connect again, with this or another app or broker.");
    if (stored && (stored.clientId !== clientId || stored.broker !== base)) throw new HttpError(409, GITHUB_CONNECTION_ERROR_CODES.exists, "The lost connection is pinned to another Client ID or broker. Disconnect first to connect with these.");
    const flow: Flow = { clientId, broker: base, interval: 5, abort: new AbortController() };
    this.flow = flow;
    this.lastProblem = undefined;
    try {
      await this.requestDeviceCode(flow);
    } catch (error) {
      // A disconnect that came while GitHub was asked for the code is the owner's answer: nothing went wrong.
      if (flow.abort.signal.aborted) return this.status();
      if (this.flow === flow) this.flow = undefined;
      this.lastProblem = error instanceof FlowProblem ? error.problem : { code: "github-unreachable", message: GITHUB_MESSAGES["github-unreachable"] };
      this.dependencies.log(`The server's GitHub connection was not started: ${this.lastProblem.code}.`);
      return this.status();
    }
    void this.poll(flow);
    return this.status();
  }

  /** A broker the owner did not list is never given anything, when the owner made a list. */
  private assertAllowed(origin: string): void {
    const allowed = this.dependencies.allowedBrokerOrigins();
    if (allowed && !allowed.includes(origin)) throw invalidUrl(`The owner of this server accepts only some brokers (githubConnection.allowedBrokerOrigins in config.json), and ${origin} is not one of them.`);
  }

  private async requestDeviceCode(flow: Flow): Promise<void> {
    let answer: { status: number; json: unknown };
    try {
      answer = await this.call(this.options.deviceUrl ?? DEVICE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: flow.clientId }).toString() }, { signal: flow.abort.signal });
    } catch {
      throw new FlowProblem("github-unreachable");
    }
    const data = record(answer.json);
    const error = codeOf(data.error);
    if (error) throw this.githubProblem(error, answer.status);
    if (answer.status === 404) throw new FlowProblem("client-id-rejected");
    const deviceCode = token(data.device_code, 4096);
    const userCode = typeof data.user_code === "string" && USER_CODE.test(data.user_code) ? data.user_code : undefined;
    const expiresIn = wholeSeconds(data.expires_in, 1, MAX_FLOW_SECONDS);
    if (answer.status !== 200 || !deviceCode || !userCode || !expiresIn) throw this.githubProblem("", answer.status);
    flow.deviceCode = deviceCode;
    flow.userCode = userCode;
    flow.verificationUri = this.verificationAddress(data.verification_uri);
    flow.expiresAt = this.now() + expiresIn * 1000;
    flow.interval = wholeSeconds(data.interval, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS) ?? 5;
  }

  /** The address the owner is told to open: GitHub's own page. What GitHub says is used only when it is on the same site as the address the code came from. */
  private verificationAddress(value: unknown): string {
    const fallback = this.options.deviceUrl ? new URL("/login/device", this.options.deviceUrl).href : DEFAULT_VERIFICATION_URI;
    if (typeof value !== "string" || value.length > 300) return fallback;
    try {
      const given = new URL(value);
      const expected = new URL(this.options.deviceUrl ?? DEVICE_URL);
      return given.origin === expected.origin && !given.username && !given.password && !given.search && !given.hash ? given.href : fallback;
    } catch {
      return fallback;
    }
  }

  /** What GitHub's error code (or an answer that is none of the ones it gives) means for the owner. */
  private githubProblem(error: string, status?: number): FlowProblem {
    switch (error) {
      case "device_flow_disabled": return new FlowProblem("device-flow-disabled");
      case "access_denied": return new FlowProblem("access-denied");
      case "expired_token": return new FlowProblem("code-expired");
      case "incorrect_client_credentials": return new FlowProblem("client-id-rejected");
      default: return new FlowProblem("github-rejected", `${GITHUB_MESSAGES["github-rejected"]} (${[status ? `HTTP ${status}` : "", error].filter(Boolean).join(", ") || "no reason given"})`);
    }
  }

  /** Ask GitHub, as often as it allows, whether the owner has typed the code; it ends when it is answered, refused, or the code expires. */
  private async poll(flow: Flow): Promise<void> {
    const wait = this.options.sleep ?? sleepFor;
    try {
      for (;;) {
        await wait(flow.interval * 1000);
        if (this.closed || flow.abort.signal.aborted || this.flow !== flow) return;
        if (this.now() >= (flow.expiresAt ?? 0)) throw new FlowProblem("code-expired");
        let answer: { status: number; json: unknown };
        try {
          answer = await this.call(this.options.tokenUrl ?? TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: flow.clientId, device_code: flow.deviceCode ?? "", grant_type: DEVICE_GRANT }).toString(),
          }, { signal: flow.abort.signal });
        } catch {
          if (flow.abort.signal.aborted) return;
          flow.problem = { code: "github-unreachable", message: GITHUB_MESSAGES["github-unreachable"] };
          continue;
        }
        flow.problem = undefined;
        const data = record(answer.json);
        const error = codeOf(data.error);
        if (error === "authorization_pending") continue;
        if (error === "slow_down") {
          flow.interval = Math.min(MAX_INTERVAL_SECONDS, Math.max(flow.interval + SLOW_DOWN_SECONDS, wholeSeconds(data.interval, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS) ?? 0));
          continue;
        }
        if (error) throw this.githubProblem(error, answer.status);
        if (answer.status !== 200) throw this.githubProblem("", answer.status);
        await this.finish(flow, data);
        return;
      }
    } catch (error) {
      if (this.closed || this.flow !== flow) return;
      this.flow = undefined;
      this.lastProblem = error instanceof FlowProblem ? error.problem : { code: "github-rejected", message: GITHUB_MESSAGES["github-rejected"] };
      this.dependencies.log(`The server's GitHub connection was not made: ${this.lastProblem.code}.`);
    }
  }

  /** The owner typed the code: keep the pair (only an expiring one), find the account's name, and save it all before anything uses the token. */
  private async finish(flow: Flow, data: Record<string, unknown>): Promise<void> {
    const accessToken = token(data.access_token, 16_384);
    const refreshToken = token(data.refresh_token, 4096);
    const expiresIn = wholeSeconds(data.expires_in, 1, MAX_ACCESS_LIFETIME_SECONDS);
    if (!accessToken) throw this.githubProblem("", 200);
    // A token that does not end, or comes with nothing to renew it, is refused and not kept: the server would hold a credential for good, or one that dies in eight hours with no way to go on.
    if (!refreshToken || !expiresIn) throw new FlowProblem("expiring-tokens-off");
    const now = this.now();
    const refreshExpiresIn = wholeSeconds(data.refresh_token_expires_in, 1, MAX_LIFETIME_SECONDS);
    const login = await this.loginOf(accessToken, flow.abort.signal);
    const next: StoredConnection = {
      version: 1,
      state: "connected",
      clientId: flow.clientId,
      broker: flow.broker,
      ...(login ? { login } : {}),
      connectedAt: new Date(now).toISOString(),
      accessToken,
      accessTokenExpiresAt: new Date(now + expiresIn * 1000).toISOString(),
      refreshToken,
      ...(refreshExpiresIn ? { refreshTokenExpiresAt: new Date(now + refreshExpiresIn * 1000).toISOString() } : {}),
    };
    await this.lock.run("connection", async () => {
      if (this.closed || this.flow !== flow) return;
      try {
        await this.persist(next);
      } catch {
        throw new FlowProblem("renewal-failed", "The connection was made, but it could not be saved on this computer (check the data folder), so nothing was kept. Connect again.");
      }
      this.stored = next;
      this.unsaved = false;
      this.unreadable = undefined;
      this.flow = undefined;
      this.lastProblem = undefined;
      this.renewalProblem = undefined;
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.schedule();
      this.dependencies.log(`The server is connected to GitHub${login ? ` as ${login}` : ""}.`);
    });
  }

  /** The login of the account that authorized the server, from GitHub's own API; `undefined` when it cannot be read (it is asked again at the next renewal). */
  private async loginOf(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
    for (let attempt = 0; attempt < LOGIN_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) return undefined;
      try {
        const answer = await this.call(`${(this.options.apiUrl ?? API_URL).replace(/\/+$/, "")}/user`, { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } }, { signal });
        const login = record(answer.json).login;
        if (answer.status === 200 && typeof login === "string" && LOGIN.test(login)) return login;
        if (answer.status >= 400 && answer.status < 500 && answer.status !== 429) return undefined;
      } catch {
        // Tried again.
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // Using it, and renewing it
  // ---------------------------------------------------------------------------------------------

  /** The access token the books use: renewed first when it ends in less than the margin. See `GitHubTokenSource`. */
  async accessToken(): Promise<string> {
    const first = this.stored;
    if (!first || first.state !== "connected" || !first.accessToken) throw this.required();
    if (this.due(first)) await this.renew();
    const current = this.stored;
    if (!current || current.state !== "connected" || !current.accessToken) throw this.required();
    if (this.expired(current)) {
      throw new HttpError(502, GITHUB_CONNECTION_ERROR_CODES.unavailable, `The server's GitHub token ended and could not be renewed: ${this.renewalProblem?.message ?? "the broker did not answer."}`);
    }
    if (this.unsaved) void this.saveAgain();
    return current.accessToken;
  }

  private required(): HttpError {
    const lost = this.stored?.state === "needs-reconnect" || this.unreadable;
    return new HttpError(412, GITHUB_CONNECTION_ERROR_CODES.required, lost
      ? "The server's connection to GitHub was lost: connect it again (the personal server settings, or the admin panel), then try again."
      : "The server is not connected to GitHub. Connect it in the personal server settings (GitHub connection) before using it for a book.");
  }

  private expiresAt(stored: StoredConnection): number {
    const at = Date.parse(stored.accessTokenExpiresAt ?? "");
    return Number.isFinite(at) ? at : 0;
  }

  private expired(stored: StoredConnection): boolean {
    return this.expiresAt(stored) <= this.now();
  }

  private due(stored: StoredConnection): boolean {
    return this.expiresAt(stored) - this.marginMs <= this.now();
  }

  /** One renewal at a time, whoever asks: the callers that come while one is going on wait for that one. It never throws: what happened is in the status. */
  private renew(): Promise<void> {
    if (!this.renewing) {
      this.renewing = this.lock.run("connection", () => this.renewLocked()).catch(() => undefined).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  private async renewLocked(): Promise<void> {
    const current = this.stored;
    if (!current || current.state !== "connected" || !current.refreshToken || this.closed) return;
    // Another caller renewed while this one waited for its turn.
    if (!this.due(current)) return;
    const now = this.now();
    if (this.expired(current) ? now - this.lastAttemptAt < EXPIRED_RETRY_MS : now < this.nextAttemptAt) return;
    this.lastAttemptAt = now;
    let renewed: Renewed;
    try {
      renewed = await this.askBroker(current);
    } catch (error) {
      await this.renewalFailed(current, error);
      return;
    }
    const at = this.now();
    const next: StoredConnection = {
      ...current,
      renewedAt: new Date(at).toISOString(),
      accessToken: renewed.accessToken,
      accessTokenExpiresAt: new Date(at + renewed.expiresIn * 1000).toISOString(),
      refreshToken: renewed.refreshToken,
      ...(renewed.refreshTokenExpiresIn ? { refreshTokenExpiresAt: new Date(at + renewed.refreshTokenExpiresIn * 1000).toISOString() } : {}),
    };
    // The refresh token GitHub just rotated is the only one that works from now on: it is saved before the new access token is used. If it cannot be saved it is kept in memory and saved again,
    // since throwing it away would lose the connection.
    try {
      await this.persist(next);
      this.unsaved = false;
      this.renewalProblem = undefined;
    } catch {
      this.unsaved = true;
      this.renewalProblem = { code: "renewal-failed", message: "The renewed GitHub token could not be saved on this computer. It is used from memory and saved again at the next chance: check the data folder." };
      this.dependencies.log("The server's renewed GitHub token could not be saved: it is kept in memory and saved again.");
    }
    this.stored = next;
    this.failures = 0;
    this.nextAttemptAt = 0;
    if (!next.login) void this.learnLogin();
    this.schedule();
  }

  private async renewalFailed(current: StoredConnection, error: unknown): Promise<void> {
    const failure = error instanceof RenewalFailure ? error : new RenewalFailure("retry", { code: "broker-unreachable", message: GITHUB_MESSAGES["broker-unreachable"] });
    if (failure.kind === "lost") {
      // GitHub refuses the refresh token for good: nothing usable is kept, the pins are, and the books on the connection stop with a clear error.
      const lost: StoredConnection = { version: 1, state: "needs-reconnect", clientId: current.clientId, broker: current.broker, ...(current.login ? { login: current.login } : {}), ...(current.connectedAt ? { connectedAt: current.connectedAt } : {}), problem: failure.problem };
      try {
        await this.persist(lost);
      } catch {
        this.dependencies.log("The server's lost GitHub connection could not be saved as lost.");
      }
      this.stored = lost;
      this.unsaved = false;
      this.renewalProblem = undefined;
      this.dependencies.log("The server's GitHub connection was lost: GitHub no longer accepts it. It has to be connected again.");
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    this.failures += 1;
    this.nextAttemptAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (this.failures - 1));
    this.renewalProblem = failure.problem;
    if (this.failures === 1) this.dependencies.log(`The server could not renew its GitHub token (${failure.problem.code}): it tries again, and keeps the current token until it ends.`);
    this.schedule();
  }

  /**
   * Exchange the refresh token for a new pair through the broker (the Worker's `github/refresh` route, the one the browser uses; the Worker holds the client secret). The call is never cut short by the
   * server closing: GitHub rotates the refresh token when it answers, and an answer that is thrown away would lose the connection.
   */
  private async askBroker(current: StoredConnection): Promise<Renewed> {
    const origin = new URL(current.broker).origin;
    const allowed = this.dependencies.allowedBrokerOrigins();
    if (allowed && !allowed.includes(origin)) throw new RenewalFailure("retry", { code: "broker-not-configured", message: GITHUB_MESSAGES["broker-not-configured"] });
    let answer: { status: number; json: unknown };
    try {
      answer = await this.call(`${current.broker}/oauth/github/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: current.refreshToken }) });
    } catch {
      throw new RenewalFailure("retry", { code: "broker-unreachable", message: GITHUB_MESSAGES["broker-unreachable"] });
    }
    const data = record(answer.json);
    const error = codeOf(data.error);
    if (answer.status === 400 && error === "invalid_grant") throw new RenewalFailure("lost", { code: "renewal-failed", message: GITHUB_MESSAGES["renewal-failed"] });
    if (answer.status === 501 && error === "not_configured") throw new RenewalFailure("retry", { code: "broker-not-configured", message: GITHUB_MESSAGES["broker-not-configured"] });
    if (answer.status >= 500 || answer.status === 429 || answer.status === 404) throw new RenewalFailure("retry", { code: "broker-unreachable", message: GITHUB_MESSAGES["broker-unreachable"] });
    const accessToken = token(data.accessToken, 16_384);
    const refreshToken = token(data.refreshToken, 4096);
    const expiresIn = wholeSeconds(data.expiresIn, 1, MAX_ACCESS_LIFETIME_SECONDS);
    if (answer.status !== 200 || !accessToken || !refreshToken || !expiresIn) {
      throw new RenewalFailure("retry", { code: "renewal-failed", message: `The broker's answer to the renewal was not what the server expects (HTTP ${answer.status}${error ? `, ${error}` : ""}). It tries again, and keeps the current token until it ends.` });
    }
    const refreshTokenExpiresIn = wholeSeconds(data.refreshTokenExpiresIn, 1, MAX_LIFETIME_SECONDS);
    return { accessToken, expiresIn, refreshToken, ...(refreshTokenExpiresIn ? { refreshTokenExpiresIn } : {}) };
  }

  /** The account's name, when the first reading of it failed: asked once the connection is renewed (it is not worth failing anything for). */
  private async learnLogin(): Promise<void> {
    const current = this.stored;
    if (!current || current.state !== "connected" || !current.accessToken || current.login) return;
    const login = await this.loginOf(current.accessToken, this.closing.signal);
    if (!login) return;
    await this.lock.run("connection", async () => {
      if (this.stored !== current || this.closed) return;
      const next = { ...current, login };
      try {
        await this.persist(next);
        this.stored = next;
      } catch {
        // Not saved, not needed: the next renewal asks again.
      }
    });
  }

  private async saveAgain(): Promise<void> {
    await this.lock.run("connection", async () => {
      const current = this.stored;
      if (!this.unsaved || !current || current.state !== "connected") return;
      try {
        await this.persist(current);
        this.unsaved = false;
        this.renewalProblem = undefined;
      } catch {
        // Still not: tried again at the next use.
      }
    });
  }

  private persist(connection: StoredConnection): Promise<void> {
    return this.dependencies.store.writeGitHubConnection(JSON.stringify(connection));
  }

  /** Wake up before the access token ends (or when a failed renewal is to be tried again) and renew it: a server that runs no book keeps its connection alive too. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.stored;
    if (this.closed || !current || current.state !== "connected") return;
    const target = Math.max(this.expiresAt(current) - this.marginMs, this.nextAttemptAt);
    const delay = Math.min(LONGEST_SLEEP_MS, MAX_TIMER_MS, Math.max(1000, target - this.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.renew().then(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  // ---------------------------------------------------------------------------------------------
  // Disconnecting
  // ---------------------------------------------------------------------------------------------

  /**
   * Forget the connection: stop waiting for a code, wait for a renewal that is in the middle of its save, delete the saved pair, and ask the broker to revoke the server's own access token (best
   * effort: a broker without the route, or out of reach, leaves the token to end by itself within eight hours). Already disconnected is not an error.
   */
  async disconnect(): Promise<ServerGitHubConnection> {
    const flow = this.flow;
    this.flow = undefined;
    flow?.abort.abort();
    await this.renewing?.catch(() => undefined);
    let revoke: { broker: string; token: string } | undefined;
    await this.lock.run("connection", async () => {
      const current = this.stored;
      if (current?.state === "connected" && current.accessToken) revoke = { broker: current.broker, token: current.accessToken };
      if (current || this.unreadable || this.unsaved) await this.dependencies.store.writeGitHubConnection(null);
      this.stored = undefined;
      this.unreadable = undefined;
      this.unsaved = false;
      this.lastProblem = undefined;
      this.renewalProblem = undefined;
      this.failures = 0;
      this.nextAttemptAt = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    });
    if (revoke) await this.revoke(revoke.broker, revoke.token);
    return this.status();
  }

  /**
   * Revoke the server's own token, and no other: the Worker's `github/revoke` deletes the owner's whole authorization of the app, and with it the browser's sign-in, so the Worker has a route of its
   * own for one token (`github/revoke-token`). A Worker that does not have it answers 404, and the token ends by itself.
   */
  private async revoke(broker: string, accessToken: string): Promise<void> {
    try {
      const allowed = this.dependencies.allowedBrokerOrigins();
      if (allowed && !allowed.includes(new URL(broker).origin)) return;
      const answer = await this.call(`${broker}/oauth/github/revoke-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: accessToken }) }, { timeoutMs: REVOKE_TIMEOUT_MS });
      if (answer.status < 200 || answer.status > 299) this.dependencies.log(`The broker did not revoke the server's GitHub token (HTTP ${answer.status}): it ends by itself within eight hours.`);
    } catch {
      this.dependencies.log("The broker could not be reached to revoke the server's GitHub token: it ends by itself within eight hours.");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The calls
  // ---------------------------------------------------------------------------------------------

  /** One call to GitHub or to the broker: a fixed time to answer, no redirect followed (a credential never goes anywhere else), an answer read up to a limit. */
  private async call(url: string, init: { method: string; headers: Record<string, string>; body?: string }, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const guard = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const fetcher = this.options.fetch ?? ((input, request) => globalThis.fetch(input, request));
    let response: Response;
    try {
      response = await fetcher(url, { ...init, headers: { accept: "application/json", "user-agent": USER_AGENT, ...init.headers }, redirect: "manual", signal: guard });
    } catch {
      throw new Transport(timeout.aborted ? "timeout" : "network");
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new Transport("redirect");
    }
    let text: string;
    try {
      text = await readLimited(response);
    } catch (error) {
      throw error instanceof Transport ? error : new Transport(timeout.aborted ? "timeout" : "network");
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
      if (unsafeKeys(json)) json = undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }
}

interface Renewed {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn?: number;
}
