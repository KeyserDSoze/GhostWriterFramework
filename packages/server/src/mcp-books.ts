import { slugify } from "narrarium-engine";
import { assertBookId } from "./config.js";
import { HttpError } from "./errors.js";
import { atomicJson, readJson } from "./files.js";
import { KeyedMutex } from "./fs-store.js";

/** One book's MCP: its address and whether it is open. Off until the owner switches it on. */
export interface McpBookState {
  bookId: string;
  /** The last part of the address: `/mcp/<slug>`. Made from the title once, then the owner's to change: a new title never moves it. */
  slug: string;
  enabled: boolean;
  updatedAt: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_CHARACTERS = 80;
/** A slug made from a title: short enough that the number that makes it unique still fits in `MAX_SLUG_CHARACTERS`. */
const DERIVED_SLUG_CHARACTERS = 60;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATES = 1000;

/** Cut a slug at a hyphen, so that no word is left half. */
function cut(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  const hyphen = head.lastIndexOf("-");
  return (hyphen > 0 ? head.slice(0, hyphen) : head).replace(/-+$/, "");
}

/**
 * The slug a book gets: its title in lower case, accents taken off, words joined by hyphens. A title with no letter of ours in it (Cyrillic,
 * Chinese, Arabic…) has nothing to make a slug from: the book's id is used, which is as stable as anything and is already unique.
 */
export function slugFromTitle(title: string, bookId: string): string {
  return cut(slugify(title), DERIVED_SLUG_CHARACTERS) || cut(slugify(bookId), DERIVED_SLUG_CHARACTERS) || "book";
}

/** A slug the owner typed: exactly the form a slug has, never corrected into one (what the answer says is what the address is). */
export function assertSlug(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_SLUG_CHARACTERS || !SLUG.test(value)) {
    throw new HttpError(400, "invalid_slug", `A slug has 1 to ${MAX_SLUG_CHARACTERS} characters: lowercase letters and digits, joined by single hyphens (for example "my-book").`);
  }
  return value;
}

function parseState(value: unknown): McpBookState | undefined {
  const entry = value as Partial<McpBookState> | null;
  if (!entry || typeof entry.bookId !== "string" || typeof entry.slug !== "string" || typeof entry.enabled !== "boolean") return undefined;
  try {
    assertBookId(entry.bookId);
  } catch {
    return undefined;
  }
  if (entry.slug.length > MAX_SLUG_CHARACTERS || !SLUG.test(entry.slug)) return undefined;
  return { bookId: entry.bookId, slug: entry.slug, enabled: entry.enabled, updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.slice(0, 40) : new Date(0).toISOString() };
}

/**
 * The books' MCP switches and slugs, kept in `mcp.json` in the data folder and in memory: a request for an address is answered from memory, so
 * switching a book off is felt by the next request. A file that cannot be read leaves every book off (the safe state): the owner switches them on
 * again, and the first change replaces the damaged file.
 */
export class McpBooks {
  private readonly bySlug = new Map<string, McpBookState>();
  private readonly byBook = new Map<string, McpBookState>();
  private readonly mutex = new KeyedMutex();

  private constructor(private readonly file: string) {}

  static async open(file: string, log: (line: string) => void = () => undefined): Promise<McpBooks> {
    const books = new McpBooks(file);
    try {
      const stored = await readJson(file, MAX_STATE_BYTES) as { version?: unknown; books?: unknown } | undefined;
      if (stored === undefined) return books;
      if (!stored || stored.version !== 1 || !Array.isArray(stored.books)) throw new Error("it is not a list of books");
      for (const entry of stored.books.slice(0, MAX_STATES)) {
        const state = parseState(entry);
        if (state && !books.byBook.has(state.bookId) && !books.bySlug.has(state.slug)) books.index(state);
      }
    } catch (error) {
      books.byBook.clear();
      books.bySlug.clear();
      log(`mcp.json could not be read (${error instanceof Error ? error.message : String(error)}): the MCP of every book stays off until you switch it on again.`);
    }
    return books;
  }

  private index(state: McpBookState): void {
    const previous = this.byBook.get(state.bookId);
    if (previous) this.bySlug.delete(previous.slug);
    this.byBook.set(state.bookId, state);
    this.bySlug.set(state.slug, state);
  }

  private async save(states: McpBookState[]): Promise<void> {
    await atomicJson(this.file, { version: 1, books: [...states].sort((left, right) => left.slug.localeCompare(right.slug)) });
  }

  /** A slug no book has, made from `base` (`base`, then `base-2`, `base-3`…). */
  private free(base: string): string {
    if (!this.bySlug.has(base)) return base;
    for (let number = 2; ; number += 1) {
      const suffix = `-${number}`;
      const candidate = `${cut(base, MAX_SLUG_CHARACTERS - suffix.length)}${suffix}`;
      if (!this.bySlug.has(candidate)) return candidate;
    }
  }

  /** The book that has this slug, with its switch: the caller decides what an address that is off is worth (nothing). */
  resolve(slug: string): McpBookState | undefined {
    return this.bySlug.get(slug);
  }

  /** What is known of a book's MCP, without making anything: `undefined` for a book that has none yet (looking is not a change). */
  peek(bookId: string): McpBookState | undefined {
    return this.byBook.get(bookId);
  }

  /** The slug a book without MCP state would get now (it is only given when the book's MCP is first read or switched). */
  propose(bookId: string, title: string): string {
    return this.byBook.get(bookId)?.slug ?? this.free(slugFromTitle(title, bookId));
  }

  /** What is known of a book's MCP; a book that has none yet gets its slug now, and keeps it. */
  state(bookId: string, title: string): Promise<McpBookState> {
    const known = this.byBook.get(bookId);
    return known ? Promise.resolve(known) : this.update(bookId, title, {});
  }

  /** Switch a book on or off and/or give it another slug (`409 slug_taken` when another book has it); what is not said stays as it was. */
  update(bookId: string, title: string, change: { enabled?: boolean; slug?: string }): Promise<McpBookState> {
    return this.mutex.run("state", async () => {
      const current = this.byBook.get(bookId);
      const slug = change.slug !== undefined ? assertSlug(change.slug) : current?.slug ?? this.free(slugFromTitle(title, bookId));
      const holder = this.bySlug.get(slug);
      if (change.slug !== undefined && holder && holder.bookId !== bookId) throw new HttpError(409, "slug_taken", `The slug "${slug}" belongs to another book.`);
      const enabled = change.enabled ?? current?.enabled ?? false;
      if (current && current.slug === slug && current.enabled === enabled) return current;
      const next: McpBookState = { bookId, slug, enabled, updatedAt: new Date().toISOString() };
      // On disk first: a change that could not be kept is not made.
      await this.save([...[...this.byBook.values()].filter((state) => state.bookId !== bookId), next]);
      this.index(next);
      return next;
    });
  }

  /** A book that was removed has no address, and its slug is free again. */
  forget(bookId: string): Promise<void> {
    return this.mutex.run("state", async () => {
      const current = this.byBook.get(bookId);
      if (!current) return;
      await this.save([...this.byBook.values()].filter((state) => state.bookId !== bookId));
      this.byBook.delete(bookId);
      this.bySlug.delete(current.slug);
    });
  }
}
