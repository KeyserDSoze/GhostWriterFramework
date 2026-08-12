import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitNavigationPrompt, matchesToolKeyword } from "../src/assistant/orchestratorRules.ts";

test("does not intercept an editorial chapter question as navigation", () => {
  assert.equal(isExplicitNavigationPrompt("mi dici dell'ultimo capitolo cosa abbiamo scritto?"), false);
});

test("keeps explicit chapter navigation local", () => {
  assert.equal(isExplicitNavigationPrompt("vai al capitolo 3"), true);
});

test("does not match the pull-request abbreviation inside primo", () => {
  assert.equal(matchesToolKeyword("e sai dirmi se ti piace questo primo paragrafo?", "pr"), false);
  assert.equal(matchesToolKeyword("mostra le pr aperte", "pr"), true);
  assert.equal(matchesToolKeyword("list pull requests", "pull requests"), true);
});
