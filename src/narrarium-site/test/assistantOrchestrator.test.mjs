import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitNavigationPrompt } from "../src/assistant/orchestratorRules.ts";

test("does not intercept an editorial chapter question as navigation", () => {
  assert.equal(isExplicitNavigationPrompt("mi dici dell'ultimo capitolo cosa abbiamo scritto?"), false);
});

test("keeps explicit chapter navigation local", () => {
  assert.equal(isExplicitNavigationPrompt("vai al capitolo 3"), true);
});
