// Runs the server's tests in two groups. The files that start real child processes through the supervisor harness (a server that is stopped
// and started again by an update, a failed install, a rollback) are timed by those processes: on a runner with a few cores they were slow
// whenever three other files ran beside them, and their waits ran out now and then on Windows. They run one at a time, after the others.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SERIAL = ["rollback.test.mjs", "supervisor.test.mjs", "update-history.test.mjs", "update-verification.test.mjs"];

const run = (files, extra = []) => {
  const result = spawnSync(process.execPath, ["--test", "--test-timeout=300000", ...extra, ...files], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
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
const first = run(parallel);
const second = run(SERIAL.map((name) => `test/${name}`), ["--test-concurrency=1"]);
process.exit(first !== 0 ? first : second);
