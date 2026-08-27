import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { scaffoldReaderSite } from "../cli-dist/scaffold.js";
import { GET as getEncryptedEpub } from "../cli-dist/pages/epub.enc.js";
import { exportReaderEpub } from "../scripts/book-dev-utils.mjs";
import { buildCanonPageView } from "../cli-dist/lib/public-canon.js";
import { createChapter, createSecretProfile, initializeBookRepo, readEntity } from "narrarium";

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
    const markdownHelper = await readFile(path.join(rootPath, "src", "lib", "markdown.ts"), "utf8");
    const publicCanon = await readFile(path.join(rootPath, "src", "lib", "public-canon.ts"), "utf8");
    const workshop = await readFile(path.join(rootPath, "src", "pages", "workshop", "index.astro"), "utf8");
    const evaluationModal = await readFile(path.join(rootPath, "src", "components", "EvaluationModal.astro"), "utf8");

    assert.equal(result.coreDependency, "file:../../packages/core");
    assert.equal(packageJson.engines.node, ">=22.12.0");
    assert.equal(packageJson.dependencies.narrarium, "file:../../packages/core");
    assert.equal(packageJson.dependencies.astro, "^7.2.6");
    assert.equal(packageJson.dependencies.chokidar, "^4.0.3");
    assert.equal(packageJson.dependencies["js-yaml"], undefined);
    assert.equal(packageJson.dependencies.marked, undefined);
    assert.match(markdownHelper, /renderSafeMarkdownHtml/);
    assert.match(publicCanon, /access\.isRevealed && entity\.body/);
    assert.match(workshop, /EncryptedHtml/);
    assert.match(evaluationModal, /EncryptedHtml/);
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

test("reader EPUB export skips cleanly when a book has no chapters yet", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-empty-"));
  const readerRoot = path.join(workspaceRoot, "reader");
  const bookRoot = path.join(workspaceRoot, "book");

  try {
    await scaffoldReaderSite(readerRoot, {
      bookRoot: "../book",
      packageName: "reader-empty-site",
      coreDependency: "file:../../packages/core",
    });

    await mkdir(bookRoot, { recursive: true });
    await writeFile(path.join(bookRoot, "book.md"), "---\ntype: book\nid: book\ntitle: Empty Book\nlanguage: en\n---\n", "utf8");

    const exportState = await exportReaderEpub("../book", readerRoot);
    const previousBookRoot = process.env.NARRARIUM_BOOK_ROOT;
    let endpointResponse;
    try {
      process.env.NARRARIUM_BOOK_ROOT = bookRoot;
      endpointResponse = await getEncryptedEpub();
    } finally {
      if (previousBookRoot === undefined) delete process.env.NARRARIUM_BOOK_ROOT;
      else process.env.NARRARIUM_BOOK_ROOT = previousBookRoot;
    }

    assert.equal(exportState.result.skipped, true);
    assert.equal(exportState.result.reason, "no-chapters");
    assert.match(exportState.validation.detail, /no chapters yet/i);
    assert.equal(endpointResponse.status, 200);
    assert.equal((await endpointResponse.arrayBuffer()).byteLength, 0);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("public canon pages do not expose entity bodies before reveal_in", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-spoiler-"));
  const previousRoot = process.env.NARRARIUM_BOOK_ROOT;
  const previousMode = process.env.NARRARIUM_READER_CANON_MODE;

  try {
    await initializeBookRepo(rootPath, { title: "Spoiler Threshold", language: "en" });
    await createChapter(rootPath, { number: 1, title: "Arrival" });
    await createChapter(rootPath, { number: 2, title: "Reveal" });
    await createSecretProfile(rootPath, {
      title: "The hidden truth",
      slug: "hidden-truth",
      functionInBook: "Protects the mystery.",
      stakes: "Early disclosure breaks the story.",
      revealIn: "chapter:002-reveal",
      body: "SPOILER_BODY_MARKER",
    });

    process.env.NARRARIUM_BOOK_ROOT = rootPath;
    delete process.env.NARRARIUM_READER_CANON_MODE;
    const entity = await readEntity(rootPath, "secret", "hidden-truth");
    const teaser = await buildCanonPageView("secret", entity);
    assert.equal(teaser.mode, "teaser");
    assert.equal(teaser.html, undefined);

    process.env.NARRARIUM_READER_CANON_MODE = "full";
    const full = await buildCanonPageView("secret", entity);
    assert.equal(full.mode, "full");
    assert.match(full.html ?? "", /SPOILER_BODY_MARKER/);
  } finally {
    if (previousRoot === undefined) delete process.env.NARRARIUM_BOOK_ROOT;
    else process.env.NARRARIUM_BOOK_ROOT = previousRoot;
    if (previousMode === undefined) delete process.env.NARRARIUM_READER_CANON_MODE;
    else process.env.NARRARIUM_READER_CANON_MODE = previousMode;
    await rm(rootPath, { recursive: true, force: true });
  }
});
