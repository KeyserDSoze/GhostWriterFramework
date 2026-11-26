import { OUTLINE_CHANGES_FILE, outlineJournalChange, type BookFileChange, type OutlineJournalAuthor, type OutlineJournalHints } from "narrarium-engine";
import { outlineFilesAt, type OutlineSource } from "@/outline/outlineSource";

/**
 * The journal of the Synopsis in the app (`outline/changes.yml`, the engine's `outline-journal.ts`): every series of edits the app saves in `outline/` carries,
 * in the same commit, a series of the journal that says what happened to each chapter and who did it. The Synopsis page, the Copilot and Brainstorming save
 * through here, so that no series is saved without it.
 */

export interface JournalMeta {
  by: OutlineJournalAuthor;
  /** The language of the book: the one-line summaries of the file are in it. */
  language?: string;
  note?: string;
  /** What the composer knows of the series (`ComposedOutlineEdits.created`, `.moved`). */
  hints?: OutlineJournalHints;
}

/** The files of a commit with the change of the journal added (none when no chapter's entry changes), from the files of the outline as they are before it. */
export async function withJournal(files: ReadonlyMap<string, { content: string; hash: string }>, changes: readonly BookFileChange[], meta: JournalMeta): Promise<BookFileChange[]> {
  const before = new Map([...files].map(([path, file]) => [path, file.content]));
  const current = files.get(OUTLINE_CHANGES_FILE);
  const journal = await outlineJournalChange({ journal: current ? { content: current.content, hash: current.hash } : null, before, changes, ...meta });
  return journal ? [...changes, journal] : [...changes];
}

/** Commit files of the outline with their series of the journal: the files the commit changes and the journal are read as they are now. */
export async function commitWithJournal(source: OutlineSource, changes: readonly BookFileChange[], message: string, meta: JournalMeta): Promise<void> {
  const paths = [...new Set([...changes.map((change) => change.path), OUTLINE_CHANGES_FILE])];
  const read = await outlineFilesAt(source, paths);
  const files = new Map<string, { content: string; hash: string }>();
  paths.forEach((path, index) => {
    const file = read[index];
    if (file) files.set(path, { content: file.content, hash: file.sha });
  });
  await source.commit(await withJournal(files, changes, meta), message);
}
