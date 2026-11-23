import { describe, expect, it } from "vitest";
import { AiFallbackBlockedError, AiPromptTooLargeError, AiProviderError, AiReplyRejectedError, AiRoutingBudgetError, AiToolsRequiredError } from "narrarium-engine";
import { MAX_QUIET_WAIT_MS, QUIET_RETRY_ATTEMPTS, quietRetryWait } from "@/assistant/quietRetry";

const middle = () => 0.5;
const lowest = () => 0;
const highest = () => 1;
const failure = (status: number | undefined, details: ConstructorParameters<typeof AiProviderError>[3] = {}) => new AiProviderError(`openai model-a: ${status ?? "no status"}`, status, true, details);

describe("the quiet retry of a passing error: the wait before the next attempt of the same candidate", () => {
  it("gives a candidate three attempts: the first, and two more after about one second and about three", () => {
    expect(QUIET_RETRY_ATTEMPTS).toBe(3);
    const passing = failure(503, { transient: true });
    expect(quietRetryWait(passing, 1, middle)).toBe(1_000);
    expect(quietRetryWait(passing, 2, middle)).toBe(3_000);
    expect(quietRetryWait(passing, 3, middle)).toBeNull();
    expect(quietRetryWait(passing, 4, middle)).toBeNull();
  });

  it("varies each wait by a quarter either way, so that many clients do not come back together", () => {
    const passing = failure(503, { transient: true });
    expect([quietRetryWait(passing, 1, lowest), quietRetryWait(passing, 1, highest)]).toEqual([750, 1_250]);
    expect([quietRetryWait(passing, 2, lowest), quietRetryWait(passing, 2, highest)]).toEqual([2_250, 3_750]);
  });

  it("uses the jitter of the browser when none is given, always within the bounds", () => {
    const passing = failure(503, { transient: true });
    for (let index = 0; index < 50; index += 1) {
      const wait = quietRetryWait(passing, 1) as number;
      expect(wait).toBeGreaterThanOrEqual(750);
      expect(wait).toBeLessThanOrEqual(1_250);
    }
  });

  it("is never sooner than what the provider asked, up to ten seconds", () => {
    expect(quietRetryWait(failure(429, { transient: true, retryAfterMs: 2_000 }), 1, middle)).toBe(2_000);
    expect(quietRetryWait(failure(503, { transient: true, retryAfterMs: 500 }), 1, middle), "a shorter wish than the Copilot's own is not what it waits for").toBe(1_000);
    expect(quietRetryWait(failure(503, { transient: true, retryAfterMs: 5_000 }), 2, middle)).toBe(5_000);
    expect(MAX_QUIET_WAIT_MS).toBe(10_000);
    expect(quietRetryWait(failure(429, { transient: true, retryAfterMs: 10_000 }), 1, middle)).toBe(10_000);
  });

  it("is no quiet retry at all when the provider asks for more than ten seconds: that is not a blip", () => {
    expect(quietRetryWait(failure(429, { transient: true, retryAfterMs: 10_001 }), 1, middle)).toBeNull();
    expect(quietRetryWait(failure(503, { transient: true, retryAfterMs: 120_000 }), 1, middle)).toBeNull();
  });

  describe("what counts as a passing error", () => {
    it.each([408, 429, 502, 503, 504])("%s, which the engine marks as depending on the moment", (status) => {
      expect(quietRetryWait(failure(status, { transient: true }), 1, middle)).toBe(1_000);
    });

    it.each([500, 501, 507, 520, 522, 523, 599])("%s: a server error of any kind is what a flaky node gives, though the engine does not call it passing", (status) => {
      expect(quietRetryWait(failure(status), 1, middle)).toBe(1_000);
    });

    it("but not a 524, the timeout of a gateway that waited for about 100 seconds: asking again would take as long again", () => {
      expect(quietRetryWait(failure(524), 1, middle)).toBeNull();
      expect(quietRetryWait(failure(524, { transient: true }), 1, middle)).toBeNull();
    });

    it("a connection that could not be made, or that was lost while the model answered: they carry no status, and the engine marks them", () => {
      expect(quietRetryWait(failure(undefined, { transient: true }), 1, middle)).toBe(1_000);
    });
  });

  describe("what is never tried again", () => {
    it.each([400, 401, 403, 404, 409, 410, 413, 422])("%s: the request is refused, and waiting does not change it", (status) => {
      expect(quietRetryWait(failure(status), 1, middle)).toBeNull();
    });

    it("a 4xx is not tried again whatever else the error says", () => {
      expect(quietRetryWait(failure(400, { transient: true }), 1, middle)).toBeNull();
      expect(quietRetryWait(failure(422, { transient: true, retryAfterMs: 1_000 }), 1, middle)).toBeNull();
    });

    it("an error that ran out of time: after minutes, to ask again is no blip", () => {
      expect(quietRetryWait(failure(undefined, { transient: true, timedOut: true, timeout: { phase: "start", ms: 600_000 } }), 1, middle)).toBeNull();
      expect(quietRetryWait(failure(undefined, { transient: true, timedOut: true, timeout: { phase: "idle", ms: 30_000 } }), 1, middle)).toBeNull();
      expect(quietRetryWait(failure(undefined, { transient: true, timedOut: true, timeout: { phase: "total", ms: 40_000 } }), 1, middle)).toBeNull();
      expect(quietRetryWait(failure(504, { transient: true, timedOut: true }), 1, middle)).toBeNull();
    });

    it("a reply that was refused, a prompt that does not fit, a limit of the routing, a policy that blocks the fallback, and «Tools only» with no model for it", () => {
      expect(quietRetryWait(new AiReplyRejectedError("the reply was empty", { transient: true }), 1, middle)).toBeNull();
      expect(quietRetryWait(new AiPromptTooLargeError("too large", 100, 50), 1, middle)).toBeNull();
      expect(quietRetryWait(new AiRoutingBudgetError("over the budget"), 1, middle)).toBeNull();
      expect(quietRetryWait(new AiFallbackBlockedError("blocked"), 1, middle)).toBeNull();
      expect(quietRetryWait(new AiToolsRequiredError("Tools only is on", ["model-a"]), 1, middle)).toBeNull();
    });

    it("a reply that the output limit cut, and a content filter: the provider answered, and would answer the same", () => {
      expect(quietRetryWait(failure(undefined, { truncated: true }), 1, middle)).toBeNull();
      expect(quietRetryWait(failure(undefined, { truncated: true, reasoningOnly: true }), 1, middle)).toBeNull();
      expect(quietRetryWait(new AiProviderError("openai model-a: the provider filtered the reply content (content_filter).", undefined, false), 1, middle)).toBeNull();
    });

    it("a failure that no status and no flag says is a passing one", () => {
      expect(quietRetryWait(failure(undefined), 1, middle)).toBeNull();
    });

    it("whatever is not an error of the engine's client: the author's Stop, an error of the Copilot's own, a text", () => {
      expect(quietRetryWait(new DOMException("Stopped by the author.", "AbortError"), 1, middle)).toBeNull();
      expect(quietRetryWait(new Error("invalid score"), 1, middle)).toBeNull();
      expect(quietRetryWait("boom", 1, middle)).toBeNull();
      expect(quietRetryWait(undefined, 1, middle)).toBeNull();
    });
  });
});
