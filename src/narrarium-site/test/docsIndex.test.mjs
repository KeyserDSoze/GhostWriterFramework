import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appDocEntries } from "../src/lib/appDocs.ts";
import { docEntries, docMarkdown } from "../src/lib/generated-docs.ts";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LIB = path.join(SITE, "src", "lib");
const OUTPUTS = ["generated-docs.ts", "generated-mcp-book-tools.ts", "generated-public-meta.ts", "public-doc-routes.json"];
const LANGUAGES = ["en", "it"];

/** Run the generator, writing its files into `out` (the paths inside them stay the ones of `src/lib`). */
function generate(out) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SITE, "scripts", "generate-docs.mjs")], { cwd: SITE, env: { ...process.env, NARRARIUM_DOCS_OUT: out }, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`generate-docs exited with ${code}`))));
  });
}

/** The lines of a document long enough to be its own text, leaving out the ones the index keeps on purpose (the title and the summary). */
function bodyLines(markdown, entry) {
  const kept = Object.values(entry.translations).flatMap((translation) => [translation.title, translation.summary]).join("\n");
  return markdown.split("\n").map((line) => line.trim()).filter((line) => line.length >= 60 && !kept.includes(line.replace(/\s+/g, " ")));
}

const everyEntry = () => [...appDocEntries, ...docEntries];

test("the index carries the titles and the summaries, never the text of a document", async () => {
  const index = await readFile(path.join(LIB, "generated-docs.ts"), "utf8");
  assert.ok(Buffer.byteLength(index) < 80_000, `the index is small (${Buffer.byteLength(index)} bytes; it was 475 KB with every text in it)`);
  assert.doesNotMatch(index, /\bmarkdown\s*:/, "no entry has a markdown field");
  assert.doesNotMatch(index, /const markdown\d+ =/, "no text is kept in a constant");
  let checked = 0;
  for (const entry of docEntries) {
    for (const language of LANGUAGES) {
      const source = await readFile(path.join(ROOT, entry.translations[language].sourcePath), "utf8");
      for (const line of bodyLines(source, entry)) {
        checked += 1;
        assert.ok(!index.includes(line), `${entry.slug} (${language}): "${line.slice(0, 60)}…" is in the index`);
      }
    }
  }
  assert.ok(checked > 500, `the check reads the documents (saw ${checked} lines)`);
});

test("the index of the app's guides carries their titles and summaries, never their text", async () => {
  const guides = await readFile(path.join(LIB, "appDocs.ts"), "utf8");
  assert.ok(Buffer.byteLength(guides) < 20_000, `the guides' index is small (${Buffer.byteLength(guides)} bytes; it was 105 KB with every guide in it)`);
  let checked = 0;
  for (const entry of appDocEntries) {
    for (const language of LANGUAGES) {
      const source = await readFile(path.join(ROOT, entry.translations[language].sourcePath), "utf8");
      for (const line of bodyLines(source, entry)) {
        checked += 1;
        assert.ok(!guides.includes(line), `${entry.slug} (${language}): "${line.slice(0, 60)}…" is in appDocs.ts`);
      }
    }
  }
  assert.ok(checked > 100, `the check reads the guides (saw ${checked} lines)`);
});

test("every document has one loader for each language, which imports its own source file and nothing else", async () => {
  const used = new Set();
  for (const entry of everyEntry()) {
    for (const language of LANGUAGES) {
      const sourcePath = entry.translations[language]?.sourcePath;
      assert.equal(typeof sourcePath, "string", `${entry.slug} has a source in ${language}`);
      const load = docMarkdown[sourcePath];
      assert.equal(typeof load, "function", `${entry.slug} (${language}) has a loader for ${sourcePath}`);
      const imported = /import\(\s*"([^"]+)\?raw"\s*\)/.exec(load.toString());
      assert.ok(imported, `the loader of ${sourcePath} is a dynamic import of the text`);
      assert.equal(path.relative(ROOT, path.resolve(LIB, imported[1])).split(path.sep).join("/"), sourcePath, `the loader of ${sourcePath} imports that very file`);
      await readFile(path.join(ROOT, sourcePath));
      used.add(sourcePath);
    }
  }
  assert.deepEqual(Object.keys(docMarkdown).filter((key) => !used.has(key)), [], "no loader without a document");
  assert.deepEqual(Object.keys(docMarkdown), [...Object.keys(docMarkdown)].sort(), "the loaders are sorted by source, so a new document touches one line");
  const localized = docEntries.find((entry) => entry.slug === "guide-1-how-it-works");
  assert.notEqual(localized.translations.en.sourcePath, localized.translations.it.sourcePath, "a translated guide has a file for each language");
  const single = docEntries.find((entry) => entry.slug === "server");
  assert.equal(single.translations.en.sourcePath, single.translations.it.sourcePath, "a document written once is one file for both languages");
});

test("the generator is deterministic and what is committed is what it makes from the sources", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "narrarium-docs-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "narrarium-docs-b-"));
  try {
    await generate(first);
    await generate(second);
    for (const file of OUTPUTS) {
      const made = await readFile(path.join(first, file), "utf8");
      assert.equal(await readFile(path.join(second, file), "utf8"), made, `${file}: two runs make the same file`);
      assert.equal(await readFile(path.join(LIB, file), "utf8"), made, `${file} is stale: run node scripts/generate-docs.mjs`);
      assert.doesNotMatch(made, /\b20\d\d-\d\d-\d\dT\d\d:\d\d/, `${file} carries no date`);
    }
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
