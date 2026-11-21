import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SERVER_PORT, pickAiRuntimeConfig, type AiRuntimeConfig, type ServerBookStorage } from "narrarium-engine";

export const DEFAULT_ORIGINS = [
  "https://narrarium.net",
  "https://www.narrarium.net",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

export interface ServerConfig {
  version: 1;
  serverId: string;
  label: string;
  port: number;
  host: string;
  /** Extra browser origins allowed to call the API (the defaults are always allowed). */
  origins: string[];
  /** Maximum books whose autopilot runs at the same time. */
  maxConcurrentRuns: number;
  createdAt: string;
}

export interface StoredToken {
  id: string;
  label: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface StoredBook {
  bookId: string;
  title: string;
  storage: ServerBookStorage;
  createdAt: string;
  updatedAt: string;
}

export function defaultDataDirectory(): string {
  return process.env.NARRARIUM_SERVER_HOME?.trim() || path.join(os.homedir(), ".narrarium-server");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const BOOK_ID = /^[A-Za-z0-9._-]{1,120}$/;
const HELD_LOCKS = new Set<string>();

export function assertBookId(bookId: string): string {
  if (!BOOK_ID.test(bookId) || bookId === "." || bookId === "..") throw Object.assign(new Error("Invalid book id."), { status: 400, code: "invalid_book" });
  return bookId;
}

/** Everything the server keeps on disk. Secrets are written with mode 0600. */
export class DataDirectory {
  constructor(readonly root: string) {}

  file(name: string): string {
    return path.join(this.root, name);
  }

  bookDirectory(bookId: string): string {
    return path.join(this.root, "books", assertBookId(bookId), "repo");
  }

  async ensure(): Promise<void> {
    await mkdir(path.join(this.root, "books"), { recursive: true, mode: 0o700 });
  }

  async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  async writeJson(name: string, value: unknown, secret = false): Promise<void> {
    const target = this.file(name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: secret ? 0o600 : 0o644 });
    await rename(temporary, target);
  }

  async config(overrides: Partial<Pick<ServerConfig, "port" | "host" | "label">> & { origins?: string[] } = {}): Promise<ServerConfig> {
    const stored = await this.readJson<Partial<ServerConfig> | null>("config.json", null);
    const config: ServerConfig = {
      version: 1,
      serverId: stored?.serverId ?? randomUUID(),
      label: overrides.label ?? stored?.label ?? `narrarium-server@${os.hostname()}`,
      port: overrides.port ?? stored?.port ?? DEFAULT_SERVER_PORT,
      host: overrides.host ?? stored?.host ?? "127.0.0.1",
      origins: [...new Set([...(stored?.origins ?? []), ...(overrides.origins ?? [])])],
      maxConcurrentRuns: stored?.maxConcurrentRuns ?? 2,
      createdAt: stored?.createdAt ?? new Date().toISOString(),
    };
    if (!stored || JSON.stringify(stored) !== JSON.stringify(config)) await this.writeJson("config.json", config);
    return config;
  }

  async tokens(): Promise<StoredToken[]> {
    return (await this.readJson<{ tokens?: StoredToken[] }>("tokens.json", {})).tokens ?? [];
  }

  /** Create a client token; the clear value is returned once and never stored. */
  async createToken(label: string): Promise<{ id: string; token: string }> {
    const token = `nrs_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID().slice(0, 8);
    const tokens = await this.tokens();
    tokens.push({ id, label: label.trim() || "client", hash: hashToken(token), createdAt: new Date().toISOString() });
    await this.writeJson("tokens.json", { tokens }, true);
    return { id, token };
  }

  async revokeToken(id: string): Promise<boolean> {
    const tokens = await this.tokens();
    const remaining = tokens.filter((token) => token.id !== id);
    if (remaining.length === tokens.length) return false;
    await this.writeJson("tokens.json", { tokens: remaining }, true);
    return true;
  }

  async verifyToken(token: string): Promise<StoredToken | null> {
    if (!token.trim()) return null;
    const hash = hashToken(token);
    return (await this.tokens()).find((entry) => sameHash(entry.hash, hash)) ?? null;
  }

  async aiConfig(): Promise<{ config: AiRuntimeConfig; updatedAt: string | null }> {
    const stored = await this.readJson<{ config?: unknown; updatedAt?: string }>("ai.json", {});
    return { config: pickAiRuntimeConfig(stored.config ?? {}), updatedAt: stored.updatedAt ?? null };
  }

  async saveAiConfig(config: AiRuntimeConfig): Promise<void> {
    await this.writeJson("ai.json", { config: pickAiRuntimeConfig(config), updatedAt: new Date().toISOString() }, true);
  }

  async books(): Promise<StoredBook[]> {
    return (await this.readJson<{ books?: StoredBook[] }>("books.json", {})).books ?? [];
  }

  async saveBook(book: StoredBook): Promise<void> {
    const books = (await this.books()).filter((entry) => entry.bookId !== book.bookId);
    books.push(book);
    await this.writeJson("books.json", { books: books.sort((left, right) => left.title.localeCompare(right.title)) });
  }

  async removeBook(bookId: string): Promise<void> {
    await this.writeJson("books.json", { books: (await this.books()).filter((entry) => entry.bookId !== bookId) });
    await this.setBookToken(bookId, null);
    await rm(path.join(this.root, "books", assertBookId(bookId)), { recursive: true, force: true });
  }

  async bookToken(bookId: string): Promise<string | undefined> {
    return (await this.readJson<{ tokens?: Record<string, string> }>("book-tokens.json", {})).tokens?.[bookId];
  }

  async setBookToken(bookId: string, token: string | null): Promise<void> {
    const stored = await this.readJson<{ tokens?: Record<string, string> }>("book-tokens.json", {});
    const tokens = { ...(stored.tokens ?? {}) };
    if (token) tokens[bookId] = token.trim();
    else delete tokens[bookId];
    await this.writeJson("book-tokens.json", { tokens }, true);
  }

  /** One server per data directory: the lock holds the pid and is taken over only from dead processes. */
  async acquireLock(): Promise<() => Promise<void>> {
    const lock = this.file("server.lock");
    const key = path.resolve(this.root);
    if (HELD_LOCKS.has(key)) throw new Error(`Another narrarium-server (pid ${process.pid}) is already using ${this.root}.`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        HELD_LOCKS.add(key);
        return async () => {
          HELD_LOCKS.delete(key);
          await rm(lock, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number((await readFile(lock, "utf8").catch(() => "")).trim());
        if (pid && pid !== process.pid && processAlive(pid)) throw new Error(`Another narrarium-server (pid ${pid}) is already using ${this.root}.`);
        await rm(lock, { force: true });
      }
    }
    throw new Error(`Could not lock ${this.root}.`);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
