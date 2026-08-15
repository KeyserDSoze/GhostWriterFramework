import assert from "node:assert/strict";
import test from "node:test";
import { executeMediaFallback } from "../src/assistant/mediaFallback.ts";

const ai = (model) => ({ integration: { id: model }, model });
const browser = { browser: true };

test("runs AI fallbacks in configured order", async () => {
  const calls = [];
  const result = await executeMediaFallback({ candidates: [ai("one"), ai("two")], runAi: async (candidate) => { calls.push(candidate.model); if (candidate.model === "one") throw new Error("failed"); return "ok"; } });
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["one", "two"]);
});

test("uses browser only where explicitly configured, including as primary", async () => {
  let browserCalls = 0;
  const fallback = await executeMediaFallback({ candidates: [ai("one"), browser], runAi: async () => { throw new Error("failed"); }, runBrowser: async () => { browserCalls += 1; return "browser"; } });
  const primary = await executeMediaFallback({ candidates: [browser, ai("one")], runAi: async () => "ai", runBrowser: async () => { browserCalls += 1; return "browser"; } });
  assert.equal(fallback, "browser");
  assert.equal(primary, "browser");
  assert.equal(browserCalls, 2);
  const afterBrowserFailure = await executeMediaFallback({ candidates: [browser, ai("two")], runAi: async () => "ai", runBrowser: async () => { throw new Error("browser failed"); } });
  assert.equal(afterBrowserFailure, "ai");
});

test("reports exhaustion without injecting browser", async () => {
  let browserCalls = 0;
  await assert.rejects(executeMediaFallback({ candidates: [ai("one")], runAi: async () => { throw new Error("exhausted"); }, runBrowser: async () => { browserCalls += 1; return "browser"; } }), /exhausted/);
  assert.equal(browserCalls, 0);
});

test("abort stops fallback", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(executeMediaFallback({ candidates: [ai("one"), ai("two"), browser], signal: controller.signal, runAi: async (candidate) => { calls.push(candidate.model); controller.abort(); throw new Error("failed"); }, runBrowser: async () => "browser" }), (error) => error instanceof Error && error.name === "AbortError");
  assert.deepEqual(calls, ["one"]);
  await assert.rejects(executeMediaFallback({ candidates: [ai("one"), ai("two")], runAi: async () => { throw new DOMException("stopped", "AbortError"); } }), (error) => error instanceof Error && error.name === "AbortError");
});
