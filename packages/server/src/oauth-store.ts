import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./errors.js";
import { atomicJson, readJson } from "./files.js";
import { KeyedMutex } from "./fs-store.js";
import type { McpScope } from "./mcp-access.js";
import { PASSKEY_ALGORITHMS, type PasskeyAlgorithm } from "./webauthn.js";

/** What the OAuth server of a book's MCP endpoint keeps in the data folder: the apps that registered, what the owner allowed them (grants), and his passkeys. */

export const ACCESS_TOKEN_MS = 60 * 60_000;
export const REFRESH_TOKEN_MS = 60 * 24 * 60 * 60_000;
/** An app that nobody has used for this long, and that holds no grant, is forgotten. */
export const CLIENT_IDLE_MS = 30 * 24 * 60 * 60_000;
export const MAX_CLIENTS = 500;
export const MAX_GRANTS = 500;
export const MAX_PASSKEYS = 20;
const MAX_SPENT_REFRESH_TOKENS = 8;
const MAX_ACCESS_TOKENS_PER_GRANT = 8;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const FLUSH_MS = 30_000;
export const ACCESS_PREFIX = "nra_";
export const REFRESH_PREFIX = "nrr_";

/** A refusal in the words of RFC 6749: an `error` code and a description that holds no secret. */
export class OAuthProblem extends Error {
  constructor(readonly status: number, readonly error: string, readonly description: string, readonly headers: Readonly<Record<string, string>> = {}) {
    super(description);
    this.name = "OAuthProblem";
  }
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  /** The scope the app said it would ask for (public names, separated by spaces). */
  scope: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface OAuthGrant {
  id: string;
  clientId: string;
  bookId: string;
  /** The MCP address of the book that the owner allowed (the audience of the tokens). */
  resource: string;
  scopes: McpScope[];
  /** Where the owner was sent back to, as the owner saw it (a host, with its port when it has one). */
  redirectHost: string;
  createdAt: string;
  lastUsedAt: string;
  /** SHA-256 of the current refresh token, and when it ends (milliseconds); an app that registered without refresh has none. */
  refreshHash?: string;
  refreshExpiresAt?: number;
  /** Hashes of refresh tokens that were used up: showing one again says the grant was copied. */
  spent: string[];
  access: Array<{ hash: string; expiresAt: number; scopes: McpScope[] }>;
}

export interface StoredPasskey {
  id: string;
  label: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  alg: PasskeyAlgorithm;
  counter: number;
  transports: string[];
  /** The relying party it was made for: a passkey is usable only on the host it was made for. */
  rpId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface State {
  version: 1;
  /** The WebAuthn user handle of the owner: the same for all of his passkeys. */
  userHandle: string;
  clients: OAuthClient[];
  grants: OAuthGrant[];
  passkeys: StoredPasskey[];
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes: McpScope[];
}

/** What the owner is told of a connected app: never a token. */
export interface GrantView {
  id: string;
  clientId: string;
  name: string;
  redirectHost: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string;
}

const ORDER: readonly McpScope[] = ["read", "write", "run"];
const sortScopes = (scopes: Iterable<McpScope>): McpScope[] => {
  const wanted = new Set(scopes);
  return ORDER.filter((scope) => wanted.has(scope));
};
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const secret = (prefix: string): string => `${prefix}${randomBytes(32).toString("base64url")}`;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isScope = (value: unknown): value is McpScope => value === "read" || value === "write" || value === "run";
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function parseClient(value: unknown): OAuthClient | undefined {
  const client = value as Partial<OAuthClient> | null;
  if (!client || !isText(client.id, 80) || !client.id || !isText(client.name, 200) || !Array.isArray(client.redirectUris) || !client.redirectUris.length || client.redirectUris.length > 5) return undefined;
  if (!client.redirectUris.every((uri) => isText(uri, 2048)) || !Array.isArray(client.grantTypes) || !client.grantTypes.every((grant) => isText(grant, 40)) || !isText(client.scope, 200) || !isIso(client.createdAt) || !isIso(client.lastUsedAt)) return undefined;
  return { id: client.id, name: client.name, redirectUris: [...client.redirectUris], grantTypes: [...client.grantTypes], scope: client.scope, createdAt: client.createdAt, lastUsedAt: client.lastUsedAt };
}

function parseGrant(value: unknown): OAuthGrant | undefined {
  const grant = value as Partial<OAuthGrant> | null;
  if (!grant || !isText(grant.id, 80) || !grant.id || !isText(grant.clientId, 80) || !isText(grant.bookId, 200) || !isText(grant.resource, 2048) || !Array.isArray(grant.scopes) || !grant.scopes.every(isScope)) return undefined;
  if (!isText(grant.redirectHost, 300) || !isIso(grant.createdAt) || !isIso(grant.lastUsedAt) || !Array.isArray(grant.spent) || !Array.isArray(grant.access)) return undefined;
  if (grant.refreshHash !== undefined && (!isDigest(grant.refreshHash) || typeof grant.refreshExpiresAt !== "number")) return undefined;
  const access = grant.access.filter((entry) => entry && isDigest(entry.hash) && typeof entry.expiresAt === "number" && Array.isArray(entry.scopes) && entry.scopes.every(isScope)).slice(-MAX_ACCESS_TOKENS_PER_GRANT);
  return {
    id: grant.id,
    clientId: grant.clientId,
    bookId: grant.bookId,
    resource: grant.resource,
    scopes: sortScopes(grant.scopes),
    redirectHost: grant.redirectHost,
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
    ...(grant.refreshHash ? { refreshHash: grant.refreshHash, refreshExpiresAt: grant.refreshExpiresAt } : {}),
    spent: grant.spent.filter(isDigest).slice(-MAX_SPENT_REFRESH_TOKENS),
    access: access.map((entry) => ({ hash: entry.hash, expiresAt: entry.expiresAt, scopes: sortScopes(entry.scopes) })),
  };
}

function parsePasskey(value: unknown): StoredPasskey | undefined {
  const key = value as Partial<StoredPasskey> | null;
  if (!key || !isText(key.id, 2048) || !key.id || !isText(key.label, 80) || !isText(key.publicKey, 4096) || !PASSKEY_ALGORITHMS.includes(key.alg as PasskeyAlgorithm)) return undefined;
  if (typeof key.counter !== "number" || !Number.isSafeInteger(key.counter) || key.counter < 0 || !Array.isArray(key.transports) || !isText(key.rpId, 255) || !isIso(key.createdAt) || (key.lastUsedAt !== null && !isIso(key.lastUsedAt))) return undefined;
  return { id: key.id, label: key.label, publicKey: key.publicKey, alg: key.alg as PasskeyAlgorithm, counter: key.counter, transports: key.transports.filter((entry): entry is string => isText(entry, 20)).slice(0, 6), rpId: key.rpId, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt ?? null };
}

function parseState(value: unknown): State {
  const stored = value as Partial<State> | null;
  if (!stored || stored.version !== 1 || !Array.isArray(stored.clients) || !Array.isArray(stored.grants) || !Array.isArray(stored.passkeys)) throw new Error("it is not an OAuth state");
  const clients = stored.clients.slice(0, MAX_CLIENTS).map(parseClient).filter((client): client is OAuthClient => client !== undefined);
  const known = new Set(clients.map((client) => client.id));
  return {
    version: 1,
    userHandle: isText(stored.userHandle, 100) && stored.userHandle ? stored.userHandle : randomBytes(32).toString("base64url"),
    clients,
    grants: stored.grants.slice(0, MAX_GRANTS).map(parseGrant).filter((grant): grant is OAuthGrant => grant !== undefined && known.has(grant.clientId)),
    passkeys: stored.passkeys.slice(0, MAX_PASSKEYS).map(parsePasskey).filter((key): key is StoredPasskey => key !== undefined),
  };
}

/** Whether a grant can still be used at `at`: its refresh token has not ended, or one of its access tokens has not. */
function alive(grant: OAuthGrant, at: number): boolean {
  return (grant.refreshExpiresAt !== undefined && grant.refreshExpiresAt > at) || grant.access.some((entry) => entry.expiresAt > at);
}

export interface OAuthStoreOptions {
  now: () => Date;
  log: (line: string) => void;
}

/**
 * The state of the OAuth server, in memory and in `private/oauth.json`. A change is written before it is answered (a copy is changed, written, and then taken as the state), so
 * what a client was told is what is kept. Tokens and codes are never kept, only their SHA-256: a copy of the file is no way in. A file that cannot be read leaves nothing
 * authorized (the safe state): the apps connect again and the owner registers his passkeys again.
 */
export class OAuthStore {
  private state: State;
  private readonly accessIndex = new Map<string, { grantId: string; expiresAt: number; scopes: McpScope[] }>();
  private readonly refreshIndex = new Map<string, string>();
  private readonly spentIndex = new Map<string, string>();
  private readonly mutex = new KeyedMutex();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;

  private constructor(private readonly file: string, private readonly options: OAuthStoreOptions, state: State) {
    this.state = state;
    this.reindex();
  }

  static async open(file: string, options: OAuthStoreOptions): Promise<OAuthStore> {
    let state: State | undefined;
    try {
      const stored = await readJson(file, MAX_FILE_BYTES);
      if (stored !== undefined) state = parseState(stored);
    } catch (error) {
      options.log(`oauth.json could not be read (${error instanceof Error ? error.message : String(error)}): no app is authorized and no passkey is kept until you set them up again.`);
    }
    return new OAuthStore(file, options, state ?? { version: 1, userHandle: randomBytes(32).toString("base64url"), clients: [], grants: [], passkeys: [] });
  }

  private get nowMs(): number {
    return this.options.now().getTime();
  }

  private reindex(): void {
    this.accessIndex.clear();
    this.refreshIndex.clear();
    this.spentIndex.clear();
    for (const grant of this.state.grants) {
      for (const entry of grant.access) this.accessIndex.set(entry.hash, { grantId: grant.id, expiresAt: entry.expiresAt, scopes: entry.scopes });
      if (grant.refreshHash) this.refreshIndex.set(grant.refreshHash, grant.id);
      for (const spent of grant.spent) this.spentIndex.set(spent, grant.id);
    }
  }

  private change<T>(action: (draft: State) => T | Promise<T>): Promise<T> {
    return this.mutex.run("oauth", async () => {
      const draft = structuredClone(this.state);
      const result = await action(draft);
      await atomicJson(this.file, draft);
      this.state = draft;
      this.dirty = false;
      this.reindex();
      return result;
    });
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => this.options.log(`oauth.json could not be written: ${error instanceof Error ? error.message : String(error)}`));
    }, FLUSH_MS);
    this.flushTimer.unref();
  }

  /** Write what was only noted in memory (when an app was last used). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) return;
    await this.mutex.run("oauth", async () => {
      if (!this.dirty) return;
      await atomicJson(this.file, this.state);
      this.dirty = false;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Apps
  // -------------------------------------------------------------------------------------------

  client(id: string): OAuthClient | undefined {
    return this.state.clients.find((client) => client.id === id);
  }

  get clientCount(): number {
    return this.state.clients.length;
  }

  touchClient(id: string): void {
    const client = this.client(id);
    if (!client) return;
    client.lastUsedAt = this.options.now().toISOString();
    this.markDirty();
  }

  /** Keep a new app. Past `max` the app that has gone unused for longest and holds no grant makes room; when every app holds a grant, nothing can. */
  registerClient(input: { name: string; redirectUris: string[]; grantTypes: string[]; scope: string }, max: number): Promise<OAuthClient> {
    return this.change((draft) => {
      const at = this.nowMs;
      while (draft.clients.length >= Math.max(1, max)) {
        const idle = draft.clients
          .filter((client) => !draft.grants.some((grant) => grant.clientId === client.id && alive(grant, at)))
          .sort((left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt))[0];
        if (!idle) throw new OAuthProblem(503, "temporarily_unavailable", "This server keeps too many apps that are in use to take another now.", { "retry-after": "3600" });
        draft.clients = draft.clients.filter((client) => client.id !== idle.id);
        draft.grants = draft.grants.filter((grant) => grant.clientId !== idle.id);
      }
      const stamp = this.options.now().toISOString();
      const client: OAuthClient = { id: randomBytes(16).toString("base64url"), name: input.name, redirectUris: input.redirectUris, grantTypes: input.grantTypes, scope: input.scope, createdAt: stamp, lastUsedAt: stamp };
      draft.clients.push(client);
      return client;
    });
  }

  /** Forget the grants that ended and the apps that nobody used for 30 days and that hold no grant. Answers what it removed. */
  async sweep(): Promise<{ grants: number; clients: number }> {
    const at = this.nowMs;
    const idle = (client: OAuthClient) => Date.parse(client.lastUsedAt) + CLIENT_IDLE_MS < at;
    const anyDead = this.state.grants.some((grant) => !alive(grant, at)) || this.state.grants.some((grant) => grant.access.some((entry) => entry.expiresAt <= at));
    const idleClients = this.state.clients.some((client) => idle(client) && !this.state.grants.some((grant) => grant.clientId === client.id && alive(grant, at)));
    if (!anyDead && !idleClients) return { grants: 0, clients: 0 };
    return this.change((draft) => {
      const before = { grants: draft.grants.length, clients: draft.clients.length };
      draft.grants = draft.grants.filter((grant) => alive(grant, at));
      for (const grant of draft.grants) grant.access = grant.access.filter((entry) => entry.expiresAt > at);
      draft.clients = draft.clients.filter((client) => !idle(client) || draft.grants.some((grant) => grant.clientId === client.id));
      draft.grants = draft.grants.filter((grant) => draft.clients.some((client) => client.id === grant.clientId));
      return { grants: before.grants - draft.grants.length, clients: before.clients - draft.clients.length };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Grants and tokens
  // -------------------------------------------------------------------------------------------

  private issue(grant: OAuthGrant, scopes: McpScope[], withRefresh: boolean, at: number): IssuedTokens {
    const accessToken = secret(ACCESS_PREFIX);
    grant.access = [...grant.access.filter((entry) => entry.expiresAt > at), { hash: hashToken(accessToken), expiresAt: at + ACCESS_TOKEN_MS, scopes: sortScopes(scopes) }].slice(-MAX_ACCESS_TOKENS_PER_GRANT);
    let refreshToken: string | undefined;
    if (withRefresh) {
      if (grant.refreshHash) grant.spent = [...grant.spent, grant.refreshHash].slice(-MAX_SPENT_REFRESH_TOKENS);
      refreshToken = secret(REFRESH_PREFIX);
      grant.refreshHash = hashToken(refreshToken);
      grant.refreshExpiresAt = at + REFRESH_TOKEN_MS;
    }
    grant.lastUsedAt = new Date(at).toISOString();
    return { accessToken, ...(refreshToken ? { refreshToken } : {}), expiresIn: ACCESS_TOKEN_MS / 1000, scopes: sortScopes(scopes) };
  }

  /**
   * Make a grant and its first tokens. `stillOpen` is asked inside the change, so a book that is switched off, or an app that was removed, between the owner's answer and
   * this moment gets no grant (and one that is switched off a moment later loses it with the revocation that follows the switch).
   */
  createGrant(input: { clientId: string; bookId: string; resource: string; scopes: McpScope[]; redirectHost: string; withRefresh: boolean }, stillOpen: () => boolean): Promise<IssuedTokens & { grantId: string }> {
    return this.change((draft) => {
      if (!stillOpen() || !draft.clients.some((client) => client.id === input.clientId)) throw new OAuthProblem(400, "invalid_grant", "The book is no longer open to apps, or the app is no longer known.");
      const at = this.nowMs;
      if (draft.grants.length >= MAX_GRANTS) {
        draft.grants = draft.grants.filter((grant) => alive(grant, at));
        if (draft.grants.length >= MAX_GRANTS) {
          const oldest = [...draft.grants].sort((left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt))[0];
          draft.grants = draft.grants.filter((grant) => grant !== oldest);
        }
      }
      const stamp = new Date(at).toISOString();
      const grant: OAuthGrant = { id: randomBytes(12).toString("base64url"), clientId: input.clientId, bookId: input.bookId, resource: input.resource, scopes: sortScopes(input.scopes), redirectHost: input.redirectHost, createdAt: stamp, lastUsedAt: stamp, spent: [], access: [] };
      const tokens = this.issue(grant, grant.scopes, input.withRefresh, at);
      draft.grants.push(grant);
      return { ...tokens, grantId: grant.id };
    });
  }

  /** The grant that a refresh token belongs to. A token that was used up says the grant was copied: that is for the caller to revoke. */
  findRefresh(token: string): { grant: OAuthGrant; spent: boolean } | undefined {
    if (!token.startsWith(REFRESH_PREFIX) || token.length > 200) return undefined;
    const digest = hashToken(token);
    const spentGrant = this.spentIndex.get(digest);
    const liveGrant = this.refreshIndex.get(digest);
    const id = liveGrant ?? spentGrant;
    const grant = id ? this.state.grants.find((entry) => entry.id === id) : undefined;
    if (!grant) return undefined;
    if (liveGrant) return grant.refreshExpiresAt !== undefined && grant.refreshExpiresAt > this.nowMs ? { grant, spent: false } : undefined;
    return { grant, spent: true };
  }

  /**
   * Spend a refresh token and give a new pair. A token that is no longer the grant's current one (two requests at once) is a reuse: the grant is revoked, and the answer is
   * `undefined`.
   */
  rotate(grantId: string, refreshToken: string, scopes: McpScope[]): Promise<IssuedTokens | undefined> {
    const digest = hashToken(refreshToken);
    return this.change((draft) => {
      const grant = draft.grants.find((entry) => entry.id === grantId);
      if (!grant || grant.refreshHash !== digest || (grant.refreshExpiresAt ?? 0) <= this.nowMs) {
        draft.grants = draft.grants.filter((entry) => entry.id !== grantId);
        return undefined;
      }
      return this.issue(grant, scopes, true, this.nowMs);
    });
  }

  /** Revoke a grant: its tokens stop working at once. */
  revokeGrant(id: string): Promise<boolean> {
    if (!this.state.grants.some((grant) => grant.id === id)) return Promise.resolve(false);
    return this.change((draft) => {
      const before = draft.grants.length;
      draft.grants = draft.grants.filter((grant) => grant.id !== id);
      return draft.grants.length < before;
    });
  }

  /** Revoke every grant of a book (it was switched off, got another address, or was removed). */
  revokeBook(bookId: string): Promise<number> {
    if (!this.state.grants.some((grant) => grant.bookId === bookId)) return Promise.resolve(0);
    return this.change((draft) => {
      const before = draft.grants.length;
      draft.grants = draft.grants.filter((grant) => grant.bookId !== bookId);
      return before - draft.grants.length;
    });
  }

  /** The grant that a token of the app belongs to (RFC 7009: an app revokes its own tokens only), whichever kind of token it is, used up or not. */
  grantOfToken(token: string, clientId: string): OAuthGrant | undefined {
    if (token.length > 200) return undefined;
    const digest = hashToken(token);
    const id = this.accessIndex.get(digest)?.grantId ?? this.refreshIndex.get(digest) ?? this.spentIndex.get(digest);
    const grant = id ? this.state.grants.find((entry) => entry.id === id) : undefined;
    return grant && grant.clientId === clientId ? grant : undefined;
  }

  /** Who an access token is for, if it is good now. */
  authenticate(token: string): { grant: OAuthGrant; scopes: McpScope[] } | undefined {
    if (!token.startsWith(ACCESS_PREFIX) || token.length > 200) return undefined;
    const found = this.accessIndex.get(hashToken(token));
    if (!found || found.expiresAt <= this.nowMs) return undefined;
    const grant = this.state.grants.find((entry) => entry.id === found.grantId);
    return grant ? { grant, scopes: found.scopes } : undefined;
  }

  hasGrant(id: string): boolean {
    return this.state.grants.some((grant) => grant.id === id);
  }

  touchGrant(id: string): void {
    const grant = this.state.grants.find((entry) => entry.id === id);
    if (!grant) return;
    grant.lastUsedAt = this.options.now().toISOString();
    this.markDirty();
  }

  grant(id: string): OAuthGrant | undefined {
    return this.state.grants.find((grant) => grant.id === id);
  }

  private view(grant: OAuthGrant): GrantView {
    const client = this.client(grant.clientId);
    return { id: grant.id, clientId: grant.clientId, name: client?.name ?? "?", redirectHost: grant.redirectHost, scopes: [...grant.scopes], createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt };
  }

  /** The connected apps of a book (or of all), as the owner sees them. */
  grantsOf(bookId?: string): GrantView[] {
    const at = this.nowMs;
    return this.state.grants.filter((grant) => (bookId === undefined || grant.bookId === bookId) && alive(grant, at)).map((grant) => this.view(grant));
  }

  // -------------------------------------------------------------------------------------------
  // Passkeys
  // -------------------------------------------------------------------------------------------

  get userHandle(): string {
    return this.state.userHandle;
  }

  passkeys(): StoredPasskey[] {
    return this.state.passkeys.map((key) => ({ ...key, transports: [...key.transports] }));
  }

  passkey(id: string): StoredPasskey | undefined {
    return this.state.passkeys.find((key) => key.id === id);
  }

  addPasskey(key: Omit<StoredPasskey, "createdAt" | "lastUsedAt">): Promise<StoredPasskey> {
    return this.change((draft) => {
      if (draft.passkeys.some((entry) => entry.id === key.id)) throw new HttpError(409, "passkey_exists", "This passkey is already registered.");
      if (draft.passkeys.length >= MAX_PASSKEYS) throw new HttpError(409, "too_many_passkeys", `At most ${MAX_PASSKEYS} passkeys are kept: remove one in the admin panel first.`);
      const added: StoredPasskey = { ...key, createdAt: this.options.now().toISOString(), lastUsedAt: null };
      draft.passkeys.push(added);
      return added;
    });
  }

  renamePasskey(id: string, label: string): Promise<boolean> {
    return this.change((draft) => {
      const key = draft.passkeys.find((entry) => entry.id === id);
      if (!key) return false;
      key.label = label;
      return true;
    });
  }

  removePasskey(id: string): Promise<boolean> {
    return this.change((draft) => {
      const before = draft.passkeys.length;
      draft.passkeys = draft.passkeys.filter((entry) => entry.id !== id);
      return draft.passkeys.length < before;
    });
  }

  /** A sign-in with a passkey: its counter is kept, and so is when it was used. */
  recordPasskeyUse(id: string, counter: number): Promise<void> {
    return this.change((draft) => {
      const key = draft.passkeys.find((entry) => entry.id === id);
      if (!key) return;
      key.counter = counter;
      key.lastUsedAt = this.options.now().toISOString();
    });
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
