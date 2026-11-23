import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AI_CALL_BUDGETS, DEFAULT_ADMIN_PORT, DEFAULT_SERVER_PORT, pickAiRuntimeConfig, serverIdentityMessage, type AiRuntimeConfig, type ServerBookStorage } from "narrarium-engine";
import { AI_CALLS_DIRECTORY } from "./ai-calls.js";
import { HttpError } from "./errors.js";
import { KeyedMutex } from "./fs-store.js";
import { atomicJson, ensurePrivateDirectory, readJson, renameReplacing } from "./files.js";
import { hasSpendSettings, parseSpendSettings, type SpendSettings } from "./spend.js";
import { isEncryptedSecret, Vault, type EncryptedSecret } from "./vault.js";

/** Browser origins that may always call the API: the Narrarium web app and its local dev servers. */
export const DEFAULT_ORIGINS = [
  "https://narrarium.net",
  "https://www.narrarium.net",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** Non-secret settings of a server, editable by the CLI (ports, label) and the admin panel (network). */
export interface ServerConfig {
  version: 2;
  serverId: string;
  label: string;
  apiPort: number;
  adminPort: number;
  /** Extra browser origins allowed to call the API (the defaults are always allowed). */
  origins: string[];
  /**
   * The AI endpoints the server may send API keys to, approved by the owner: an origin (what every version up to 0.1.3 saved; it covers every
   * base on it) or an origin and a path (it covers that base and what is under it). The outbound guard in `network.ts` still decides by origin.
   */
  allowedAiBases: string[];
  /** The AI bases (origin and path, the providers' defaults included) of a configuration sent by a client that no approval covers yet. */
  pendingAiBases: string[];
  /** Public HTTPS address of the API (for example a Cloudflare hostname). */
  publicUrl?: string;
  /** Public HTTPS address of the admin panel (defaults to `publicUrl`). */
  adminPublicUrl?: string;
  /** Serve the admin panel on its public address too (only when that address is routed to the admin port). */
  allowRemoteAdmin: boolean;
  /** Maximum books whose autopilot runs at the same time. */
  maxConcurrentRuns: number;
  createdAt: string;
  /** The owner's spending caps and switch (absent: no cap, the switch on). Only the admin panel and the command line change it. */
  spend?: SpendSettings;
  /** The records of the AI calls (absent: recording on, `AI_CALL_BUDGETS.serverPerBookBytes` a book). Only the admin panel changes the switch. */
  aiCalls?: AiCallsSettings;
}

/**
 * The owner's choice about the records of the AI calls of the autopilot (what was sent to the AI and what came back: the book's text, its secrets and the author's notes). `enabled` is the
 * switch (a run that starts while it is off records nothing, and the calls that are open when it is turned off are cut there); `budgetBytes` is how much of them a book keeps, for whoever
 * edits `config.json` by hand (the panel does not offer it). A configuration that never mentions them records, up to the engine's budget for a server.
 */
export interface AiCallsSettings {
  enabled: boolean;
  budgetBytes?: number;
}

/** The least and the most bytes of records a book may be given in `config.json`; what is not in between is not believed. */
export const AI_CALLS_MIN_BUDGET_BYTES = 1024 * 1024;
export const AI_CALLS_MAX_BUDGET_BYTES = 1024 ** 4;

/** What a stored `aiCalls` says, as far as it can be believed: nothing at all when it says nothing, so that a configuration that never had it stays as it was. */
export function parseAiCallsSettings(value: unknown): AiCallsSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  const budget = typeof raw.budgetBytes === "number" && Number.isSafeInteger(raw.budgetBytes) && raw.budgetBytes >= AI_CALLS_MIN_BUDGET_BYTES && raw.budgetBytes <= AI_CALLS_MAX_BUDGET_BYTES ? raw.budgetBytes : undefined;
  if (enabled === undefined && budget === undefined) return undefined;
  return { enabled: enabled ?? true, ...(budget !== undefined ? { budgetBytes: budget } : {}) };
}

/** The switch and the budget as they are now, with what a configuration that says nothing means. */
export function aiCallsSettingsOf(config: Pick<ServerConfig, "aiCalls">): { enabled: boolean; budgetBytes: number } {
  return { enabled: config.aiCalls?.enabled !== false, budgetBytes: config.aiCalls?.budgetBytes ?? AI_CALL_BUDGETS.serverPerBookBytes };
}

export interface StoredBook {
  bookId: string;
  title: string;
  storage: ServerBookStorage;
  createdAt: string;
  updatedAt: string;
}

const BOOK_ID = /^[A-Za-z0-9._-]{1,120}$/;
/** Where removed and replaced working copies wait, inside `books/`: no book may use this name. */
const TRASH_DIRECTORY = ".trash";
/** The AI call records of a removed book wait in the trash beside its working copy, with the same time in their name and this ending. */
const TRASH_CALLS_SUFFIX = ".ai-calls";
/** How long a working copy stays in the trash before the server deletes it for good. */
export const TRASH_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** The longest GitHub token accepted (real ones are well under 100 characters): the token file is read with a 1 MiB cap. */
export const MAX_BOOK_TOKEN_CHARACTERS = 512;

export function assertBookId(bookId: string): string {
  if (!BOOK_ID.test(bookId) || bookId === "." || bookId === ".." || bookId.toLowerCase() === TRASH_DIRECTORY) throw new HttpError(400, "invalid_book", "Invalid book id.");
  return bookId;
}

/** The names Windows keeps for devices (`com0` and `lpt0` too, as a Windows run showed): a file or folder called like this (with any extension) cannot be created there. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * The id of a book that is registered now. On top of `assertBookId` it refuses what a Windows computer cannot keep as a folder name
 * (device names, a name that ends with a dot) and a hidden name (`.git`): books registered under such an id before keep working.
 */
export function assertNewBookId(bookId: string): string {
  assertBookId(bookId);
  if (bookId.startsWith(".") || /[. ]$/.test(bookId) || WINDOWS_DEVICE_NAME.test(bookId.split(".")[0])) {
    throw new HttpError(400, "invalid_book", "Invalid book id: it may not start or end with a dot, nor be a name that Windows keeps for devices (con, prn, aux, nul, com0-9, lpt0-9), with or without an extension.");
  }
  // The files of the data folder refuse these three as JSON keys, and the stored GitHub tokens are keyed by book id: a book called so
  // would make the tokens of every book unreadable.
  if (bookId === "__proto__" || bookId === "constructor" || bookId === "prototype") {
    throw new HttpError(400, "invalid_book", `Invalid book id: "${bookId}" is a name that the server's files cannot hold as a key.`);
  }
  return bookId;
}

/** Refuse a GitHub token that is too long to be one (clearing a token with `null` or "" is always fine). */
export function assertBookToken(token: string | null | undefined): void {
  if (typeof token === "string" && token.trim().length > MAX_BOOK_TOKEN_CHARACTERS) {
    throw new HttpError(400, "invalid_token", `The GitHub token is too long: at most ${MAX_BOOK_TOKEN_CHARACTERS} characters.`);
  }
}

function validPort(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : fallback;
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length <= 500))].slice(0, max) : [];
}

/** Origin of an http(s) URL typed by the owner; plain HTTP only for loopback. */
export function normalizeOrigin(value: string, allowLoopbackHttp = true): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(422, "invalid_url", `Not a valid address: ${value}`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowLoopbackHttp))) {
    throw new HttpError(422, "invalid_url", `Use an https:// address (plain http only for this computer): ${value}`);
  }
  return url.origin;
}

/** What a server is called until its owner names it. Earlier versions added the computer's name (`narrarium-server@name`). */
const DEFAULT_LABEL = "narrarium-server";

/**
 * The label for anybody who is not the owner: `GET /info`, and the autopilot state that is committed (and pushed to GitHub). A
 * default label written by an earlier version carries the computer's name (`narrarium-server@name`), which is not for them; a label
 * the owner chose is shown as it is. Whatever follows the `@` is taken for that name: the computer may have been renamed since, and
 * a name of more than 63 characters (a cloud runner's) was cut to the 80 characters of a label when the configuration was read.
 */
export function publicLabel(label: string, hostname: string = os.hostname()): string {
  const legacy = `${DEFAULT_LABEL}@`;
  if (!label.startsWith(legacy)) return label;
  return /^\S+$/.test(label) || `${legacy}${hostname}`.startsWith(label) ? DEFAULT_LABEL : label;
}

export function configPath(root: string): string {
  return path.join(root, "config.json");
}

/**
 * `existing`: the configuration comes from a file that was already there. Before `allowRemoteAdmin` was a setting, a configuration
 * that did not mention it allowed the panel on its public address, so such a file keeps that (and is written with it); a new
 * configuration starts with the panel reachable from this computer only, until the owner turns the public address on.
 */
function parseConfig(stored: unknown, existing: boolean): ServerConfig {
  const value = (stored && typeof stored === "object" ? stored : {}) as Partial<ServerConfig> & { port?: unknown };
  const spend = parseSpendSettings(value.spend);
  const aiCalls = parseAiCallsSettings(value.aiCalls);
  return {
    version: 2,
    serverId: typeof value.serverId === "string" && /^[0-9a-f-]{36}$/i.test(value.serverId) ? value.serverId : randomUUID(),
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim().slice(0, 80) : DEFAULT_LABEL,
    apiPort: validPort(value.apiPort ?? value.port, DEFAULT_SERVER_PORT),
    adminPort: validPort(value.adminPort, DEFAULT_ADMIN_PORT),
    origins: stringList(value.origins, 20),
    allowedAiBases: stringList(value.allowedAiBases, 50),
    pendingAiBases: stringList(value.pendingAiBases, 50),
    ...(typeof value.publicUrl === "string" && value.publicUrl ? { publicUrl: value.publicUrl } : {}),
    ...(typeof value.adminPublicUrl === "string" && value.adminPublicUrl ? { adminPublicUrl: value.adminPublicUrl } : {}),
    allowRemoteAdmin: typeof value.allowRemoteAdmin === "boolean" ? value.allowRemoteAdmin : existing,
    maxConcurrentRuns: typeof value.maxConcurrentRuns === "number" && value.maxConcurrentRuns >= 1 && value.maxConcurrentRuns <= 8 ? Math.round(value.maxConcurrentRuns) : 2,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    ...(hasSpendSettings(spend) ? { spend } : {}),
    ...(aiCalls ? { aiCalls } : {}),
  };
}

/** Read `config.json`, apply the given overrides and save it when something changed. */
export async function loadServerConfig(root: string, overrides: Partial<Pick<ServerConfig, "label" | "apiPort" | "adminPort">> & { origins?: string[] } = {}): Promise<ServerConfig> {
  await ensurePrivateDirectory(root);
  const stored = await readJson(configPath(root), 1024 * 1024);
  const config = parseConfig(stored, stored !== undefined);
  if (overrides.label?.trim()) config.label = overrides.label.trim().slice(0, 80);
  if (overrides.apiPort !== undefined) config.apiPort = validPort(overrides.apiPort, config.apiPort);
  if (overrides.adminPort !== undefined) config.adminPort = validPort(overrides.adminPort, config.adminPort);
  if (overrides.origins?.length) config.origins = [...new Set([...config.origins, ...overrides.origins.map((origin) => normalizeOrigin(origin))])].slice(0, 20);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(config)) await atomicJson(configPath(root), config, 0o600);
  return config;
}

interface IdentityFile {
  version: 1;
  publicKey: string;
  privateKey: EncryptedSecret;
}

/**
 * The secrets this process holds, in memory and nowhere else: the keys of the AI integrations and the GitHub tokens of the books. The records of the AI calls are kept clean of them (the
 * engine's recorder is given them when each call starts, and the store checks again), and a call is no moment to read a file and decrypt it, so they are read once when the data folder is opened
 * and again whenever the configuration or a token is saved. The fields are private to the class (`#`): nothing that prints, copies or serializes the data folder can show them.
 */
class KnownSecrets {
  #aiKeys: string[] = [];
  readonly #tokens = new Map<string, string>();
  #all: string[] = [];

  setAiKeys(keys: readonly string[]): void {
    this.#aiKeys = keys.map((key) => key.trim()).filter((key) => key.length > 0);
    this.#rebuild();
  }

  setToken(bookId: string, token: string | undefined): void {
    const value = token?.trim();
    if (value) this.#tokens.set(bookId, value);
    else this.#tokens.delete(bookId);
    this.#rebuild();
  }

  /** A copy: whoever holds it cannot change what the next call is given. */
  list(): string[] {
    return [...this.#all];
  }

  #rebuild(): void {
    this.#all = [...new Set([...this.#aiKeys, ...this.#tokens.values()])];
  }
}

/** Everything the server keeps on disk. Secrets go through the vault. */
export class DataDirectory {
  /** One writer per file: every update reads the current content inside its turn, and readers wait for a write in progress. */
  private readonly locks = new KeyedMutex();
  private readonly known = new KnownSecrets();

  private constructor(
    readonly root: string,
    readonly vault: Vault,
    private currentConfig: ServerConfig,
    readonly publicKey: string,
    private readonly privateKey: KeyObject,
  ) {}

  static async open(root: string, overrides: Parameters<typeof loadServerConfig>[1] = {}): Promise<DataDirectory> {
    const resolved = await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(path.join(resolved, "private"));
    await fs.mkdir(path.join(resolved, "books"), { recursive: true, mode: 0o700 });
    const vault = await Vault.open(resolved);
    const config = await loadServerConfig(resolved, overrides);
    const identityPath = path.join(resolved, "private", "identity.json");
    const stored = await readJson(identityPath, 64 * 1024) as Partial<IdentityFile> | undefined;
    let identity: IdentityFile;
    if (stored?.version === 1 && typeof stored.publicKey === "string" && isEncryptedSecret(stored.privateKey)) {
      identity = stored as IdentityFile;
    } else {
      if (stored !== undefined) throw new Error("private/identity.json is not valid; the server identity is never regenerated automatically.");
      const keys = generateKeyPairSync("ed25519");
      identity = {
        version: 1,
        publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        privateKey: vault.encrypt(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
      };
      await atomicJson(identityPath, identity);
    }
    const data = new DataDirectory(resolved, vault, config, identity.publicKey, createPrivateKey(vault.decrypt(identity.privateKey)));
    await data.primeSecrets();
    return data;
  }

  /**
   * Every secret this server holds that a record of an AI call must never keep, as the server knows them now: the keys of the AI integrations and the GitHub tokens of the books. Synchronous and
   * in memory (nothing is read from the disk, so it can be asked at every call), refreshed when the configuration or a token is saved. A copy: the list is the caller's.
   */
  knownSecrets(): string[] {
    return this.known.list();
  }

  /** Read the keys and the tokens that are saved, once, when the folder is opened: a secret that cannot be read cannot be kept out of a record either, and is not a reason to stop. */
  private async primeSecrets(): Promise<void> {
    try {
      this.known.setAiKeys((await this.aiConfig()).config.aiIntegrations.map((integration) => integration.apiKey));
    } catch {
      // A configuration that cannot be read is told where it is used.
    }
    try {
      const tokens = await this.locks.run("book-tokens", () => this.readBookTokens());
      for (const [bookId, encrypted] of Object.entries(tokens)) {
        try {
          this.known.setToken(bookId, this.vault.decrypt(encrypted));
        } catch {
          // One damaged token does not hide the others.
        }
      }
    } catch {
      // Nor does a damaged list.
    }
  }

  get config(): ServerConfig {
    return this.currentConfig;
  }

  get fingerprint(): string {
    return createHash("sha256").update(Buffer.from(this.publicKey, "base64")).digest("hex");
  }

  /** Ed25519 signature proving the server's identity for one nonce. */
  signIdentity(nonce: string): string {
    return sign(null, Buffer.from(serverIdentityMessage(nonce, this.currentConfig.serverId, this.publicKey)), this.privateKey).toString("base64");
  }

  /** Apply `change` to the configuration as it is when this update gets its turn: updates never overwrite each other. */
  updateConfig(change: (config: ServerConfig) => void): Promise<ServerConfig> {
    return this.locks.run("config", async () => {
      const next = structuredClone(this.currentConfig);
      change(next);
      const checked = parseConfig(next, true);
      await atomicJson(configPath(this.root), checked, 0o600);
      this.currentConfig = checked;
      return checked;
    });
  }

  file(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  bookDirectory(bookId: string): string {
    return path.join(this.root, "books", assertBookId(bookId), "repo");
  }

  /** The AI call records of a book: beside its working copy, never in it, so that git never sees them (see `FileAiCallStore`). */
  aiCallsDirectory(bookId: string): string {
    return path.join(this.root, "books", assertBookId(bookId), AI_CALLS_DIRECTORY);
  }

  aiConfig(): Promise<{ config: AiRuntimeConfig; updatedAt: string | null }> {
    return this.locks.run("ai", async () => {
      const stored = await readJson(this.file("private", "ai.json"), 4 * 1024 * 1024) as { encrypted?: unknown; updatedAt?: unknown } | undefined;
      if (!stored || !isEncryptedSecret(stored.encrypted)) return { config: pickAiRuntimeConfig({}), updatedAt: null };
      return { config: pickAiRuntimeConfig(JSON.parse(this.vault.decrypt(stored.encrypted))), updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null };
    });
  }

  async saveAiConfig(config: AiRuntimeConfig): Promise<void> {
    await this.locks.run("ai", async () => {
      const kept = pickAiRuntimeConfig(config);
      await atomicJson(this.file("private", "ai.json"), { encrypted: this.vault.encrypt(JSON.stringify(kept)), updatedAt: new Date().toISOString() });
      this.known.setAiKeys(kept.aiIntegrations.map((integration) => integration.apiKey));
    });
  }

  private async readBooks(): Promise<StoredBook[]> {
    const stored = await readJson(this.file("books.json"), 4 * 1024 * 1024) as { books?: StoredBook[] } | undefined;
    return Array.isArray(stored?.books) ? stored.books.filter((book) => book && typeof book.bookId === "string" && BOOK_ID.test(book.bookId)) : [];
  }

  books(): Promise<StoredBook[]> {
    return this.locks.run("books", () => this.readBooks());
  }

  async saveBook(book: StoredBook): Promise<void> {
    await this.locks.run("books", async () => {
      const books = (await this.readBooks()).filter((entry) => entry.bookId !== book.bookId);
      books.push(book);
      await atomicJson(this.file("books.json"), { books: books.sort((left, right) => left.title.localeCompare(right.title)) }, 0o600);
    });
  }

  /**
   * Forget a book and its GitHub token. Its working copy is moved to the trash, never deleted: if that
   * fails nothing else is changed.
   */
  async removeBook(bookId: string): Promise<void> {
    assertBookId(bookId);
    const trashed = await this.moveToTrash(bookId);
    try {
      // The records of its AI calls go with it, so that what the owner can bring back within the fourteen days is the whole book.
      await this.moveAiCallsToTrash(bookId, trashed);
    } catch (error) {
      if (trashed) await renameReplacing(trashed, this.bookDirectory(bookId)).catch(() => undefined);
      throw error;
    }
    await this.forgetBook(bookId);
    await this.setBookToken(bookId, null);
    await fs.rm(path.join(this.root, "books", bookId), { recursive: true, force: true });
  }

  /** Take a book out of the list of hosted books (its working copy and its token are not touched). */
  async forgetBook(bookId: string): Promise<void> {
    await this.locks.run("books", async () => {
      await atomicJson(this.file("books.json"), { books: (await this.readBooks()).filter((entry) => entry.bookId !== bookId) }, 0o600);
    });
  }

  get trashDirectory(): string {
    return path.join(this.root, "books", TRASH_DIRECTORY);
  }

  /**
   * Move a book's working copy to `books/.trash/<bookId>-<time>` (mode 0700) instead of deleting it.
   * Returns where it went, or `undefined` when there was nothing to keep.
   */
  async moveToTrash(bookId: string): Promise<string | undefined> {
    const directory = this.bookDirectory(bookId);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!entries.length) {
      await fs.rmdir(directory);
      return undefined;
    }
    await fs.mkdir(this.trashDirectory, { recursive: true, mode: 0o700 });
    let stamp = Date.now();
    while (await fs.lstat(path.join(this.trashDirectory, `${bookId}-${stamp}`)).then(() => true, () => false)) stamp += 1;
    const target = path.join(this.trashDirectory, `${bookId}-${stamp}`);
    await renameReplacing(directory, target);
    if (process.platform !== "win32") await fs.chmod(target, 0o700).catch(() => undefined);
    return target;
  }

  /**
   * Move the AI call records of a book to `books/.trash/<bookId>-<time>.ai-calls` (the time of its working copy's entry when it has one, so that the two belong together; mode 0700).
   * Returns where they went, or `undefined` when there were none.
   */
  async moveAiCallsToTrash(bookId: string, workingCopyInTrash?: string): Promise<string | undefined> {
    const directory = this.aiCallsDirectory(bookId);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!entries.length) {
      await fs.rmdir(directory);
      return undefined;
    }
    await fs.mkdir(this.trashDirectory, { recursive: true, mode: 0o700 });
    const taken = (target: string) => fs.lstat(target).then(() => true, () => false);
    let target = workingCopyInTrash ? `${workingCopyInTrash}${TRASH_CALLS_SUFFIX}` : "";
    if (!target || (await taken(target))) {
      let stamp = Date.now();
      while ((await taken(path.join(this.trashDirectory, `${bookId}-${stamp}${TRASH_CALLS_SUFFIX}`))) || (await taken(path.join(this.trashDirectory, `${bookId}-${stamp}`)))) stamp += 1;
      target = path.join(this.trashDirectory, `${bookId}-${stamp}${TRASH_CALLS_SUFFIX}`);
    }
    await renameReplacing(directory, target);
    if (process.platform !== "win32") await fs.chmod(target, 0o700).catch(() => undefined);
    return target;
  }

  /**
   * Delete the trash entries older than `maxAgeMs`. The age is the time in the name (`<bookId>-<time>`):
   * a moved folder keeps its old modification time, so that time would be wrong for it. Entries without
   * a time in their name are judged by their modification time.
   */
  async purgeTrash(maxAgeMs = TRASH_RETENTION_MS, now = Date.now()): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.trashDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const removed: string[] = [];
    for (const entry of entries) {
      const target = path.join(this.trashDirectory, entry);
      const stamp = /^.+-(\d{10,16})(?:\.ai-calls)?$/.exec(entry)?.[1];
      const since = stamp ? Number(stamp) : await fs.lstat(target).then((info) => info.mtimeMs, () => now);
      if (now - since <= maxAgeMs) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed.push(entry);
    }
    return removed;
  }

  private async readBookTokens(): Promise<Record<string, EncryptedSecret>> {
    const stored = await readJson(this.file("private", "book-tokens.json"), 1024 * 1024) as { tokens?: Record<string, unknown> } | undefined;
    const tokens: Record<string, EncryptedSecret> = {};
    for (const [bookId, value] of Object.entries(stored?.tokens ?? {})) if (BOOK_ID.test(bookId) && isEncryptedSecret(value)) tokens[bookId] = value;
    return tokens;
  }

  bookToken(bookId: string): Promise<string | undefined> {
    return this.locks.run("book-tokens", async () => {
      const encrypted = (await this.readBookTokens())[bookId];
      return encrypted ? this.vault.decrypt(encrypted) : undefined;
    });
  }

  async setBookToken(bookId: string, token: string | null): Promise<void> {
    assertBookToken(token);
    await this.locks.run("book-tokens", async () => {
      const tokens = await this.readBookTokens();
      if (token?.trim()) tokens[assertBookId(bookId)] = this.vault.encrypt(token.trim());
      else delete tokens[bookId];
      await atomicJson(this.file("private", "book-tokens.json"), { tokens });
      this.known.setToken(bookId, token ?? undefined);
    });
  }
}
