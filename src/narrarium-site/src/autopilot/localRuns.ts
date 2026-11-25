/**
 * The books whose autopilot runs in this tab, as the runtime says them: what the update of the app and a page that cannot load must know before
 * they reload the document, which would stop those runs. Small on purpose, and free of the runtime: the entry of the app reads it.
 */

let running: readonly string[] = [];
const listeners = new Set<() => void>();

/** The books whose autopilot runs in this tab now (none before the runtime is loaded). */
export function localRuns(): readonly string[] {
  return running;
}

/** What the runtime says when a run of this tab starts or ends: the books that run. */
export function setLocalRuns(bookIds: readonly string[]): void {
  const next = [...new Set(bookIds)].sort();
  if (next.length === running.length && next.every((id, index) => id === running[index])) return;
  running = next;
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` whenever the runs of this tab change. Returns what stops it. */
export function subscribeLocalRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
