import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);

test("root build and test scripts include narrarium-site", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.match(pkg.scripts.build, /build -w narrarium-site/);
  assert.match(pkg.scripts.test, /test -w narrarium-site/);
});

test("pull-request CI gates on the full checks, which run the site tests and publish coverage", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const checks = await readFile(new URL(".github/workflows/checks.yml", root), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/checks\.yml/);
  assert.match(checks, /run: npm run test:typecheck -w narrarium-site/);
  assert.match(checks, /run: npm run test:unit -w narrarium-site/);
  assert.match(checks, /npm run test:browser -w narrarium-site --/);
  assert.match(checks, /run: npx vitest --merge-reports --coverage/);
  assert.match(checks, /narrarium-site-coverage/);
});

test("Pages deployment publishes only after the checks of its lane, and builds before it uploads", async () => {
  const workflow = await readFile(new URL(".github/workflows/book-management-system.yml", root), "utf8");
  const pages = await readFile(new URL(".github/workflows/pages.yml", root), "utf8");
  // The full lane waits for the full checks, the quick lane for its own; the express lane is manual and runs none.
  assert.match(workflow, /publish-full:\n(?:.*\n)*?\s+needs: \[lane, checks\]/);
  assert.match(workflow, /publish-quick:\n(?:.*\n)*?\s+needs: \[lane, quick, quick-e2e\]/);
  assert.match(workflow, /checks:\n(?:.*\n)*?\s+uses: \.\/\.github\/workflows\/checks\.yml/);
  assert.match(workflow, /--parts tests/);
  const build = pages.indexOf("npm run docs:build");
  const upload = pages.indexOf("actions/upload-pages-artifact");
  const deploy = pages.indexOf("actions/deploy-pages");
  assert.ok(build >= 0 && build < upload && upload < deploy);
});

test("site tests typecheck browser suites and enforce coverage thresholds", async () => {
  const pkg = JSON.parse(await readFile(new URL("src/narrarium-site/package.json", root), "utf8"));
  const config = await readFile(new URL("src/narrarium-site/vitest.config.ts", root), "utf8");
  assert.match(pkg.scripts.test, /test:typecheck.*test:unit.*test:browser/);
  assert.match(config, /thresholds:/);
  assert.match(config, /environment: "jsdom"/);
});
