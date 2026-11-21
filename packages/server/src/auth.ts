import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { SERVER_SCOPES, type ServerScope } from "narrarium-engine";
import { HttpError, retryAfter } from "./errors.js";
import { atomicJson, atomicWrite, readJson, readPrivateText } from "./files.js";
import { LOCAL_SOURCE, WindowLimiter } from "./limits.js";
import { isEncryptedSecret, type EncryptedSecret, type Vault } from "./vault.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const sameHash = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
/** Compare two secrets of any content and length: their digests always have the same length. */
const sameSecret = (left: string, right: string) => sameHash(hash(left), hash(right));

export const MAX_CLIENTS = 100;
export const ADMIN_SESSION_MS = 30 * 60_000;
export const PAIRING_MS = 5 * 60_000;
export const ATTEMPT_WINDOW_MS = 5 * 60_000;
/** Wrong admin codes one source may send per window; a success clears its count, and the next attempt is refused until the window ends. */
export const LOGIN_FAILURES_PER_WINDOW = 10;
/** Pairing requests one source may send per window, right or wrong, whether or not a pairing is open. */
export const PAIRING_ATTEMPTS_PER_WINDOW = 10;
/** Wrong codes one source may try inside one pairing... */
export const PAIRING_GUESSES_PER_SOURCE = 5;
/** ...and wrong codes from everybody together after which the pairing is cancelled. */
export const PAIRING_GUESSES_TOTAL = 50;
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
  /** Wrong codes tried so far, from all sources together. */
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

/** Refuse a client that lacks a permission. */
export function assertScope(client: ClientRecord, scope: ServerScope): void {
  if (!client.scopes.includes(scope)) throw new HttpError(403, "scope", `This client token does not have the "${scope}" permission.`);
}

function tooManyAttempts(retryAfterMs: number): HttpError {
  return new HttpError(429, "too_many_attempts", "Too many attempts from this address: wait a few minutes and try again.", retryAfter(retryAfterMs));
}

export function assertAdminCode(value: string): string {
  if (value.length < 32 || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(422, "admin_code", "The admin code must have 32-200 visible characters, without line breaks or leading/trailing spaces.");
  }
  return value;
}

/** Reads what the server wrote. Fields of older versions that are no longer used (`failureWindow`, `failures`) are ignored. */
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
  /** Wrong admin codes per source. In memory only: nothing anonymous is ever written to disk. */
  private readonly logins = new WindowLimiter({ max: LOGIN_FAILURES_PER_WINDOW, windowMs: ATTEMPT_WINDOW_MS });
  private readonly pairingAttempts = new WindowLimiter({ max: PAIRING_ATTEMPTS_PER_WINDOW, windowMs: ATTEMPT_WINDOW_MS });
  /** Wrong codes per source inside the current pairing: `PAIRING_GUESSES_TOTAL` at most in all, so it stays small. */
  private guessing: { pairingId: string; bySource: Map<string, number> } | undefined;

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
      state = { version: 1, adminHash: hash(code), clients: [] };
      await atomicJson(statePath, state);
    } else {
      state = parseState(stored);
      // Editing the code file and restarting replaces the code.
      if (state.adminHash !== hash(code)) {
        state = { ...state, adminHash: hash(code) };
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

  /** The client owning this token, optionally checking a scope. */
  authenticate(token: string | undefined, scope?: ServerScope): ClientRecord {
    if (!token || token.length > 200) throw new HttpError(401, "unauthorized", "Missing or invalid client token. Pair this client again or create a token with: npx narrarium-server client-token");
    const digest = hash(token.trim());
    const client = this.state.clients.find((entry) => !entry.revoked && sameHash(entry.hash, digest));
    if (!client) throw new HttpError(401, "unauthorized", "This client token is not valid or was revoked. Pair this client again.");
    if (scope) assertScope(client, scope);
    this.lastSeen.set(client.id, new Date().toISOString());
    return structuredClone(client);
  }

  isCurrent(client: ClientRecord): boolean {
    return this.state.clients.some((entry) => entry.id === client.id && entry.hash === client.hash && !entry.revoked);
  }

  /**
   * Check the admin code. Every source has its own budget of wrong codes: an anonymous caller can only spend its own, a
   * correct code clears the source's count, and a source over its budget is refused (429) even with the right code, so
   * the budget cannot be used to guess. Nothing is written to disk.
   */
  async login(code: string, source: string = LOCAL_SOURCE): Promise<{ cookie: string; csrf: string }> {
    // The attempt is counted before the code is looked at, so parallel guesses cannot all slip through the check.
    const verdict = this.logins.hit(source);
    if (!verdict.allowed) throw tooManyAttempts(verdict.retryAfterMs);
    if (!sameHash(this.state.adminHash, hash(code))) throw new HttpError(401, "admin_login", "Wrong admin code.");
    this.logins.reset(source);
    const cookie = secret();
    const csrf = secret();
    if (this.sessions.size >= 20) this.sessions.clear();
    this.sessions.set(cookie, { csrf, until: Date.now() + ADMIN_SESSION_MS });
    return { cookie, csrf };
  }

  adminSession(cookie: string | undefined, csrf?: string): void {
    const session = cookie ? this.sessions.get(cookie) : undefined;
    if (!session || session.until < Date.now()) throw new HttpError(401, "admin_session", "Sign in to the admin panel again.");
    if (csrf !== undefined && !sameSecret(session.csrf, csrf)) throw new HttpError(403, "csrf", "This admin request is not authorized.");
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
      this.guessing = undefined;
      return { code, expiresAt: state.pairing.expiresAt };
    });
  }

  /**
   * Count one pairing request of a source against its own budget (`PAIRING_ATTEMPTS_PER_WINDOW` per window). Every request
   * counts, also one that is malformed or comes while no pairing is open, and nothing but the source's own budget is spent.
   */
  admitPairingAttempt(source: string = LOCAL_SOURCE): void {
    const verdict = this.pairingAttempts.hit(source);
    if (!verdict.allowed) throw tooManyAttempts(verdict.retryAfterMs);
  }

  private guessesBy(pairingId: string, source: string): number {
    return this.guessing?.pairingId === pairingId ? this.guessing.bySource.get(source) ?? 0 : 0;
  }

  private noteGuess(pairingId: string, source: string): void {
    if (this.guessing?.pairingId !== pairingId) this.guessing = { pairingId, bySource: new Map() };
    this.guessing.bySource.set(source, (this.guessing.bySource.get(source) ?? 0) + 1);
  }

  /**
   * Offer the code of the open pairing. A source has `PAIRING_GUESSES_PER_SOURCE` wrong guesses in a pairing and is then
   * refused for the rest of it; wrong guesses from all sources together cancel the pairing at `PAIRING_GUESSES_TOTAL`.
   * Nothing happens (and nothing is written) when no pairing takes a code.
   */
  async requestPairing(code: string, nonce: string, label: string, source: string = LOCAL_SOURCE): Promise<{ id: string }> {
    const invalid = () => new HttpError(401, "pairing_invalid", "The code is wrong, expired or already used, or there were too many attempts.");
    if (!takesCode(this.state.pairing)) throw invalid();
    const id = await this.change((state) => {
      const pairing = state.pairing;
      if (!takesCode(pairing) || this.guessesBy(pairing.id, source) >= PAIRING_GUESSES_PER_SOURCE) return undefined;
      if (!sameHash(pairing.hash, hash(code))) {
        this.noteGuess(pairing.id, source);
        pairing.attempts += 1;
        if (pairing.attempts >= PAIRING_GUESSES_TOTAL) delete state.pairing;
        return undefined;
      }
      pairing.requestHash = hash(nonce);
      pairing.label = label;
      return pairing.id;
    });
    if (!id) throw invalid();
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
    const invalid = () => new HttpError(401, "pairing_invalid", "This pairing is not valid or expired.");
    const matches = (pairing: PairingRecord | undefined): pairing is PairingRecord => pairing !== undefined && pairing.id === id && pairing.expiresAt >= Date.now() && pairing.requestHash !== undefined && sameHash(pairing.requestHash, hash(nonce));
    // Looking costs nothing: only collecting the token changes (and writes) anything.
    const current = this.state.pairing;
    if (!matches(current)) throw invalid();
    if (!current.issued) return { pending: true };
    return this.change((state) => {
      const pairing = state.pairing;
      if (!matches(pairing)) throw invalid();
      if (!pairing.issued) return { pending: true as const };
      const token = this.vault.decrypt(pairing.issued);
      delete state.pairing;
      return { token };
    });
  }
}

/** A pairing that still takes a code: not expired, and nobody has used it yet. */
function takesCode(pairing: PairingRecord | undefined): pairing is PairingRecord {
  return pairing !== undefined && pairing.expiresAt >= Date.now() && !pairing.requestHash;
}
