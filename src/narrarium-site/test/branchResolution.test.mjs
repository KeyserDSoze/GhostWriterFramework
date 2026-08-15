import assert from "node:assert/strict";
import test from "node:test";
import { branchIsReady, resolveAuthoritativeBranch } from "../src/github/branchRules.ts";

test("branch priority is active, working, personal, loaded, default, fallback", () => {
  assert.deepEqual(resolveAuthoritativeBranch({ activeBranch: "release", workingBranch: "work", loadedBranch: "loaded", defaultBranch: "main", userEmail: "a@example.com" }).source, "active");
  assert.equal(resolveAuthoritativeBranch({ workingBranch: "work", loadedBranch: "loaded", defaultBranch: "main", userEmail: "a@example.com" }).branch, "work");
  assert.match(resolveAuthoritativeBranch({ loadedBranch: "loaded", defaultBranch: "main", userEmail: "a@example.com" }).branch, /^dev-/);
  assert.equal(resolveAuthoritativeBranch({ loadedBranch: "loaded", defaultBranch: "main" }).branch, "loaded");
  assert.equal(resolveAuthoritativeBranch({ defaultBranch: "main" }).branch, "main");
  assert.equal(resolveAuthoritativeBranch({}).branch, "main");
});

test("structure must match the authoritative branch", () => {
  assert.equal(resolveAuthoritativeBranch({ activeBranch: "draft", loadedBranch: "main" }).structureMatches, false);
  assert.equal(resolveAuthoritativeBranch({ activeBranch: "draft", loadedBranch: "draft" }).structureMatches, true);
});

test("personal branch writes stay blocked while creating or after failure", () => {
  const resolution = resolveAuthoritativeBranch({ userEmail: "writer@example.com", loadedBranch: "main", defaultBranch: "main" });
  assert.equal(branchIsReady({ resolution, ensuring: true, error: null, personalBranchRecorded: false }), false);
  assert.equal(branchIsReady({ resolution, ensuring: false, error: "creation failed", personalBranchRecorded: false }), false);
  const matching = resolveAuthoritativeBranch({ userEmail: "writer@example.com", workingBranch: resolution.branch, loadedBranch: resolution.branch, defaultBranch: "main" });
  assert.equal(branchIsReady({ resolution: matching, ensuring: false, error: null, personalBranchRecorded: true }), true);
});

test("account switch derives a different personal branch and invalidates old structure", () => {
  const first = resolveAuthoritativeBranch({ userEmail: "first@example.com", loadedBranch: "main" });
  const second = resolveAuthoritativeBranch({ userEmail: "second@example.com", loadedBranch: first.branch });
  assert.notEqual(first.branch, second.branch);
  assert.equal(second.structureMatches, false);
});
