import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BookConflictError, assertSafeBookPath, isTextBookPath, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "narrarium-engine";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".astro", "dist"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Serializes async work per key (one writer per book). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.tails.set(key, next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }));
    return next;
  }
}

export interface FileBookStoreOptions {
  /** Called inside the write lock after files are written (e.g. `git commit`); returns the new revision. */
  afterWrite?: (paths: string[], message: string) => Promise<string | undefined>;
}

/** `BookStore` over a directory: atomic replace per file, compare-and-swap, one writer at a time. */
export class FileBookStore implements BookStore {
  private readonly hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  private readonly mutex = new KeyedMutex();

  constructor(readonly root: string, private readonly options: FileBookStoreOptions = {}) {}

  private absolute(relative: string): string {
    const safe = assertSafeBookPath(relative);
    const full = path.resolve(this.root, ...safe.split("/"));
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`Unsafe book path: ${relative}`);
    return full;
  }

  private async hashOf(relative: string, full: string): Promise<string | null> {
    try {
      const info = await stat(full);
      if (!info.isFile()) return null;
      const cached = this.hashes.get(relative);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
      const hash = hashText(await readFile(full, "utf8"));
      this.hashes.set(relative, { mtimeMs: info.mtimeMs, size: info.size, hash });
      return hash;
    } catch {
      return null;
    }
  }

  async list(): Promise<BookFileEntry[]> {
    const entries: BookFileEntry[] = [];
    const walk = async (directory: string, prefix: string) => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const relative = prefix ? `${prefix}/${child.name}` : child.name;
        const full = path.join(directory, child.name);
        if (child.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(child.name)) await walk(full, relative);
        } else if (child.isFile() && isTextBookPath(relative)) {
          const hash = await this.hashOf(relative, full);
          if (hash) entries.push({ path: relative, hash });
        }
      }
    };
    await walk(this.root, "");
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(relative: string): Promise<BookFileContent | null> {
    const full = this.absolute(relative);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      const content = await readFile(full, "utf8");
      const hash = hashText(content);
      this.hashes.set(relative, { mtimeMs: info.mtimeMs, size: info.size, hash });
      return { path: relative, content, hash };
    } catch {
      return null;
    }
  }

  commit(changes: BookFileChange[], message: string): Promise<BookCommitResult> {
    return this.mutex.run("write", async () => {
      const prepared = changes.map((change) => ({ ...change, full: this.absolute(change.path) }));
      for (const change of prepared) {
        if (change.expectedHash === undefined) continue;
        const current = await this.hashOf(change.path, change.full);
        if (current !== change.expectedHash) throw new BookConflictError(`File changed since it was read: ${change.path}`, change.path);
      }
      const originals = new Map<string, string | null>();
      for (const change of prepared) originals.set(change.full, await readFile(change.full, "utf8").catch(() => null));
      try {
        for (const change of prepared) {
          if (change.content === null) {
            await rm(change.full, { force: true });
          } else {
            if (Buffer.byteLength(change.content, "utf8") > MAX_FILE_BYTES) throw new Error(`File too large: ${change.path}`);
            await mkdir(path.dirname(change.full), { recursive: true });
            const temporary = `${change.full}.${process.pid}.${Date.now()}.tmp`;
            await writeFile(temporary, change.content, { encoding: "utf8", mode: 0o644 });
            await rename(temporary, change.full);
          }
          this.hashes.delete(change.path);
        }
      } catch (error) {
        for (const [full, content] of originals) {
          if (content === null) await rm(full, { force: true }).catch(() => undefined);
          else await writeFile(full, content, "utf8").catch(() => undefined);
        }
        throw error;
      }
      const revision = await this.options.afterWrite?.(prepared.map((change) => change.path), message);
      return { revision };
    });
  }

  /** Revision of the current content when the store has no git history. */
  async contentRevision(): Promise<string> {
    const entries = await this.list();
    return hashText(entries.map((entry) => `${entry.path}:${entry.hash}`).join("\n")).slice(0, 16);
  }
}
