export function abortError(message = "The operation was aborted."): Error {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Combine an optional caller signal with a timeout; `dispose` must always be called. */
export function linkedSignal(parent: AbortSignal | undefined, timeoutMs?: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let expired = false;
  const onAbort = () => controller.abort(parent?.reason instanceof Error ? parent.reason : abortError());
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs && timeoutMs > 0
    ? setTimeout(() => {
      expired = true;
      controller.abort(new DOMException(`The request exceeded ${Math.round(timeoutMs / 1000)} seconds.`, "TimeoutError"));
    }, timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}
