import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ADMIN_PORT, DEFAULT_SERVER_PORT, pickAiRuntimeConfig, serverIdentityMessage, type AiRuntimeConfig, type ServerBookStorage } from "narrarium-engine";
import { HttpError } from "./errors.js";
import { atomicJson, ensurePrivateDirectory, readJson } from "./files.js";
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
  /** Origins of the AI endpoints the server may call, approved by the owner. */
  allowedAiBases: string[];
  /** AI endpoint origins sent by a client and waiting for the owner's approval. */
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
}

export interface StoredBook {
  bookId: string;
  title: string;
  storage: ServerBookStorage;
  createdAt: string;
  updatedAt: string;
}

const BOOK_ID = /^[A-Za-z0-9._-]{1,120}$/;

export function assertBookId(bookId: string): string {
  if (!BOOK_ID.test(bookId) || bookId === "." || bookId === "..") throw new HttpError(400, "invalid_book", "Invalid book id.");
  return bookId;
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

export function configPath(root: string): string {
  return path.join(root, "config.json");
}

function parseConfig(stored: unknown): ServerConfig {
  const value = (stored && typeof stored === "object" ? stored : {}) as Partial<ServerConfig> & { port?: unknown };
  return {
    version: 2,
    serverId: typeof value.serverId === "string" && /^[0-9a-f-]{36}$/i.test(value.serverId) ? value.serverId : randomUUID(),
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim().slice(0, 80) : `narrarium-server@${os.hostname()}`,
    apiPort: validPort(value.apiPort ?? value.port, DEFAULT_SERVER_PORT),
    adminPort: validPort(value.adminPort, DEFAULT_ADMIN_PORT),
    origins: stringList(value.origins, 20),
    allowedAiBases: stringList(value.allowedAiBases, 50),
    pendingAiBases: stringList(value.pendingAiBases, 50),
    ...(typeof value.publicUrl === "string" && value.publicUrl ? { publicUrl: value.publicUrl } : {}),
    ...(typeof value.adminPublicUrl === "string" && value.adminPublicUrl ? { adminPublicUrl: value.adminPublicUrl } : {}),
    allowRemoteAdmin: value.allowRemoteAdmin !== false,
    maxConcurrentRuns: typeof value.maxConcurrentRuns === "number" && value.maxConcurrentRuns >= 1 && value.maxConcurrentRuns <= 8 ? Math.round(value.maxConcurrentRuns) : 2,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
  };
}

/** Read `config.json`, apply the given overrides and save it when something changed. */
export async function loadServerConfig(root: string, overrides: Partial<Pick<ServerConfig, "label" | "apiPort" | "adminPort">> & { origins?: string[] } = {}): Promise<ServerConfig> {
  await ensurePrivateDirectory(root);
  const stored = await readJson(configPath(root), 1024 * 1024);
  const config = parseConfig(stored);
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

/** Everything the server keeps on disk. Secrets go through the vault. */
export class DataDirectory {
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
    return new DataDirectory(resolved, vault, config, identity.publicKey, createPrivateKey(vault.decrypt(identity.privateKey)));
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

  async updateConfig(change: (config: ServerConfig) => void): Promise<ServerConfig> {
    const next = structuredClone(this.currentConfig);
    change(next);
    const checked = parseConfig(next);
    await atomicJson(configPath(this.root), checked, 0o600);
    this.currentConfig = checked;
    return checked;
  }

  file(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  bookDirectory(bookId: string): string {
    return path.join(this.root, "books", assertBookId(bookId), "repo");
  }

  async aiConfig(): Promise<{ config: AiRuntimeConfig; updatedAt: string | null }> {
    const stored = await readJson(this.file("private", "ai.json"), 4 * 1024 * 1024) as { encrypted?: unknown; updatedAt?: unknown } | undefined;
    if (!stored || !isEncryptedSecret(stored.encrypted)) return { config: pickAiRuntimeConfig({}), updatedAt: null };
    return { config: pickAiRuntimeConfig(JSON.parse(this.vault.decrypt(stored.encrypted))), updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null };
  }

  async saveAiConfig(config: AiRuntimeConfig): Promise<void> {
    await atomicJson(this.file("private", "ai.json"), { encrypted: this.vault.encrypt(JSON.stringify(pickAiRuntimeConfig(config))), updatedAt: new Date().toISOString() });
  }

  async books(): Promise<StoredBook[]> {
    const stored = await readJson(this.file("books.json"), 4 * 1024 * 1024) as { books?: StoredBook[] } | undefined;
    return Array.isArray(stored?.books) ? stored.books.filter((book) => book && typeof book.bookId === "string" && BOOK_ID.test(book.bookId)) : [];
  }

  async saveBook(book: StoredBook): Promise<void> {
    const books = (await this.books()).filter((entry) => entry.bookId !== book.bookId);
    books.push(book);
    await atomicJson(this.file("books.json"), { books: books.sort((left, right) => left.title.localeCompare(right.title)) }, 0o600);
  }

  async removeBook(bookId: string): Promise<void> {
    await atomicJson(this.file("books.json"), { books: (await this.books()).filter((entry) => entry.bookId !== bookId) }, 0o600);
    await this.setBookToken(bookId, null);
    await fs.rm(path.join(this.root, "books", assertBookId(bookId)), { recursive: true, force: true });
  }

  private async bookTokens(): Promise<Record<string, EncryptedSecret>> {
    const stored = await readJson(this.file("private", "book-tokens.json"), 1024 * 1024) as { tokens?: Record<string, unknown> } | undefined;
    const tokens: Record<string, EncryptedSecret> = {};
    for (const [bookId, value] of Object.entries(stored?.tokens ?? {})) if (BOOK_ID.test(bookId) && isEncryptedSecret(value)) tokens[bookId] = value;
    return tokens;
  }

  async bookToken(bookId: string): Promise<string | undefined> {
    const encrypted = (await this.bookTokens())[bookId];
    return encrypted ? this.vault.decrypt(encrypted) : undefined;
  }

  async setBookToken(bookId: string, token: string | null): Promise<void> {
    const tokens = await this.bookTokens();
    if (token?.trim()) tokens[assertBookId(bookId)] = this.vault.encrypt(token.trim());
    else delete tokens[bookId];
    await atomicJson(this.file("private", "book-tokens.json"), { tokens });
  }
}
