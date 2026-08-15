import assert from "node:assert/strict";
import test from "node:test";
import { isCreateFromResearchPrompt, resolveResearchTarget } from "../src/assistant/researchTarget.ts";

const files = [
  { path: "research/high-renaissance.md", slug: "high-renaissance", title: "High Renaissance" },
  { path: "research/renaissance-weapons.md", slug: "renaissance-weapons", title: "Renaissance Weapons" },
];

test("recognizes dedicated English and Italian create-from-research dispatch", () => {
  assert.equal(isCreateFromResearchPrompt("create a character from research/high-renaissance.md"), true);
  assert.equal(isCreateFromResearchPrompt("crea un personaggio partendo da questa ricerca"), true);
  assert.equal(isCreateFromResearchPrompt("create a character"), false);
  assert.equal(isCreateFromResearchPrompt("research a historical character"), false);
});

test("resolves an explicit research path exactly", () => {
  assert.deepEqual(resolveResearchTarget("create a character from research/high-renaissance.md", files), { status: "resolved", file: files[0] });
});

test("resolves current research only with route context", () => {
  assert.deepEqual(resolveResearchTarget("crea un luogo da questa ricerca", files, "renaissance-weapons"), { status: "resolved", file: files[1] });
  assert.equal(resolveResearchTarget("create from this research", files).status, "missing");
});

test("fails closed for ambiguous and missing research references", () => {
  assert.equal(resolveResearchTarget("create an item from Renaissance", files).status, "ambiguous");
  assert.equal(resolveResearchTarget("create an item from High", files).status, "missing");
  assert.equal(resolveResearchTarget("create an item from Victorian research", files).status, "missing");
});
