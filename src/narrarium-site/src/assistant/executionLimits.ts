export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

export class CandidateTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Provider request timed out after ${timeoutMs}ms.`);
    this.name = "CandidateTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function runWithCandidateTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<T> {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  let rejectParent: ((reason: unknown) => void) | undefined;
  const parentCancellation = new Promise<never>((_, reject) => { rejectParent = reject; });
  const abortFromParent = () => {
    const reason = parentSignal?.reason ?? new DOMException("Aborted", "AbortError");
    controller.abort(reason);
    rejectParent?.(reason);
  };
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PROVIDER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const request = run(controller.signal).catch((error) => {
      if (controller.signal.reason instanceof CandidateTimeoutError) throw controller.signal.reason;
      throw error;
    });
    return await Promise.race([
      request,
      parentCancellation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new CandidateTimeoutError(boundedTimeout);
          controller.abort(error);
          reject(error);
        }, boundedTimeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}
