import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildScriptLedgerDocument, SCRIPT_LEDGER_PATH } from "../dist/script-ledger.js";

const script = (title, body) => `---
type: script
id: script:001-opening:001-scene
chapter: chapter:001-opening
paragraph: paragraph:001-opening:001-scene
number: 1
title: ${title}
tags: []
secret_refs: []
character_refs: []
location_refs: []
item_refs: []
faction_refs: []
timeline_refs: []
reveal_policy: {}
---

${body}
`;

test("browser ledger builder overlays a pending script and emits the canonical document", () => {
  const files = [
    { path: "chapters/001-opening/chapter.md", content: "---\ntype: chapter\nid: chapter:001-opening\nnumber: 1\ntitle: Opening\n---\n" },
    { path: "secrets/door.md", content: "---\ntype: secret\nid: secret:door\ntitle: The Door\nfalse_beliefs: []\n---\n" },
    { path: "scripts/001-opening/001-scene.md", content: script("Old", "@scene_goal{Old goal}\n@pov{character:old}") },
  ];
  const pending = script("Imported", "@scene_goal{Open it}\n@pov{character:lyra}\n@secret{secret:door mode=reveal}\n@writer_truth{The door is a machine.}\n@reader_surface{The door opens.}\n@reveal{The mechanism is visible.}\n@end_secret{}\n@var{door.state=open}");
  const overlaid = files.map((file) => file.path.endsWith("001-scene.md") ? { ...file, content: pending } : file);

  const result = buildScriptLedgerDocument(overlaid, { generatedAt: "2026-08-15T00:00:00.000Z" });

  assert.equal(result.path, SCRIPT_LEDGER_PATH);
  assert.equal(result.ledger.scripts[0].title, "Imported");
  assert.equal(result.ledger.scripts[0].scene_goal, "Open it");
  assert.equal(result.ledger.secrets[0].canonical_secret.exists, true);
  assert.equal(result.ledger.variables.latest_by_name["door.state"].value, "open");
  assert.match(result.content, /<!-- narrarium:script-ledger:data -->/);
  assert.doesNotMatch(result.content, /Imported script paths/);
});

test("browser entry and its direct internal dependencies contain no Node imports", async () => {
  for (const file of ["script-ledger.js", "frontmatter.js", "schemas.js", "templates.js"]) {
    const source = await readFile(new URL(`../dist/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["']node:/, file);
  }
});
