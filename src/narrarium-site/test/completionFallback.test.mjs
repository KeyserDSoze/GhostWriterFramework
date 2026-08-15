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
