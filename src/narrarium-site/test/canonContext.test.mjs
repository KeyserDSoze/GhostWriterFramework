import assert from "node:assert/strict";
import test from "node:test";
import { selectMentionedCanonFiles } from "../src/assistant/canonContext.ts";

test("selects canon entries mentioned as complete names without matching substrings", () => {
  /** @type {import("../src/assistant/canonContext.ts").CanonContextCandidate[]} */
  const candidates = [
    { path: "characters/lyra-vale.md", name: "Lyra Vale", section: "characters" },
    { path: "characters/lyra.md", name: "Lyra", section: "characters" },
    { path: "locations/the-grotto.md", name: "The Grotto", section: "locations" },
  ];
  const selected = selectMentionedCanonFiles(candidates, "Lyra Vale waits at The Grotto.");

  assert.deepEqual(selected.map((entry) => entry.path), ["characters/lyra-vale.md", "locations/the-grotto.md"]);
});

test("caps related canon entries", () => {
  /** @type {import("../src/assistant/canonContext.ts").CanonContextCandidate[]} */
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    path: `characters/character-${index}.md`,
    name: `Character ${index}`,
    section: "characters",
  }));
  assert.equal(selectMentionedCanonFiles(candidates, candidates.map((entry) => entry.name).join(" "), 5).length, 5);
});
