import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ADMIN_PORT, type ServerScope } from "narrarium-engine";
import { ADMIN_CODE_FILE, assertAdminCode, parseScopes } from "./auth.js";
import { readPrivateText } from "./files.js";

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
}

interface AdminSession {
  origin: string;
  csrf: string;
  cookie: string;
  fetchImpl: typeof fetch;
}

/** Sign in to the loopback admin API of a running server with the local admin code. */
async function localAdminSession(options: LocalAdminOptions): Promise<AdminSession> {
  const code = await readAdminCode(options.dataRoot);
  const origin = `http://127.0.0.1:${options.adminPort ?? DEFAULT_ADMIN_PORT}`;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let login: Response;
  try {
    login = await fetchImpl(`${origin}/admin/api/login`, { method: "POST", redirect: "error", credentials: "omit", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  } catch {
    throw new Error(`The server is not running on ${origin}: start it with \`npx narrarium-server start\`.`);
  }
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
    headers: { origin: session.origin, "content-type": "application/json", cookie: session.cookie, "x-csrf-token": session.csrf },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || `The admin request failed (HTTP ${response.status}).`);
  return payload as T;
}

export async function requestLocalClientToken(options: LocalAdminOptions & { label: string; scopes: string[] }): Promise<{ token: string; clientId: string }> {
  const label = options.label.trim();
  if (!label || label.length > 80) throw new Error("The client name must have 1-80 characters.");
  const scopes: ServerScope[] = parseScopes(options.scopes.map((scope) => scope.trim()));
  const session = await localAdminSession(options);
  return adminPost(session, "/admin/api/token", { label, scopes });
}

/** Replace the admin code with a random one; the old one stops working. */
export async function rotateLocalAdminCode(options: LocalAdminOptions): Promise<string> {
  const session = await localAdminSession(options);
  const result = await adminPost<{ code?: unknown }>(session, "/admin/api/admin-code/rotate", {});
  if (typeof result.code !== "string") throw new Error("The new admin code is not valid.");
  return result.code;
}

export async function setLocalAdminCode(options: LocalAdminOptions & { code: string }): Promise<void> {
  const code = assertAdminCode(options.code);
  const session = await localAdminSession(options);
  await adminPost(session, "/admin/api/admin-code/set", { code });
}
