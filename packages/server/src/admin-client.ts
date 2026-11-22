import { createPublicKey, randomBytes, verify } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ADMIN_PORT, serverIdentityMessage, type ServerScope } from "narrarium-engine";
import { ADMIN_CODE_FILE, assertAdminCode, parseScopes } from "./auth.js";
import { readJson, readPrivateText } from "./files.js";
import type { ServerSpendStatus, SpendSettings } from "./spend.js";
import { SERVER_VERSION } from "./version.js";

/** The admin code of a data folder (the CLI reads it locally; it is never sent anywhere but the loopback admin port). */
export async function readAdminCode(dataRoot: string): Promise<string> {
  const text = await readPrivateText(path.join(path.resolve(dataRoot), "private", ADMIN_CODE_FILE), 202);
  if (text === undefined) throw new Error("The admin code does not exist yet: start the server once with `npx narrarium-server start`.");
  const code = text.trim();
  if (!code || /[\r\n\0]/.test(code)) throw new Error("The admin code file is not valid.");
  return code;
}

/** Read a new admin code from a private 0600 file (never from the command line). */
export async function readAdminCodeFile(file: string): Promise<string> {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 32 || info.size > 201 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("The code file must be a private (0600) regular file with 32-200 characters.");
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("The code file changed while it was read.");
    const text = await handle.readFile("utf8");
    return assertAdminCode(text.endsWith("\n") ? text.slice(0, -1) : text);
  } finally {
    await handle.close();
  }
}

export interface LocalAdminOptions {
  dataRoot: string;
  adminPort?: number;
  fetchImpl?: typeof fetch;
  /** How long the server has to answer the identity challenge (default five seconds). */
  identityTimeoutMs?: number;
}

interface AdminSession {
  origin: string;
  csrf: string;
  cookie: string;
  fetchImpl: typeof fetch;
}

/** What the data folder says the server is: its public key (and its id), written by the server itself. */
interface PinnedIdentity {
  publicKey: string;
  serverId?: string;
}

/** How the command line introduces itself: the owner sees it next to the tokens it made, in the admin panel. */
const CLI_AGENT = `narrarium-server-cli/${SERVER_VERSION}`;
const IDENTITY_TIMEOUT_MS = 5_000;
const MAX_IDENTITY_BYTES = 8 * 1024;

async function pinnedIdentity(dataRoot: string): Promise<PinnedIdentity> {
  const root = path.resolve(dataRoot);
  const stored = await readJson(path.join(root, "private", "identity.json"), 64 * 1024) as { publicKey?: unknown } | undefined;
  if (typeof stored?.publicKey !== "string" || !stored.publicKey) throw new Error("The identity of the server is not known yet: start it once with `npx narrarium-server start`.");
  const config = await readJson(path.join(root, "config.json"), 1024 * 1024).catch(() => undefined) as { serverId?: unknown } | undefined;
  return { publicKey: stored.publicKey, ...(typeof config?.serverId === "string" ? { serverId: config.serverId } : {}) };
}

function notThisServer(origin: string, dataRoot: string, reason: string): Error {
  return new Error(`Something answers on ${origin}, but it is not the narrarium-server of this data folder (${path.resolve(dataRoot)}): ${reason}. The admin code was NOT sent. If you run more than one server, check --data-root and the ports (npx narrarium-server status); otherwise another program is using this port.`);
}

/** The body of an answer, or `undefined` when it is longer than `max` (nothing more is read). */
async function boundedText(response: Response, max: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Check a signed answer against what the data folder says the server is (never against what the answer says about itself). */
function assertProof(value: unknown, nonce: string, pinned: PinnedIdentity): boolean {
  const proof = value as { serverId?: unknown; publicKey?: unknown; nonce?: unknown; signature?: unknown } | null;
  if (!proof || typeof proof !== "object" || proof.nonce !== nonce || typeof proof.serverId !== "string" || typeof proof.signature !== "string" || proof.publicKey !== pinned.publicKey) return false;
  if (pinned.serverId !== undefined && proof.serverId !== pinned.serverId) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(pinned.publicKey, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(serverIdentityMessage(nonce, proof.serverId, pinned.publicKey)), key, Buffer.from(proof.signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Make the listener on the admin port prove it is the server of this data folder, before anything secret is sent to it: it signs a
 * fresh random nonce with the Ed25519 key whose public half the data folder holds. Anything else (a program that took the port while
 * the server was down, another server, an answer recorded earlier) is refused, and so is a server too old to answer.
 */
async function proveServerIdentity(options: LocalAdminOptions, origin: string, fetchImpl: typeof fetch): Promise<void> {
  const pinned = await pinnedIdentity(options.dataRoot);
  const nonce = randomBytes(32).toString("hex");
  const timeoutMs = options.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS;
  let response: Response;
  let text: string | undefined;
  try {
    response = await fetchImpl(`${origin}/admin/api/identity?nonce=${nonce}`, { method: "GET", redirect: "error", credentials: "omit", headers: { accept: "application/json", "user-agent": CLI_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    text = await boundedText(response, MAX_IDENTITY_BYTES);
  } catch (error) {
    const reason = String((error as { cause?: { message?: unknown } })?.cause?.message ?? (error as Error)?.message ?? "");
    if ((error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError") {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      throw new Error(`The program on ${origin} did not answer within ${seconds} second${seconds === 1 ? "" : "s"}: is the server running? The admin code was NOT sent.`);
    }
    if (/redirect/i.test(reason)) throw notThisServer(origin, options.dataRoot, "it redirects instead of proving its identity");
    throw new Error(`The server is not running on ${origin}: start it with \`npx narrarium-server start\`.`);
  }
  if (text === undefined) throw notThisServer(origin, options.dataRoot, "its answer to the identity check is far too long");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if ((response.status === 401 || response.status === 404) && (parsed as { code?: unknown } | undefined)?.code !== "invalid_nonce") {
    // A server of an earlier version answers every unknown admin address with a request to sign in.
    throw new Error(`The program on ${origin} cannot prove its identity (a narrarium-server older than this command has no identity check), so the admin code was NOT sent. Restart the server with this version (npx narrarium-server start), or use the admin panel in your browser.`);
  }
  if (!response.ok || !assertProof(parsed, nonce, pinned)) throw notThisServer(origin, options.dataRoot, "its identity does not match the one of this data folder");
}

/** Sign in to the loopback admin API of a running server with the local admin code, once that server has proved who it is. */
async function localAdminSession(options: LocalAdminOptions): Promise<AdminSession> {
  const code = await readAdminCode(options.dataRoot);
  const origin = `http://127.0.0.1:${options.adminPort ?? DEFAULT_ADMIN_PORT}`;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  await proveServerIdentity(options, origin, fetchImpl);
  let login: Response;
  try {
    login = await fetchImpl(`${origin}/admin/api/login`, { method: "POST", redirect: "error", credentials: "omit", headers: { origin, "content-type": "application/json", "user-agent": CLI_AGENT }, body: JSON.stringify({ code }) });
  } catch {
    throw new Error(`The server is not running on ${origin}: start it with \`npx narrarium-server start\`.`);
  }
  if (login.status === 429) throw new Error("Admin sign-in is paused after too many wrong codes from this computer: wait a few minutes and try again.");
  if (!login.ok) throw new Error("Admin sign-in failed: check that the server of this data folder is running.");
  const session = await login.json() as { csrf?: unknown };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (typeof session.csrf !== "string" || !cookie) throw new Error("The admin session is not valid.");
  return { origin, csrf: session.csrf, cookie, fetchImpl };
}

async function adminPost<T>(session: AdminSession, route: string, body: unknown): Promise<T> {
  const response = await session.fetchImpl(`${session.origin}${route}`, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    headers: { origin: session.origin, "content-type": "application/json", cookie: session.cookie, "x-csrf-token": session.csrf, "user-agent": CLI_AGENT },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || `The admin request failed (HTTP ${response.status}).`);
  return payload as T;
}

async function adminGet<T>(session: AdminSession, route: string): Promise<T> {
  const response = await session.fetchImpl(`${session.origin}${route}`, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { origin: session.origin, cookie: session.cookie, "user-agent": CLI_AGENT },
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || `The admin request failed (HTTP ${response.status}).`);
  return payload as T;
}

/** One admin session for one command: it is closed afterwards (unless the command itself ended every session), so sessions never pile up. */
async function withLocalAdminSession<T>(options: LocalAdminOptions, action: (session: AdminSession) => Promise<T>, endsSessions = false): Promise<T> {
  const session = await localAdminSession(options);
  try {
    return await action(session);
  } finally {
    if (!endsSessions) await adminPost(session, "/admin/api/logout", {}).catch(() => undefined);
  }
}

export async function requestLocalClientToken(options: LocalAdminOptions & { label: string; scopes: string[] }): Promise<{ token: string; clientId: string }> {
  const label = options.label.trim();
  if (!label || label.length > 80) throw new Error("The client name must have 1-80 characters.");
  const scopes: ServerScope[] = parseScopes(options.scopes.map((scope) => scope.trim()));
  return withLocalAdminSession(options, (session) => adminPost(session, "/admin/api/token", { label, scopes }));
}

/** Replace the admin code with a random one; the old one stops working. */
export async function rotateLocalAdminCode(options: LocalAdminOptions): Promise<string> {
  const result = await withLocalAdminSession(options, (session) => adminPost<{ code?: unknown }>(session, "/admin/api/admin-code/rotate", {}), true);
  if (typeof result.code !== "string") throw new Error("The new admin code is not valid.");
  return result.code;
}

export async function setLocalAdminCode(options: LocalAdminOptions & { code: string }): Promise<void> {
  const code = assertAdminCode(options.code);
  await withLocalAdminSession(options, (session) => adminPost(session, "/admin/api/admin-code/set", { code }), true);
}

/** What the owner reads of the spending (the panel's own answer: with a warning when the record was damaged). */
export type LocalSpendStatus = ServerSpendStatus & { warning?: string };

/** The spending of the running server: today's use, the caps, the switch. */
export async function readLocalSpend(options: LocalAdminOptions): Promise<LocalSpendStatus> {
  return withLocalAdminSession(options, (session) => adminGet<LocalSpendStatus>(session, "/admin/api/spend"));
}

/** Change the switch or the caps of the running server (what is not given is left as it is) and answer the new status. */
export async function updateLocalSpend(options: LocalAdminOptions, changes: Partial<SpendSettings>): Promise<LocalSpendStatus> {
  return withLocalAdminSession(options, (session) => adminPost<LocalSpendStatus>(session, "/admin/api/spend", changes));
}
