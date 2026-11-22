/**
 * One token renewal at a time per provider, across tabs and across functions.
 *
 * Microsoft rotates the refresh token on every renewal, and a second renewal that starts from a token the first one
 * just replaced is wasted at best. The Web Lock "narrarium-token-refresh:<provider>" makes every tab wait its turn
 * (the holder re-reads the connection once it has the lock, because another tab may have renewed meanwhile). Without
 * Web Locks, the renewals of this tab are at least queued one after the other.
 */
export type RefreshLockProvider = "google" | "microsoft";

const queues = new Map<string, Promise<void>>();

function inTabQueue<T>(name: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(name) ?? Promise.resolve();
  const next = previous.then(run);
  const tail = next.then(() => undefined, () => undefined);
  queues.set(name, tail);
  void tail.then(() => { if (queues.get(name) === tail) queues.delete(name); });
  return next;
}

export async function withTokenRefreshLock<T>(provider: RefreshLockProvider, run: () => Promise<T>): Promise<T> {
  const name = `narrarium-token-refresh:${provider}`;
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: { request?: unknown } }).locks;
  if (locks && typeof locks.request === "function") {
    let started = false;
    try {
      return await (navigator.locks as LockManager).request(name, { mode: "exclusive" }, () => { started = true; return run(); });
    } catch (error) {
      // A lock manager that refused to lock (an opaque origin, say) is not a failure of the job.
      if (started) throw error;
    }
  }
  return inTabQueue(name, run);
}

export function resetTokenRefreshLockForTests(): void {
  queues.clear();
}
