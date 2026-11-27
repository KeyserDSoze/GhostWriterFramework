import { computeConflictDiff, type ConflictDiff } from "@/components/diff/conflictDiff";
import type { ConflictDiffRequest, ConflictDiffResponse } from "@/components/diff/conflictDiff.worker";

type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener">;

/**
 * Compares the versions of the files in conflict in one worker, one file after the other, for as long as the resolver is open (`close` ends it). Where
 * there is no worker (tests, an old browser) the comparison runs after the page has drawn, a file at a time.
 */
export function createConflictDiffer(createWorker: () => WorkerLike | null = () => (typeof Worker === "undefined" ? null : new Worker(new URL("./conflictDiff.worker.ts", import.meta.url), { type: "module" }))) {
  let worker: WorkerLike | null | undefined;
  let next = 0;
  const pending = new Map<number, { resolve: (diff: ConflictDiff) => void; reject: (error: Error) => void }>();
  const started = () => {
    if (worker !== undefined) return worker;
    try { worker = createWorker(); } catch { worker = null; }
    worker?.addEventListener("message", (event: Event) => {
      const response = (event as MessageEvent<ConflictDiffResponse>).data;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if ("error" in response) request.reject(new Error(response.error));
      else request.resolve(response.diff);
    });
    worker?.addEventListener("error", () => {
      for (const request of pending.values()) request.reject(new Error("The comparison of the two versions failed."));
      pending.clear();
      worker?.terminate();
      worker = null;
    });
    return worker;
  };
  return {
    compare(previous: string, nextText: string): Promise<ConflictDiff> {
      const running = started();
      if (!running) return new Promise((resolve) => { setTimeout(() => resolve(computeConflictDiff(previous, nextText)), 0); });
      const id = ++next;
      return new Promise<ConflictDiff>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        running.postMessage({ id, previous, next: nextText } satisfies ConflictDiffRequest);
      });
    },
    /** Ends the worker; a later comparison starts another one. */
    close() {
      for (const request of pending.values()) request.reject(new Error("closed"));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    },
  };
}

export type ConflictDiffer = ReturnType<typeof createConflictDiffer>;
