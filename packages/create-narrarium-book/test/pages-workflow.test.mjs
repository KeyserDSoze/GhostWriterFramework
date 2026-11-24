import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildPagesWorkflow } from "narrarium-astro-reader/scaffold";

const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const workflowFile = (root) => path.join(root, ".github", "workflows", "deploy-reader-pages.yml");
const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });

/** The root workflow create-narrarium-book wrote up to 0.1.60, with the single password line an owner added by hand. */
const OLD_WORKFLOW = `name: Deploy Reader To GitHub Pages

on:
  workflow_dispatch:
  push:
    branches:
      - main
      - master

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: github-pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: reader/package-lock.json

      - name: Install project dependencies
        run: npm install

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Build reader site
        env:
          NARRARIUM_BOOK_ROOT: .
          SITE_BASE: /\${{ github.event.repository.name }}/
          NARRARIUM_READER_PASSWORD: \${{ secrets.NARRARIUM_READER_PASSWORD }}
        run: npm run build

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: reader/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;

test("a new book gets the root Pages workflow that reads the reader passwords from the repository's secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "create-narrarium-pages-"));
  try {
    const result = run([root, "--title", "Pages Test", "--language", "en", "--no-install"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const workflow = await readFile(workflowFile(root), "utf8");
    assert.equal(workflow, buildPagesWorkflow({ readerDir: "reader" }));
    assert.match(workflow, /NARRARIUM_READER_SECRETS: \$\{\{ toJSON\(secrets\) \}\}/);
    assert.match(workflow, /READER_PASSWORD_SECRETS: \$\{\{ vars\.READER_PASSWORD_SECRETS \}\}/);
    assert.match(workflow, /SITE_BASE: \/\$\{\{ github\.event\.repository\.name \}\}\//);
    const nested = await readFile(path.join(root, "reader", ".github", "workflows", "deploy-pages.yml"), "utf8");
    assert.equal(nested, buildPagesWorkflow({ readerDir: "." }), "the reader's own copy is the same workflow, for a reader kept on its own");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an upgrade never changes the Pages workflow by itself; --update-pages-workflow updates an untouched one and keeps its single password", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "create-narrarium-pages-upgrade-"));
  try {
    assert.equal(run([root, "--title", "Pages Upgrade", "--language", "en", "--no-install"]).status, 0);
    await writeFile(workflowFile(root), OLD_WORKFLOW, "utf8");

    let result = run(["--upgrade", root, "--with-reader", "--no-install"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(workflowFile(root), "utf8"), OLD_WORKFLOW, "not changed without the flag");
    assert.match(result.stdout, /--update-pages-workflow/);

    result = run(["--upgrade", root, "--with-reader", "--no-install", "--update-pages-workflow"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const updated = await readFile(workflowFile(root), "utf8");
    assert.equal(updated, buildPagesWorkflow({ readerDir: "reader", legacyPasswordSecret: "NARRARIUM_READER_PASSWORD" }));
    assert.match(updated, /NARRARIUM_READER_PASSWORD: \$\{\{ secrets\.NARRARIUM_READER_PASSWORD \}\}/);
    assert.match(result.stdout, /Updated \.github\/workflows\/deploy-reader-pages\.yml/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a workflow with the owner's own edits is never overwritten, even with --update-pages-workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "create-narrarium-pages-custom-"));
  try {
    assert.equal(run([root, "--title", "Pages Custom", "--language", "en", "--no-install"]).status, 0);
    const edited = OLD_WORKFLOW.replace("node-version: 22", "node-version: 20");
    await writeFile(workflowFile(root), edited, "utf8");
    const result = run(["--upgrade", root, "--with-reader", "--no-install", "--update-pages-workflow"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(workflowFile(root), "utf8"), edited);
    assert.match(result.stdout, /has edits Narrarium cannot merge/);
    assert.match(result.stdout, /\+ node-version: 20/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
