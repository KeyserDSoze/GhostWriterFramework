import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { BookConflictError, assertSafeBookPath, isSafeBookPath, isTextBookPath, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "narrarium-engine";
import { HttpError } from "./errors.js";
import { renameReplacing } from "./files.js";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".astro", "dist"]);
/** Larger files are neither listed, read nor replaced: no client could ever sync them. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Files one commit may change. The first upload of a big book legitimately sends thousands of them at once. */
export const MAX_COMMIT_CHANGES = 5000;
/** Bytes of existing files one commit may have to put back if it fails. */
const MAX_ROLLBACK_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function unsafePath(relative: unknown): HttpError {
  return new HttpError(400, "invalid_path", `Unsafe book path: ${String(relative).slice(0, 200)}`);
}

/** Serializes async work per key (one writer per book). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(action);
    // The tail never rejects: the caller owns the rejection of `next`, nobody else must see it.
    const tail = next.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export interface FileBookStoreOptions {
  /** Called inside the write lock after files are written (e.g. `git commit`); returns the new revision. */
  afterWrite?: (paths: string[], message: string) => Promise<string | undefined>;
}

/** Where a book path really is, after looking at every component of it. */
interface Location {
  /** The normalized path: `/` separators, safe spelling. */
  safe: string;
  full: string;
  /** The path crosses a link or leaves the book, or the file system would not say what is there. */
  unsafe: boolean;
  /** What the path ends at: nothing, a regular file, or anything else (a folder, or a file where a folder is needed). */
  kind: "missing" | "file" | "other";
  /** The file's own status, when `kind` is `file`. */
  info?: Stats;
}

/** A change whose path is normalized, checked for duplicates and for size. */
interface PreparedChange {
  path: string;
  content: string | null;
  expectedHash?: string | null;
}

interface Target extends PreparedChange {
  location: Location;
  /** What the file held before the commit (`null`: nothing), to put it back if the commit fails. */
  original: Buffer | null;
}

/**
 * `BookStore` over a directory: atomic replace per file, compare-and-swap, one writer at a time.
 * The working copy may come from anywhere (a cloned repository is not trusted), so no operation ever
 * follows a symbolic link: a link anywhere on a path makes the file "not there" for reads and an
 * unsafe path for writes.
 */
export class FileBookStore implements BookStore {
  private readonly hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  private readonly mutex = new KeyedMutex();

  constructor(readonly root: string, private readonly options: FileBookStoreOptions = {}) {}

  private safePath(relative: string): string {
    try {
      return assertSafeBookPath(relative);
    } catch {
      throw unsafePath(relative);
    }
  }

  /**
   * Checks every existing component below the root with `lstat` (a link anywhere makes the path unsafe)
   * and compares the real path of the deepest existing folder with the real root.
   */
  private async locate(relative: string): Promise<Location> {
    const safe = this.safePath(relative);
    const root = path.resolve(this.root);
    const parts = safe.split("/");
    const full = path.join(root, ...parts);
    const blocked: Location = { safe, full, unsafe: true, kind: "other" };
    if (!full.startsWith(root + path.sep)) return blocked;
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { safe, full, unsafe: false, kind: "missing" } : blocked;
    }
    let anchor = root;
    let current = root;
    let kind: Location["kind"] = "missing";
    let info: Stats | undefined;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      let stats: Stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        return blocked;
      }
      if (stats.isSymbolicLink()) return blocked;
      if (index === parts.length - 1) {
        kind = stats.isFile() ? "file" : "other";
        info = stats;
      } else if (stats.isDirectory()) {
        anchor = current;
      } else {
        kind = "other";
        break;
      }
    }
    try {
      const real = anchor === root ? realRoot : await realpath(anchor);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return blocked;
    } catch {
      return blocked;
    }
    return { safe, full, unsafe: false, kind, info: kind === "file" ? info : undefined };
  }

  /** The bytes of a regular file of at most `MAX_FILE_BYTES`, opened without following a link. */
  private async readBytes(full: string): Promise<{ bytes: Buffer; info: Stats } | null> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(full, constants.O_RDONLY | NO_FOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      const bytes = await handle.readFile();
      return bytes.byteLength > MAX_FILE_BYTES ? null : { bytes, info };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async hashOf(location: Location): Promise<string | null> {
    const { info } = location;
    if (location.unsafe || location.kind !== "file" || !info || info.size > MAX_FILE_BYTES) return null;
    const cached = this.hashes.get(location.safe);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hash;
    const file = await this.readBytes(location.full);
    if (!file) return null;
    const hash = hashText(file.bytes.toString("utf8"));
    this.hashes.set(location.safe, { mtimeMs: file.info.mtimeMs, size: file.info.size, hash });
    return hash;
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
        // Links are skipped, so the walk only ever stands in real folders: the file itself is the last thing to check.
        if (child.isSymbolicLink()) continue;
        const relative = prefix ? `${prefix}/${child.name}` : child.name;
        const full = path.join(directory, child.name);
        if (child.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(child.name)) await walk(full, relative);
        } else if (child.isFile() && isTextBookPath(relative) && isSafeBookPath(relative)) {
          const info = await lstat(full).catch(() => null);
          if (!info?.isFile()) continue;
          const hash = await this.hashOf({ safe: relative, full, unsafe: false, kind: "file", info });
          if (hash) entries.push({ path: relative, hash });
        }
      }
    };
    await walk(path.resolve(this.root), "");
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(relative: string): Promise<BookFileContent | null> {
    const location = await this.locate(relative);
    if (location.unsafe || location.kind !== "file" || !location.info || location.info.size > MAX_FILE_BYTES) return null;
    const file = await this.readBytes(location.full);
    if (!file) return null;
    const content = file.bytes.toString("utf8");
    const hash = hashText(content);
    this.hashes.set(location.safe, { mtimeMs: file.info.mtimeMs, size: file.info.size, hash });
    return { path: relative, content, hash };
  }

  async commit(changes: BookFileChange[], message: string): Promise<BookCommitResult> {
    const prepared = this.prepare(changes);
    return this.mutex.run("write", () => this.apply(prepared, message));
  }

  /** Everything that can be checked without looking at the disk: count, paths (normalized once), duplicates, sizes. */
  private prepare(changes: BookFileChange[]): PreparedChange[] {
    if (changes.length > MAX_COMMIT_CHANGES) throw new HttpError(413, "too_many_changes", `A commit may change at most ${MAX_COMMIT_CHANGES} files: send the rest in another commit.`);
    const seen = new Set<string>();
    return changes.map((change) => {
      const safe = this.safePath(change.path);
      // Only the text files of a book travel through the API; git's own files (`.gitmodules`, `.gitattributes`, `.gitignore`) and binaries never do.
      if (!isTextBookPath(safe)) throw new HttpError(400, "invalid_path", `Only text files of a book (.md, .markdown, .txt, .json, .yaml, .yml) can be written: ${safe}`);
      const key = safe.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw new HttpError(400, "duplicate_path", `The same file appears twice in one commit: ${safe}`);
      seen.add(key);
      if (change.content !== null && Buffer.byteLength(change.content, "utf8") > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large", `File too large: ${safe}`);
      return { path: safe, content: change.content, expectedHash: change.expectedHash };
    });
  }

  private async apply(prepared: PreparedChange[], message: string): Promise<BookCommitResult> {
    // The whole change set is checked before anything is written.
    const targets: Target[] = [];
    for (const change of prepared) {
      const location = await this.locate(change.path);
      if (location.unsafe) throw unsafePath(change.path);
      if (location.kind === "other") throw new HttpError(400, "invalid_path", `Not a file path (a folder or a file is in the way): ${change.path}`);
      targets.push({ ...change, location, original: null });
    }
    for (const target of targets) {
      if (target.expectedHash === undefined) continue;
      const current = await this.hashOf(target.location);
      if (current !== target.expectedHash) throw new BookConflictError(`File changed since it was read: ${target.path}`, target.path);
    }
    let remembered = 0;
    for (const target of targets) {
      if (target.location.kind !== "file") continue;
      const size = target.location.info?.size ?? 0;
      if (size > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large", `File too large to replace safely: ${target.path}`);
      remembered += size;
      if (remembered > MAX_ROLLBACK_BYTES) throw new HttpError(413, "payload_too_large", "This commit replaces too much existing content at once: send it in smaller commits.");
      const file = await this.readBytes(target.location.full);
      if (!file) throw unsafePath(target.path);
      target.original = file.bytes;
    }

    let reached = 0;
    const created: string[] = [];
    try {
      for (const target of targets) {
        reached += 1;
        this.hashes.delete(target.path);
        if (target.content === null) {
          await rm(target.location.full, { force: true });
        } else {
          const first = await mkdir(path.dirname(target.location.full), { recursive: true });
          if (first) created.push(first);
          await this.replaceFile(target.location.full, target.content);
        }
      }
      const revision = await this.options.afterWrite?.(targets.map((target) => target.path), message);
      return { revision };
    } catch (error) {
      await this.putBack(targets.slice(0, reached), created);
      throw error;
    }
  }

  /** Write through a private temporary file in the same folder, then rename: readers never see a partial file. */
  private async replaceFile(full: string, content: string | Uint8Array): Promise<void> {
    const temporary = path.join(path.dirname(full), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
      await renameReplacing(temporary, full);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Undo a failed commit: every file back to what it held, the folders it created removed. */
  private async putBack(targets: Target[], created: string[]): Promise<void> {
    for (const target of targets) {
      this.hashes.delete(target.path);
      try {
        const location = await this.locate(target.path);
        if (location.unsafe) continue;
        if (target.original === null) await rm(location.full, { force: true });
        else await this.replaceFile(location.full, target.original);
      } catch {
        // Keep going: the other files must still be put back.
      }
    }
    for (const directory of created.reverse()) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Revision of the current content when the store has no git history. */
  async contentRevision(): Promise<string> {
    const entries = await this.list();
    return hashText(entries.map((entry) => `${entry.path}:${entry.hash}`).join("\n")).slice(0, 16);
  }
}
