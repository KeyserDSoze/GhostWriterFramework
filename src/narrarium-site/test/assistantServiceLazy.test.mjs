import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const SITE = new URL("../", import.meta.url);

// The assistant's service is the largest module of the Copilot: the bundle of the app is tight, and what the app shell imports statically is in every page. The service is opened by the
// Assistant panel and the evaluation style page, which are lazy, and by `narrarium/pipeline.ts` with import() when a score is asked for. Types are imported as types.

const sources = [];
for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
  if (!/\.(ts|tsx)$/.test(entry)) continue;
  sources.push({ path: `src/${entry}`, text: await readFile(new URL(`src/${entry}`, SITE), "utf8") });
}

test("only the lazy Assistant panel and the evaluation style page import the assistant's service statically", () => {
  const importers = sources
    .filter((source) => /^import\s+(?!type\b)(?:[^;]*?\bfrom\s+)?["'](?:@\/assistant\/service|\.\/service)["']/m.test(source.text) && (source.path.startsWith("src/assistant/") ? source.path !== "src/assistant/service.ts" : true))
    .map((source) => source.path)
    .sort();
  assert.deepEqual(importers, ["src/components/assistant/AssistantPanel.tsx", "src/pages/EvaluationStylePage.tsx"]);
});

test("the evaluation pipeline opens the service when a score is asked for", () => {
  const pipeline = sources.find((source) => source.path === "src/narrarium/pipeline.ts").text;
  assert.match(pipeline, /import\("@\/assistant\/service"\)/);
  assert.equal(pipeline.match(/await evaluationScoring\(\)/g)?.length, 2);
});
