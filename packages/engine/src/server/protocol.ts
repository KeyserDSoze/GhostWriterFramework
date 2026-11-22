import type { AiRuntimeConfig, RedactedAiIntegration, RedactedAiTaskRoute } from "../ai/config.js";
import type { EvaluationTarget } from "../book/paths.js";
import type { BookFileChange, BookFileContent, BookFileEntry } from "../book/store.js";
import type { DirectorOpinion } from "../director/opinion.js";
import type { AutopilotEvent, AutopilotLiveOptions, AutopilotPauseMode, AutopilotSnapshot, AutopilotStateSummary, InterventionInput, QuestionAnswer, StartOptions } from "../autopilot/types.js";

export const SERVER_API_VERSION = 1;
/** The oldest and the newest `ServerInfo.apiVersion` a server may speak for this engine to talk to it (see `serverCompatibility`). */
export const MIN_SUPPORTED_SERVER_API = 1;
export const MAX_SUPPORTED_SERVER_API = 1;
export const DEFAULT_SERVER_PORT = 24242;
/** Loopback port of the server's admin panel. */
export const DEFAULT_ADMIN_PORT = 24243;
export const SERVER_PACKAGE_NAME = "narrarium-server";

/** Permissions of a client token. `update` (replace the server version) is granted only explicitly by the owner. */
export const SERVER_SCOPES = ["read", "write", "run", "update"] as const;
export type ServerScope = (typeof SERVER_SCOPES)[number];

export interface ServerInfo {
  name: typeof SERVER_PACKAGE_NAME;
  apiVersion: number;
  serverVersion: string;
  engineVersion: string;
  serverId: string;
  label: string;
  /** Whether `git` is available for GitHub-backed books. */
  git: boolean;
  features: string[];
  /** Ed25519 public key of the server (SPKI DER, base64) and its SHA-256 fingerprint (hex). */
  publicKey?: string;
  fingerprint?: string;
  /** Echo of the request nonce and the Ed25519 signature of `nonce\nserverId\npublicKey` (base64). */
  nonce?: string;
  signature?: string;
  /** Started with `npx narrarium-server start`: the supervisor can install a new version on request. */
  supervised?: boolean;
}

/** Whether this engine and a server speak the same API: `server-older` (the server must be updated) or `server-newer` (this app must be). */
export type ServerCompatibilityStatus = "ok" | "server-older" | "server-newer";

export interface ServerCompatibility {
  status: ServerCompatibilityStatus;
  /** What to tell the author, in English: which version the server speaks, which this engine supports, and what to update. */
  message: string;
}

/**
 * Whether the server that answered `info` speaks an API this engine supports (`MIN_SUPPORTED_SERVER_API` to
 * `MAX_SUPPORTED_SERVER_API`). It never throws: a server that does not say which API it speaks (or says it oddly) is an older one,
 * and what to do about each answer is for the host to decide.
 */
export function serverCompatibility(info: Pick<ServerInfo, "apiVersion"> | null | undefined): ServerCompatibility {
  const version = info?.apiVersion;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { status: "server-older", message: "The personal server does not say which API version it speaks, so it is older than this app supports: update the server." };
  }
  const supported = MIN_SUPPORTED_SERVER_API === MAX_SUPPORTED_SERVER_API ? `${MIN_SUPPORTED_SERVER_API}` : `${MIN_SUPPORTED_SERVER_API} to ${MAX_SUPPORTED_SERVER_API}`;
  if (version < MIN_SUPPORTED_SERVER_API) return { status: "server-older", message: `The personal server speaks API version ${version}; this app supports ${supported}: update the server.` };
  if (version > MAX_SUPPORTED_SERVER_API) return { status: "server-newer", message: `The personal server speaks API version ${version}; this app supports ${supported}: update Narrarium.` };
  return { status: "ok", message: `The personal server speaks API version ${version}, which this app supports.` };
}

export interface ServerSession {
  serverId: string;
  label: string;
  clientLabel: string;
  clientId: string;
  scopes: ServerScope[];
}

export interface PairingRequest {
  /** Nine-digit code shown in the server's admin panel. */
  code: string;
  /** 64 hex characters chosen by the client; only its hash is kept by the server. */
  nonce: string;
  label: string;
}

/**
 * What polling a pairing answers: still waiting for the owner, or the token (delivered once), with the four digits the owner
 * sees next to the client in the admin panel when the server sends them (`verification`: older servers do not).
 */
export type PairingResult = { pending: true } | { token: string; verification?: string };

export type ServerUpdateReason = "not_published" | "no_trusted_release" | "unavailable" | "up_to_date" | "no_supervisor" | "missing_scope";

export interface ServerUpdateResult {
  requestId: string;
  state: "completed" | "failed";
  /** `completed`, or why the update did not happen. */
  outcome: "completed" | "failed" | "limited" | "stopping";
  version: string;
  fromVersion: string;
  at: string;
  message: string;
}

export interface ServerUpdateInfo {
  packageName: typeof SERVER_PACKAGE_NAME;
  installedVersion: string;
  latestVersion?: string;
  /** A newer release exists, signed by the npm registry and attested by the publishing workflow. */
  available: boolean;
  /** This client may ask for the update now. */
  canRequest: boolean;
  signed: boolean;
  supervised: boolean;
  hasUpdateScope: boolean;
  reason?: ServerUpdateReason;
  message: string;
  lastUpdate?: ServerUpdateResult;
  /** An update already requested and waiting for the supervisor. */
  pending?: { version: string; requestedAt: string };
}

export interface ServerUpdateRequest {
  version: string;
  installedVersion: string;
  confirmed: true;
}

export interface ServerUpdateAccepted {
  accepted: true;
  version: string;
  message: string;
}

export type ServerBookStorage =
  | { kind: "github"; owner: string; repo: string; branch: string }
  | { kind: "local" };

export interface RegisterBookRequest {
  title: string;
  storage: ServerBookStorage;
  /** GitHub token for this book, sent only with the author's consent. `null` removes it. */
  githubToken?: string | null;
}

export interface ServerBookSync {
  at: string;
  ok: boolean;
  message: string;
  head?: string;
}

export interface ServerBookSummary {
  bookId: string;
  title: string;
  storage: ServerBookStorage;
  hasGithubToken: boolean;
  ready: boolean;
  /** Changes whenever a file of the book changes on the server. */
  revision: string;
  autopilot: AutopilotStateSummary | null;
  running: boolean;
  lastSync: ServerBookSync | null;
  error?: string;
}

export interface ServerManifest {
  revision: string;
  files: BookFileEntry[];
}

export interface CommitFilesRequest {
  changes: BookFileChange[];
  message: string;
}

export interface ReadFilesResponse {
  files: BookFileContent[];
}

export interface AskDirectorRequest {
  target: EvaluationTarget;
  question?: string;
  save?: boolean;
}

export interface AskDirectorResponse {
  opinion: DirectorOpinion;
  path: string;
  saved: boolean;
  /** Problems of `director.md`, when the server's engine reports them (older servers send none). */
  warnings?: string[];
}

export interface ServerAiStatus {
  configured: boolean;
  /** Every integration, without its key; an integration that sets a thinking level says it (`thinking`). */
  integrations: RedactedAiIntegration[];
  routedTasks: string[];
  updatedAt: string | null;
  /** AI endpoint origins the server owner still has to approve in the admin panel before they can be called. */
  pendingApproval?: string[];
  /** Whether "Tools only" is in force (`AiRuntimeConfig.toolsOnly`: true unless the configuration turned it off). Absent from a server that does not say. */
  toolsOnly?: boolean;
  /** The route of every routed task, with the thinking level of each target when it sets one (`redactAiRuntimeConfig(...).taskRouting`). Absent from a server that does not say. */
  taskRouting?: Record<string, RedactedAiTaskRoute>;
}

export interface PutAiConfigRequest {
  config: AiRuntimeConfig;
}

/**
 * The `ServerInfo.features` entry of a server that implements the quick controls of the autopilot: the pause modes `after-chapter` and
 * `cancel`, the `limits` of `start`, and `PUT /api/v1/books/:id/autopilot/options` (see `AutopilotLiveOptions`). A server without it
 * ignores `limits` (the run would not stop after the step or the chapter that was asked for) and takes every pause mode but `now` for
 * `after-step` (a `cancel` would pause): a client checks `serverSupportsAutopilotControls` before it sends them.
 */
export const SERVER_FEATURE_AUTOPILOT_CONTROLS = "autopilot-controls";

/** Whether the server announces that it implements the quick controls of the autopilot. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsAutopilotControls(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_CONTROLS);
}

/**
 * The `ServerInfo.features` entry of a server that implements the routes that edit the permanent rules of the autopilot:
 * `PUT` and `DELETE /api/v1/books/:id/autopilot/rules/:index` (see `UpdateAutopilotRuleRequest`). A server without it answers 404 to them:
 * a client checks `serverSupportsAutopilotRules` before it offers to edit or remove a rule.
 */
export const SERVER_FEATURE_AUTOPILOT_RULES = "autopilot-rules";

/** Whether the server announces that it implements the routes that edit the permanent rules. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsAutopilotRules(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_RULES);
}

/** The `mode`s of `POST /api/v1/books/:id/autopilot/pause`: `now`, `after-step` and `after-chapter` pause (see `AutopilotPauseMode`); `cancel` takes back a pause that waits. */
export const PAUSE_AUTOPILOT_MODES = ["now", "after-step", "after-chapter", "cancel"] as const;

/** How a client asks the server to pause (one of `PAUSE_AUTOPILOT_MODES`). */
export type PauseAutopilotMode = AutopilotPauseMode | "cancel";

export type StartAutopilotRequest = StartOptions & { force?: boolean };
export type PauseAutopilotRequest = { mode: PauseAutopilotMode };
/** The body of `PUT /api/v1/books/:id/autopilot/options`: at least one of the two settings that can change while a run goes on. */
export type UpdateAutopilotOptionsRequest = AutopilotLiveOptions;
/**
 * The body of `PUT /api/v1/books/:id/autopilot/rules/:index`: the new text of the rule at that index of `state.constraints`, and the text the
 * author saw there (`expectedText`), so that a rule that changed in the meantime is never overwritten (`DELETE …/rules/:index?expectedText=…`
 * takes it as a query parameter). Both answer the snapshot, like `configure`.
 */
export interface UpdateAutopilotRuleRequest {
  text: string;
  expectedText?: string;
}
export type InterveneRequest = InterventionInput;
export type AnswerRequest = QuestionAnswer;

export interface EventsResponse {
  events: AutopilotEvent[];
  lastSeq: number;
}

export interface ErrorResponse {
  code: string;
  message: string;
}

/** Messages carried by the `/api/v1/events` stream. */
export type ServerStreamMessage =
  | { event: "hello"; data: { serverId: string; at: string } }
  | { event: "heartbeat"; data: { at: string } }
  | { event: "autopilot"; data: AutopilotEvent }
  | { event: "book"; data: ServerBookSummary };

export function encodeServerSentEvent(message: ServerStreamMessage, id?: string | number): string {
  const lines = [`event: ${message.event}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  for (const line of JSON.stringify(message.data).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** Incremental parser for a `text/event-stream` body. */
export class ServerSentEventParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];

  constructor(private readonly onEvent: (event: string, data: string) => void, private readonly maxEventBytes = 2_000_000) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxEventBytes) throw new Error("Server event too large.");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) this.onEvent(this.event, this.data.join("\n"));
      this.event = "message";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value || "message";
    else if (field === "data") this.data.push(value);
  }
}

/** Normalize a server URL typed by the author (`localhost:24242` → `http://localhost:24242`). */
export function normalizeServerUrl(value: string): string {
  let raw = value.trim();
  if (!raw) throw new Error("The server address is empty.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") throw new Error("The server address must use http or https.");
  if (!scheme) raw = `${/^(localhost|127\.|\[::1\])/i.test(raw) ? "http" : "https"}://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The server address must use http or https.");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function bookRoute(bookId: string, suffix = ""): string {
  return `/api/v1/books/${encodeURIComponent(bookId)}${suffix}`;
}

/** The text a server signs to prove its identity for one request. */
export function serverIdentityMessage(nonce: string, serverId: string, publicKey: string): string {
  return `${nonce}\n${serverId}\n${publicKey}`;
}

/** 64 random hex characters, used as identity and pairing nonces. */
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface ServerIdentityCheck {
  /** The signature was verified with Web Crypto. */
  verified: boolean;
  /** This runtime cannot verify Ed25519 signatures (only the fingerprint can be compared). */
  unsupported?: boolean;
  fingerprint: string;
  /** Whether the server speaks an API this engine supports: reported, never thrown, so the host decides how to say it. */
  compatibility: ServerCompatibility;
}

/**
 * Check that a signed `/api/v1/info` answer comes from the holder of the announced key: the
 * fingerprint must match the key and the signature must cover this nonce. Throws when they do not.
 */
export async function verifyServerIdentity(info: ServerInfo, nonce: string): Promise<ServerIdentityCheck> {
  if (!info.publicKey || !info.signature || !info.fingerprint || info.nonce !== nonce) throw new Error("The personal server did not prove its identity.");
  const compatibility = serverCompatibility(info);
  const subtle = globalThis.crypto.subtle;
  const keyBytes = base64Bytes(info.publicKey);
  const digest = new Uint8Array(await subtle.digest("SHA-256", keyBytes));
  const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (fingerprint !== info.fingerprint) throw new Error("The personal server's identity does not match its key.");
  let key: CryptoKey;
  try {
    key = await subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { verified: false, unsupported: true, fingerprint, compatibility };
  }
  const valid = await subtle.verify({ name: "Ed25519" }, key, base64Bytes(info.signature), new TextEncoder().encode(serverIdentityMessage(nonce, info.serverId, info.publicKey)));
  if (!valid) throw new Error("The personal server's identity signature is not valid.");
  return { verified: true, fingerprint, compatibility };
}

export type { AutopilotSnapshot };
