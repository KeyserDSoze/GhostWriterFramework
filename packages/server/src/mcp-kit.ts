import { assertFrontmatterReadable, parseMarkdown, renderMarkdown, type BookFileChange, type BookFileContent, type BookSnapshot, type CanonInfo, type CanonKind, type ChapterInfo, type MarkdownDocument, type ParagraphInfo } from "narrarium-engine";
import type { BookRegistry, BookRuntime } from "./books.js";
import type { McpPrincipal, McpScope } from "./mcp-access.js";
import { integer, type JsonSchema } from "./mcp-schema.js";

/** A failure of a tool that the model can read and act on: it becomes a result with `isError`, and its text starts with `[code]`. */
export class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

/** What a tool is given for one call. */
export interface ToolContext {
  readonly bookId: string;
  readonly runtime: BookRuntime;
  readonly books: BookRegistry;
  readonly principal: McpPrincipal;
  /** Say which files this call looks at or changes: the audit lists them (never what they hold). */
  touch(...paths: string[]): void;
  /** The book's chapters, scenes and canon, read once per call. */
  snapshot(): Promise<BookSnapshot>;
  /**
   * One commit of `changes` through the book's store: compare-and-swap with the hashes they carry, one writer at a time, a git commit with the message
   * `MCP (<client>): <what>`, and what a commit from the app does after it (a GitHub book is published). A file that changed meanwhile is a `conflict`
   * error and nothing is written. Answers the revision of the commit, when the book has a history.
   */
  commit(changes: BookFileChange[], what: string): Promise<string | undefined>;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** The permission a client needs to see this tool and to call it. */
  scope: McpScope;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
  inputSchema: JsonSchema;
  run(context: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

// ─── Answers ─────────────────────────────────────────────────────────────────

/** An answer that is data: one block of JSON. */
export const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** An answer that is data and a text: the data first, the text as a block of its own (a text is not squeezed into a JSON string, so a model reads it as it is). */
export const withText = (value: unknown, text: string): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }, ...(text ? [{ type: "text" as const, text }] : [])] });

export interface TextPage {
  offset: number;
  returned: number;
  total: number;
  /** Where the next page starts, or `null` at the end. */
  nextOffset: number | null;
}

export const DEFAULT_PAGE_CHARACTERS = 20_000;
export const MAX_PAGE_CHARACTERS = 60_000;

/** One page of a text, counted in characters; a page never ends in the middle of a character that takes two code units. */
export function pageText(text: string, offset = 0, limit = DEFAULT_PAGE_CHARACTERS): { slice: string; page: TextPage } {
  const start = Math.min(Math.max(0, offset), text.length);
  let end = Math.min(text.length, start + Math.max(1, limit));
  if (end < text.length) {
    const last = text.charCodeAt(end - 1);
    // The page ends between the two halves of a character: it stops before it, or (when that would leave nothing) takes it whole.
    if (last >= 0xd800 && last <= 0xdbff) end = end - 1 > start ? end - 1 : end + 1;
  }
  return { slice: text.slice(start, end), page: { offset: start, returned: end - start, total: text.length, nextOffset: end < text.length ? end : null } };
}

export const offsetProperty = (): JsonSchema => integer("Character to start from (default 0). To read on, pass the `nextOffset` of the page before.", 0, 100_000_000);
export const pageProperty = (): JsonSchema => integer(`How many characters to return (default ${DEFAULT_PAGE_CHARACTERS}, at most ${MAX_PAGE_CHARACTERS}).`, 1, MAX_PAGE_CHARACTERS);

/** The numbers of a paged list. */
export function pageList<T>(items: readonly T[], offset = 0, limit: number): { slice: T[]; offset: number; limit: number; total: number; nextOffset: number | null } {
  const slice = items.slice(offset, offset + limit);
  return { slice, offset, limit, total: items.length, nextOffset: offset + slice.length < items.length ? offset + slice.length : null };
}

export const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const asInteger = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isInteger(value) ? value : fallback);

/** A text as a message may quote it: one line, short. */
export const shorten = (text: string, max = 80): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** Lower case, without accents, for matching names and words. */
export const plain = (text: string): string => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// ─── What a call names ───────────────────────────────────────────────────────

/** A chapter by its slug (`001-arrival`), its number (`1`) or its id (`chapter:001-arrival`, or its path). */
export function findChapter(snapshot: BookSnapshot, reference: string): ChapterInfo {
  const text = reference.trim().replace(/^chapter:/, "").replace(/^chapters\//, "").replace(/\/chapter\.md$/, "").replace(/\/$/, "");
  const found = (/^\d+$/.test(text) ? snapshot.chapters.find((chapter) => chapter.number === Number(text)) : undefined) ?? snapshot.chapters.find((chapter) => chapter.slug === text);
  if (!found) throw new ToolError("not_found", `There is no chapter "${shorten(reference)}". Use list_chapters to see the chapters and their slugs.`);
  return found;
}

/** A scene of a chapter by its slug (`001-the-quay`), its number (`1`) or its id. */
export function findScene(chapter: ChapterInfo, reference: string): ParagraphInfo {
  const text = reference.trim().replace(/^paragraph:[^:]*:/, "").replace(/\.md$/, "");
  const found = (/^\d+$/.test(text) ? chapter.paragraphs.find((scene) => scene.number === Number(text)) : undefined) ?? chapter.paragraphs.find((scene) => scene.slug === text);
  if (!found) throw new ToolError("not_found", `There is no scene "${shorten(reference)}" in chapter ${chapter.slug}. Use read_chapter to see its scenes.`);
  return found;
}

/** A canon entry of a kind by its slug, its name or one of its aliases (case and accents do not matter). */
export function findCanon(snapshot: BookSnapshot, kind: CanonKind, reference: string): CanonInfo {
  const entries = snapshot.canon.filter((entry) => entry.kind === kind);
  const wanted = plain(reference);
  const bySlug = entries.find((entry) => entry.slug.toLowerCase() === reference.trim().toLowerCase());
  if (bySlug) return bySlug;
  const named = entries.filter((entry) => [entry.name, ...entry.aliases].some((name) => plain(name) === wanted));
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new ToolError("ambiguous", `More than one ${kind} is called "${shorten(reference)}": ${named.map((entry) => entry.slug).join(", ")}. Use the slug.`);
  throw new ToolError("not_found", `There is no ${kind} "${shorten(reference)}". Use list_canon to see the entries and their slugs.`);
}

// ─── Changing a file ─────────────────────────────────────────────────────────

const HASH = /^[0-9a-f]{64}$/;

/** The hash a client passes back: the one a read tool gave. */
export function expectedHashOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !HASH.test(value)) throw new ToolError("invalid_input", "`expectedHash` must be the hash that a read tool gave for the file: 64 lowercase hexadecimal characters.");
  return value;
}

export const conflictError = (path: string): ToolError => new ToolError("conflict", `The file changed since you read it (${path}): read it again and retry. Nothing was written.`);

/** A file as it is now, with its frontmatter read (a file whose frontmatter cannot be read is never rewritten: it would lose the keys it holds). */
export async function openForEdit(context: ToolContext, path: string, language: string): Promise<{ file: BookFileContent; document: MarkdownDocument }> {
  context.touch(path);
  const file = await context.runtime.store.read(path);
  if (!file) throw new ToolError("not_found", `${path} is not in the book.`);
  const document = parseMarkdown(file.content);
  assertFrontmatterReadable(path, document, language);
  return { file, document };
}

/**
 * What a call that changes a file has to show: the hash it read, when it has one, must be the hash that is there. A call that replaces a whole text
 * (`replacing`) must have one: a text is replaced only by someone who has seen the one that was there, and the message says which tool gives the hash.
 */
export function checkSeen(path: string, current: BookFileContent, expectedHash: string | undefined, replacing?: { readWith: string }): void {
  if (expectedHash !== undefined && expectedHash !== current.hash) throw conflictError(path);
  if (replacing && expectedHash === undefined) {
    throw new ToolError("expected_hash_required", `A new text replaces a whole text: pass the hash that ${replacing.readWith} gave for ${path} as expectedHash, so that a change made meanwhile is never overwritten. Read it first with ${replacing.readWith}.`);
  }
}

/** The file's text with its frontmatter changed by `patch` (a key set to `null` is taken out) and its body replaced by `body`. */
export function composeDocument(document: MarkdownDocument, patch: Record<string, unknown>, body: string): string {
  const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  if (!document.hasFrontmatter && !Object.keys(changes).length) return `${body}\n`;
  return renderMarkdown({ ...document.frontmatter, ...changes }, body);
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** `body` with the one place where `find` stands replaced: the passage must be there exactly once. Line breaks are matched as the text writes them. */
export function replacePassage(body: string, find: string, replacement: string): string {
  const windows = body.includes("\r\n");
  const lines = (text: string) => (windows ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n"));
  const needle = lines(find);
  const count = occurrences(body, needle);
  if (count === 0) throw new ToolError("not_found", "The passage to replace was not found in the text. Read it again and copy the passage as it is, with its punctuation and line breaks.");
  if (count > 1) throw new ToolError("ambiguous", `The passage is in the text ${count} times: include more of the text around it, so that it is there only once.`);
  const at = body.indexOf(needle);
  return body.slice(0, at) + lines(replacement) + body.slice(at + needle.length);
}

/** Of the named properties, the ones a call gave. */
export function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
}

/** Whether a patch would change nothing in a document: every value it gives is what the file already has (and `null` is a key the file does not have). */
export function changesNothing(document: MarkdownDocument, patch: Record<string, unknown>, body: string): boolean {
  if (body !== document.body) return false;
  return Object.entries(patch).every(([key, value]) => (value === null ? document.frontmatter[key] === undefined : JSON.stringify(document.frontmatter[key]) === JSON.stringify(value)));
}
