// The E2E suite (`npm run test:e2e`) split into parallel jobs of about the same length. Playwright's own `--shard` balances by the number of
// tests, and this suite runs its files one at a time (`fullyParallel: false`), so one shard took most of the time: here whole files are
// given to the shards by how long they take (longest first, each to the shortest shard). Every file of the list is in exactly one shard;
// a file that has no measured time counts as DEFAULT_SECONDS. A stale time only makes the shards less even, never drops a file.
//   node scripts/e2e-shards.mjs list <total>        the files of every shard, as JSON
//   node scripts/e2e-shards.mjs run <index> <total> run the files of one shard (1-based) with the suite's configuration
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Seconds per file, from the list reporter of CI run 46082478410 (2026-11-27). */
export const E2E_SECONDS = {
  "e2e/paragraph-sync.spec.ts": 96,
  "e2e/ai-routing.spec.ts": 56,
  "e2e/local-first.spec.ts": 32,
  "e2e/autopilot-resume.spec.ts": 29,
  "e2e/autopilot-navigation.spec.ts": 28,
  "e2e/responses-api.spec.ts": 22,
  "e2e/costs-budgets.spec.ts": 21,
  "e2e/repository-conflicts.spec.ts": 17,
  "e2e/long-paste.spec.ts": 16,
  "e2e/reader-run.spec.ts": 13,
  "e2e/review-reading.spec.ts": 11,
  "e2e/review-targets.spec.ts": 9,
  "e2e/annotations.spec.ts": 9,
  "e2e/indexeddb-upgrades.spec.ts": 8,
  "e2e/ai-calls.spec.ts": 7,
  "e2e/synopsis-apply.spec.ts": 7,
  "e2e/costs-dashboard.spec.ts": 5,
  "e2e/page-copilot.spec.ts": 5,
  "e2e/costs-ledger.spec.ts": 5,
  "e2e/route-splitting.spec.ts": 5,
  "e2e/review-campaigns.spec.ts": 4,
  "e2e/prompt-caching.spec.ts": 3,
  "e2e/design-run.spec.ts": 3,
  "e2e/brainstorming.spec.ts": 3,
  "e2e/app-entry.spec.ts": 1,
  "e2e/google-scopes.spec.ts": 1,
};
export const DEFAULT_SECONDS = 15;

/** The spec files of a Playwright script of package.json, in their order. */
export function specsOf(script) {
  return String(script ?? "").split(/\s+/).filter((part) => /^e2e\/.+\.spec\.ts$/.test(part));
}

export function suiteSpecs() {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return specsOf(scripts["test:e2e"]);
}

/** `specs` in `total` shards of about the same time; each shard keeps the suite's order of its files. */
export function shardSpecs(specs, total, seconds = E2E_SECONDS) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`A number of shards is a positive integer, not ${total}.`);
  const weight = (file) => seconds[file] ?? DEFAULT_SECONDS;
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  const order = [...specs].sort((a, b) => weight(b) - weight(a) || specs.indexOf(a) - specs.indexOf(b));
  for (const file of order) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  return shards.map((shard) => ({ files: specs.filter((file) => shard.files.includes(file)), seconds: shard.seconds }));
}

function main([command, ...rest]) {
  if (command === "list") {
    console.log(JSON.stringify(shardSpecs(suiteSpecs(), Number(rest[0])), null, 2));
    return;
  }
  if (command === "run") {
    const [index, total] = rest.map(Number);
    const shards = shardSpecs(suiteSpecs(), total);
    const shard = shards[index - 1];
    if (!shard) throw new Error(`There is no shard ${index} of ${total}.`);
    console.log(`E2E shard ${index}/${total}: ${shard.files.length} files, about ${shard.seconds} s of tests\n${shard.files.join("\n")}\n`);
    const result = spawnSync("npx", ["playwright", "test", "--config=playwright.config.ts", ...shard.files], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    process.exit(result.status ?? 1);
  }
  console.error("usage: node scripts/e2e-shards.mjs list <total> | run <index> <total>");
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
