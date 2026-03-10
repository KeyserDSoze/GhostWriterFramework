import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { scaffoldReaderSite } from "../cli-dist/scaffold.js";

test("reader scaffold includes canon index pages and configurable core dependency", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-"));

  try {
    const result = await scaffoldReaderSite(rootPath, {
      bookRoot: "..",
      packageName: "reader-test-site",
      coreDependency: "file:../../packages/core",
      pagesDomain: "example.com",
    });

    const packageJson = JSON.parse(await readFile(path.join(rootPath, "package.json"), "utf8"));
    const bookConfig = await readFile(path.join(rootPath, "src", "lib", "book-config.ts"), "utf8");
    const bookConfigScript = await readFile(path.join(rootPath, "scripts", "book-config.mjs"), "utf8");
    const envFile = await readFile(path.join(rootPath, ".env"), "utf8");
    const envExample = await readFile(path.join(rootPath, ".env.example"), "utf8");
    const bookHelper = await readFile(path.join(rootPath, "src", "lib", "book.ts"), "utf8");
    const exportScript = await readFile(path.join(rootPath, "scripts", "export-epub.mjs"), "utf8");
    const doctorScript = await readFile(path.join(rootPath, "scripts", "doctor.mjs"), "utf8");
    const devScript = await readFile(path.join(rootPath, "scripts", "dev.mjs"), "utf8");
    const pagesWorkflow = await readFile(path.join(rootPath, ".github", "workflows", "deploy-pages.yml"), "utf8");
    const cname = await readFile(path.join(rootPath, "public", "CNAME"), "utf8");
    const readme = await readFile(path.join(rootPath, "README.md"), "utf8");
    const charactersPage = await readFile(path.join(rootPath, "src", "pages", "characters", "index.astro"), "utf8");
    const factionsPage = await readFile(path.join(rootPath, "src", "pages", "factions", "index.astro"), "utf8");
    const itemsPage = await readFile(path.join(rootPath, "src", "pages", "items", "index.astro"), "utf8");
    const locationsPage = await readFile(path.join(rootPath, "src", "pages", "locations", "index.astro"), "utf8");
    const secretsPage = await readFile(path.join(rootPath, "src", "pages", "secrets", "index.astro"), "utf8");
    const timelinePage = await readFile(path.join(rootPath, "src", "pages", "timeline", "index.astro"), "utf8");

    assert.equal(result.coreDependency, "file:../../packages/core");
    assert.equal(packageJson.dependencies.narrarium, "file:../../packages/core");
    assert.equal(packageJson.dependencies.chokidar, "^4.0.3");
    assert.equal(packageJson.scripts.dev, "node ./scripts/dev.mjs");
    assert.equal(packageJson.scripts["export:epub"], "node ./scripts/export-epub.mjs");
    assert.equal(packageJson.scripts.doctor, "node ./scripts/doctor.mjs");
    assert.match(bookConfig, /defaultBookRoot = "\.\."/);
    assert.match(bookConfigScript, /defaultBookRoot = "\.\."/);
    assert.match(envFile, /NARRARIUM_BOOK_ROOT=\.\./);
    assert.equal(envFile, envExample);
    assert.match(bookHelper, /from "\.\/book-config\.js"/);
    assert.match(exportScript, /exportReaderEpub/);
    assert.match(doctorScript, /doctorBook/);
    assert.match(devScript, /Watching book files/);
    assert.doesNotMatch(devScript, /astro\/astro\.js/);
    assert.match(devScript, /astro\/package\.json/);
    assert.match(devScript, /astroPackageJson\.bin/);
    assert.match(pagesWorkflow, /Deploy Reader To GitHub Pages/);
    assert.match(pagesWorkflow, /SITE_URL: https:\/\/example.com/);
    assert.equal(cname.trim(), "example.com");
    assert.match(readme, /npm run doctor/);
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
