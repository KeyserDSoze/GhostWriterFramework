import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const SITE = new URL("../", import.meta.url);

/** Every source file of the app, by its path from the site folder, with its text. */
async function sources() {
  const files = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    const relative = `src/${entry.split("\\").join("/")}`;
    if (/\.(ts|tsx)$/.test(relative)) files.push({ file: relative, text: await readFile(new URL(relative, SITE), "utf8") });
  }
  return files;
}

const importers = (files, pattern) => files.filter(({ text }) => pattern.test(text)).map(({ file }) => file).sort();

test("the text of a document is imported in one place only, and only when it is opened", async () => {
  const files = await sources();
  assert.ok(files.length > 300, `the scan reads the app (saw ${files.length} files)`);
  assert.deepEqual(importers(files, /\.md\?raw/), ["src/lib/generated-docs.ts"], "the texts are reached through the loaders of the index alone");
  const index = files.find(({ file }) => file === "src/lib/generated-docs.ts").text;
  assert.doesNotMatch(index, /^\s*import\s[^(]*\.md\?raw/m, "the index has no static import of a text");
  assert.ok((index.match(/import\("[^"]+\.md\?raw"\)/g) ?? []).length >= 40, "every text is a dynamic import");
  assert.deepEqual(importers(files, /content\/guides/).filter((file) => file !== "src/lib/generated-docs.ts" && file !== "src/lib/appDocs.ts"), [], "the guides' files are not imported by anything else");
  assert.doesNotMatch(files.find(({ file }) => file === "src/lib/appDocs.ts").text, /import\(|\?raw|^\s*import\s(?!type\b)/m, "the index of the guides imports no text");
});

test("only the loader reads the loaders, only the page of a document calls the loader, and the menu of the app loads neither", async () => {
  const files = await sources();
  assert.deepEqual(importers(files, /\bdocMarkdown\b/).filter((file) => file !== "src/lib/generated-docs.ts"), ["src/lib/docContent.ts"]);
  assert.deepEqual(importers(files, /["']@\/lib\/docContent["']/), ["src/components/docs/DocContent.tsx"]);
  for (const file of ["src/lib/docs.ts", "src/lib/appDocs.ts", "src/components/layout/Sidebar.tsx"]) {
    const text = files.find((entry) => entry.file === file).text;
    assert.doesNotMatch(text, /^import\s(?!type\b)[^;]*["'](?:@\/lib\/|\.\/)generated-docs["']/m, `${file} imports the index of the repository's documents for its types only`);
    assert.doesNotMatch(text, /docContent|components\/docs\/DocContent/, `${file} does not load documents`);
  }
});

test("the content of a document uses only what the docs routes already load, so the preload lists that the app entry keeps for them do not grow", async () => {
  // Each chunk that a lazy route needs is written, for that route, into the app entry, which the public home shares: an icon, a component or the
  // helper of the lazy catalogues used here would lengthen those lists, and the home route has a margin of about 3 kB.
  for (const file of ["src/components/docs/DocContent.tsx", "src/i18n/docsContent.ts", "src/lib/docContent.ts"]) {
    const text = await readFile(new URL(file, SITE), "utf8");
    assert.doesNotMatch(text, /lucide-react|@\/components\/ui\/(?!button["'])|@\/i18n\/lazyBundles/, `${file} imports no icon, no component but the button, and not the helper of the lazy catalogues`);
  }
});
