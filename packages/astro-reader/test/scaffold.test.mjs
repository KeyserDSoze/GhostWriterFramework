import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { scaffoldReaderSite } from "../cli-dist/scaffold.js";

test("reader scaffold includes canon index pages and configurable core dependency", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ghostwriter-reader-"));

  try {
    const result = await scaffoldReaderSite(rootPath, {
      bookRoot: "..",
      packageName: "reader-test-site",
      coreDependency: "file:../../packages/core",
    });

    const packageJson = JSON.parse(await readFile(path.join(rootPath, "package.json"), "utf8"));
    const bookConfig = await readFile(path.join(rootPath, "src", "lib", "book-config.ts"), "utf8");
    const bookHelper = await readFile(path.join(rootPath, "src", "lib", "book.ts"), "utf8");
    const charactersPage = await readFile(path.join(rootPath, "src", "pages", "characters", "index.astro"), "utf8");
    const factionsPage = await readFile(path.join(rootPath, "src", "pages", "factions", "index.astro"), "utf8");
    const itemsPage = await readFile(path.join(rootPath, "src", "pages", "items", "index.astro"), "utf8");
    const locationsPage = await readFile(path.join(rootPath, "src", "pages", "locations", "index.astro"), "utf8");
    const secretsPage = await readFile(path.join(rootPath, "src", "pages", "secrets", "index.astro"), "utf8");
    const timelinePage = await readFile(path.join(rootPath, "src", "pages", "timeline", "index.astro"), "utf8");

    assert.equal(result.coreDependency, "file:../../packages/core");
    assert.equal(packageJson.dependencies["@ghostwriter/core"], "file:../../packages/core");
    assert.match(bookConfig, /defaultBookRoot = "\.\."/);
    assert.match(bookHelper, /from "\.\/book-config\.js"/);
    assert.match(charactersPage, /Characters/);
    assert.match(factionsPage, /Factions/);
    assert.match(itemsPage, /Items/);
    assert.match(locationsPage, /Locations/);
    assert.match(secretsPage, /Secrets/);
    assert.match(timelinePage, /Timeline/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
