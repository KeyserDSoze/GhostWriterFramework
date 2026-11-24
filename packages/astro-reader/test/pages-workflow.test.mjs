import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import {
  PAGES_WORKFLOW_PATH,
  PAGES_WORKFLOW_VERSION,
  buildPagesWorkflow,
  planPagesWorkflowUpgrade,
} from "../cli-dist/pages-workflow.js";
import * as scaffold from "../cli-dist/scaffold.js";

/** What the site strips from the root workflow (see src/narrarium-site/scripts/generate-book-template.mjs). */
const SITE_CACHE_LINES = "          cache: npm\n          cache-dependency-path: reader/package-lock.json\n";

function stepsOf(text) {
  return YAML.parse(text).jobs.build.steps;
}

test("the root workflow of a book gives the secrets to the build step only, with the list from the repository variable", () => {
  const text = buildPagesWorkflow({ readerDir: "reader" });
  const workflow = YAML.parse(text);
  assert.equal(workflow.name, "Deploy Reader To GitHub Pages");
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "deploy"]);
  assert.equal(workflow.env, undefined, "no secret at the level of the workflow");
  assert.equal(workflow.jobs.build.env, undefined, "no secret at the level of the job");
  const steps = stepsOf(text);
  const withSecrets = steps.filter((step) => JSON.stringify(step).includes("secrets"));
  assert.deepEqual(withSecrets.map((step) => step.name), ["Build reader site"]);
  const build = steps.find((step) => step.name === "Build reader site");
  assert.deepEqual(build.env, {
    NARRARIUM_BOOK_ROOT: ".",
    SITE_BASE: "/${{ github.event.repository.name }}/",
    READER_PASSWORD_SECRETS: "${{ vars.READER_PASSWORD_SECRETS }}",
    NARRARIUM_READER_SECRETS: "${{ toJSON(secrets) }}",
  });
  assert.equal(build.run, "npm run build");
  const check = steps.find((step) => step.name === "Check that the passwords protect the reader");
  assert.equal(check.if, "${{ vars.READER_PASSWORD_SECRETS != '' }}");
  assert.match(check.run, /require\('\.\/reader\/dist\/version\.json'\)\.protected === true/);
  assert.equal(steps.at(-1).with.path, "reader/dist");
  assert.equal(steps.find((step) => step.name === "Setup Node").with["cache-dependency-path"], "reader/package-lock.json");
  assert.ok(text.startsWith(`# Narrarium Pages workflow, version ${PAGES_WORKFLOW_VERSION}:`));
  assert.equal(PAGES_WORKFLOW_PATH, ".github/workflows/deploy-reader-pages.yml");
});

test("the site's copy (without the npm cache) is still a workflow that needs no secret by name and names no cache", () => {
  const text = buildPagesWorkflow({ readerDir: "reader" });
  assert.equal(text.split(SITE_CACHE_LINES).length, 2, "the site removes these lines exactly once");
  const siteCopy = text.replace(SITE_CACHE_LINES, "");
  assert.equal(siteCopy, buildPagesWorkflow({ readerDir: "reader", npmCache: false }));
  // The checks of src/narrarium-site/test/bookTemplate.test.mjs and test-browser/bookTemplateParity.test.ts.
  assert.doesNotMatch(siteCopy, /cache/);
  assert.doesNotMatch(siteCopy, /secrets\./);
  assert.match(siteCopy, /actions\/setup-node@v4/);
  assert.match(siteCopy, /actions\/configure-pages@v5/);
  assert.match(siteCopy, /pages: write/);
  YAML.parse(siteCopy);
});

test("SITE_BASE follows the repository name, or is / with the custom domain", () => {
  const plain = stepsOf(buildPagesWorkflow({ readerDir: "reader" })).find((step) => step.name === "Build reader site").env;
  assert.equal(plain.SITE_BASE, "/${{ github.event.repository.name }}/");
  assert.equal(plain.SITE_URL, undefined);
  const domain = stepsOf(buildPagesWorkflow({ readerDir: "reader", pagesDomain: "books.example.com" })).find((step) => step.name === "Build reader site").env;
  assert.equal(domain.SITE_BASE, "/");
  assert.equal(domain.SITE_URL, "https://books.example.com");
  assert.throws(() => buildPagesWorkflow({ pagesDomain: "bad domain/" }));
  assert.throws(() => buildPagesWorkflow({ readerDir: "reader\n    evil: true" }));
  assert.throws(() => buildPagesWorkflow({ readerDir: "/absolute" }));
});

test("a reader that is its own repository gets the same steps on its own folder", () => {
  const text = buildPagesWorkflow({ readerDir: "." });
  const steps = stepsOf(text);
  const build = steps.find((step) => step.name === "Build reader site");
  assert.equal(build.env.NARRARIUM_BOOK_ROOT, undefined);
  assert.equal(build.env.NARRARIUM_READER_SECRETS, "${{ toJSON(secrets) }}");
  assert.equal(steps.find((step) => step.name === "Install project dependencies").run, "npm ci");
  assert.equal(steps.at(-1).with.path, "dist");
  assert.match(steps.find((step) => step.name === "Check that the passwords protect the reader").run, /\.\/dist\/version\.json/);
  assert.equal(steps.find((step) => step.name === "Setup Node").with["cache-dependency-path"], undefined);
});

// What create-narrarium-book wrote up to 0.1.60 (buildRootPagesWorkflow), byte for byte.
function oldRootWorkflow({ readerDir = "reader", domain, cache = true, bookRoot = "NARRARIUM_BOOK_ROOT", extraEnv = [] } = {}) {
  const env = domain
    ? [`          ${bookRoot}: .`, "          SITE_BASE: /", `          SITE_URL: https://${domain}`]
    : [`          ${bookRoot}: .`, "          SITE_BASE: /${{ github.event.repository.name }}/"];
  return `name: Deploy Reader To GitHub Pages

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
${cache ? `          cache: npm\n          cache-dependency-path: ${readerDir}/package-lock.json\n` : ""}
      - name: Install project dependencies
        run: npm install

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Build reader site
        env:
${[...env, ...extraEnv].join("\n")}
        run: npm run build

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ${readerDir}/dist

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
}

test("a repository without the workflow gets it", () => {
  const plan = planPagesWorkflowUpgrade(null);
  assert.equal(plan.status, "missing");
  assert.equal(plan.safe, true);
  assert.equal(plan.text, buildPagesWorkflow());
  assert.equal(plan.path, ".github/workflows/deploy-reader-pages.yml");
});

test("a workflow Narrarium wrote and nobody touched is upgraded, keeping its folder, domain and npm cache", () => {
  for (const variant of [{}, { cache: false }, { domain: "read.example.org" }, { readerDir: "site" }, { bookRoot: "GHOSTWRITER_BOOK_ROOT" }]) {
    const plan = planPagesWorkflowUpgrade(oldRootWorkflow(variant));
    assert.equal(plan.status, "generated", JSON.stringify(variant));
    assert.equal(plan.safe, true);
    assert.equal(plan.text, buildPagesWorkflow({ readerDir: variant.readerDir ?? "reader", pagesDomain: variant.domain, npmCache: variant.cache !== false }));
    assert.ok(plan.changes.length >= 2);
    assert.deepEqual(plan.customizations, []);
  }
  // Windows line endings and trailing spaces are not edits.
  assert.equal(planPagesWorkflowUpgrade(oldRootWorkflow().replace(/\n/g, "  \r\n")).status, "generated");
});

test("the single password of an older book is kept as one of its passwords; the commented template line is not", () => {
  const legacy = oldRootWorkflow({ extraEnv: ["          NARRARIUM_READER_PASSWORD: ${{ secrets.NARRARIUM_READER_PASSWORD }}"] });
  const plan = planPagesWorkflowUpgrade(legacy);
  assert.equal(plan.status, "generated");
  assert.equal(plan.settings.legacyPasswordSecret, "NARRARIUM_READER_PASSWORD");
  const build = stepsOf(plan.text).find((step) => step.name === "Build reader site");
  assert.equal(build.env.NARRARIUM_READER_PASSWORD, "${{ secrets.NARRARIUM_READER_PASSWORD }}");
  assert.equal(build.env.NARRARIUM_READER_SECRETS, "${{ toJSON(secrets) }}");
  assert.ok(plan.changes.some((change) => change.includes("NARRARIUM_READER_PASSWORD")));
  // Its own secret name, before the other variables, is kept too; and the upgraded file is then current.
  const renamed = oldRootWorkflow({ extraEnv: [] }).replace("          NARRARIUM_BOOK_ROOT: .", "          NARRARIUM_READER_PASSWORD: ${{ secrets.MY_READER_PW }}\n          NARRARIUM_BOOK_ROOT: .");
  const renamedPlan = planPagesWorkflowUpgrade(renamed);
  assert.equal(renamedPlan.status, "generated");
  assert.equal(stepsOf(renamedPlan.text).find((step) => step.name === "Build reader site").env.NARRARIUM_READER_PASSWORD, "${{ secrets.MY_READER_PW }}");
  assert.equal(planPagesWorkflowUpgrade(renamedPlan.text).status, "current");
  const commented = oldRootWorkflow({ extraEnv: ["          # NARRARIUM_READER_PASSWORD: ${{ secrets.NARRARIUM_READER_PASSWORD }}"] });
  const commentedPlan = planPagesWorkflowUpgrade(commented);
  assert.equal(commentedPlan.status, "generated");
  assert.equal(commentedPlan.settings.legacyPasswordSecret, undefined);
  assert.doesNotMatch(commentedPlan.text, /secrets\./);
});

test("a workflow with edits Narrarium cannot merge is never called safe, and the edits are listed", () => {
  const edited = oldRootWorkflow().replace("node-version: 22", "node-version: 20").replace("      - name: Configure Pages", "      - name: Lint\n        run: npm run lint\n\n      - name: Configure Pages");
  const plan = planPagesWorkflowUpgrade(edited);
  assert.equal(plan.status, "customized");
  assert.equal(plan.safe, false);
  assert.ok(plan.customizations.includes("+ node-version: 20"));
  assert.ok(plan.customizations.includes("+ run: npm run lint"));
  assert.ok(plan.customizations.includes("- node-version: 22"));
  assert.equal(plan.text, buildPagesWorkflow(), "the replacement is offered, to be committed only on an explicit choice");
  assert.equal(planPagesWorkflowUpgrade("on: push\njobs: {}\n").status, "customized");
});

test("the current workflow needs nothing, with or without the cache lines", () => {
  for (const options of [{}, { npmCache: false }, { pagesDomain: "x.example.com" }]) {
    const plan = planPagesWorkflowUpgrade(buildPagesWorkflow(options));
    assert.equal(plan.status, "current");
    assert.equal(plan.safe, false);
  }
});

test("narrarium-astro-reader/scaffold exports the workflow, its upgrade and the Pages helpers for the site", () => {
  for (const name of ["buildPagesWorkflow", "planPagesWorkflowUpgrade", "enablePagesSite", "disablePagesSite", "readPagesSite", "readReaderPasswordNames", "writeReaderPasswordNames", "dispatchPagesWorkflow", "readLatestPagesRun", "formatReaderPasswordSecretNames", "nextReaderPasswordSecretName", "scaffoldReaderSite"]) {
    assert.equal(typeof scaffold[name], "function", name);
  }
});

test("narrarium-astro-reader/github-pages is importable without Node: no node: import in what it loads", async () => {
  const { readFile } = await import("node:fs/promises");
  const seen = new Set();
  const visit = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /from "node:|require\("node:|import\("node:/, `${file} imports Node`);
    for (const match of text.matchAll(/from "(\.[^"]+)"/g)) await visit(new URL(match[1], `file://${file}`).pathname);
  };
  await visit(new URL("../cli-dist/github-pages.js", import.meta.url).pathname);
  assert.ok(seen.size >= 4);
  const browserEntry = await import("narrarium-astro-reader/github-pages");
  assert.equal(typeof browserEntry.planPagesWorkflowUpgrade, "function");
  assert.equal(typeof browserEntry.disablePagesSite, "function");
});
