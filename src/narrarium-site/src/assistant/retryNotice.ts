import type { TFunction } from "i18next";

/** What the chat says while the Copilot waits to ask a model again: the number of the attempt that comes, how many attempts there are, and how long the wait is. */
export interface RetryNotice {
  attempt: number;
  of: number;
  waitMs: number;
}

type Listener = (notice: RetryNotice) => void;

/**
 * The notices are told to whoever listens to the signal of the request that is waiting, and to no one else: the chat that sent the request, and not another that is open, or a
 * call that runs in the background. The routed calls know their caller's signal and nothing else of the chat, so the signal is the address.
 */
const listeners = new WeakMap<AbortSignal, Set<Listener>>();

/** Listens to the notices of the calls made with `signal`; the result stops listening. */
export function listenToRetries(signal: AbortSignal, listener: Listener): () => void {
  let set = listeners.get(signal);
  if (!set) {
    set = new Set();
    listeners.set(signal, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Tells the listeners of `signal` that a wait begins. A listener that throws never breaks the call that is waiting. */
export function announceRetry(signal: AbortSignal | undefined, notice: RetryNotice): void {
  if (!signal) return;
  for (const listener of [...(listeners.get(signal) ?? [])]) {
    try {
      listener(notice);
    } catch {
      // A listener of the chat must never break a call.
    }
  }
}

/** The sentence of the chat for a notice, in the author's language: once for each retry, rounded to the second, never a countdown. */
export function retryNoticeText(notice: RetryNotice, t: TFunction): string {
  return t("autopilot.copilotRetry.notice", { seconds: Math.max(1, Math.round(notice.waitMs / 1000)), attempt: notice.attempt, of: notice.of });
}
