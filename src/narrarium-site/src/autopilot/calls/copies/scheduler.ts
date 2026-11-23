import type { CallsCopier } from "./copier";
import { COPY_RETRY, type CopyTargetKind } from "./types";

export interface CopyScheduler {
  /** Looks for what is to copy and copies it: `force` ignores the waiting time of the items (the device is back online, a token was renewed). */
  kick(options?: { force?: boolean; scan?: boolean }): Promise<void>;
  /** A task of a book just finished: it is queued and copied. */
  taskFinished(bookId: string, taskId: string): Promise<void>;
  stop(): void;
}

export interface CopySchedulerDeps {
  copier: CallsCopier;
  /** The books that have a target, as the settings say now. */
  targets: () => ReadonlyArray<{ bookId: string; kind: CopyTargetKind }>;
  /** The window: `online` is listened to. */
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Called when a connection's token was renewed; returns what stops it. */
  subscribeTokenRefresh?: (listener: () => void) => () => void;
  intervalMs?: number;
}

/**
 * Starts the copying: when the page starts, when the device comes back online, when a token is renewed, when a task finishes, and every five minutes.
 * It runs on its own, apart from any run and any page; a failure of a copy is the copier's to queue, never the scheduler's to raise.
 */
export function startCopyScheduler(deps: CopySchedulerDeps): CopyScheduler {
  let stopped = false;
  let pending: { force: boolean; scan: boolean } | null = null;
  let active: Promise<void> | null = null;

  const pass = async (force: boolean, scan: boolean): Promise<void> => {
    const targets = deps.targets();
    if (scan) await Promise.all(targets.map(({ bookId, kind }) => deps.copier.scan(bookId, kind).catch(() => 0)));
    await deps.copier.runAll(targets, { force });
  };

  const kick = (options: { force?: boolean; scan?: boolean } = {}): Promise<void> => {
    if (stopped) return Promise.resolve();
    const request = { force: options.force === true, scan: options.scan !== false };
    if (active) {
      pending = { force: Boolean(pending?.force) || request.force, scan: Boolean(pending?.scan) || request.scan };
      return active;
    }
    active = (async () => {
      let next: { force: boolean; scan: boolean } | null = request;
      while (next && !stopped) {
        pending = null;
        try { await pass(next.force, next.scan); } catch { /* the copier queues its own failures */ }
        next = pending;
      }
    })().finally(() => { active = null; });
    return active;
  };

  const online = () => { void kick({ force: true }); };
  deps.events?.addEventListener("online", online);
  const unsubscribe = deps.subscribeTokenRefresh?.(() => { void kick({ force: true }); });
  const timer = setInterval(() => { void kick({ scan: true }); }, deps.intervalMs ?? COPY_RETRY.intervalMs);
  void kick();

  return {
    kick,
    async taskFinished(bookId, taskId) {
      const target = deps.targets().find((entry) => entry.bookId === bookId);
      if (!target) return;
      await deps.copier.enqueue(bookId, target.kind, taskId).catch(() => undefined);
      await kick({ scan: false });
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      deps.events?.removeEventListener("online", online);
      unsubscribe?.();
    },
  };
}
