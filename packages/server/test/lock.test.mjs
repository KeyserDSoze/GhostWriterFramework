import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, readlink, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { lockDataRoot, lockStartMs, processAlive, startNarrariumServer } from "../dist/testing.mjs";
import { gatedAi, noRelease, until } from "./helpers.mjs";

const posix = process.platform !== "win32";
const testing = new URL("../dist/testing.mjs", import.meta.url).href;
const serverEntry = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const noTunnel = { findBinary: () => undefined, detectOtherConnectors: async () => [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A deadline that never keeps the test process alive after the test has finished. */
const timeoutAfter = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const temporary = (prefix = "narrarium-lock-") => mkdtemp(path.join(os.tmpdir(), prefix));
const PIDFILE = { method: "pidfile", checkMs: 50 };

/** A process that tries to take the lock (with the pid-file method) at `barrier`, says what happened, and holds it until its input ends. */
function contender(root, { barrier = 0, method = "pidfile" } = {}) {
  const source = `
    import { lockDataRoot } from ${JSON.stringify(testing)};
    while (Date.now() < ${barrier}) await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      await lockDataRoot(${JSON.stringify(root)}, () => process.stdout.write("LOST\\n"), { method: ${JSON.stringify(method)}, checkMs: 100 });
      process.stdout.write("LOCKED\\n");
    } catch (error) {
      process.stdout.write("REFUSED " + error.message + "\\n");
      process.exit(3);
    }
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
    output: () => stdout,
    errors: () => stderr,
    outcome: () => until(() => (/(LOCKED|REFUSED[^\n]*)\n/.exec(stdout)?.[1]), 60_000).catch((error) => {
      throw new Error(`${error.message}: ${stdout}\n${stderr}`);
    }),
    release: () => {
      child.stdin.end();
      return exited;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// R11 / R3: the lock file used where there is no kernel lock (macOS, and anywhere else) is a lock
// ---------------------------------------------------------------------------------------------

test("R11: the pid-file lock keeps a second server out, also from another process, and a killed holder leaves a lock that is taken over", async () => {
  const root = await temporary();
  try {
    const first = contender(root);
    assert.equal(await first.outcome(), "LOCKED");
    await assert.rejects(() => lockDataRoot(root, () => undefined, PIDFILE), /already using/, "this process");
    const second = contender(root);
    assert.match(await second.outcome(), /^REFUSED Another narrarium-server \(pid \d+\) is already using/);
    first.child.kill("SIGKILL");
    await first.exited;
    const release = await lockDataRoot(root, () => undefined, PIDFILE);
    await release();
    await assert.rejects(() => stat(path.join(root, "server.lock")), { code: "ENOENT" }, "releasing removes the lock");
  } finally {
    await remove(root);
  }
});

test("R11: eight servers started at the same instant: exactly one gets the lock, round after round, also when a dead server's lock is lying there", async (t) => {
  // Windows holds its lock in a named mutex, not in this file (and asking it who a process is takes a PowerShell run each time).
  if (!posix) return t.skip("the pid-file lock is for the systems that have no kernel lock to use");
  const root = await temporary();
  try {
    let winner;
    for (let round = 0; round < 4; round += 1) {
      const barrier = Date.now() + 2_500;
      const field = Array.from({ length: 8 }, () => contender(root, { barrier }));
      const outcomes = await Promise.all(field.map((entry) => entry.outcome()));
      assert.equal(outcomes.filter((outcome) => outcome === "LOCKED").length, 1, `round ${round}: ${JSON.stringify(outcomes)}`);
      assert.equal(outcomes.filter((outcome) => outcome.startsWith("REFUSED Another narrarium-server")).length, 7, `round ${round}: ${JSON.stringify(outcomes)}`);
      winner = field[outcomes.indexOf("LOCKED")];
      // The winner dies without a word: its lock stays behind, for the next round to find.
      winner.child.kill("SIGKILL");
      await winner.exited;
      await Promise.all(field.map((entry) => entry.release().catch(() => undefined)));
      assert.ok(await stat(path.join(root, "server.lock")).then(() => true, () => false), "the dead server's lock is there");
    }
  } finally {
    await remove(root);
  }
});

test("R11: a lock whose number now belongs to another program is not a lock (the number was reused after a reboot or a crash)", async (t) => {
  if (!posix) return t.skip("needs a program that is not node, with a known id");
  const root = await temporary();
  const other = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    await until(() => processAlive(other.pid), 5_000);
    // The format of this version: the pid, and when that process started. The number is alive, but it is not the process that wrote it.
    await writeFile(path.join(root, "server.lock"), `${JSON.stringify({ version: 1, pid: other.pid, start: "another-boot:1", token: "old" })}\n`);
    let release = await lockDataRoot(root, () => undefined, PIDFILE);
    await release();
    // The format of earlier versions: just a number. A live process that is not node cannot be a narrarium-server.
    await writeFile(path.join(root, "server.lock"), String(other.pid));
    release = await lockDataRoot(root, () => undefined, PIDFILE);
    await release();
    // A live node process in an earlier version's file might well be one: that stays a refusal.
    await writeFile(path.join(root, "server.lock"), String(process.pid));
    await assert.rejects(() => lockDataRoot(root, () => undefined, PIDFILE), /already using/);
    await rm(path.join(root, "server.lock"));
    // A lock that names a process that is gone is stale.
    await writeFile(path.join(root, "server.lock"), `${JSON.stringify({ version: 1, pid: 2 ** 22 - 1, start: "x:1", token: "old" })}\n`);
    release = await lockDataRoot(root, () => undefined, PIDFILE);
    await release();
  } finally {
    other.kill("SIGKILL");
    await remove(root);
  }
});

test("R11: an empty or damaged lock file is waited for while it is fresh (it may be being written), and taken over once it is clearly old", async () => {
  const root = await temporary();
  try {
    const lock = path.join(root, "server.lock");
    await writeFile(lock, "");
    let started = Date.now();
    let release = await lockDataRoot(root, () => undefined, { ...PIDFILE, damagedAfterMs: 800 });
    assert.ok(Date.now() - started >= 500, `a fresh empty file is not taken at once (${Date.now() - started} ms)`);
    await release();
    const old = new Date(Date.now() - 60_000);
    for (const content of ["", "{not json", "12 34", JSON.stringify({ version: 1, pid: "nope" })]) {
      await writeFile(lock, content);
      await utimes(lock, old, old);
      started = Date.now();
      release = await lockDataRoot(root, () => undefined, { ...PIDFILE, damagedAfterMs: 800 });
      assert.ok(Date.now() - started < 500, `an old damaged file (${JSON.stringify(content)}) is taken over`);
      await release();
    }
  } finally {
    await remove(root);
  }
});

test("R11: taking a second lock in a process asks nothing more about the process (it does not change, and on Windows and macOS asking starts a program)", async () => {
  const roots = [await temporary(), await temporary()];
  const source = `
    import fsp from "node:fs/promises";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { lockDataRoot } from ${JSON.stringify(testing)};
    let asks = 0;
    const readFile = fsp.readFile;
    fsp.readFile = async (file, ...rest) => {
      if (String(file) === "/proc/" + process.pid + "/stat") asks += 1;
      return readFile(file, ...rest);
    };
    const execFile = childProcess.execFile;
    childProcess.execFile = (command, args, ...rest) => {
      if ([command, ...(args ?? [])].join(" ").includes(String(process.pid))) asks += 1;
      return execFile(command, args, ...rest);
    };
    syncBuiltinESMExports();
    const first = await lockDataRoot(${JSON.stringify(roots[0])}, () => undefined, { method: "pidfile", checkMs: 1000 });
    const afterFirst = asks;
    const second = await lockDataRoot(${JSON.stringify(roots[1])}, () => undefined, { method: "pidfile", checkMs: 1000 });
    process.stdout.write("ASKS " + JSON.stringify({ afterFirst, afterSecond: asks }) + "\\n");
    await first();
    await second();
  `;
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await new Promise((resolve) => child.once("exit", resolve));
    const asks = /ASKS (.*)\n/.exec(stdout);
    assert.ok(asks, `${stdout}\n${stderr}`);
    const { afterFirst, afterSecond } = JSON.parse(asks[1]);
    assert.ok(afterFirst >= 1, "the first lock asked who this process is (to write it into the lock)");
    assert.equal(afterSecond, afterFirst, "and the second did not ask again");
  } finally {
    await remove(...roots);
  }
});

test("R3: a pid-file lock that is deleted or replaced under its holder is reported as lost, and a normal release is not", async () => {
  const root = await temporary();
  try {
    let lost = 0;
    const release = await lockDataRoot(root, () => {
      lost += 1;
    }, PIDFILE);
    await sleep(250);
    assert.equal(lost, 0, "nothing is lost while the lock is there");
    await rm(path.join(root, "server.lock"));
    await until(() => lost === 1, 5_000);
    await release();
    await sleep(200);
    assert.equal(lost, 1, "reported once");

    lost = 0;
    const second = await lockDataRoot(root, () => {
      lost += 1;
    }, PIDFILE);
    // Somebody else's lock in its place.
    await writeFile(path.join(root, "server.lock"), `${JSON.stringify({ version: 1, pid: process.pid, start: "x", token: "somebody-else" })}\n`);
    await until(() => lost === 1, 5_000);
    await second();
    assert.match(await readFile(path.join(root, "server.lock"), "utf8"), /somebody-else/, "releasing a lock that is no longer ours leaves the other's alone");
    await rm(path.join(root, "server.lock"));

    lost = 0;
    const clean = await lockDataRoot(root, () => {
      lost += 1;
    }, PIDFILE);
    await clean();
    await sleep(250);
    assert.equal(lost, 0, "a normal release is not a loss");
  } finally {
    await remove(root);
  }
});

test("R3: the lock of Linux (a kernel lock held by a helper) reports a helper that dies, and nothing else", async (t) => {
  if (process.platform !== "linux") return t.skip("the kernel lock helper is Linux's");
  const root = await temporary();
  try {
    let lost = 0;
    const release = await lockDataRoot(root, () => {
      lost += 1;
    });
    const holder = await holderOf(root);
    assert.ok(holder, "the helper that holds the lock");
    process.kill(holder, "SIGKILL");
    await until(() => lost === 1, 10_000);
    await release();
    assert.equal(lost, 1);
  } finally {
    await remove(root);
  }
});

/** The helper process (a child of this one) that has the lock file of a data folder open. */
async function holderOf(root) {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (parent !== process.pid) continue;
    const descriptors = await readdir(`/proc/${entry}/fd`).catch(() => []);
    for (const descriptor of descriptors) {
      const target = await readlink(`/proc/${entry}/fd/${descriptor}`).catch(() => "");
      if (target.endsWith(`${path.sep}.server.lock`) && target.startsWith(await realpath(root))) return Number(entry);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// R3: a server that lost its lock stops; it never goes on as a second server
// ---------------------------------------------------------------------------------------------

/** A server whose lock the test can take away: the `onLost` the server gave to the lock is handed back. */
async function lockableServer(extra = {}) {
  const dataDir = await temporary("narrarium-lost-lock-");
  const handles = {};
  const log = [];
  const server = await startNarrariumServer({
    dataDir,
    port: 0,
    adminPort: 0,
    ai: createFakeAutopilotAi(),
    supervised: false,
    checkRelease: noRelease,
    tunnel: noTunnel,
    lock: async (root, onLost) => {
      handles.lose = onLost;
      return async () => {
        handles.released = true;
      };
    },
    log: (line) => log.push(line),
    onLockLost: () => {
      handles.reported = true;
    },
    ...extra,
  });
  return { server, dataDir, handles, log };
}

test("R3: a server that loses its lock stops serving, pauses its autopilots and tells its host, instead of running next to a second server", async () => {
  const slow = gatedAi();
  const { server, dataDir, handles, log } = await lockableServer({ ai: slow.ai });
  try {
    const { token } = await server.auth.issue("writer", ["read", "write", "run"]);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const call = (method, route, body) => fetch(`${server.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call("PUT", "/api/v1/books/b", { title: "B", storage: { kind: "local" } })).status, 200);
    assert.equal((await call("POST", "/api/v1/books/b/files/commit", { changes: Object.entries(seedBookFiles()).map(([file, content]) => ({ path: file, content })), message: "seed" })).status, 200);
    assert.equal((await call("POST", "/api/v1/books/b/autopilot/start", { brief: { idea: "A harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } })).status, 200);
    await slow.started;
    assert.equal(server.books.runningCount(), 1);

    handles.lose();
    // At once, whatever else happens, nothing that writes is accepted.
    const refused = await call("POST", "/api/v1/books/b/files/commit", { changes: [{ path: "late.md", content: "x" }], message: "late" }).catch(() => undefined);
    if (refused) {
      assert.equal(refused.status, 503);
      assert.equal((await refused.json()).code, "lock_lost");
    }
    slow.release();
    await until(() => handles.reported, 10_000);
    assert.equal(server.books.runningCount(), 0, "the autopilot was paused");
    assert.ok(log.some((line) => /lock was lost/i.test(line)), "and the log says why");
    await assert.rejects(() => fetch(`${server.url}/api/v1/info`), "the listener is closed");
    await assert.rejects(() => fetch(`${server.adminUrl}/`), "and so is the admin panel");
    await server.close();
  } finally {
    slow.release();
    await server.close().catch(() => undefined);
    await remove(dataDir);
  }
});

test("R3: a lock lost while the server is still starting stops the start", async () => {
  const dataDir = await temporary("narrarium-lost-start-");
  try {
    await assert.rejects(() => startNarrariumServer({
      dataDir,
      port: 0,
      adminPort: 0,
      ai: createFakeAutopilotAi(),
      supervised: false,
      checkRelease: noRelease,
      tunnel: noTunnel,
      lock: async (root, onLost) => {
        setImmediate(onLost);
        return async () => undefined;
      },
    }), /lost/i);
  } finally {
    await remove(dataDir);
  }
});

/** The server exactly as it is published, in a child process. */
async function serverProcess(dataDir) {
  const home = await temporary("narrarium-lock-home-");
  const child = spawn(process.execPath, [serverEntry, "--data-root", dataDir], { env: { ...process.env, HOME: home, USERPROFILE: home, NARRARIUM_SUPERVISED: "" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const api = await until(() => /API:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1], 30_000).catch((error) => {
    throw new Error(`${error.message}: ${stdout}\n${stderr}`);
  });
  return { child, exited, api, output: () => ({ stdout, stderr }), cleanup: () => remove(home) };
}

test("R3: the real server process, whose lock helper is killed, stops and exits with an error (it used to log a line and run on)", async (t) => {
  if (process.platform !== "linux") return t.skip("the helper process of the kernel lock is Linux's");
  const dataDir = await temporary("narrarium-lost-real-");
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ version: 2, apiPort: 0, adminPort: 0 }), { mode: 0o600 });
  const proc = await serverProcess(dataDir);
  try {
    const helper = await holderOfChildOf(dataDir, proc.child.pid);
    assert.ok(helper, "the lock helper of the server process");
    process.kill(helper, "SIGKILL");
    const exit = await Promise.race([proc.exited, timeoutAfter(30_000, "still running")]);
    assert.notEqual(exit, "still running", `the server went on: ${JSON.stringify(proc.output())}`);
    assert.equal(exit.code, 1, JSON.stringify(proc.output()));
    assert.match(proc.output().stdout, /lock was lost/i);
    // And the folder is free for the server that took over.
    await (await lockDataRoot(dataDir, () => undefined))();
  } finally {
    proc.child.kill("SIGKILL");
    await proc.cleanup();
    await remove(dataDir);
  }
});

async function holderOfChildOf(root, parentPid) {
  const real = await realpath(root);
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (parent !== parentPid) continue;
    for (const descriptor of await readdir(`/proc/${entry}/fd`).catch(() => [])) {
      const target = await readlink(`/proc/${entry}/fd/${descriptor}`).catch(() => "");
      if (target.startsWith(real) && target.endsWith(".server.lock")) return Number(entry);
    }
  }
  return undefined;
}

test("R3: a closed terminal (SIGHUP) ends the server as cleanly as Ctrl+C: it exits normally and its lock is free", async (t) => {
  if (!posix) return t.skip("SIGHUP is a POSIX signal");
  const dataDir = await temporary("narrarium-hup-");
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ version: 2, apiPort: 0, adminPort: 0 }), { mode: 0o600 });
  const proc = await serverProcess(dataDir);
  try {
    proc.child.kill("SIGHUP");
    const exit = await Promise.race([proc.exited, timeoutAfter(30_000, "still running")]);
    assert.notEqual(exit, "still running");
    assert.deepEqual(exit, { code: 0, signal: null }, JSON.stringify(proc.output()));
    await (await lockDataRoot(dataDir, () => undefined))();
  } finally {
    proc.child.kill("SIGKILL");
    await proc.cleanup();
    await remove(dataDir);
  }
});

test("the helper that holds a kernel lock gets thirty seconds on Windows, where PowerShell has taken more than ten on a loaded runner, and ten elsewhere", () => {
  assert.equal(lockStartMs("win32"), 30_000);
  for (const platform of ["linux", "darwin", "freebsd"]) assert.equal(lockStartMs(platform), 10_000, platform);
  assert.equal(lockStartMs(), process.platform === "win32" ? 30_000 : 10_000, "by the system it runs on");
});
