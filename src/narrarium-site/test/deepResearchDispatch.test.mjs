import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeepResearchRequest } from "../src/assistant/deepResearchRequest.ts";

test("parses English and Italian deep-research requests", () => {
  assert.deepEqual(resolveDeepResearchRequest("run deep research on Roman aqueduct construction"), { query: "Roman aqueduct construction", depth: "high", intents: ["auto"] });
  assert.deepEqual(resolveDeepResearchRequest("fai una ricerca approfondita su acquedotti romani"), { query: "acquedotti romani", depth: "high", intents: ["auto"] });
});

test("preserves explicit depth and research intents", () => {
  const result = resolveDeepResearchRequest("run quick research on elections using news and wikipedia");
  assert.equal(result?.depth, "low");
  assert.deepEqual(result?.intents, ["news", "encyclopedia"]);
});

test("rejects a research command without a topic", () => {
  assert.equal(resolveDeepResearchRequest("run deep research"), null);
});

test("preserves depth words that belong to the research topic", () => {
  assert.deepEqual(resolveDeepResearchRequest("run research on deep sea ecosystems"), { query: "deep sea ecosystems", depth: "medium", intents: ["auto"] });
  assert.deepEqual(resolveDeepResearchRequest("run research on the High Renaissance"), { query: "the High Renaissance", depth: "medium", intents: ["auto"] });
});
