import assert from "node:assert/strict";
import test from "node:test";
import { isValidGitBranchName, parseBranchName, parseBranchOperation } from "../src/github/branchNameParser.ts";

test("parses English and Italian create branch requests with connectors and slashes", () => {
  assert.deepEqual(parseBranchName("create a branch called feature/new-ending"), { status: "ok", branchName: "feature/new-ending" });
  assert.deepEqual(parseBranchName("crea un branch chiamato fix/capitolo-7"), { status: "ok", branchName: "fix/capitolo-7" });
  assert.deepEqual(parseBranchName("crea il ramo feature/nuovo-finale"), { status: "ok", branchName: "feature/nuovo-finale" });
  assert.deepEqual(parseBranchName("crea il branch fix/epilogo"), { status: "ok", branchName: "fix/epilogo" });
});

test("parses English and Italian switch branch requests", () => {
  assert.deepEqual(parseBranchName("switch to branch feature/rewrite"), { status: "ok", branchName: "feature/rewrite" });
  assert.deepEqual(parseBranchName("cambia branch in feature/finale"), { status: "ok", branchName: "feature/finale" });
  assert.deepEqual(parseBranchName("vai sul branch release/uno"), { status: "ok", branchName: "release/uno" });
  assert.deepEqual(parseBranchName("passa al branch feature/due"), { status: "ok", branchName: "feature/due" });
  assert.deepEqual(parseBranchName("passa al ramo feature/tre"), { status: "ok", branchName: "feature/tre" });
});

test("supports quoted branch names", () => {
  assert.deepEqual(parseBranchName('create branch called "feature/new ending"'), { status: "invalid", branchName: "feature/new ending" });
  assert.deepEqual(parseBranchName("crea branch 'feature/nuovo-finale'"), { status: "ok", branchName: "feature/nuovo-finale" });
  assert.deepEqual(parseBranchName("crea il ramo “feature/finale”"), { status: "ok", branchName: "feature/finale" });
  assert.equal(parseBranchName('create branch "feature/malformed\'').status, "invalid");
  assert.equal(parseBranchName("crea il ramo ‘feature/malformato\"").status, "invalid");
});

test("asks for clarification for missing and ambiguous names", () => {
  assert.deepEqual(parseBranchName("create a branch"), { status: "missing" });
  assert.deepEqual(parseBranchName("switch branch to feature/a, not branch to feature/b"), { status: "ambiguous", candidates: ["feature/a", "feature/b"] });
  assert.deepEqual(parseBranchName('create branch "feature/a" or branch "feature/b"'), { status: "ambiguous", candidates: ["feature/a", "feature/b"] });
});

test("validates complete Git branch ref rules", () => {
  for (const name of ["feature/x", "release-1.2", "user/topic_name"]) assert.equal(isValidGitBranchName(name), true, name);
  for (const name of ["", "HEAD", "@", "-bad", ".hidden", "a/.hidden", "a..b", "a//b", "a@{b", "a.lock", "a/b.lock", "a~b", "a b", "a/", "/a", "a."]) assert.equal(isValidGitBranchName(name), false, name);
});

test("derives create intent from command syntax, not branch-name words", () => {
  assert.equal(parseBranchOperation("switch to branch feature/new-ending"), "switch");
  assert.equal(parseBranchOperation("create branch feature/ending"), "create");
  assert.equal(parseBranchOperation("crea il branch feature/nuovo-finale"), "create");
});
