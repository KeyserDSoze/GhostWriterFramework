import { parseDocument, stringify } from "yaml";
import { DIRECTOR_FILE, defaultDirector, parseDirector, serializeDirector, type DirectorProfile } from "narrarium-engine";
import { mergeManagedFrontmatter } from "@/assistant/immediateMutation";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import type { BookEntry } from "@/types/settings";

/** Frontmatter keys owned by the director editor; any other key the author added is preserved. */
export const DIRECTOR_MANAGED_KEYS = [
  "type",
  "id",
  "name",
  "language",
  "persona",
  "autonomy",
  "strictness",
  "approval_score",
  "max_review_rounds",
  "priorities",
  "taste",
  "red_lines",
  "reader_weights",
] as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function frontmatterOf(raw: string | null): Record<string, unknown> {
  const match = raw ? FRONTMATTER.exec(raw) : null;
  if (!match) return {};
  const parsed = parseDocument(match[1]).toJSON() as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/**
 * The book's director (`director.md`) from the local working copy, or the defaults in the book
 * language when it is not saved yet.
 */
export async function loadDirectorProfile(input: { book: BookEntry; branch: string; language?: string }): Promise<{ profile: DirectorProfile; exists: boolean }> {
  const file = await createBrowserBookStore(input.book, input.branch).read(DIRECTOR_FILE);
  return file ? { profile: parseDirector(file.content, input.language), exists: true } : { profile: defaultDirector(input.language), exists: false };
}

export function renderDirectorFile(profile: DirectorProfile, existing: string | null): string {
  const generated = serializeDirector(profile);
  const match = FRONTMATTER.exec(generated)!;
  const managed = frontmatterOf(generated);
  const frontmatter = mergeManagedFrontmatter(frontmatterOf(existing), managed, DIRECTOR_MANAGED_KEYS);
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${match[2].trim()}\n`;
}

/** Save the director as one local commit, refusing to overwrite a concurrent change. */
export async function saveDirectorProfile(input: { book: BookEntry; branch: string; profile: DirectorProfile }): Promise<void> {
  const store = createBrowserBookStore(input.book, input.branch);
  const existing = await store.read(DIRECTOR_FILE);
  const content = renderDirectorFile(input.profile, existing?.content ?? null);
  if (existing?.content === content) return;
  await store.commit([{ path: DIRECTOR_FILE, content, expectedHash: existing?.hash ?? null }], `${existing ? "Update" : "Add"} director`);
}
