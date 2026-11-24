import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as server from "../dist/testing.mjs";
import { SERVER_VERSION } from "../dist/testing.mjs";
import { adminLogin, oneUpdateFileAtATime, until, withServer } from "./helpers.mjs";
import { REAL_RELEASE, REAL_VERSION, attestationUrl, bootstrapRelease, fakeNpm, fakeRegistry, forgeRelease, latestUrl } from "./release-fixtures.mjs";

const { HIGHEST_VERSION_FILE, RollbackRefusedError, RuntimeInstaller, UPDATE_MESSAGES, checkNpmServerRelease, cliMain, prepareRuntime, superviseServer } = server;

const posix = process.platform !== "win32";
const remove = (directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const runtimeFolder = (dataRoot) => path.join(dataRoot, "private", "npm-runtime");
const recordFile = (dataRoot) => path.join(dataRoot, "private", "npm-highest.json");
const record = (highestVersion, extra = {}) => ({ schemaVersion: 1, packageName: "narrarium-server", highestVersion, recordedAt: new Date().toISOString(), ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A promise that must settle soon: a supervisor that was expected to stop must not hold a test (or the run) hostage. */
const within = (promise, ms = 5000) => Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms).unref())]);

const VERSIONS = ["0.1.1", "0.1.5", "0.2.0", "0.3.0"];

/** A data folder that has seen 0.1.1 and then 0.2.0 (0.1.5 and 0.3.0 exist on the registry, valid and trusted). */
async function withHistory(run, { install = ["0.1.1", "0.2.0"], extraReleases = [] } = {}) {
  const releases = [...VERSIONS.map((version) => forgeRelease(version)), bootstrapRelease("0.1.0"), ...extraReleases];
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-rollback-"));
  const npm = fakeNpm({ releases, latest: "0.2.0" });
  const registry = fakeRegistry({ releases, latest: "0.2.0" });
  const installer = oneUpdateFileAtATime(new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, fetch: registry.fetch }));
  try {
    for (const version of install) await installer.installVersion(version);
    await run({ installer, npm, registry, dataRoot });
  } finally {
    await remove(dataRoot);
  }
}

const refusal = (version, highest) => (error) => {
  assert.ok(error instanceof RollbackRefusedError, `a RollbackRefusedError, not ${error?.name}: ${error?.message}`);
  assert.ok(error.message.includes(version) && error.message.includes(highest), error.message);
  assert.match(error.message, /rollback --to/, "it says how to go back to a copy that is installed");
  return true;
};

const activeVersion = async (installer) => (await installer.activeRuntime())?.version;

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

test("C8 anti-rollback: the highest version ever activated is recorded atomically in the data folder, private to the user", async () => {
  await withHistory(async ({ installer, dataRoot }) => {
    assert.equal(HIGHEST_VERSION_FILE, path.join("private", "npm-highest.json"));
    const saved = JSON.parse(await readFile(recordFile(dataRoot), "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["highestVersion", "packageName", "recordedAt", "schemaVersion"]);
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.packageName, "narrarium-server");
    assert.equal(saved.highestVersion, "0.2.0");
    assert.equal(new Date(saved.recordedAt).toISOString(), saved.recordedAt);
    assert.equal(await installer.highestVersion(), "0.2.0");
    assert.deepEqual((await readdir(path.join(dataRoot, "private"))).filter((name) => name.includes(".new-")), [], "no half-written file is left");
    if (posix) assert.equal((await stat(recordFile(dataRoot))).mode & 0o777, 0o600);
  });
  // The first activation creates it, and the record never goes down by itself.
  await withHistory(async ({ installer, dataRoot }) => {
    assert.equal(await installer.highestVersion(), undefined, "a fresh data folder has seen nothing");
    assert.equal(existsSync(recordFile(dataRoot)), false, "reading it creates nothing");
    await installer.installVersion("0.1.5");
    assert.equal((await installer.highestVersion()), "0.1.5");
    await installer.installVersion("0.3.0");
    assert.equal(JSON.parse(await readFile(recordFile(dataRoot), "utf8")).highestVersion, "0.3.0");
  }, { install: [] });
});

test("C8 anti-rollback: a data folder from before the record existed is protected by the version it runs", async () => {
  await withHistory(async ({ installer, npm, dataRoot }) => {
    await rm(recordFile(dataRoot));
    assert.equal(await installer.highestVersion(), "0.2.0", "inferred from the active runtime");
    await assert.rejects(() => installer.installVersion("0.1.5"), refusal("0.1.5", "0.2.0"));
    assert.equal(existsSync(recordFile(dataRoot)), false, "refusing writes nothing");
    // Only the install state is left (the active runtime file is unreadable): still enough.
    await writeFile(path.join(runtimeFolder(dataRoot), "active.json"), "garbage");
    assert.equal(await installer.highestVersion(), "0.2.0", "inferred from the install state");
    await assert.rejects(() => installer.installVersion("0.1.5"), refusal("0.1.5", "0.2.0"));
    assert.equal(npm.names().filter((name) => name === "install").length, 2, "nothing was installed since");
    // An install is still how a damaged runtime is repaired.
    assert.equal((await installer.installVersion("0.2.0")).version, "0.2.0");
    assert.equal(JSON.parse(await readFile(recordFile(dataRoot), "utf8")).highestVersion, "0.2.0");
  });
});

test("C8 anti-rollback: a record that cannot be trusted stops installs, with a message that says what to do", async () => {
  const damaged = [
    ["not JSON", "{oops"],
    ["a list", "[]"],
    ["another schema version", JSON.stringify(record("0.2.0", { schemaVersion: 2 }))],
    ["another package", JSON.stringify(record("0.2.0", { packageName: "other" }))],
    ["a version that is not exact", JSON.stringify(record("latest"))],
    ["an extra field", JSON.stringify(record("0.2.0", { extra: true }))],
    ["a date that is not a date", JSON.stringify(record("0.2.0", { recordedAt: "yesterday" }))],
  ];
  for (const [name, text] of damaged) {
    await withHistory(async ({ installer, npm, dataRoot }) => {
      await writeFile(recordFile(dataRoot), text);
      await assert.rejects(() => installer.highestVersion(), /highest version/, name);
      const calls = npm.calls.length;
      await assert.rejects(() => installer.installVersion("0.3.0"), (error) => /npm-highest\.json/.test(error.message) && !(error instanceof RollbackRefusedError), name);
      assert.equal(npm.calls.length, calls, `${name}: not even npm was asked`);
      assert.equal(await activeVersion(installer), "0.2.0", name);
      const offer = await checkNpmServerRelease("0.2.0", fakeRegistry({ latest: "0.3.0", releases: [forgeRelease("0.3.0")] }).fetch, { highestInstalled: () => installer.highestVersion() });
      assert.equal(offer.available, false, name);
      assert.equal(offer.reason, "unavailable", name);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Every path that installs or activates
// ---------------------------------------------------------------------------------------------

test("C8 anti-rollback: an explicit older version is refused before npm is even asked, although its copy is installed and it is trusted", async () => {
  await withHistory(async ({ installer, npm, registry, dataRoot }) => {
    assert.ok(existsSync(path.join(runtimeFolder(dataRoot), "versions", "0.1.1")), "the old copy is there");
    const calls = npm.calls.length;
    const reads = registry.requests.length;
    await assert.rejects(() => installer.installVersion("0.1.1"), refusal("0.1.1", "0.2.0"));
    await assert.rejects(() => installer.installVersion("0.1.5"), refusal("0.1.5", "0.2.0"));
    await assert.rejects(() => installer.installVersion("0.1.0", { bootstrapRegistryRelease: true }), refusal("0.1.0", "0.2.0"));
    assert.equal(npm.calls.length, calls, "npm was not run");
    assert.equal(registry.requests.length, reads, "the registry was not asked");
    assert.equal(await activeVersion(installer), "0.2.0");
    assert.equal(await installer.highestVersion(), "0.2.0");
  });
});

test("C8 anti-rollback: the same version, and newer ones, still install", async () => {
  await withHistory(async ({ installer }) => {
    assert.equal((await installer.installVersion("0.2.0")).version, "0.2.0", "the installed version can be verified again");
    assert.equal((await installer.installVersion("0.3.0")).version, "0.3.0");
    assert.equal(await installer.highestVersion(), "0.3.0");
  });
});

test("C8 anti-rollback: 'latest' is refused when npm announces an older version than the one that runs, or than the highest known", async () => {
  await withHistory(async ({ installer, npm, dataRoot }) => {
    npm.state.latest = "0.1.1";
    let calls = npm.calls.length;
    await assert.rejects(() => installer.installVersion("latest"), refusal("0.1.1", "0.2.0"));
    assert.deepEqual(npm.calls.slice(calls).map((call) => call.args.slice(0, 3)), [["view", "narrarium-server", "version"]], "only the question 'what is latest' was asked");
    assert.equal(await activeVersion(installer), "0.2.0");

    // The same after a deliberate rollback: latest is above the running copy but below the highest.
    await installer.rollbackTo("0.1.1");
    npm.state.latest = "0.1.5";
    calls = npm.calls.length;
    await assert.rejects(() => installer.installVersion("latest"), refusal("0.1.5", "0.2.0"));
    assert.equal(npm.calls.length, calls + 1);
    assert.equal(await activeVersion(installer), "0.1.1");
    assert.equal(await installer.highestVersion(), "0.2.0");
    assert.equal(JSON.parse(await readFile(recordFile(dataRoot), "utf8")).highestVersion, "0.2.0");

    // And the highest itself, or something newer, is fine.
    npm.state.latest = "0.2.0";
    assert.equal((await installer.installVersion("latest")).version, "0.2.0");
  });
});

test("C8 anti-rollback: the update request file of a supervisor cannot go back either", async () => {
  await withHistory(async ({ installer, npm, dataRoot }) => {
    await supervise(installer, { currentVersion: "0.2.0" }, async ({ children, supervised }) => {
      await until(() => children.list.length === 1);
      assert.match(children.list[0].serverPath, /versions[\\/]0\.2\.0[\\/]/);
      const calls = npm.calls.length;

      const request = updateRequest("0.1.5");
      await installer.writeUpdateRequest(request);
      const result = await until(async () => {
        const answer = await installer.readUpdateResult();
        return answer?.requestId === request.requestId ? answer : undefined;
      });
      assert.equal(result.state, "failed");
      assert.equal(result.outcome, "failed");
      assert.equal(result.message, UPDATE_MESSAGES.failed);
      assert.equal(result.version, "0.1.5");
      assert.deepEqual(children.list[0].signals, [], "the running server was not even stopped");
      assert.equal(children.list.length, 1, "and no other one was started");
      assert.equal(npm.calls.length, calls, "npm was not run");
      assert.equal(await activeVersion(installer), "0.2.0");
      await sleep(40);
      assert.equal(children.list.length, 1, "the same request is not retried");

      // A legitimate update right after that still works.
      await installer.writeUpdateRequest(updateRequest("0.3.0"));
      await until(() => children.list.length === 2);
      assert.match(children.list[1].serverPath, /versions[\\/]0\.3\.0[\\/]/);
      assert.equal(JSON.parse(await readFile(recordFile(dataRoot), "utf8")).highestVersion, "0.3.0");
      children.list[1].exit(0);
      await within(supervised);
    });
  });
});

test("C8 anti-rollback: boot-time activation never installs something older than the highest version, and the supervisor says so", async () => {
  await withHistory(async ({ installer, npm, dataRoot }) => {
    // The CLI that starts the supervisor is older than what this folder has run, and no runtime is active.
    await rm(path.join(runtimeFolder(dataRoot), "active.json"));
    await supervise(installer, { currentVersion: "0.1.5" }, async ({ children, supervised }) => {
      await assert.rejects(() => within(supervised), refusal("0.1.5", "0.2.0"));
      assert.equal(children.list.length, 0, "no server was started on an older version");
    });
    assert.equal(existsSync(path.join(runtimeFolder(dataRoot), "active.json")), false);
    assert.equal(npm.names().filter((name) => name === "install").length, 2, "nothing was installed since");
  });
});

// ---------------------------------------------------------------------------------------------
// Going back on purpose: an explicit, separate operation
// ---------------------------------------------------------------------------------------------

test("C8 rollback: a copy that is already installed can be reactivated on purpose, offline, without lowering the record", async () => {
  await withHistory(async ({ installer, npm, registry, dataRoot }) => {
    const calls = npm.calls.length;
    const reads = registry.requests.length;
    const active = await installer.rollbackTo("0.1.1");
    assert.equal(active.version, "0.1.1");
    assert.equal(active.serverPath, path.join(runtimeFolder(dataRoot), "versions", "0.1.1", "dist", "server.mjs"));
    assert.equal(npm.calls.length, calls, "npm was not run");
    assert.equal(registry.requests.length, reads, "nothing was read from the registry");
    assert.equal(await activeVersion(installer), "0.1.1");
    assert.equal((await installer.installerState()).activeVersion, "0.1.1");
    assert.equal(await installer.highestVersion(), "0.2.0", "the record stays where it was");
    assert.equal(JSON.parse(await readFile(recordFile(dataRoot), "utf8")).highestVersion, "0.2.0");

    // Updates are as strict as before: nothing below the highest is installed from npm ...
    await assert.rejects(() => installer.installVersion("0.1.5"), refusal("0.1.5", "0.2.0"));
    await assert.rejects(() => installer.installVersion("0.1.1"), refusal("0.1.1", "0.2.0"));
    // ... and the way forward is open.
    assert.equal((await installer.installVersion("0.2.0")).version, "0.2.0");
    assert.equal((await installer.installVersion("0.3.0")).version, "0.3.0");
  });
});

test("C8 rollback: the supervisor starts whatever is active, a copy that was put back on purpose included", async () => {
  await withHistory(async ({ installer }) => {
    await installer.rollbackTo("0.1.1");
    await supervise(installer, { currentVersion: "0.1.1" }, async ({ children, supervised }) => {
      await until(() => children.list.length === 1);
      assert.match(children.list[0].serverPath, /versions[\\/]0\.1\.1[\\/]/, "not refused for being older than the record");
      children.list[0].exit(0);
      assert.deepEqual(await within(supervised), { code: 0, signal: null });
    });
  });
});

test("C8 rollback: a failed update still leaves the previous version running", async () => {
  await withHistory(async ({ installer, npm }) => {
    npm.state.failInstall.add("0.3.0");
    await supervise(installer, { currentVersion: "0.2.0" }, async ({ children, supervised }) => {
      await until(() => children.list.length === 1);
      await installer.writeUpdateRequest(updateRequest("0.3.0"));
      await until(() => children.list.length === 2);
      assert.match(children.list[1].serverPath, /versions[\\/]0\.2\.0[\\/]/);
      assert.equal((await installer.readUpdateResult()).state, "failed");
      children.list[1].exit(0);
      await within(supervised);
    });
  });
});

test("C8 rollback: a version that is not installed here cannot be rolled back to, and nothing changes", async () => {
  await withHistory(async ({ installer, npm, dataRoot }) => {
    const calls = npm.calls.length;
    await assert.rejects(() => installer.rollbackTo("0.1.5"), (error) => /not installed/.test(error.message) && error.message.includes("0.1.1") && error.message.includes("0.2.0"));
    await assert.rejects(() => installer.rollbackTo("0.1"), /exact semver/);
    await assert.rejects(() => installer.rollbackTo("latest"), /exact semver/);
    // A copy that is damaged is not activated either.
    await rm(path.join(runtimeFolder(dataRoot), "versions", "0.1.1", "dist", "server.mjs"));
    await assert.rejects(() => installer.rollbackTo("0.1.1"), /incomplete|does not match/);
    assert.equal(npm.calls.length, calls);
    assert.equal(await activeVersion(installer), "0.2.0");
    assert.equal(await installer.highestVersion(), "0.2.0");
  });
});

test("C8 rollback: the record also guards what the real 0.1.2 started (the published release is the floor of a folder that ran it)", async () => {
  await withHistory(async ({ installer }) => {
    assert.equal(await installer.highestVersion(), REAL_VERSION);
    await assert.rejects(() => installer.installVersion("0.1.1"), refusal("0.1.1", REAL_VERSION));
    assert.equal((await installer.installVersion(REAL_VERSION)).version, REAL_VERSION);
  }, { install: [REAL_VERSION], extraReleases: [REAL_RELEASE] });
});

// ---------------------------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------------------------

test("C8 anti-rollback: an update below the highest version is never offered", async () => {
  const releases = [forgeRelease("0.1.5"), forgeRelease("0.2.0"), forgeRelease("0.3.0")];
  const offer = (installed, latest, highest) => checkNpmServerRelease(installed, fakeRegistry({ latest, releases }).fetch, { highestInstalled: async () => highest });
  const refused = await offer("0.1.1", "0.1.5", "0.2.0");
  assert.equal(refused.available, false);
  assert.equal(refused.signed, false);
  assert.equal(refused.reason, "no_trusted_release");
  assert.equal(refused.latestVersion, undefined);
  assert.match(refused.message, /0\.1\.5 is not offered/);
  assert.match(refused.message, /0\.2\.0/);
  assert.equal((await offer("0.1.1", "0.2.0", "0.2.0")).available, true, "the highest itself is a way forward from a rolled-back copy");
  assert.equal((await offer("0.1.1", "0.3.0", "0.2.0")).available, true);
  assert.equal((await offer("0.1.1", "0.3.0", undefined)).available, true, "no record, no floor");
  assert.equal((await offer("0.3.0", "0.2.0", "0.3.0")).reason, "up_to_date", "older than what runs: nothing to say");
  // The registry is not asked for an attestation of something that is refused anyway.
  const registry = fakeRegistry({ latest: "0.1.5", releases });
  await checkNpmServerRelease("0.1.1", registry.fetch, { highestInstalled: async () => "0.2.0" });
  assert.deepEqual(registry.urls(), [latestUrl]);
  const readable = fakeRegistry({ latest: "0.3.0", releases });
  await checkNpmServerRelease("0.1.1", readable.fetch, { highestInstalled: async () => "0.2.0" });
  assert.deepEqual(readable.urls(), [latestUrl, attestationUrl("0.3.0")]);
});

test("C8 anti-rollback: the update endpoints of the server follow the record (API and admin panel)", async () => {
  // Versions far from the server's own, so that the test does not age with the releases.
  const releases = [forgeRelease("8.0.0"), forgeRelease("9.0.0")];
  const original = globalThis.fetch;
  const install = (latest) => {
    const registry = fakeRegistry({ latest, releases });
    globalThis.fetch = (input, init) => (String(input).startsWith("https://registry.npmjs.org/") ? registry.fetch(input, init) : original(input, init));
    return registry;
  };
  const plant = (serverInstance, text) => mkdir(path.join(serverInstance.data.root, "private"), { recursive: true }).then(() => writeFile(path.join(serverInstance.data.root, "private", "npm-highest.json"), text));
  try {
    // No record: the newer, attested release is offered, and only that one can be requested.
    install("9.0.0");
    await withServer(async (_server, client) => {
      const info = await client.updates();
      assert.equal(info.available, true);
      assert.equal(info.latestVersion, "9.0.0");
      await assert.rejects(() => client.requestUpdate("0.0.1", SERVER_VERSION), (error) => error.status === 409 && error.code === "release", "an older explicit version through the API");
    }, { checkRelease: undefined, supervised: true, scopes: ["read", "write", "run", "update"] });

    // A record above the offered release: it is not offered and cannot be requested, and the owner can read why in the log.
    install("9.0.0");
    const logged = [];
    await withServer(async (serverInstance, client) => {
      await plant(serverInstance, JSON.stringify(record("9.5.0")));
      const info = await client.updates();
      assert.ok(logged.some((line) => /^Update not offered: Version 9\.0\.0 is not offered/.test(line)), logged.join("\n"));
      assert.equal(info.available, false);
      assert.equal(info.canRequest, false);
      assert.equal(info.reason, "no_trusted_release");
      assert.equal(info.latestVersion, undefined);
      assert.match(info.message, /9\.0\.0 is not offered/);
      await assert.rejects(() => client.requestUpdate("9.0.0", SERVER_VERSION), (error) => error.status === 409 && error.code === "release");
      const admin = await adminLogin(serverInstance);
      const refused = await admin.call("POST", "/admin/api/updates", { version: "9.0.0", installedVersion: SERVER_VERSION });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, "release");
      const lower = await admin.call("POST", "/admin/api/updates", { version: "0.0.1", installedVersion: SERVER_VERSION });
      assert.equal(lower.status, 409);
      assert.equal(await readFile(path.join(serverInstance.data.root, "private", "update-request.json"), "utf8").catch(() => null), null, "no request was written");
    }, { checkRelease: undefined, supervised: true, scopes: ["read", "write", "run", "update"], log: (line) => logged.push(line) });

    // A record that cannot be read: the check says so instead of offering anything.
    install("9.0.0");
    await withServer(async (serverInstance, client) => {
      await plant(serverInstance, "{oops");
      const info = await client.updates();
      assert.equal(info.available, false);
      assert.equal(info.reason, "unavailable");
    }, { checkRelease: undefined, supervised: true, scopes: ["read", "write", "run", "update"] });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

/** Without the hooks, `main` would run the machine's real npm against the real registry: these tests must never get that far. */
function assertCliHooks() {
  assert.equal(typeof prepareRuntime, "function", "the CLI has no hook for a fake installer");
}

/** `main` with a fake installer and captured output. */
async function runCli(argv, installer) {
  assertCliHooks();
  const out = [];
  const err = [];
  const code = await cliMain(argv, {}, { createInstaller: () => installer, stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
  return { code, out: out.join(""), err: err.join("") };
}

test("C8 anti-rollback (CLI): `update --to` an older version fails and says how to go back; `rollback --to` does it on purpose", async () => {
  await withHistory(async ({ installer, npm, dataRoot }) => {
    const calls = npm.calls.length;
    const refused = await runCli(["update", "--data-root", dataRoot, "--to", "0.1.1"], installer);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /0\.1\.1 is older than 0\.2\.0/);
    assert.match(refused.err, /rollback --to 0\.1\.1/);
    assert.equal(npm.calls.length, calls);
    assert.equal(await activeVersion(installer), "0.2.0");

    const done = await runCli(["rollback", "--data-root", dataRoot, "--to", "0.1.1"], installer);
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, /0\.2\.0 → 0\.1\.1/);
    assert.match(done.out, /nothing was downloaded/i);
    assert.equal(await activeVersion(installer), "0.1.1");

    const missing = await runCli(["rollback", "--data-root", dataRoot, "--to", "0.1.9"], installer);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /not installed/);

    const withoutVersion = await runCli(["rollback", "--data-root", dataRoot], installer);
    assert.equal(withoutVersion.code, 2);
    assert.match(withoutVersion.err, /--to/);
    const notAVersion = await runCli(["rollback", "--data-root", dataRoot, "--to", "1.2"], installer);
    assert.equal(notAVersion.code, 2);
    assert.match(notAVersion.err, /exact semver/);

    const forward = await runCli(["update", "--data-root", dataRoot, "--to", "0.3.0"], installer);
    assert.equal(forward.code, 0, forward.err);
    assert.match(forward.out, /0\.1\.1 → 0\.3\.0/);
  });
});

test("C8 anti-rollback (CLI): `setup` installs the CLI's own version, but not over a newer one, and says which command to run instead", async () => {
  assertCliHooks();
  const own = SERVER_VERSION.replaceAll(".", "\\.");
  await withHistory(async ({ installer, dataRoot }) => {
    const refused = await runCli(["setup", "--data-root", dataRoot], installer);
    assert.equal(refused.code, 1);
    assert.match(refused.err, new RegExp(`Version ${own} is older than 90\\.0\\.0`));
    assert.match(refused.err, /npx narrarium-server@latest setup/);
    assert.equal(await activeVersion(installer), "90.0.0", "the newer runtime stays");
  }, { install: ["90.0.0"], extraReleases: [forgeRelease("90.0.0")] });
  await withHistory(async ({ installer, dataRoot }) => {
    const done = await runCli(["setup", "--data-root", dataRoot], installer);
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, new RegExp(`personal server ${own} installed in`));
    assert.equal(await activeVersion(installer), SERVER_VERSION);
  }, { install: [], extraReleases: [forgeRelease(SERVER_VERSION)] });
});

test("C8 anti-rollback (CLI): `status` shows the highest version, so a refusal can be understood", async () => {
  await withHistory(async ({ installer, dataRoot }) => {
    // Ports that nothing listens on: `status` asks whether a server answers there.
    await writeFile(path.join(dataRoot, "config.json"), JSON.stringify({ version: 2, apiPort: 1, adminPort: 2 }), { mode: 0o600 });
    const shown = await runCli(["status", "--data-root", dataRoot], installer);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Active runtime: 0\.2\.0/);
    assert.match(shown.out, /Highest ever:\s+0\.2\.0 \(nothing older is installed from npm\)/);
    await installer.rollbackTo("0.1.1");
    const afterwards = await runCli(["status", "--data-root", dataRoot], installer);
    assert.match(afterwards.out, /Active runtime: 0\.1\.1/);
    assert.match(afterwards.out, /Highest ever:\s+0\.2\.0/);
    await writeFile(recordFile(dataRoot), "{oops");
    assert.match((await runCli(["status", "--data-root", dataRoot], installer)).out, /Highest ever:\s+unreadable/);
  });
});

test("C8 anti-rollback (CLI): help and parsing know the new command", () => {
  assert.equal(server.parseCommand(["rollback", "--to", "0.1.1"]).requestedVersion, "0.1.1");
  assert.equal(server.parseCommand(["rollback", "--to", "0.1.1"]).command, "rollback");
  assert.throws(() => server.parseCommand(["rollback"]), /--to/);
  assert.throws(() => server.parseCommand(["rollback", "--to", "1.2"]), /exact semver/);
  assert.throws(() => server.parseCommand(["start", "--to", "0.1.1"]), /not allowed/);
  assert.match(server.HELP, /rollback \[--data-root DIR\] --to VERSION/);
});

test("C8 anti-rollback (CLI): `start` prepares the runtime like before, but never installs an older version, and never hides that behind the direct mode", async () => {
  assertCliHooks();
  const lines = [];
  const say = (line) => lines.push(line);
  // A fresh folder: the CLI's own version is installed (the bootstrap flag lets the hand-published 0.1.0 in).
  await withHistory(async ({ installer, npm }) => {
    assert.equal(await prepareRuntime(installer, "0.1.1", say), "supervised");
    assert.equal(await activeVersion(installer), "0.1.1");
    assert.deepEqual(npm.names().filter((name) => name === "install"), ["install"]);
  }, { install: [] });
  // The active runtime is newer than the CLI: nothing is installed, nothing is asked.
  await withHistory(async ({ installer, npm }) => {
    const calls = npm.calls.length;
    assert.equal(await prepareRuntime(installer, "0.1.5", say), "supervised");
    assert.equal(npm.calls.length, calls);
    assert.equal(await activeVersion(installer), "0.2.0");
  });
  // The active runtime is older than the CLI: the CLI's own version replaces it.
  await withHistory(async ({ installer }) => {
    assert.equal(await prepareRuntime(installer, "0.3.0", say), "supervised");
    assert.equal(await activeVersion(installer), "0.3.0");
  });
  // No runtime, and a CLI older than the highest version this folder ran: refused, loudly.
  await withHistory(async ({ installer, dataRoot }) => {
    await rm(path.join(runtimeFolder(dataRoot), "active.json"));
    await assert.rejects(() => prepareRuntime(installer, "0.1.5", say), refusal("0.1.5", "0.2.0"));
  });
  // A runtime exists (put back on purpose), and the CLI sits between it and the highest: the runtime is kept.
  await withHistory(async ({ installer }) => {
    await installer.rollbackTo("0.1.1");
    lines.length = 0;
    assert.equal(await prepareRuntime(installer, "0.1.5", say), "supervised");
    assert.equal(await activeVersion(installer), "0.1.1");
    assert.match(lines.join("\n"), /Keeping the installed runtime/);
  });
  // Any other failure to prepare the runtime keeps the old way out: the CLI's own copy, directly.
  await withHistory(async ({ installer, npm }) => {
    npm.state.failInstall.add("0.3.0");
    assert.equal(await prepareRuntime(installer, "0.3.0", say), "supervised", "the runtime that exists is kept");
  });
  await withHistory(async ({ installer, npm }) => {
    npm.state.failInstall.add("0.3.0");
    assert.equal(await prepareRuntime(installer, "0.3.0", say), "direct");
  }, { install: [] });
});

// ---------------------------------------------------------------------------------------------
// Supervisor doubles
// ---------------------------------------------------------------------------------------------

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
      exited,
      kill(signal) {
        child.signals.push(signal);
        finish({ code: null, signal });
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

/** Runs a supervisor over fake children; whatever the test does, every child is ended and the supervisor is awaited afterwards. */
async function supervise(installer, options, run) {
  const children = fakeChildren();
  const supervised = superviseServer({ installer, spawnChild: children.spawn, pollMs: 5, stopTimeoutMs: 2000, forwardSignals: false, log: () => undefined, ...options });
  let done = false;
  supervised.then(() => (done = true), () => (done = true));
  try {
    await run({ children, supervised });
  } finally {
    const deadline = Date.now() + 5000;
    while (!done && Date.now() < deadline) {
      for (const child of children.list) child.exit(0);
      await sleep(10);
    }
    await supervised.catch(() => undefined);
  }
}

function updateRequest(version) {
  return { schemaVersion: 1, packageName: "narrarium-server", version, requestedAt: new Date().toISOString(), requestId: randomUUID(), source: "client" };
}
