/** What the runtime uses of `navigator.locks`. */
export interface FakeLockManager {
  request<T>(name: string, callback: (lock: { name: string; mode: "exclusive" } | null) => Promise<T> | T): Promise<T>;
  request<T>(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal; steal?: boolean; mode?: "exclusive" | "shared" }, callback: (lock: { name: string; mode: "exclusive" } | null) => Promise<T> | T): Promise<T>;
  query(): Promise<{ held: Array<{ name: string; mode: string }>; pending: Array<{ name: string; mode: string }> }>;
}

interface Waiter {
  tab: string;
  start: () => void;
  fail: (reason: unknown) => void;
  detach: () => void;
}

/**
 * The lock manager of a browser, shared by its tabs: exclusive locks only, queued in the order asked.
 * `forTab` gives the `navigator.locks` a tab sees; `closeTab` is what the browser does when a tab goes away.
 */
export class FakeLockRegistry {
  private readonly holders = new Map<string, { tab: string; token: symbol }>();
  private readonly queues = new Map<string, Waiter[]>();

  forTab(tab: string): FakeLockManager {
    const request = (name: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
      const options = (typeof optionsOrCallback === "function" ? {} : optionsOrCallback ?? {}) as { ifAvailable?: boolean; signal?: AbortSignal };
      const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as (lock: { name: string; mode: "exclusive" } | null) => unknown;
      return new Promise<unknown>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        const start = () => {
          const token = Symbol(name);
          this.holders.set(name, { tab, token });
          Promise.resolve()
            .then(() => callback({ name, mode: "exclusive" }))
            .then(resolve, reject)
            .finally(() => {
              if (this.holders.get(name)?.token === token) {
                this.holders.delete(name);
                this.grantNext(name);
              }
            });
        };
        if (!this.holders.has(name)) {
          start();
          return;
        }
        if (options.ifAvailable) {
          Promise.resolve().then(() => callback(null)).then(resolve, reject);
          return;
        }
        const waiter: Waiter = {
          tab,
          start,
          fail: reject,
          detach: () => options.signal?.removeEventListener("abort", onAbort),
        };
        const onAbort = () => {
          const queue = this.queues.get(name) ?? [];
          this.queues.set(name, queue.filter((entry) => entry !== waiter));
          reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        this.queues.set(name, [...(this.queues.get(name) ?? []), waiter]);
      });
    };
    return {
      request: request as FakeLockManager["request"],
      query: async () => ({
        held: [...this.holders.keys()].map((name) => ({ name, mode: "exclusive" })),
        pending: [...this.queues.entries()].flatMap(([name, queue]) => queue.map(() => ({ name, mode: "exclusive" }))),
      }),
    };
  }

  private grantNext(name: string): void {
    const queue = this.queues.get(name) ?? [];
    const next = queue.shift();
    if (!queue.length) this.queues.delete(name);
    if (next) {
      next.detach();
      next.start();
    }
  }

  /** The tab that holds a lock, or null. */
  holderOf(name: string): string | null {
    return this.holders.get(name)?.tab ?? null;
  }

  held(): string[] {
    return [...this.holders.keys()];
  }

  pending(name: string): number {
    return (this.queues.get(name) ?? []).length;
  }

  /** The tab closed: its locks are released and its waiting requests disappear. */
  closeTab(tab: string): void {
    for (const [name, queue] of [...this.queues.entries()]) {
      const rest = queue.filter((waiter) => waiter.tab !== tab);
      for (const waiter of queue) if (waiter.tab === tab) waiter.detach();
      if (rest.length) this.queues.set(name, rest);
      else this.queues.delete(name);
    }
    for (const [name, holder] of [...this.holders.entries()]) {
      if (holder.tab !== tab) continue;
      this.holders.delete(name);
      this.grantNext(name);
    }
  }
}

/** Install a lock manager as `navigator.locks` for one test. */
export function installNavigatorLocks(manager: FakeLockManager | undefined): () => void {
  Object.defineProperty(navigator, "locks", { configurable: true, value: manager });
  return () => { delete (navigator as { locks?: unknown }).locks; };
}
