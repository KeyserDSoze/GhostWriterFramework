import type { AssistantFileUpdate } from "@/assistant/store";

export function pendingFileUpdates(updates: AssistantFileUpdate[], selectedPaths?: string[]): AssistantFileUpdate[] {
  const selected = selectedPaths?.length ? new Set(selectedPaths) : null;
  return updates.filter((update) => (update.status ?? "pending") !== "applied" && (!selected || selected.has(update.path)));
}

export function markFileUpdatesApplied(
  updates: AssistantFileUpdate[],
  results: Record<string, { previousContent: string | null; appliedHash: string }>,
): AssistantFileUpdate[] {
  return updates.map((update) => results[update.path]
    ? { ...update, status: "applied", previousContent: results[update.path].previousContent, appliedHash: results[update.path].appliedHash, error: undefined }
    : update);
}

export function markFileUpdatesFailed(updates: AssistantFileUpdate[], attemptedPaths: string[], error: string): AssistantFileUpdate[] {
  const attempted = new Set(attemptedPaths);
  return updates.map((update) => attempted.has(update.path) ? { ...update, status: "failed", error } : update);
}

export function markFileUpdatesUndone(updates: AssistantFileUpdate[], paths: string[]): AssistantFileUpdate[] {
  const undone = new Set(paths);
  return updates.map((update) => undone.has(update.path)
    ? { ...update, status: "pending", previousContent: undefined, appliedHash: undefined, error: undefined }
    : update);
}

export function fileUpdateCounts(updates: AssistantFileUpdate[]) {
  return updates.reduce((counts, update) => {
    counts[update.status ?? "pending"] += 1;
    return counts;
  }, { pending: 0, applied: 0, failed: 0 });
}

export function currentRevisionToken(expected: string | null | undefined, currentSha: string | null, currentContentHash: string | null): string | null {
  if (expected === currentSha) return currentSha;
  if (expected === currentContentHash) return currentContentHash;
  return currentSha;
}

export function fileRevisionMatches(expected: string | null | undefined, currentSha: string | null, currentContentHash: string | null): boolean {
  return expected === currentSha || expected === currentContentHash;
}
