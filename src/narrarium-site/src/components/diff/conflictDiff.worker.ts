import { computeConflictDiff, type ConflictDiff } from "@/components/diff/conflictDiff";

/** Compares the two versions of a file in conflict off the page's thread: see `conflictDiff.ts`. */

export interface ConflictDiffRequest { id: number; previous: string; next: string }
export type ConflictDiffResponse = { id: number; diff: ConflictDiff } | { id: number; error: string };

self.onmessage = (event: MessageEvent<ConflictDiffRequest>) => {
  const { id, previous, next } = event.data;
  try {
    self.postMessage({ id, diff: computeConflictDiff(previous, next) } satisfies ConflictDiffResponse);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies ConflictDiffResponse);
  }
};
