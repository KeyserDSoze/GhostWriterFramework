import assert from "node:assert/strict";
import test from "node:test";
import { CompletionFallbackError, executeCompletionFallback } from "../src/assistant/completionFallback.ts";

const candidates = [{ label: "one" }, { label: "two" }];

test("empty and filtered primaries fall through to a valid candidate", async () => {
  for (const invalid of ["", "   ", "[Content filtered]"]) {
    const calls = [];
    const result = await executeCompletionFallback({ candidates, run: async (candidate) => { calls.push(candidate.label); return candidate.label === "one" ? invalid : "valid fallback"; } });
    assert.equal(result, "valid fallback");
    assert.deepEqual(calls, ["one", "two"]);
  }
});

test("partial streaming output is reset before fallback", async () => {
  const resets = [];
  let partial = "";
  const result = await executeCompletionFallback({ candidates, resetPartial: () => { partial = ""; resets.push("reset"); }, run: async (candidate) => { if (candidate.label === "one") { partial = "partial"; throw new Error("stream failed"); } partial = "complete"; return partial; } });
  assert.equal(result, "complete");
  assert.equal(partial, "complete");
  assert.ok(resets.length >= 3);
});

test("total exhaustion preserves sanitized candidate diagnostics", async () => {
  const unsafe = [{ label: "one\nsecret=label-secret" }, { label: "two" }];
  await assert.rejects(executeCompletionFallback({ candidates: unsafe, run: async (candidate) => { if (candidate.label.startsWith("one")) throw new Error("Authorization: Bearer sk-live timeout"); return ""; } }), (error) => error instanceof CompletionFallbackError && error.failures.length === 2 && error.message.includes("[redacted]") && !error.message.includes("sk-live") && !error.message.includes("label-secret") && !error.message.includes("\n"));
});

test("abort prevents fallback", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(executeCompletionFallback({ candidates, signal: controller.signal, run: async (candidate) => { calls.push(candidate.label); controller.abort(); throw new DOMException("stopped", "AbortError"); } }), (error) => error instanceof Error && error.name === "AbortError");
  assert.deepEqual(calls, ["one"]);
});

test("provider AbortError advances fallback when the operation remains active", async () => {
  const calls = [];
  const result = await executeCompletionFallback({ candidates, run: async (candidate) => {
    calls.push(candidate.label);
    if (candidate.label === "one") throw new DOMException("provider aborted", "AbortError");
    return "fallback";
  } });
  assert.equal(result, "fallback");
  assert.deepEqual(calls, ["one", "two"]);
});

test("a slow candidate is never cut by a timer of the loop: the deadlines of a request are the client's", async () => {
  const controller = new AbortController();
  const seen = [];
  const result = await executeCompletionFallback({
    candidates,
    signal: controller.signal,
    run: async (candidate, signal, index) => {
      seen.push({ label: candidate.label, index, same: signal === controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(signal.aborted, false);
      return "slow and good";
    },
  });
  assert.equal(result, "slow and good");
  assert.deepEqual(seen, [{ label: "one", index: 0, same: true }]);
});

test("a call that nobody can stop gets a signal that never aborts", async () => {
  const received = [];
  await executeCompletionFallback({ candidates, run: async (_candidate, signal) => { received.push(signal); return "fine"; } });
  assert.equal(received.length, 1);
  assert.equal(received[0].aborted, false);
});

test("the candidates after the first are not asked once the routing time says it is used up, and the error says why", async () => {
  const asked = [];
  const stops = [];
  await assert.rejects(executeCompletionFallback({
    candidates: [{ label: "one" }, { label: "two" }, { label: "three" }],
    stopBefore: (candidate, index) => { stops.push(`${candidate.label}:${index}`); return index === 1 ? "Fallbacks were not tried: the total routing time (maxTotalDurationMs, 60 s) was used up." : undefined; },
    run: async (candidate) => { asked.push(candidate.label); throw new Error("busy"); },
  }), (error) => {
    assert.ok(error instanceof CompletionFallbackError);
    assert.deepEqual(error.failures, ["one: busy"]);
    assert.deepEqual(error.notes, ["Fallbacks were not tried: the total routing time (maxTotalDurationMs, 60 s) was used up."]);
    assert.equal(error.message, "All configured completion candidates failed: one: busy. Fallbacks were not tried: the total routing time (maxTotalDurationMs, 60 s) was used up.");
    return true;
  });
  assert.deepEqual(asked, ["one"]);
  assert.deepEqual(stops, ["two:1"], "the first candidate is never asked about: it runs whatever the total");
});

test("a failure is reported in the sentence the client wrote when it wrote one, whole up to 600 characters, and as label and message otherwise (240)", async () => {
  const sentence = `openai muse-glimmer-30b: the provider did not start answering within 30 s (${"the Provider timeout of the integration ".repeat(8)})`;
  assert.ok(sentence.length > 240 && sentence.length < 600);
  const long = "x".repeat(500);
  await assert.rejects(executeCompletionFallback({
    candidates,
    describe: (candidate) => (candidate.label === "one" ? sentence : undefined),
    run: async (candidate) => { throw new Error(candidate.label === "one" ? "ignored: the client's sentence is used" : long); },
  }), (error) => {
    assert.ok(error instanceof CompletionFallbackError);
    assert.equal(error.failures[0], sentence);
    assert.equal(error.failures[1], `two: ${"x".repeat(240)}`);
    return true;
  });
});

test("exhaustion keeps the kind of each failure, never its message", async () => {
  await assert.rejects(executeCompletionFallback({ candidates, run: async (candidate) => {
    if (candidate.label === "one") throw Object.assign(new Error("429 Bearer sk-live rate limited"), { name: "RateLimitError", status: 429 });
    return "";
  } }), (error) => {
    assert.ok(error instanceof CompletionFallbackError);
    assert.deepEqual(error.causes, [{ name: "RateLimitError", status: 429 }, { name: "Error" }]);
    assert.ok(!JSON.stringify(error.causes).includes("sk-live"));
    return true;
  });
});

test("user cancellation settles immediately even when a provider ignores AbortSignal", async () => {
  const controller = new AbortController();
  const pending = executeCompletionFallback({
    candidates,
    signal: controller.signal,
    run: async () => new Promise(() => undefined),
  });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, (error) => error instanceof Error && error.name === "AbortError");
});
