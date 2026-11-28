// `npm run check:quick`: the quick check of a small site fix, on this machine, in a few minutes. It is what the quick lane of the deploy
// runs (scripts/release-lane.mjs), and the same parts run there:
//   prepare  build core, engine, the reader CLI and the book scaffolder (the site's tests and build need them)
//   tests    the site's typecheck, its node unit tests, and the component tests related to the changed files (`vitest related`)
//   build    the production build of the site, with its bundle budgets and its content-security checks
//   e2e      the E2E build and the smoke subset (`npm run test:e2e:smoke`), then the GitHub Pages basename routing
// The change is the range from --base (default: where HEAD left origin/main) to HEAD, plus what is not committed yet. A change that the
// quick lane would refuse (the engine, the server, workflows, auth or security code, dependencies, ...) is refused here as well: it needs
// the full check (`npm run release:check` and both E2E suites). `--parts tests,e2e` runs some parts only (the deploy runs them in two jobs).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideLane, describeRange, knownCommit, packageJsonChanges, siteTestTargets } from "./release-lane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const PARTS = ["prepare", "tests", "build", "e2e"];
const parts = option("parts", PARTS.join(",")).split(",").map((part) => part.trim()).filter(Boolean);
for (const part of parts) if (!PARTS.includes(part)) throw new Error(`Unknown part "${part}": use ${PARTS.join(", ")}.`);

const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const defaultBase = () => {
  try {
    return git("merge-base", "HEAD", "origin/main");
  } catch {
    return "HEAD^";
  }
};
const base = option("base", process.env.CHECK_QUICK_BASE || defaultBase());
const head = option("head", "HEAD");
if (!knownCommit(base)) throw new Error(`The base ${base} is not a commit here: pass --base <ref>.`);

// What is not committed counts too: the check is of the working tree.
const range = describeRange(base, head);
// Not trimmed: the first column of a status line is a space when only the work tree changed.
const status = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
const pending = head === "HEAD" ? status().split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").pop()) : [];
const files = [...new Set([...(range.files ?? []), ...pending])].sort();
for (const file of pending) {
  if (/(^|\/)package\.json$/.test(file)) {
    let before;
    try {
      before = git("show", `${base}:${file}`);
    } catch {
      before = "{}";
    }
    const after = existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : "{}";
    range.packageChanges[file] = packageJsonChanges(before, after);
  }
  if (file === "package-lock.json") range.lockChanges = ["(uncommitted lockfile: run the full check)"];
}
// The trailer is the author's call; this check answers "may this change take the quick lane", so it asks as if the trailer were there.
const decision = decideLane({ message: "check\n\nFast-Track: local check", files: range.files ? files : null, packageChanges: range.packageChanges, lockChanges: range.lockChanges });
console.log(`check:quick of ${base.slice(0, 12)}..${head} (${files.length} files)`);
if (decision.lane !== "quick") {
  console.error("This change cannot take the quick lane, so the quick check does not vouch for it:");
  for (const why of decision.refused) console.error(`  - ${why}`);
  console.error("Run the full check instead: npm run release:check, then both E2E suites (see AGENTS.md, Release lanes).");
  process.exit(2);
}

const run = (title, command, commandArgs, env = {}, cwd = root) => {
  const started = Date.now();
  console.log(`\n### ${title}\n$ ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.status !== 0) {
    console.error(`\ncheck:quick FAILED at "${title}" after ${seconds} s.`);
    process.exit(result.status ?? 1);
  }
  console.log(`### ${title}: ok (${seconds} s)`);
};

const SITE_ENV = { SITE_BASE: "/" };
const started = Date.now();
if (parts.includes("prepare")) {
  run("Build core, engine, reader CLI and book scaffolder", "npm", ["run", "build:prerequisites"]);
}
if (parts.includes("tests")) {
  run("Typecheck of the site", "npm", ["run", "test:typecheck", "-w", "narrarium-site"]);
  run("Unit tests of the site", "npm", ["run", "test:unit", "-w", "narrarium-site"]);
  const site = path.join(root, "src", "narrarium-site");
  // A deleted file has nothing to relate: its importers changed too, or the typecheck has said so.
  const targets = siteTestTargets(files).filter((file) => existsSync(path.join(site, file)));
  if (targets.length) run(`Component tests related to ${targets.length} changed files`, "npx", ["vitest", "related", "--run", "--passWithNoTests", ...targets], {}, site);
  else console.log("\n### Component tests: no source or test file of the site changed, none is related");
}
if (parts.includes("build")) run("Production build of the site, bundle budgets and CSP", "npm", ["run", "build", "-w", "narrarium-site"], SITE_ENV);
if (parts.includes("e2e")) {
  run("E2E build", "npm", ["run", "test:e2e:build"], SITE_ENV);
  run("Smoke E2E", "npm", ["run", "test:e2e:smoke"], SITE_ENV);
  run("GitHub Pages basename routing", "npm", ["run", "test:e2e:basename"]);
}
console.log(`\ncheck:quick passed (${parts.join(", ")}) in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
