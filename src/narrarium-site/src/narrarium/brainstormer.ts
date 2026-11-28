import { parseDocument, stringify } from "yaml";
import { BRAINSTORMER_FILE, defaultBrainstormer, parseBrainstormer, serializeBrainstormer, type BrainstormerProfile } from "narrarium-engine";
import { mergeManagedFrontmatter } from "@/assistant/immediateMutation";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { sha256Text } from "@/repository/localRepository";
import type { BookEntry } from "@/types/settings";

/** Frontmatter keys owned by the Brainstormer editor; any other key the author added is preserved. */
export const BRAINSTORMER_MANAGED_KEYS = ["type", "id", "name", "language", "persona", "boldness", "priorities", "avoid"] as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function frontmatterOf(raw: string | null): Record<string, unknown> {
  const match = raw ? FRONTMATTER.exec(raw) : null;
  if (!match) return {};
  const parsed = parseDocument(match[1]).toJSON() as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/**
 * The book's Brainstormer (`brainstormer.md`) from the local working copy, or the defaults in the book language when it is not saved yet. `hash` is the version that was read
 * (`null` when the file does not exist): hand it back to `saveBrainstormerProfile` as the version being edited.
 */
export async function loadBrainstormerProfile(input: { book: BookEntry; branch: string; language?: string }): Promise<{ profile: BrainstormerProfile; exists: boolean; hash: string | null }> {
  const file = await createBrowserBookStore(input.book, input.branch).read(BRAINSTORMER_FILE);
  return file ? { profile: parseBrainstormer(file.content, input.language), exists: true, hash: file.hash } : { profile: defaultBrainstormer(input.language), exists: false, hash: null };
}

export function renderBrainstormerFile(profile: BrainstormerProfile, existing: string | null): string {
  const generated = serializeBrainstormer(profile);
  const match = FRONTMATTER.exec(generated)!;
  const managed = frontmatterOf(generated);
  const frontmatter = mergeManagedFrontmatter(frontmatterOf(existing), managed, BRAINSTORMER_MANAGED_KEYS);
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${match[2].trim()}\n`;
}

/**
 * Save the Brainstormer as one local commit, refusing to overwrite a concurrent change. `expectedHash` is the version the author edited (`loadBrainstormerProfile`, `null` when the file
 * did not exist): a change made since then is refused with a `BookConflictError`. Without it the version read now is replaced. Returns the hash of the saved version.
 */
export async function saveBrainstormerProfile(input: { book: BookEntry; branch: string; profile: BrainstormerProfile; expectedHash?: string | null }): Promise<{ hash: string | null }> {
  const store = createBrowserBookStore(input.book, input.branch);
  const existing = await store.read(BRAINSTORMER_FILE);
  const content = renderBrainstormerFile(input.profile, existing?.content ?? null);
  if (existing?.content === content) return { hash: existing.hash };
  const expectedHash = input.expectedHash === undefined ? existing?.hash ?? null : input.expectedHash;
  await store.commit([{ path: BRAINSTORMER_FILE, content, expectedHash }], `${existing ? "Update" : "Add"} brainstormer`);
  return { hash: await sha256Text(content) };
}
