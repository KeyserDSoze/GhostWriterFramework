import {
  AUTOPILOT_STATE_FILE,
  FROZEN_EDITS_MODES,
  chapterBodyDigest,
  chapterFilePath,
  parseChapterFreeze,
  parseMarkdown,
  sceneBodyDigest,
  type ChapterFreeze,
  type FrozenEditsMode,
} from "narrarium-engine";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { chapterTextFile } from "@/frozen/chapterText";
import { chapterNumberFromSlug } from "@/lib/chapterSlug";
import type { BookEntry } from "@/types/settings";

/** A file a proposal of the Copilot writes (`content`, `null` to delete it), or the new text of a scene (`body`, a rewrite of it). */
export interface ProposedFile {
  path: string;
  content?: string | null;
  body?: string;
}

/** A frozen chapter a proposal changes: its text (`changed`, the autopilot will notice it), or its freeze, which chapter.md loses (`unfrozen`). */
export interface FrozenProposalNotice {
  slug: string;
  number: number | null;
  kind: "changed" | "unfrozen";
}

function freezeOf(content: string): ChapterFreeze | null {
  try {
    return parseChapterFreeze(parseMarkdown(content).frontmatter.frozen).freeze ?? null;
  } catch {
    return null;
  }
}

/** The fingerprint the engine takes of a file of the chapter as the proposal leaves it, `null` when the proposal deletes it. */
function digestAfter(file: ProposedFile, name: string): string | null {
  const body = file.body ?? (typeof file.content === "string" ? parseMarkdown(file.content).body : null);
  if (body === null) return null;
  return name === "chapter.md" ? chapterBodyDigest(body) : sceneBodyDigest(body);
}

/**
 * The frozen chapters among those a proposal touches, and what it does to them, as the engine will tell it: a change of their text against their
 * record (a scene changed, added or deleted, the body of chapter.md), never of a frontmatter alone; chapter.md written without its record, or
 * deleted, unfreezes the chapter. `chapterFiles` are the chapter.md of the chapters touched, as they are now.
 */
export function frozenProposalNotices(files: readonly ProposedFile[], chapterFiles: ReadonlyArray<{ path: string; content: string }>): FrozenProposalNotice[] {
  const records = new Map<string, ChapterFreeze>();
  for (const file of chapterFiles) {
    const target = chapterTextFile(file.path);
    const freeze = target?.name === "chapter.md" ? freezeOf(file.content) : null;
    if (target && freeze) records.set(target.slug, freeze);
  }
  const found = new Map<string, FrozenProposalNotice["kind"]>();
  for (const file of files) {
    const target = chapterTextFile(file.path);
    const record = target ? records.get(target.slug) : undefined;
    if (!target || !record || found.get(target.slug) === "unfrozen") continue;
    if (target.name === "chapter.md" && file.content !== undefined && (file.content === null || !freezeOf(file.content))) {
      found.set(target.slug, "unfrozen");
      continue;
    }
    const before = target.name === "chapter.md" ? record.digest : record.files[target.name] ?? null;
    if (digestAfter(file, target.name) !== before) found.set(target.slug, "changed");
  }
  return [...found].sort(([left], [right]) => left.localeCompare(right)).map(([slug, kind]) => ({ slug, number: chapterNumberFromSlug(slug), kind }));
}

/** `options.frozenEdits` of the book's autopilot, read as the engine reads it; `ask`, the default, when there is no state or no choice in it. */
function frozenEditsOf(content: string | undefined): FrozenEditsMode {
  try {
    const value = (JSON.parse(content ?? "null") as { options?: { frozenEdits?: unknown } } | null)?.options?.frozenEdits;
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    return (FROZEN_EDITS_MODES as readonly string[]).includes(text) ? (text as FrozenEditsMode) : "ask";
  } catch {
    return "ask";
  }
}

/**
 * Reads, in the book's working copy, the chapter.md of the chapters a proposal touches and the autopilot's choice: what the panel says of the frozen
 * ones. A book without a working copy in this browser fails (`LocalWorkingCopyMissingError`), and the panel says nothing.
 */
export async function readFrozenProposal(book: BookEntry, branch: string, files: readonly ProposedFile[]): Promise<{ notices: FrozenProposalNotice[]; mode: FrozenEditsMode }> {
  const slugs = [...new Set(files.map((file) => chapterTextFile(file.path)?.slug).filter((slug): slug is string => Boolean(slug)))];
  if (!slugs.length) return { notices: [], mode: "ask" };
  const store = createBrowserBookStore(book, branch);
  const paths = [...slugs.map(chapterFilePath), AUTOPILOT_STATE_FILE];
  const read = store.readMany ? await store.readMany(paths) : (await Promise.all(paths.map((path) => store.read(path)))).filter((file) => file !== null);
  const state = read.find((file) => file.path === AUTOPILOT_STATE_FILE);
  return { notices: frozenProposalNotices(files, read.filter((file) => file !== state)), mode: frozenEditsOf(state?.content) };
}
