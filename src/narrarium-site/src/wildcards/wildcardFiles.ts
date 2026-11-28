import { mergeWildcards, parseWildcard, serializeWildcard, wildcardPath, type WildcardProfile } from "narrarium-engine";
import { slugifyAny } from "@/narrarium/canon";
import { captureImmediateMutation, commitImmediateMutation, commitImmediateMutations } from "@/assistant/immediateMutation";
import { loadFileContent } from "@/github/githubClient";
import { optionalRepositoryRead } from "@/repository/repositoryError";
import type { BookStructure } from "@/types/book";
import type { AppSettings, BookEntry } from "@/types/settings";
import { liveAccountWildcards, removeAccountWildcard, upsertAccountWildcard, type WildcardAccountSettings } from "@/wildcards/accountWildcards";

/**
 * The wildcards of a book as the web app reads and writes them: the book's files (`wildcards/<slug>.md`), the author's account ones (`settings.wildcards`, the
 * same text) and the built-in ones, merged by the engine (`mergeWildcards`: built-in, then account, then book). The files are the engine's format, read and
 * written by the engine; what a file has that this version does not know is kept.
 */

/** The largest file of a wildcard that is imported. */
export const MAX_WILDCARD_IMPORT_BYTES = 64 * 1024;

export interface WildcardRoomLayers {
  /** Every wildcard in force for the book, merged. */
  room: WildcardProfile[];
  /** The book's own files, read. */
  book: WildcardProfile[];
  /** The account's wildcards, read. */
  account: WildcardProfile[];
}

/** The account's wildcards, read from their texts (a text that cannot be read is a profile with warnings, never asked). */
export function accountWildcardProfiles(settings: Pick<AppSettings, "wildcards">): WildcardProfile[] {
  return liveAccountWildcards(settings.wildcards).map((entry) => ({ ...parseWildcard(entry.slug, entry.text, `account:${entry.slug}`), id: entry.id, path: undefined, source: "account" as const }));
}

/** The book's wildcard files, read (from the working copy, as every page reads its files). */
export async function loadBookWildcards(input: { token: string; book: BookEntry; branch: string; structure: Pick<BookStructure, "wildcards"> }): Promise<WildcardProfile[]> {
  const files = input.structure.wildcards ?? [];
  const read = await Promise.all(files.map(async (entry) => {
    const raw = await optionalRepositoryRead(() => loadFileContent(input.token, input.book.owner, input.book.repo, entry.path, input.branch)) ?? "";
    return raw ? parseWildcard(entry.slug, raw, entry.path) : null;
  }));
  return read.filter((profile): profile is WildcardProfile => Boolean(profile));
}

/** The room of a book: its files, the account's wildcards and the built-in ones. Without a book (the account's page), the account over the built-in ones. */
export async function loadWildcardRoom(input: { settings: Pick<AppSettings, "wildcards">; language?: string; token?: string; book?: BookEntry | null; branch?: string; structure?: Pick<BookStructure, "wildcards" | "language"> | null }): Promise<WildcardRoomLayers> {
  const account = accountWildcardProfiles(input.settings);
  const book = input.book && input.structure && input.token ? await loadBookWildcards({ token: input.token, book: input.book, branch: input.branch ?? "", structure: input.structure }) : [];
  return { room: mergeWildcards(input.structure?.language ?? input.language, { account, book }), book, account };
}

/** The slug of a wildcard's file: its own when it is a file name, else made from its name. */
export function wildcardSlug(profile: Pick<WildcardProfile, "slug" | "name">): string {
  return wildcardPath(profile).slice("wildcards/".length, -3);
}

/** Write a wildcard into the book (its file, created or rewritten): the keys of the file this version does not know are kept. */
export async function saveBookWildcard(input: { token: string; book: BookEntry; branch: string; profile: WildcardProfile; signal?: AbortSignal }): Promise<string> {
  const slug = wildcardSlug(input.profile);
  const path = `wildcards/${slug}.md`;
  const snapshot = await captureImmediateMutation({ token: input.token, book: input.book, branch: input.branch, path, ...(input.signal ? { signal: input.signal } : {}) });
  const existing = snapshot.content ? parseWildcard(slug, snapshot.content, path) : null;
  const content = serializeWildcard({ ...input.profile, slug, extra: { ...(existing?.extra ?? {}), ...(input.profile.extra ?? {}) } });
  await commitImmediateMutation({ token: input.token, book: input.book, branch: input.branch, snapshot, content, message: `${snapshot.content ? "Update" : "Add"} wildcard ${input.profile.name || slug}` });
  return path;
}

/** Remove a wildcard's file from the book: a built-in one goes back to what the account or Narrarium says, one of the author's own is gone. */
export async function deleteBookWildcard(input: { token: string; book: BookEntry; branch: string; profile: Pick<WildcardProfile, "path" | "slug" | "name"> }): Promise<boolean> {
  const path = input.profile.path?.startsWith("wildcards/") ? input.profile.path : `wildcards/${input.profile.slug}.md`;
  const snapshot = await captureImmediateMutation({ token: input.token, book: input.book, branch: input.branch, path });
  if (!snapshot.content) return false;
  await commitImmediateMutations({ token: input.token, book: input.book, branch: input.branch, snapshots: [{ snapshot, content: null }], message: `Remove wildcard ${input.profile.name || input.profile.slug}` });
  return true;
}

/** The account's wildcards with one written in (its text is the file a book would have). */
export function withAccountWildcard(settings: Pick<AppSettings, "wildcards">, profile: WildcardProfile, now = new Date()): WildcardAccountSettings {
  const slug = wildcardSlug(profile);
  return upsertAccountWildcard(settings.wildcards, { id: profile.id, slug, text: serializeWildcard({ ...profile, slug }) }, now);
}

/** The account's wildcards with one removed (a tombstone, so that another copy does not bring it back). */
export function withoutAccountWildcard(settings: Pick<AppSettings, "wildcards">, id: string, now = new Date()): WildcardAccountSettings {
  return removeAccountWildcard(settings.wildcards, id, now);
}

/** The file a wildcard is exported as, and its name. */
export function exportedWildcard(profile: WildcardProfile): { name: string; text: string } {
  const slug = wildcardSlug(profile);
  return { name: `${slug}.wildcard.md`, text: serializeWildcard({ ...profile, slug }) };
}

/**
 * A wildcard from a file the author imports: its slug from the file's name (`hacker.wildcard.md`, `hacker.md`), else from its name. A file that is too
 * large, or not text, is refused with a reason; what cannot be read in it is the profile's warnings, as for a book's file.
 */
export function importedWildcard(fileName: string, text: string): WildcardProfile {
  if (new TextEncoder().encode(text).byteLength > MAX_WILDCARD_IMPORT_BYTES) throw new Error(`«${fileName}» is larger than ${MAX_WILDCARD_IMPORT_BYTES / 1024} KB.`);
  if (/\u0000/.test(text)) throw new Error(`«${fileName}» is not a text file.`);
  const base = fileName.replace(/\.(?:wildcard\.)?md$/i, "").replace(/\.txt$/i, "");
  const fromName = slugifyAny(base, "wildcard", true);
  const profile = parseWildcard(fromName, text, fileName);
  const slug = fromName === "wildcard" && profile.name ? slugifyAny(profile.name, "wildcard", true) : fromName;
  return { ...profile, slug, path: undefined, warnings: profile.warnings ?? [] };
}
