import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeInstaller, UPDATE_MESSAGES, superviseServer } from "../dist/testing.mjs";
import { npmMetadata, oneUpdateFileAtATime, until } from "./helpers.mjs";
import { forgingRegistry, integrityFor, lockfile } from "./release-fixtures.mjs";

/** npm as the installer sees it: metadata, installs into the staging prefix, signature audit. */
function fakeNpm(options = {}) {
  const calls = [];
  const state = {
    latest: options.latest ?? "0.2.0",
    untrusted: new Set(options.untrusted ?? []),
    failInstall: new Set(options.failInstall ?? []),
    failAudit: new Set(options.failAudit ?? []),
    content: (version) => `// narrarium-server ${version}\n`,
  };
  const installedVersion = async (prefix) => JSON.parse(await readFile(path.join(prefix, "node_modules", "narrarium-server", "package.json"), "utf8")).version;
  const runner = async (command, args, commandOptions) => {
    calls.push({ command, args: [...args], env: commandOptions.env });
    assert.equal(args.at(-1), "--registry=https://registry.npmjs.org", "always the public registry");
    const spec = args.find((arg) => arg.startsWith("narrarium-server@"));
    const version = spec?.slice("narrarium-server@".length);
    if (args[0] === "view" && args[2] === "version") return { code: 0, stdout: JSON.stringify(state.latest), stderr: "" };
    if (args[0] === "view") return { code: 0, stdout: JSON.stringify(npmMetadata(version, { attested: version !== "0.1.0" && !state.untrusted.has(version) })), stderr: "" };
    if (args[0] === "install") {
      if (state.failInstall.has(version)) return { code: 1, stdout: "", stderr: "npm error 404" };
      const root = path.join(args[args.indexOf("--prefix") + 1], "node_modules", "narrarium-server");
      await mkdir(path.join(root, "dist"), { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "narrarium-server", version }));
      await writeFile(path.join(root, "dist", "cli.mjs"), "// cli\n");
      await writeFile(path.join(root, "dist", "server.mjs"), state.content(version));
      await writeFile(path.join(args[args.indexOf("--prefix") + 1], "package-lock.json"), lockfile(version, integrityFor(version)));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "audit") {
      const audited = await installedVersion(args[args.indexOf("--prefix") + 1]);
      return { code: state.failAudit.has(audited) ? 1 : 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected npm command" };
  };
  return { runner, calls, state };
}

/** Server processes started by the supervisor; `stubborn` ones ignore SIGTERM. */
function fakeChildren() {
  const list = [];
  const spawn = (serverPath, dataRoot) => {
    let finish;
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    const child = {
      serverPath,
      dataRoot,
      signals: [],
      stubborn: false,
      exited,
      kill(signal) {
        child.signals.push(signal);
        if (!child.stubborn) finish({ code: null, signal });
        return true;
      },
      exit(code = 0) {
        finish({ code, signal: null });
      },
    };
    list.push(child);
    return child;
  };
  return { list, spawn };
}

function updateRequest(version) {
  return { schemaVersion: 1, packageName: "narrarium-server", version, requestedAt: new Date().toISOString(), requestId: randomUUID(), source: "client" };
}

async function withRuntime(run, npmOptions) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-runtime-test-"));
  const npm = fakeNpm(npmOptions);
  try {
    await run(oneUpdateFileAtATime(new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, fetch: forgingRegistry().fetch })), npm, dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the installer trusts the metadata first, installs without scripts or credentials, audits and then activates", async () => {
  process.env.NPM_TOKEN = "npm_secret_token";
  try {
    await withRuntime(async (installer, npm, dataRoot) => {
      assert.equal(await installer.activeRuntime(), undefined);
      await assert.rejects(() => installer.installVersion("0.1.0"), /provenance/, "the bootstrap release only with its explicit flag");
      const first = await installer.installVersion("0.1.0", { bootstrapRegistryRelease: true });
      assert.equal(first.version, "0.1.0");
      assert.equal(first.serverPath, path.join(dataRoot, "private", "npm-runtime", "versions", "0.1.0", "dist", "server.mjs"));
      const install = npm.calls.find((call) => call.args[0] === "install");
      assert.ok(install.args.includes("--ignore-scripts"));
      // Configuration reaches npm on the command line only: not one npm_config_* variable is left in its environment.
      assert.deepEqual(Object.keys(install.env).filter((name) => /^npm_config_/i.test(name)), []);
      assert.equal(install.env.NPM_TOKEN, undefined, "npm never sees the user's tokens");
      assert.ok(npm.calls.findIndex((call) => call.args[0] === "view") < npm.calls.findIndex((call) => call.args[0] === "install"));

      const latest = await installer.installVersion();
      assert.equal(latest.version, "0.2.0");
      assert.equal((await installer.installerState()).activeVersion, "0.2.0");
      assert.deepEqual((await readdir(path.join(dataRoot, "private", "npm-runtime"))).sort(), ["active.json", "versions"], "staging folders are removed");

      npm.state.untrusted.add("0.3.0");
      await assert.rejects(() => installer.installVersion("0.3.0"), /provenance/);
      assert.equal(npm.calls.some((call) => call.args[0] === "install" && call.args.includes("narrarium-server@0.3.0")), false, "nothing is downloaded before the metadata is trusted");

      npm.state.failAudit.add("0.4.0");
      await assert.rejects(() => installer.installVersion("0.4.0"), /npm audit did not succeed/);
      assert.equal(existsSync(path.join(dataRoot, "private", "npm-runtime", "versions", "0.4.0")), false);
      assert.equal((await installer.activeRuntime()).version, "0.2.0", "a failed install keeps the active version");

      await installer.installVersion("0.2.0");
      npm.state.content = (version) => `// tampered ${version}\n`;
      await assert.rejects(() => installer.installVersion("0.2.0"), /different copy/, "an installed version is never silently replaced");
      await assert.rejects(() => installer.installVersion("0.2"), /exact semver/);
    });
  } finally {
    delete process.env.NPM_TOKEN;
  }
});

test("the supervisor installs a requested update, restarts the server on it and records the result", async () => {
  await withRuntime(async (installer) => {
    const children = fakeChildren();
    const supervised = superviseServer({ installer, currentVersion: "0.1.0", spawnChild: children.spawn, pollMs: 5, stopTimeoutMs: 2000, forwardSignals: false });
    await until(() => children.list.length === 1);
    assert.match(children.list[0].serverPath, /versions[\\/]0\.1\.0[\\/]dist[\\/]server\.mjs$/, "the first start installs the CLI's own version");

    const request = updateRequest("0.2.0");
    await installer.writeUpdateRequest(request);
    await until(() => children.list.length === 2);
    assert.deepEqual(children.list[0].signals, ["SIGTERM"], "the old server is stopped cleanly");
    assert.match(children.list[1].serverPath, /versions[\\/]0\.2\.0[\\/]/);
    const result = await installer.readUpdateResult();
    assert.equal(result.state, "completed");
    assert.equal(result.requestId, request.requestId);
    assert.equal(result.fromVersion, "0.1.0");
    assert.equal(result.version, "0.2.0");
    assert.equal(await installer.readUpdateRequest(), undefined, "the answered request is removed");

    children.list[1].exit(0);
    assert.deepEqual(await supervised, { code: 0, signal: null });
  });
});

test("a failed update keeps the previous version and is not retried by the same supervisor", async () => {
  await withRuntime(async (installer) => {
    const children = fakeChildren();
    const supervised = superviseServer({ installer, currentVersion: "0.1.0", spawnChild: children.spawn, pollMs: 5, forwardSignals: false });
    await until(() => children.list.length === 1);
    const request = updateRequest("0.3.0");
    await installer.writeUpdateRequest(request);
    await until(() => children.list.length === 2);
    assert.match(children.list[1].serverPath, /versions[\\/]0\.1\.0[\\/]/, "the previous version runs again");
    const result = await installer.readUpdateResult();
    assert.equal(result.state, "failed");
    assert.equal(result.outcome, "failed");
    assert.equal(result.message, UPDATE_MESSAGES.failed);
    assert.deepEqual(await installer.readUpdateRequest(), request, "the request stays for diagnosis");
    await sleep(60);
    assert.equal(children.list.length, 2, "the same request is not retried");
    assert.deepEqual(children.list[1].signals, []);
    children.list[1].exit(0);
    await supervised;
  }, { failInstall: ["0.3.0"] });
});

test("at most three supervised updates per hour", async () => {
  await withRuntime(async (installer) => {
    const children = fakeChildren();
    const supervised = superviseServer({ installer, currentVersion: "0.1.0", spawnChild: children.spawn, pollMs: 5, forwardSignals: false });
    await until(() => children.list.length === 1);
    for (const [index, version] of ["0.2.0", "0.3.0", "0.4.0"].entries()) {
      await installer.writeUpdateRequest(updateRequest(version));
      await until(() => children.list.length === index + 2);
    }
    const fourth = updateRequest("0.5.0");
    await installer.writeUpdateRequest(fourth);
    const limited = await until(async () => {
      const result = await installer.readUpdateResult();
      return result?.requestId === fourth.requestId ? result : undefined;
    });
    assert.equal(limited.outcome, "limited");
    assert.equal(limited.message, UPDATE_MESSAGES.limited);
    assert.equal(children.list.length, 4, "the running server is not stopped");
    assert.match(children.list[3].serverPath, /versions[\\/]0\.4\.0[\\/]/);
    children.list[3].exit(0);
    await supervised;
  });
});

test("a server that does not stop in time keeps running, and a malformed request never stops it", async () => {
  await withRuntime(async (installer, _npm, dataRoot) => {
    const children = fakeChildren();
    const supervised = superviseServer({ installer, currentVersion: "0.1.0", spawnChild: children.spawn, pollMs: 5, stopTimeoutMs: 40, forwardSignals: false });
    await until(() => children.list.length === 1);
    await writeFile(path.join(dataRoot, "private", "update-request.json"), JSON.stringify({ version: "0.2.0", command: "rm -rf /" }));
    await sleep(60);
    assert.deepEqual(children.list[0].signals, [], "an invalid request file is ignored");

    children.list[0].stubborn = true;
    const request = updateRequest("0.2.0");
    await installer.writeUpdateRequest(request);
    const stopping = await until(async () => {
      const result = await installer.readUpdateResult();
      return result?.requestId === request.requestId ? result : undefined;
    });
    assert.equal(stopping.outcome, "stopping");
    assert.equal(children.list.length, 1, "no second server is started next to the first");
    assert.equal((await installer.activeRuntime()).version, "0.1.0");
    children.list[0].exit(0);
    await supervised;
  });
});

// ---------------------------------------------------------------------------------------------
// #103: a supervisor that starts again never acts on a request that was already answered
// ---------------------------------------------------------------------------------------------

/** Start a supervisor and wait until it has started its server and looked at the request file `reads` times since (it has seen what is there), or has stopped that server. */
async function supervisorThatHasLooked(installer, { currentVersion = "0.1.0", reads = 5 } = {}) {
  const children = fakeChildren();
  let stopped = false;
  const spawn = children.spawn;
  children.spawn = (...args) => {
    const child = spawn(...args);
    if (stopped) child.exit(0);
    return child;
  };
  let seen = 0;
  const read = installer.readUpdateRequest;
  const watched = Object.create(installer);
  watched.readUpdateRequest = async () => {
    seen += 1;
    return read();
  };
  const supervised = superviseServer({ installer: watched, currentVersion, spawnChild: children.spawn, pollMs: 5, stopTimeoutMs: 2000, forwardSignals: false });
  // Whatever a test asserts, the supervisor ends with it: every server it has started, or starts, exits at once.
  const stop = async () => {
    stopped = true;
    for (const child of children.list) child.exit(0);
    await Promise.race([supervised.catch(() => undefined), sleep(3000)]);
  };
  try {
    await until(() => children.list.length >= 1);
    const from = seen;
    // A supervisor that replays a request stops its server at once: that ends the wait too, and the test says what it did.
    await until(() => seen - from >= reads || children.list[0].signals.length > 0);
  } catch (error) {
    await stop();
    throw error;
  }
  return { children, supervised, stop };
}

/** What a replay would change: the result on disk (its moment too), the npm commands, the request. */
const footprint = async (installer, npm) => ({ result: await installer.readUpdateResult(), npm: npm.calls.length, request: await installer.readUpdateRequest() });

test("#103: a supervisor that starts again does not replay a failed update, and the request stays for diagnosis", async () => {
  await withRuntime(async (installer, npm) => {
    const first = await supervisorThatHasLooked(installer);
    const request = updateRequest("0.3.0");
    await installer.writeUpdateRequest(request);
    await until(() => first.children.list.length === 2);
    assert.equal((await installer.readUpdateResult()).state, "failed");
    first.children.list[1].exit(0);
    await first.supervised;
    const before = await footprint(installer, npm);

    const again = await supervisorThatHasLooked(installer);
    try {
      assert.deepEqual(again.children.list[0].signals, [], "the running server is not stopped for it");
      assert.equal(again.children.list.length, 1);
      assert.deepEqual(await footprint(installer, npm), before, "nothing was installed or answered again");
      assert.deepEqual(before.request, request, "the answered request is still there to read");
    } finally {
      await again.stop();
    }
  }, { failInstall: ["0.3.0"] });
});

test("#103: a supervisor that starts again does not replay an update that was limited, and so cannot go past three an hour", async () => {
  await withRuntime(async (installer, npm) => {
    const first = await supervisorThatHasLooked(installer);
    for (const [index, version] of ["0.2.0", "0.3.0", "0.4.0"].entries()) {
      await installer.writeUpdateRequest(updateRequest(version));
      await until(() => first.children.list.length === index + 2);
    }
    const fourth = updateRequest("0.5.0");
    await installer.writeUpdateRequest(fourth);
    await until(async () => (await installer.readUpdateResult())?.requestId === fourth.requestId);
    assert.equal((await installer.readUpdateResult()).outcome, "limited");
    first.children.list[3].exit(0);
    await first.supervised;
    const before = await footprint(installer, npm);

    const again = await supervisorThatHasLooked(installer, { currentVersion: "0.4.0" });
    try {
      assert.deepEqual(again.children.list[0].signals, []);
      assert.deepEqual(await footprint(installer, npm), before);
      assert.equal((await installer.activeRuntime()).version, "0.4.0", "0.5.0 was not installed by a restart");
    } finally {
      await again.stop();
    }
  });
});

test("#103: a supervisor that starts again does not replay a refused rollback, nor an update whose request could not be removed", async () => {
  await withRuntime(async (installer, npm) => {
    const first = await supervisorThatHasLooked(installer);
    const done = updateRequest("0.2.0");
    await installer.writeUpdateRequest(done);
    await until(() => first.children.list.length === 2);
    assert.equal((await installer.readUpdateResult()).state, "completed");
    const back = updateRequest("0.1.0");
    await installer.writeUpdateRequest(back);
    await until(async () => (await installer.readUpdateResult())?.requestId === back.requestId);
    assert.equal((await installer.readUpdateResult()).state, "failed", "older than 0.2.0: refused");
    first.children.list[1].exit(0);
    await first.supervised;

    const beforeRefused = await footprint(installer, npm);
    const second = await supervisorThatHasLooked(installer, { currentVersion: "0.2.0" });
    try {
      assert.deepEqual(second.children.list[0].signals, []);
      assert.deepEqual(await footprint(installer, npm), beforeRefused, "the refusal is not written again");
    } finally {
      await second.stop();
    }

    // The completed update removes its request; when that removal failed, the request and its completed result are both on disk.
    const completed = { ...(await installer.readUpdateResult()), requestId: done.requestId, state: "completed", outcome: "completed", version: "0.2.0", fromVersion: "0.1.0", message: UPDATE_MESSAGES.completed };
    await installer.writeUpdateResult(completed);
    await installer.writeUpdateRequest(done);
    const beforeCompleted = await footprint(installer, npm);
    const third = await supervisorThatHasLooked(installer, { currentVersion: "0.2.0" });
    try {
      assert.deepEqual(third.children.list[0].signals, [], "the server is not stopped to install 0.2.0 again");
      assert.deepEqual(await footprint(installer, npm), beforeCompleted);
    } finally {
      await third.stop();
    }
  });
});

test("#103: a request written while the supervisor was down, which nothing answered, is honoured when it starts", async () => {
  await withRuntime(async (installer) => {
    const first = await supervisorThatHasLooked(installer);
    const failed = updateRequest("0.3.0");
    await installer.writeUpdateRequest(failed);
    await until(() => first.children.list.length === 2);
    first.children.list[1].exit(0);
    await first.supervised;

    const fresh = updateRequest("0.2.0");
    await installer.writeUpdateRequest(fresh);
    const children = fakeChildren();
    const supervised = superviseServer({ installer, currentVersion: "0.1.0", spawnChild: children.spawn, pollMs: 5, stopTimeoutMs: 2000, forwardSignals: false });
    await until(() => children.list.length === 2);
    assert.deepEqual(children.list[0].signals, ["SIGTERM"]);
    assert.match(children.list[1].serverPath, /versions[\\/]0\.2\.0[\\/]/);
    const result = await installer.readUpdateResult();
    assert.deepEqual([result.requestId, result.state], [fresh.requestId, "completed"]);
    children.list[1].exit(0);
    await supervised;
  }, { failInstall: ["0.3.0"] });
});
