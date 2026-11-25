import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../src/content/guides/${name}`, import.meta.url), "utf8");

test("the GitHub guide says, in both languages, how branches follow the person and how the automatic sync behaves", () => {
  for (const [name, words] of [
    ["github-sync.en.md", ["branch switcher", "A new branch is one action", "Publish it on GitHub now", "Branches follow you", "Branches and automatic sync", "Rename", "Forget", "Keep in sync", "Name of the branch", "## Automatic sync", "Off", "When the book opens and when you come back to it", "Also every 5 minutes", "nothing is overwritten", "Sync now", "costs nothing of GitHub's hourly limit", "One tab of the browser syncs"]],
    ["github-sync.it.md", ["selettore dei rami", "Un nuovo ramo è un'azione sola", "Pubblicalo subito su GitHub", "I rami ti seguono", "Rami e sincronizzazione automatica", "Rinomina", "Dimentica", "Tieni sincronizzato", "Nome del ramo", "## Sincronizzazione automatica", "Spenta", "Quando il libro si apre e quando ci torni", "Anche ogni 5 minuti", "non viene sovrascritto nulla", "Sincronizza ora", "non costa nulla del limite orario di GitHub", "Una sola scheda del browser sincronizza"]],
  ]) {
    const text = read(name);
    for (const word of words) assert.ok(text.includes(word), `${name}: ${word}`);
  }
});
