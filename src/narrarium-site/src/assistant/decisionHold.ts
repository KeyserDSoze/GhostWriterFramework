import { BIBLE_DECISIONS_FILE, decisionConflictText, decisionConflicts, emptyBibleDecisions, lockedDecisions, readBibleDecisions, type BibleDecisions, type ChangedFile, type DecisionConflict } from "narrarium-engine";
import { readFileWithSha } from "@/github/githubClient";
import { optionalRepositoryRead } from "@/repository/repositoryError";
import type { BookEntry } from "@/types/settings";

/**
 * The lock of the decisions on what an assistant applies. A locked decision of the book (`bible/decisions.md`) binds every agent; for the changes the author is asked to apply (a
 * proposal of the Copilot, of Brainstorming, of a page) it is checked here, without a model, against the files the change would write: what contradicts a locked decision is held,
 * and the author decides (apply it anyway, or leave it) instead of the change being applied.
 */

/**
 * The decisions of the book as the working copy has them now (none when the file is not there, or cannot be read: the change itself says what is wrong with the working copy
 * when it is written). `read` says how a file is read where the caller already has a way (the Synopsis page's source).
 */
export async function loadBookDecisions(input: { token: string; book: BookEntry; branch: string; signal?: AbortSignal; read?: (path: string) => Promise<string | null> }): Promise<BibleDecisions> {
  try {
    const content = input.read
      ? await input.read(BIBLE_DECISIONS_FILE)
      : (await optionalRepositoryRead(() => readFileWithSha(input.token, input.book.owner, input.book.repo, input.branch, BIBLE_DECISIONS_FILE, input.signal)))?.content ?? null;
    return content === null ? emptyBibleDecisions() : readBibleDecisions(content).value;
  } catch {
    input.signal?.throwIfAborted();
    return emptyBibleDecisions();
  }
}

/** What of a change goes against a locked decision, given what the files hold now (`before`) and would hold after. Nothing is read when no decision is locked. */
export async function conflictsOfChanges(input: { token: string; book: BookEntry; branch: string; changes: readonly ChangedFile[]; signal?: AbortSignal; read?: (path: string) => Promise<string | null> }): Promise<DecisionConflict[]> {
  const decisions = await loadBookDecisions(input);
  if (!lockedDecisions(decisions).length) return [];
  return decisionConflicts(input.changes, decisions);
}

/** The words that tell the author what is held, in the language of the interface, one line for each conflict. */
export function heldLines(conflicts: readonly DecisionConflict[], language: string): string[] {
  return conflicts.map((conflict) => decisionConflictText(conflict, language));
}
