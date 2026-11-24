// Runs the server's tests in two groups. The files that start real child processes through the supervisor harness (a server that is stopped
// and started again by an update, a failed install, a rollback), and the one that makes git merge a book with its remote again and again, are timed by those processes: on a runner with a few cores they were slow
// whenever three other files ran beside them, and their waits ran out now and then on Windows. They run one at a time, after the others.
//
// A test file that fails is run once more, alone. The tests wait for what they need with generous bounds, but a shared CI runner (Windows
// above all: an antivirus that holds a file it scans, a PowerShell that takes seconds to start) can still be slower than any bound for a
// moment. A file that passes the second time is listed at the end as "FLAKY: passed on retry" (and as a warning on GitHub Actions), so it is
// never silent; a file that fails twice fails the run. Files named on the command line are run once, as they are.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SERIAL = ["github-conflicts.test.mjs", "rollback.test.mjs", "supervisor.test.mjs", "update-history.test.mjs", "update-verification.test.mjs"];
const REPORTER = pathToFileURL(fileURLToPath(new URL("./failed-files-reporter.mjs", import.meta.url))).href;
// What node shows when no reporter is named (Node 22: TAP when the output is not a terminal; later versions: spec), kept as it was.
const SHOWN = Number(process.versions.node.split(".")[0]) >= 23 || process.stdout.isTTY ? "spec" : "tap";

const run = (files, extra = []) => {
  const result = spawnSync(process.execPath, ["--test", "--test-timeout=300000", ...extra, ...files], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/** Run `files` and answer the exit code and the files that had a failure (relative to the package, as they were given). */
const runReporting = (files, extra = []) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "narrarium-server-tests-"));
  const list = path.join(folder, "failed.json");
  try {
    const status = run(files, ["--test-reporter", SHOWN, "--test-reporter-destination", "stdout", "--test-reporter", REPORTER, "--test-reporter-destination", list, ...extra]);
    let failed = [];
    try {
      failed = JSON.parse(readFileSync(list, "utf8")).map((file) => path.relative(root, file).split(path.sep).join("/"));
    } catch {
      // No list: the run ended before its reporter did. Nothing is known to retry.
    }
    return { status, failed };
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};

const flaky = [];
const broken = [];

/** Run a group; its failed files once more, one at a time. True when the group passed, at the first or at the second try. */
const runGroup = (files, extra = []) => {
  const first = runReporting(files, extra);
  if (first.status === 0) return true;
  const known = first.failed.filter((file) => files.includes(file));
  if (known.length === 0) {
    broken.push(`${files.length} files (exit code ${first.status}, no failing file was reported)`);
    return false;
  }
  console.log(`\n# Run again, once, alone: ${known.join(", ")}\n`);
  let passed = true;
  for (const file of known) {
    const again = runReporting([file], ["--test-concurrency=1"]);
    if (again.status === 0) flaky.push(file);
    else {
      broken.push(`${file} (failed twice)`);
      passed = false;
    }
  }
  // A file that failed without being named (its exit code alone) is not retried: the group fails with it.
  if (passed && known.length !== first.failed.length) passed = false;
  return passed;
};

const given = process.argv.slice(2);
if (given.length > 0) process.exit(run(given));

const all = readdirSync(new URL("../test/", import.meta.url)).filter((name) => name.endsWith(".test.mjs")).sort();
const missing = SERIAL.filter((name) => !all.includes(name));
if (missing.length > 0) {
  console.error(`scripts/run-tests.mjs lists test files that do not exist: ${missing.join(", ")}`);
  process.exit(1);
}
const parallel = all.filter((name) => !SERIAL.includes(name)).map((name) => `test/${name}`);
const first = runGroup(parallel);
const second = runGroup(SERIAL.map((name) => `test/${name}`), ["--test-concurrency=1"]);

console.log("\n# Server tests");
for (const file of flaky) {
  console.log(`# FLAKY: passed on retry: ${file}`);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning title=Flaky server test::${file} failed, then passed on retry. Look at its first failure in the log.`);
}
for (const what of broken) console.log(`# FAILED: ${what}`);
if (flaky.length === 0 && broken.length === 0) console.log("# Every file passed at the first try.");
process.exit(first && second ? 0 : 1);
