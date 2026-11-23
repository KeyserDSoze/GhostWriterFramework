import { AiFallbackBlockedError, AiPromptTooLargeError, AiProviderError, AiReplyRejectedError, AiRoutingBudgetError, AiToolsRequiredError } from "narrarium-engine";

/** The attempts a candidate is given when the provider answers with a passing error: the first, and two more. */
export const QUIET_RETRY_ATTEMPTS = 3;
/** The waits before the second and before the third attempt: about a second, then about three. */
const BASE_WAITS_MS = [1_000, 3_000] as const;
/** Each wait varies by a quarter either way, so that many clients that failed together do not come back together. */
const JITTER = 0.25;
/** The longest wait. A provider that asks for more is not having a blip, and the Copilot does not sit on it. */
export const MAX_QUIET_WAIT_MS = 10_000;

/** Cloudflare's «A timeout occurred»: the origin did not answer within about 100 seconds. A deadline that ran out at the gateway, like one of the Copilot's own: asking again takes minutes again. */
const GATEWAY_DEADLINE_STATUS = 524;

/**
 * Whether an error of the engine's client is a passing one: a 408 or a 429, a server error (a flaky node gives a 500 as often as a 503, though the engine does not call a 500
 * passing, because the run that repeats an identical one stops), or a connection that could not be made or was lost while the model answered (the engine marks those).
 * Any other refusal is the request's, and waiting does not change it; and an error that ran out of time (the Copilot's own deadlines, or the 524 of a gateway that ran out of
 * patience), or that the output limit cut, is not a blip either.
 */
function isPassing(error: AiProviderError): boolean {
  if (error.timedOut === true || error.truncated === true) return false;
  const { status } = error;
  if (status !== undefined && status >= 400 && status < 500) return status === 408 || status === 429;
  if (status !== undefined && status >= 500 && status <= 599) return status !== GATEWAY_DEADLINE_STATUS;
  return error.transient === true;
}

/**
 * How long the Copilot waits before it asks the same candidate again, in milliseconds, or `null` when this failure is not one to ask again quietly: `attemptsMade` is how many
 * attempts the candidate has had. The wait is about a second after the first attempt and about three after the second, never sooner than the provider asked (`Retry-After`) and
 * never more than ten seconds, and none at all when the provider asks for more. A reply that was refused, a prompt that does not fit, the routing limits, the privacy policy and
 * «Tools only» are never failures of the moment, and neither is what is not an error of the engine's client (the author's Stop, a check of the Copilot's own).
 */
export function quietRetryWait(error: unknown, attemptsMade: number, random: () => number = Math.random): number | null {
  if (!(error instanceof AiProviderError)) return null;
  if (attemptsMade < 1 || attemptsMade >= QUIET_RETRY_ATTEMPTS) return null;
  if (error instanceof AiReplyRejectedError || error instanceof AiPromptTooLargeError || error instanceof AiRoutingBudgetError || error instanceof AiFallbackBlockedError || error instanceof AiToolsRequiredError) return null;
  if (!isPassing(error)) return null;
  const asked = typeof error.retryAfterMs === "number" && error.retryAfterMs > 0 ? error.retryAfterMs : 0;
  if (asked > MAX_QUIET_WAIT_MS) return null;
  const jittered = Math.round(BASE_WAITS_MS[attemptsMade - 1] * (1 - JITTER + random() * 2 * JITTER));
  return Math.min(MAX_QUIET_WAIT_MS, Math.max(jittered, asked));
}

/** Waits `milliseconds`, and ends at once, with the reason of the signal, when the author stops (or the account changes): the wait is never the one that decides. */
export function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
