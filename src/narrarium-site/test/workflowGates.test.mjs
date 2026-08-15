import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);

test("root build and test scripts include narrarium-site", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.match(pkg.scripts.build, /build -w narrarium-site/);
  assert.match(pkg.scripts.test, /test -w narrarium-site/);
});

test("pull-request CI gates on site tests and publishes coverage", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /run: npm run test/);
  assert.match(workflow, /narrarium-site-coverage/);
});

test("Pages deployment runs site tests before build and artifact upload", async () => {
  const workflow = await readFile(new URL(".github/workflows/book-management-system.yml", root), "utf8");
  const tests = workflow.indexOf("npm run test -w narrarium-site");
  const build = workflow.indexOf("npm run docs:build");
  const upload = workflow.indexOf("actions/upload-pages-artifact");
  assert.ok(tests >= 0 && tests < build && build < upload);
});

test("site tests typecheck browser suites and enforce coverage thresholds", async () => {
  const pkg = JSON.parse(await readFile(new URL("src/narrarium-site/package.json", root), "utf8"));
  const config = await readFile(new URL("src/narrarium-site/vitest.config.ts", root), "utf8");
  assert.match(pkg.scripts.test, /test:typecheck.*test:unit.*test:browser/);
  assert.match(config, /thresholds:/);
  assert.match(config, /environment: "jsdom"/);
});
