import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { SERVER_SCOPES, type ServerScope } from "narrarium-engine";
import { HttpError } from "./errors.js";
import { atomicJson, atomicWrite, readJson, readPrivateText } from "./files.js";
import { isEncryptedSecret, type EncryptedSecret, type Vault } from "./vault.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const sameHash = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export const MAX_CLIENTS = 100;
export const ADMIN_SESSION_MS = 30 * 60_000;
export const PAIRING_MS = 5 * 60_000;
/** Shared budget of admin logins and pairing requests per window (every attempt counts). */
const ATTEMPTS_PER_WINDOW = 20;
const ATTEMPT_WINDOW_MS = 5 * 60_000;
export const ADMIN_CODE_FILE = "admin-code.txt";

export interface ClientRecord {
  id: string;
  label: string;
  hash: string;
  scopes: ServerScope[];
  createdAt: string;
  revoked: boolean;
}

interface PairingRecord {
  id: string;
  hash: string;
  expiresAt: number;
  attempts: number;
  requestHash?: string;
  label?: string;
  scopes: ServerScope[];
  issued?: EncryptedSecret;
}

interface AuthState {
  version: 1;
  adminHash: string;
  clients: ClientRecord[];
  pairing?: PairingRecord;
  failureWindow: number;
  failures: number;
}

export type PublicClient = Omit<ClientRecord, "hash"> & { lastSeenAt?: string };

export function isScope(value: unknown): value is ServerScope {
  return typeof value === "string" && (SERVER_SCOPES as readonly string[]).includes(value);
}

export function parseScopes(value: unknown): ServerScope[] {
  const scopes = Array.isArray(value) ? value : [];
  if (!scopes.length || scopes.length > SERVER_SCOPES.length || !scopes.every(isScope) || new Set(scopes).size !== scopes.length) {
    throw new HttpError(422, "scopes", "Choose permissions among read, write, run and update, without repetitions.");
  }
  return scopes as ServerScope[];
}

export function assertAdminCode(value: string): string {
  if (value.length < 32 || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(422, "admin_code", "The admin code must have 32-200 visible characters, without line breaks or leading/trailing spaces.");
  }
  return value;
}

function parseState(value: unknown): AuthState {
  const record = value as Partial<AuthState> | null;
  if (!record || record.version !== 1 || typeof record.adminHash !== "string" || record.adminHash.length !== 64 || !Array.isArray(record.clients) || record.clients.length > MAX_CLIENTS) {
    throw new Error("authorization.json is not valid.");
  }
  const clients = record.clients.map((client) => {
    if (!client || typeof client.id !== "string" || typeof client.label !== "string" || client.label.length > 80 || typeof client.hash !== "string" || client.hash.length !== 64 || typeof client.createdAt !== "string" || typeof client.revoked !== "boolean") {
      throw new Error("authorization.json contains an invalid client.");
    }
    return { id: client.id, label: client.label, hash: client.hash, scopes: parseScopes(client.scopes), createdAt: client.createdAt, revoked: client.revoked };
  });
  const pairing = record.pairing;
  if (pairing !== undefined && (!pairing || typeof pairing.id !== "string" || typeof pairing.hash !== "string" || typeof pairing.expiresAt !== "number" || typeof pairing.attempts !== "number" || !Array.isArray(pairing.scopes) || (pairing.issued !== undefined && !isEncryptedSecret(pairing.issued)))) {
    throw new Error("authorization.json contains an invalid pairing.");
  }
  return {
    version: 1,
    adminHash: record.adminHash,
    clients,
    ...(pairing ? { pairing: { ...pairing, scopes: pairing.scopes.filter(isScope) } } : {}),
    failureWindow: typeof record.failureWindow === "number" ? record.failureWindow : Date.now(),
    failures: typeof record.failures === "number" ? record.failures : 0,
  };
}

/** The admin code lives in a 0600 file: created at first start, read back at every start. */
async function adminCodeFromFile(file: string): Promise<string> {
  const text = await readPrivateText(file, 202);
  if (text === undefined) {
    const code = secret();
    await atomicWrite(file, `${code}\n`);
    return code;
  }
  // Editors may or may not add a final line break (LF or CRLF); anything else must be the code itself.
  const code = text.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(code)) throw new Error(`${ADMIN_CODE_FILE} must contain only the admin code; it is never regenerated automatically.`);
  return assertAdminCode(code);
}

/** Admin code, admin sessions, client tokens with scopes and pairing of new clients. */
export class Auth {
  private sessions = new Map<string, { csrf: string; until: number }>();
  private readonly lastSeen = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private readonly root: string, private readonly vault: Vault, private state: AuthState) {}

  private get statePath(): string {
    return path.join(this.root, "private", "authorization.json");
  }

  get adminCodePath(): string {
    return path.join(this.root, "private", ADMIN_CODE_FILE);
  }

  static async open(root: string, vault: Vault): Promise<Auth> {
    const statePath = path.join(root, "private", "authorization.json");
    const code = await adminCodeFromFile(path.join(root, "private", ADMIN_CODE_FILE));
    const stored = await readJson(statePath, 1024 * 1024);
    let state: AuthState;
    if (stored === undefined) {
      state = { version: 1, adminHash: hash(code), clients: [], failureWindow: Date.now(), failures: 0 };
      await atomicJson(statePath, state);
    } else {
      state = parseState(stored);
      // Editing the code file and restarting replaces the code.
      if (state.adminHash !== hash(code)) {
        state = { ...state, adminHash: hash(code), failures: 0, failureWindow: Date.now() };
        await atomicJson(statePath, state);
      }
    }
    return new Auth(root, vault, state);
  }

  private change<T>(action: (state: AuthState) => T | Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      const draft = structuredClone(this.state);
      const result = await action(draft);
      await atomicJson(this.statePath, draft);
      this.state = draft;
      return result;
    });
    this.tail = next;
    return next;
  }

  /** Replace the admin code; every admin session ends. Client tokens are not affected. */
  async replaceAdminCode(value: string): Promise<void> {
    const code = assertAdminCode(value);
    const previous = await fs.readFile(this.adminCodePath, "utf8");
    await atomicWrite(this.adminCodePath, `${code}\n`);
    try {
      await this.change((state) => {
        state.adminHash = hash(code);
        state.failures = 0;
        state.failureWindow = Date.now();
      });
      this.sessions.clear();
    } catch (error) {
      await atomicWrite(this.adminCodePath, previous);
      throw error;
    }
  }

  async rotateAdminCode(): Promise<string> {
    const code = secret();
    await this.replaceAdminCode(code);
    return code;
  }

  private countAttempt(state: AuthState): boolean {
    if (Date.now() - state.failureWindow > ATTEMPT_WINDOW_MS) {
      state.failureWindow = Date.now();
      state.failures = 0;
    }
    if (state.failures >= ATTEMPTS_PER_WINDOW) return false;
    state.failures += 1;
    return true;
  }

  /** The client owning this token, optionally checking a scope. */
  authenticate(token: string | undefined, scope?: ServerScope): ClientRecord {
    if (!token || token.length > 200) throw new HttpError(401, "unauthorized", "Missing or invalid client token. Pair this client again or create a token with: npx narrarium-server client-token");
    const digest = hash(token.trim());
    const client = this.state.clients.find((entry) => !entry.revoked && sameHash(entry.hash, digest));
    if (!client) throw new HttpError(401, "unauthorized", "This client token is not valid or was revoked. Pair this client again.");
    if (scope && !client.scopes.includes(scope)) throw new HttpError(403, "scope", `This client token does not have the "${scope}" permission.`);
    this.lastSeen.set(client.id, new Date().toISOString());
    return structuredClone(client);
  }

  isCurrent(client: ClientRecord): boolean {
    return this.state.clients.some((entry) => entry.id === client.id && entry.hash === client.hash && !entry.revoked);
  }

  async login(code: string): Promise<{ cookie: string; csrf: string }> {
    const accepted = await this.change((state) => this.countAttempt(state) && sameHash(state.adminHash, hash(code)));
    if (!accepted) throw new HttpError(401, "admin_login", "Wrong admin code, or too many attempts: wait a few minutes.");
    const cookie = secret();
    const csrf = secret();
    if (this.sessions.size >= 20) this.sessions.clear();
    this.sessions.set(cookie, { csrf, until: Date.now() + ADMIN_SESSION_MS });
    return { cookie, csrf };
  }

  adminSession(cookie: string | undefined, csrf?: string): void {
    const session = cookie ? this.sessions.get(cookie) : undefined;
    if (!session || session.until < Date.now()) throw new HttpError(401, "admin_session", "Sign in to the admin panel again.");
    if (csrf !== undefined && !sameHash(session.csrf, csrf)) throw new HttpError(403, "csrf", "This admin request is not authorized.");
  }

  logout(cookie: string | undefined): void {
    if (cookie) this.sessions.delete(cookie);
  }

  list(): { clients: PublicClient[]; pairing: { id: string; label?: string; expiresAt: number; requested: boolean; approved: boolean } | null } {
    const pairing = this.state.pairing && this.state.pairing.expiresAt > Date.now() ? this.state.pairing : undefined;
    return {
      clients: this.state.clients.map(({ hash: _hash, ...client }) => ({ ...client, ...(this.lastSeen.has(client.id) ? { lastSeenAt: this.lastSeen.get(client.id) } : {}) })),
      pairing: pairing ? { id: pairing.id, ...(pairing.label ? { label: pairing.label } : {}), expiresAt: pairing.expiresAt, requested: Boolean(pairing.requestHash), approved: Boolean(pairing.issued) } : null,
    };
  }

  private static append(state: AuthState, client: ClientRecord): void {
    if (state.clients.length >= MAX_CLIENTS) {
      const revoked = state.clients.findIndex((entry) => entry.revoked);
      if (revoked === -1) throw new HttpError(409, "client_limit", "Too many active clients: revoke one before adding another.");
      state.clients.splice(revoked, 1);
    }
    state.clients.push(client);
  }

  /** Issue a token (shown once). With `replaceId` the secret of an existing client is rotated. */
  async issue(label: string, scopes: ServerScope[], replaceId?: string): Promise<{ token: string; clientId: string }> {
    const name = label.trim();
    if (!name || name.length > 80) throw new HttpError(422, "label", "The client name must have 1-80 characters.");
    const checked = parseScopes(scopes);
    return this.change((state) => {
      const index = replaceId ? state.clients.findIndex((entry) => entry.id === replaceId) : -1;
      if (replaceId && index === -1) throw new HttpError(404, "client_missing", "Client not found.");
      const token = `nrs_${secret()}`;
      const clientId = replaceId ?? randomUUID();
      const client: ClientRecord = { id: clientId, label: name, hash: hash(token), scopes: checked, createdAt: new Date().toISOString(), revoked: false };
      if (index >= 0) state.clients[index] = client;
      else Auth.append(state, client);
      return { token, clientId };
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.change((state) => {
      const client = state.clients.find((entry) => entry.id === id);
      if (!client) return false;
      client.revoked = true;
      return true;
    });
  }

  /** A new nine-digit pairing code, valid five minutes. Starting a pairing cancels the previous one. */
  async startPairing(): Promise<{ code: string; expiresAt: number }> {
    return this.change((state) => {
      const code = String(randomInt(100_000_000, 1_000_000_000));
      state.pairing = { id: randomUUID(), hash: hash(code), expiresAt: Date.now() + PAIRING_MS, attempts: 0, scopes: ["read", "write", "run"] };
      return { code, expiresAt: state.pairing.expiresAt };
    });
  }

  async requestPairing(code: string, nonce: string, label: string): Promise<{ id: string }> {
    const id = await this.change((state) => {
      if (!this.countAttempt(state)) return undefined;
      const pairing = state.pairing;
      if (!pairing || pairing.expiresAt < Date.now() || pairing.attempts >= 5 || pairing.requestHash) return undefined;
      pairing.attempts += 1;
      if (!sameHash(pairing.hash, hash(code))) return undefined;
      pairing.requestHash = hash(nonce);
      pairing.label = label;
      return pairing.id;
    });
    if (!id) throw new HttpError(401, "pairing_invalid", "The code is wrong, expired or already used, or there were too many attempts.");
    return { id };
  }

  /** The owner approves the pending request; `allowUpdate` also lets the client update the server. */
  async approvePairing(id: string, options: { allowUpdate?: boolean } = {}): Promise<void> {
    await this.change((state) => {
      const pairing = state.pairing;
      if (!pairing || pairing.id !== id || pairing.expiresAt < Date.now() || !pairing.requestHash || !pairing.label || pairing.issued) {
        throw new HttpError(409, "pairing_state", "This pairing can no longer be approved.");
      }
      const token = `nrs_${secret()}`;
      const scopes: ServerScope[] = options.allowUpdate ? [...pairing.scopes.filter((scope) => scope !== "update"), "update"] : pairing.scopes.filter((scope) => scope !== "update");
      Auth.append(state, { id: randomUUID(), label: pairing.label, hash: hash(token), scopes, createdAt: new Date().toISOString(), revoked: false });
      pairing.issued = this.vault.encrypt(token);
    });
  }

  async cancelPairing(): Promise<void> {
    await this.change((state) => {
      delete state.pairing;
    });
  }

  async pollPairing(id: string, nonce: string): Promise<{ pending: true } | { token: string }> {
    return this.change((state) => {
      const pairing = state.pairing;
      if (!pairing || pairing.id !== id || pairing.expiresAt < Date.now() || !pairing.requestHash || !sameHash(pairing.requestHash, hash(nonce))) {
        throw new HttpError(401, "pairing_invalid", "This pairing is not valid or expired.");
      }
      if (!pairing.issued) return { pending: true as const };
      const token = this.vault.decrypt(pairing.issued);
      delete state.pairing;
      return { token };
    });
  }
}
