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

test("candidate timeout advances fallback and aborts the stalled request", async () => {
  const calls = [];
  const result = await executeCompletionFallback({
    candidates,
    timeoutMs: 5,
    run: async (candidate, signal) => {
      calls.push(candidate.label);
      if (candidate.label === "two") return "fallback";
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return "unreachable";
    },
  });
  assert.equal(result, "fallback");
  assert.deepEqual(calls, ["one", "two"]);
});

test("total timeout exhaustion reports every candidate", async () => {
  await assert.rejects(executeCompletionFallback({
    candidates,
    timeoutMs: 2,
    run: async (_candidate, signal) => {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return "unreachable";
    },
  }), (error) => error instanceof CompletionFallbackError && error.failures.length === 2 && error.message.includes("timed out"));
});

test("user cancellation settles immediately even when a provider ignores AbortSignal", async () => {
  const controller = new AbortController();
  const pending = executeCompletionFallback({
    candidates,
    signal: controller.signal,
    timeoutMs: 1_000,
    run: async () => new Promise(() => undefined),
  });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, (error) => error instanceof Error && error.name === "AbortError");
});
