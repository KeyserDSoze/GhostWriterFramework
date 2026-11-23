/** The longest wait between two questions after failures in a row: a server that does not answer is asked again, more and more slowly, up to this. */
export const POLL_BACKOFF_MAX_MS = 15_000;

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Asks `tick` now, and again `ms` after each answer, for as long as it says there is more to ask (it returns `false` once the call has ended) and until
 * the returned function stops it. While the page is hidden nothing is asked: it asks again as soon as the page is shown. A question that fails is
 * asked again later, twice as late each time (at most `POLL_BACKOFF_MAX_MS`). Never two questions at once.
 */
export function pollWhileVisible(tick: () => Promise<boolean> | boolean, ms: number): () => void {
  let stopped = false;
  let busy = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (stopped || timer !== null || hidden()) return;
    const wait = failures === 0 ? ms : Math.min(POLL_BACKOFF_MAX_MS, ms * 2 ** failures);
    timer = setTimeout(run, wait);
  };

  const run = async () => {
    timer = null;
    if (stopped || busy || hidden()) return;
    busy = true;
    let again = true;
    try {
      again = (await tick()) !== false;
      failures = 0;
    } catch {
      failures += 1;
    }
    busy = false;
    if (!again) stop();
    else schedule();
  };

  const visible = () => {
    if (!stopped && !hidden() && timer === null && !busy) void run();
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visible);
  };

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visible);
  void run();
  return stop;
}
