import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const sources = readdirSync(join(root, "src"), { recursive: true })
  .map(String)
  .filter((path) => /\.(ts|tsx)$/.test(path))
  .map((path) => `src/${path}`);
const read = (path) => readFileSync(join(root, path), "utf8");
const staticallyImporting = (pattern) => sources.filter((path) => new RegExp(`^import[^\\n]*from "${pattern}"`, "m").test(read(path))).sort();

test("the spend in the top bar is a lazy chunk, mounted only after the page is drawn and the browser is idle", () => {
  assert.deepEqual(staticallyImporting("@/components/costs/CostsIndicator"), [], "nothing imports the indicator in the initial graph");
  const bar = read("src/components/layout/Topbar.tsx");
  assert.match(bar, /const CostsIndicator = lazy\(\(\) => import\("@\/components\/costs\/CostsIndicator"\)/);
  assert.match(bar, /\{costsShown && <Suspense fallback=\{null\}><CostsIndicator \/><\/Suspense>\}/, "no placeholder: the bar does not move for it");
  assert.match(bar, /requestIdleCallback\(show, \{ timeout: \d+ \}\)/);
  assert.match(bar, /window\.setTimeout\(show, \d+\)/, "a browser without idle callbacks waits a moment");
  assert.match(bar, /useState\(false\)/);
});

test("the dashboard of the costs is in the lazy Costs route and nowhere else", () => {
  assert.deepEqual(staticallyImporting("@/pages/CostsPage"), [], "the route loads the page lazily");
  const inTheDashboard = (path) => path.startsWith("src/components/costs/dashboard/") || path === "src/pages/CostsPage.tsx";
  for (const pattern of ["@/components/costs/dashboard/[A-Za-z]+", "@/costs/dashboardModel"]) {
    const importers = staticallyImporting(pattern);
    assert.ok(importers.length > 0, pattern);
    assert.deepEqual(importers.filter((path) => !inTheDashboard(path)), [], `${pattern} is imported only by the dashboard`);
  }
  const indicator = read("src/components/costs/CostsIndicator.tsx");
  assert.doesNotMatch(indicator, /from "@\/(components\/costs\/dashboard|costs\/dashboardModel)/, "the indicator imports none of the dashboard");
  assert.match(read("src/router.tsx"), /path: "costs"[^\n]+lazy:/);
});

test("the dashboard adds nothing to the entry: its texts are the lazy costs bundle, and it reads the runtime only after it is drawn", () => {
  const page = read("src/pages/CostsPage.tsx");
  assert.match(page, /import "@\/i18n\/costs"/);
  assert.doesNotMatch(read("src/components/costs/dashboard/useBookAutopilots.ts"), /^import[^\n]*from "@\/autopilot\/runtime"/m, "the runtime is loaded through its loader");
});
