import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { adminLogin, noRelease, oneUpdateFileAtATime, until, withServer } from "./helpers.mjs";
import { logCollector } from "./oauth-helpers.mjs";
import { REGISTRY_KEY, bootstrapRelease, fakeNpm, fakeRegistry, forgeRelease, keyEntry, keysDocument, keysUrl, makeRegistryKey, npmFailures, registrySignature, signedVersionDocument, versionUrl, withoutPublishAttestation } from "./release-fixtures.mjs";

// The history of the updates (P12): the last ones, with the version they went from and to, how they ended, when, what the server checked on the way (the registry's signature,
// the provenance, `npm audit signatures`) and, for a refusal, the reason. The supervisor, which does the install, writes down what it verified (`private/update-verification.json`,
// next to the result it always wrote, whose format is not changed); the server joins the request, the result and that record into a short, bounded history
// (`update-history.json`). Everything is read through the namespace, so a missing export fails the test that needs it and nothing else.

const { RuntimeInstaller, SERVER_VERSION, UPDATE_MESSAGES, UpdateHistory, startNarrariumServer, superviseServer } = testing;

const V = "0.2.0";
const slsaOnly = (version) => withoutPublishAttestation(forgeRelease(version));
const json = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
const remove = (directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const names = (verification) => verification.checks.map((entry) => `${entry.check}:${entry.result}`);

// ---------------------------------------------------------------------------------------------
// The supervisor writes down what it verified
// ---------------------------------------------------------------------------------------------

function fakeChildren({ stubborn = false } = {}) {
  const list = [];
  let stopped = false;
  const spawn = (serverPath, dataRoot) => {
    let finish;
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    const child = {
      serverPath,
      dataRoot,
      signals: [],
      stubborn,
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
    if (stopped) child.exit(0);
    return child;
  };
  const stopAll = () => {
    stopped = true;
    for (const child of list) child.exit(0);
  };
  return { list, spawn, stopAll };
}

const updateRequest = (version, source = "admin") => ({ schemaVersion: 1, packageName: "narrarium-server", version, requestedAt: new Date().toISOString(), requestId: randomUUID(), source });

/** A supervisor over a fake npm and a fake registry, stopped whatever the test does. */
async function withSupervisor({ releases, latest, currentVersion, auditOutput = {}, routes, stubborn = false, failInstall = [] }, run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-history-"));
  const npm = fakeNpm({ releases, latest });
  for (const [version, output] of Object.entries(auditOutput)) npm.state.auditOutput.set(version, output);
  for (const version of failInstall) npm.state.failInstall.add(version);
  const registry = fakeRegistry({ releases, latest, routes });
  const installer = oneUpdateFileAtATime(new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, fetch: registry.fetch }));
  const lines = [];
  const children = fakeChildren({ stubborn });
  const supervised = superviseServer({ installer, currentVersion, spawnChild: children.spawn, pollMs: 5, stopTimeoutMs: 150, forwardSignals: false, log: (line) => lines.push(line) });
  supervised.catch(() => undefined);
  try {
    await run({ installer, children, supervised, lines, dataRoot, npm });
  } finally {
    children.stopAll();
    await Promise.race([supervised.catch(() => undefined), sleep(3000)]);
    await remove(dataRoot);
  }
}

/** Ask for an update and wait for the supervisor's answer to that very request. */
async function ask(installer, version) {
  const request = updateRequest(version, "client");
  await installer.writeUpdateRequest(request);
  const result = await until(async () => {
    const found = await installer.readUpdateResult().catch(() => undefined);
    return found?.requestId === request.requestId ? found : undefined;
  }, 15_000);
  return { request, result };
}

/** The same, and what the supervisor wrote down about it. */
async function updateTo(installer, version) {
  const answer = await ask(installer, version);
  return { ...answer, verification: await installer.readUpdateVerification() };
}

test("P12 verification: an update that passes every check says so, in the order the checks were made, and the result it always wrote is what it was", async () => {
  const releases = [bootstrapRelease("0.1.0"), forgeRelease(V)];
  await withSupervisor({ releases, latest: V, currentVersion: "0.1.0" }, async ({ installer, children, dataRoot }) => {
    await until(() => children.list.length === 1);
    const { request, result, verification } = await updateTo(installer, V);
    assert.equal(result.state, "completed");
    assert.deepEqual(Object.keys(result).sort(), ["at", "fromVersion", "message", "outcome", "requestId", "schemaVersion", "state", "version"], "the result has the fields it always had, and no more");
    assert.equal(result.message, UPDATE_MESSAGES.completed);
    assert.deepEqual([verification.requestId, verification.version, verification.fromVersion, verification.schemaVersion], [request.requestId, V, "0.1.0", 1]);
    assert.equal(new Date(verification.at).toISOString(), verification.at);
    assert.deepEqual(names(verification), [
      "rollback:passed", "metadata:passed", "provenance:passed", "registry-signature:passed", "install:passed", "integrity:passed",
      "audit-signatures:passed", "provenance:passed", "registry-signature:passed", "package:passed",
    ]);
    const file = path.join(dataRoot, "private", "update-verification.json");
    assert.ok((await stat(file)).size < 16 * 1024, "small");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600, "private");
    await until(() => children.list.length === 2);
  });
});

test("P12 verification: a release that has only the SLSA provenance, which an older npm refuses and the server accepts on its own checks, says that the audit was not able to finish", async () => {
  const releases = [bootstrapRelease("0.1.0"), slsaOnly(V)];
  await withSupervisor({ releases, latest: V, currentVersion: "0.1.0", auditOutput: { [V]: npmFailures.missingAttestationKey(V, { tuf: true }) } }, async ({ installer, children }) => {
    await until(() => children.list.length === 1);
    const { result, verification } = await updateTo(installer, V);
    assert.equal(result.state, "completed");
    const audit = verification.checks.find((entry) => entry.check === "audit-signatures");
    assert.deepEqual([audit.result, audit.code], ["tolerated", "EMISSINGSIGNATUREKEY"], "accepted, and why npm said no");
    assert.ok(verification.checks.filter((entry) => entry.check !== "audit-signatures").every((entry) => entry.result === "passed"), "everything the server checked itself passed");
  });
});

test("P12 verification: a release whose provenance names another workflow is refused before anything is downloaded, with the reason in words", async () => {
  const releases = [bootstrapRelease("0.1.0"), forgeRelease("0.3.0", { owner: "Attacker" })];
  await withSupervisor({ releases, latest: "0.3.0", currentVersion: "0.1.0" }, async ({ installer, children, npm }) => {
    await until(() => children.list.length === 1);
    const { result, verification } = await updateTo(installer, "0.3.0");
    assert.equal(result.state, "failed");
    assert.deepEqual(names(verification), ["rollback:passed", "metadata:passed", "provenance:refused"]);
    const refused = verification.checks.at(-1);
    assert.match(refused.reason, /Narrarium publishing workflow/, "which claim was wrong");
    assert.ok(refused.reason.length <= 300);
    assert.equal(npm.calls.some((call) => call.args[0] === "install" && call.args.includes("narrarium-server@0.3.0")), false, "nothing was downloaded");
  });
});

test("P12 verification: a signature of the registry that does not hold, a registry that cannot be read, and a release without usable metadata each say which check said no and in what way", async () => {
  const release = forgeRelease("0.3.0");
  const cases = [
    ["a signature by a key the registry does not list", { routes: { [versionUrl("0.3.0")]: () => json(signedVersionDocument(release, [registrySignature(makeRegistryKey(), "0.3.0", release.integrity)])) } }, ["rollback:passed", "metadata:passed", "provenance:passed", "registry-signature:refused"], /does not list/],
    // (The supervisor's own first install reads the keys once, and has to be able to: the registry fails from the second read.)
    ["a list of keys that cannot be read", { routes: { [keysUrl]: (nth) => (nth === 1 ? json(keysDocument(keyEntry(REGISTRY_KEY))) : json({ error: "boom" }, 500)) } }, ["rollback:passed", "metadata:passed", "provenance:passed", "registry-signature:unreadable"], /could not be checked/],
  ];
  for (const [name, extra, expected, reason] of cases) {
    await withSupervisor({ releases: [bootstrapRelease("0.1.0"), release], latest: "0.3.0", currentVersion: "0.1.0", ...extra }, async ({ installer, children }) => {
      await until(() => children.list.length === 1);
      const { result, verification } = await updateTo(installer, "0.3.0");
      assert.equal(result.state, "failed", name);
      assert.deepEqual(names(verification), expected, name);
      assert.match(verification.checks.at(-1).reason, reason, name);
    });
  }
  // A release that npm does not call attested at all.
  const bare = forgeRelease("0.3.0");
  delete bare.packument.dist.attestations;
  await withSupervisor({ releases: [bootstrapRelease("0.1.0"), bare], latest: "0.3.0", currentVersion: "0.1.0" }, async ({ installer, children }) => {
    await until(() => children.list.length === 1);
    const { result, verification } = await updateTo(installer, "0.3.0");
    assert.equal(result.state, "failed");
    assert.deepEqual(names(verification), ["rollback:passed", "metadata:refused"]);
    assert.equal(verification.checks.at(-1).reason, undefined, "a fixed refusal needs no text of its own: the check says it");
  });
});

test("P12 verification: `npm audit signatures` that refuses a release says so, with the code npm printed and nothing else of what it printed", async () => {
  const release = forgeRelease("0.3.0");
  const planted = { code: 1, stdout: "", stderr: "npm error code EMISSINGSIGNATUREKEY\nnpm error //registry.npmjs.org/:_authToken=npm_SECRET-TOKEN-1234\nnpm error narrarium-server@0.3.0 has attestations but no corresponding public key(s) can be found\nnpm error A complete log of this run can be found in: /home/owner/.local/share/narrarium-server/private/npm-home/cache/_logs/x.log\n" };
  await withSupervisor({ releases: [bootstrapRelease("0.1.0"), release], latest: "0.3.0", currentVersion: "0.1.0", auditOutput: { "0.3.0": planted } }, async ({ installer, children, dataRoot }) => {
    await until(() => children.list.length === 1);
    const { result, verification } = await updateTo(installer, "0.3.0");
    assert.equal(result.state, "failed", "a release that carries the publish attestation gets no tolerance");
    assert.deepEqual(names(verification), ["rollback:passed", "metadata:passed", "provenance:passed", "registry-signature:passed", "install:passed", "integrity:passed", "audit-signatures:refused"]);
    assert.deepEqual([verification.checks.at(-1).code, verification.checks.at(-1).reason], ["EMISSINGSIGNATUREKEY", undefined]);
    const text = await readFile(path.join(dataRoot, "private", "update-verification.json"), "utf8");
    for (const leak of ["npm_SECRET-TOKEN-1234", "_authToken", "/home/owner", "private/npm-home"]) assert.equal(text.includes(leak), false, `not in the record: ${leak}`);
  });
  const invalid = npmFailures.invalidSignature("0.3.0");
  await withSupervisor({ releases: [bootstrapRelease("0.1.0"), release], latest: "0.3.0", currentVersion: "0.1.0", auditOutput: { "0.3.0": invalid } }, async ({ installer, children }) => {
    await until(() => children.list.length === 1);
    const { verification } = await updateTo(installer, "0.3.0");
    const audit = verification.checks.at(-1);
    assert.deepEqual([audit.check, audit.result, audit.code], ["audit-signatures", "refused", undefined], "npm that printed no code leaves none");
  });
});

test("P12 verification: an install that npm could not do, and a version older than the highest one ever installed, are told apart from a refusal of a signature", async () => {
  const releases = [bootstrapRelease("0.1.0"), forgeRelease("0.3.0"), forgeRelease("0.4.0")];
  await withSupervisor({ releases, latest: "0.4.0", currentVersion: "0.1.0", failInstall: ["0.3.0"] }, async ({ installer, children }) => {
    await until(() => children.list.length === 1);
    const failedInstall = await updateTo(installer, "0.3.0");
    assert.equal(failedInstall.result.state, "failed");
    assert.deepEqual(names(failedInstall.verification), ["rollback:passed", "metadata:passed", "provenance:passed", "registry-signature:passed", "install:failed"]);
    await until(() => children.list.length === 2, 15_000);
    const fine = await updateTo(installer, "0.4.0");
    assert.equal(fine.result.state, "completed");
    await until(() => children.list.length === 3, 15_000);
    const back = await updateTo(installer, "0.3.0");
    assert.equal(back.result.state, "failed", "never an older version");
    assert.deepEqual(names(back.verification), ["rollback:refused"]);
    assert.match(back.verification.checks[0].reason, /older than 0\.4\.0/);
    assert.equal(children.list.length, 3, "and the running server was not stopped for it");
  });
});

test("P12 verification: an update the supervisor did not do (too many in an hour, a server that did not stop) leaves no record of verification, and the result says it", async () => {
  const releases = [bootstrapRelease("0.1.0"), forgeRelease("0.2.0"), forgeRelease("0.3.0"), forgeRelease("0.4.0"), forgeRelease("0.5.0")];
  await withSupervisor({ releases, latest: "0.5.0", currentVersion: "0.1.0" }, async ({ installer, children }) => {
    await until(() => children.list.length === 1);
    for (const [index, version] of ["0.2.0", "0.3.0", "0.4.0"].entries()) {
      assert.equal((await updateTo(installer, version)).result.state, "completed");
      await until(() => children.list.length === index + 2, 15_000);
    }
    const fourth = await updateTo(installer, "0.5.0");
    assert.equal(fourth.result.outcome, "limited");
    assert.notEqual(fourth.verification?.requestId, fourth.request.requestId, "nothing was verified for it: the record that is there is of the update before");
  });
  await withSupervisor({ releases: [bootstrapRelease("0.1.0"), forgeRelease("0.2.0")], latest: "0.2.0", currentVersion: "0.1.0", stubborn: true }, async ({ installer, children }) => {
    await until(() => children.list.length === 1);
    const stuck = await updateTo(installer, "0.2.0");
    assert.equal(stuck.result.outcome, "stopping");
    assert.notEqual(stuck.verification?.requestId, stuck.request.requestId);
  });
});

test("P12 verification: a record that cannot be written never fails an update", async () => {
  await withSupervisor({ releases: [bootstrapRelease("0.1.0"), forgeRelease(V), forgeRelease("0.3.0")], latest: "0.3.0", currentVersion: "0.1.0" }, async ({ installer, children, dataRoot }) => {
    await until(() => children.list.length === 1);
    const first = await updateTo(installer, V);
    assert.equal(first.result.state, "completed");
    assert.equal(first.verification.requestId, first.request.requestId, "when it can be written, it is");
    await until(() => children.list.length === 2);
    const file = path.join(dataRoot, "private", "update-verification.json");
    await rm(file);
    await mkdir(file, { recursive: true });
    const { result } = await ask(installer, "0.3.0");
    assert.equal(result.state, "completed", "the update is what counts");
    await until(() => children.list.length === 3);
    assert.equal((await installer.activeRuntime()).version, "0.3.0");
  });
});

test("P12 verification: the record is read strictly: a file that is not what the supervisor writes is no verification", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-history-"));
  try {
    const installer = new RuntimeInstaller({ dataRoot });
    const file = path.join(dataRoot, "private", "update-verification.json");
    await mkdir(path.join(dataRoot, "private"), { recursive: true });
    const good = { schemaVersion: 1, requestId: randomUUID(), version: V, fromVersion: "0.1.0", at: new Date().toISOString(), checks: [{ check: "provenance", result: "passed" }] };
    await writeFile(file, JSON.stringify(good));
    assert.deepEqual(await installer.readUpdateVerification(), good);
    const bad = [
      { ...good, requestId: "not-a-uuid" },
      { ...good, version: "latest" },
      { ...good, checks: [{ check: "magic", result: "passed" }] },
      { ...good, checks: [{ check: "provenance", result: "great" }] },
      { ...good, checks: Array.from({ length: 30 }, () => ({ check: "provenance", result: "passed" })) },
      { ...good, checks: [{ check: "provenance", result: "refused", reason: "x".repeat(400) }] },
      { ...good, checks: [{ check: "provenance", result: "refused", code: "not a code!" }] },
      { ...good, extra: "field" },
      { ...good, checks: "none" },
    ];
    for (const record of bad) {
      await writeFile(file, JSON.stringify(record));
      await assert.rejects(() => installer.readUpdateVerification(), undefined, JSON.stringify(record).slice(0, 80));
    }
    await writeFile(file, "x".repeat(20_000));
    await assert.rejects(() => installer.readUpdateVerification(), undefined, "a file that is too large");
    await rm(file);
    await symlink(path.join(dataRoot, "private"), file).catch(() => undefined);
    if (process.platform !== "win32") await assert.rejects(() => installer.readUpdateVerification(), undefined, "a link is not followed");
    await rm(file, { force: true });
    assert.equal(await installer.readUpdateVerification(), undefined, "no file, no record");
  } finally {
    await remove(dataRoot);
  }
});

// ---------------------------------------------------------------------------------------------
// The history the server keeps
// ---------------------------------------------------------------------------------------------

const priv = (server, name) => path.join(server.data.root, "private", name);
const writeRequest = (server, request) => writeFile(priv(server, "update-request.json"), JSON.stringify(request));
const resultOf = (requestId, outcome, { version = V, from = SERVER_VERSION, at = new Date().toISOString() } = {}) => ({ schemaVersion: 1, requestId, state: outcome === "completed" ? "completed" : "failed", outcome, version, fromVersion: from, at, message: UPDATE_MESSAGES[outcome] });
const writeResult = (server, result) => writeFile(priv(server, "update-result.json"), JSON.stringify(result));
const verificationOf = (requestId, checks, { version = V, from = SERVER_VERSION } = {}) => ({ schemaVersion: 1, requestId, version, fromVersion: from, at: new Date().toISOString(), checks });
const writeVerification = (server, record) => writeFile(priv(server, "update-verification.json"), JSON.stringify(record));
const history = async (owner) => {
  const answer = await owner.call("GET", "/admin/api/updates/history");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
const passed = (...checks) => checks.map((check) => ({ check, result: "passed" }));
const EVERYTHING = passed("rollback", "metadata", "provenance", "registry-signature", "install", "integrity", "audit-signatures", "provenance", "registry-signature", "package");

test("P12 history: an update that completed is a row with its versions, its times, who asked for it and what was checked, once for each check", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const request = updateRequest(V, "admin");
    await writeRequest(server, request);
    await writeVerification(server, verificationOf(request.requestId, EVERYTHING));
    await writeResult(server, resultOf(request.requestId, "completed", { from: "0.1.9", version: V }));
    const body = await history(owner);
    assert.equal(body.max, 20);
    assert.equal(body.entries.length, 1);
    const [entry] = body.entries;
    assert.deepEqual([entry.id, entry.kind, entry.state, entry.from, entry.to, entry.by, entry.requestedAt], [request.requestId, "update", "completed", "0.1.9", V, "admin", request.requestedAt]);
    assert.ok(!Number.isNaN(Date.parse(entry.at)));
    assert.deepEqual(entry.checks, [
      { check: "rollback", result: "passed" }, { check: "metadata", result: "passed" }, { check: "provenance", result: "passed" }, { check: "registry-signature", result: "passed" },
      { check: "install", result: "passed" }, { check: "integrity", result: "passed" }, { check: "audit-signatures", result: "passed" }, { check: "package", result: "passed" },
    ], "each check once, in the order of the install, with the worst of its results");
    assert.equal(entry.refusal, undefined);
  });
});

test("P12 history: each way an update can end is a row with its own words: a refusal for the signature, for the provenance, for the audit, a limit, a server that did not stop", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const cases = [
      ["signature", "failed", [...passed("rollback", "metadata", "provenance"), { check: "registry-signature", result: "refused", reason: "The registry signature of narrarium-server@0.2.0 was rejected: the release is signed with the key SHA256:abc, which the registry does not list." }], { check: "registry-signature", kind: "refused" }],
      ["provenance", "failed", [...passed("rollback", "metadata"), { check: "provenance", result: "refused", reason: "The provenance of narrarium-server@0.2.0 was rejected: the signing certificate names another workflow." }], { check: "provenance", kind: "refused" }],
      ["audit", "failed", [...passed("rollback", "metadata", "provenance", "registry-signature", "install", "integrity"), { check: "audit-signatures", result: "refused", code: "EMISSINGSIGNATUREKEY" }], { check: "audit-signatures", kind: "refused", code: "EMISSINGSIGNATUREKEY" }],
      ["unreadable", "failed", [...passed("rollback", "metadata", "provenance"), { check: "registry-signature", result: "unreadable", reason: "The registry signature of narrarium-server@0.2.0 could not be checked: npm's list of signing keys could not be read (the registry answered 500)." }], { check: "registry-signature", kind: "unreadable" }],
      ["install", "failed", [...passed("rollback", "metadata", "provenance", "registry-signature"), { check: "install", result: "failed" }], { check: "install", kind: "failed" }],
      ["tolerated", "completed", [...passed("rollback", "metadata", "provenance", "registry-signature", "install", "integrity"), { check: "audit-signatures", result: "tolerated", code: "EMISSINGSIGNATUREKEY" }, ...passed("provenance", "registry-signature", "package")], undefined],
      ["limited", "limited", undefined, undefined],
      ["stopping", "stopping", undefined, undefined],
    ];
    const seen = [];
    for (const [name, outcome, checks, refusal] of cases) {
      const request = updateRequest(V, "client");
      await writeRequest(server, request);
      if (checks) await writeVerification(server, verificationOf(request.requestId, checks));
      await writeResult(server, resultOf(request.requestId, outcome));
      const [entry] = (await history(owner)).entries;
      assert.equal(entry.id, request.requestId, name);
      assert.equal(entry.state, outcome, name);
      assert.equal(entry.by, "client", name);
      assert.deepEqual(entry.refusal && { check: entry.refusal.check, kind: entry.refusal.kind, ...(entry.refusal.code ? { code: entry.refusal.code } : {}) }, refusal, name);
      if (checks && refusal && refusal.kind !== "failed" && checks.at(-1).reason) assert.equal(entry.refusal.reason, checks.at(-1).reason, `${name}: the reason is the supervisor's own words`);
      if (!checks) assert.equal(entry.checks, undefined, `${name}: nothing was checked, and nothing is claimed`);
      if (name === "tolerated") assert.equal(entry.checks.find((check) => check.check === "audit-signatures").result, "tolerated");
      seen.push(entry.state);
    }
    assert.deepEqual(seen, cases.map(([, outcome]) => outcome));
    assert.equal((await history(owner)).entries.length, cases.length, "newest first, all kept");
    assert.deepEqual((await history(owner)).entries.map((entry) => entry.state), [...seen].reverse());
  });
});

test("P12 history: an update that was asked for and has no answer yet is a row too, and a result the server never saw asked for (an older supervisor, a request made on the computer) is one with what is known", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const waiting = updateRequest(V, "client");
    await writeRequest(server, waiting);
    let body = await history(owner);
    assert.deepEqual(body.entries.map((entry) => [entry.id, entry.state, entry.by, entry.to, entry.from]), [[waiting.requestId, "requested", "client", V, SERVER_VERSION]]);
    await writeResult(server, resultOf(waiting.requestId, "failed"));
    body = await history(owner);
    assert.equal(body.entries.length, 1, "the answer completes the row, it does not add one");
    assert.equal(body.entries[0].state, "failed");
    assert.equal(body.entries[0].checks, undefined, "a supervisor that did not write what it verified: the outcome is all that is known");

    const unknown = randomUUID();
    await writeResult(server, resultOf(unknown, "completed", { from: "0.1.8", version: "0.1.9" }));
    body = await history(owner);
    assert.deepEqual(body.entries.map((entry) => [entry.id === unknown, entry.state, entry.from, entry.to, entry.by]), [[true, "completed", "0.1.8", "0.1.9", undefined], [false, "failed", SERVER_VERSION, V, "client"]]);
  });
});

test("P12 history: the history is joined when the server asks it, and again and again it says the same: a result is one row however often it is read", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const request = updateRequest(V, "admin");
    await writeRequest(server, request);
    await writeResult(server, resultOf(request.requestId, "completed"));
    const first = await history(owner);
    const second = await history(owner);
    const third = await history(owner);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(first.entries.length, 1);
  });
});

test("P12 history: a record of verification of another update, or one that cannot be trusted, is left out, and the row says only what the result says", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const request = updateRequest(V, "admin");
    await writeRequest(server, request);
    await writeResult(server, resultOf(request.requestId, "failed"));
    for (const record of [verificationOf(randomUUID(), EVERYTHING), { ...verificationOf(request.requestId, EVERYTHING), checks: [{ check: "magic", result: "passed" }] }, "not an object", { hello: "world" }]) {
      await writeFile(priv(server, "update-verification.json"), typeof record === "string" ? record : JSON.stringify(record));
      const body = await history(owner);
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0].checks, undefined);
    }
    await writeFile(priv(server, "update-verification.json"), "{ cut");
    assert.equal((await history(owner)).entries[0].state, "failed", "a file that is not JSON is not a reason to say nothing");
  });
});

test("P12 history: only the last twenty are kept, in a file that stays small", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const ids = [];
    for (let index = 0; index < 27; index += 1) {
      const request = updateRequest(V, index % 2 ? "client" : "admin");
      ids.push(request.requestId);
      await writeRequest(server, request);
      await writeVerification(server, verificationOf(request.requestId, EVERYTHING));
      await writeResult(server, resultOf(request.requestId, index % 3 ? "failed" : "completed", { at: new Date(Date.UTC(2026, 10, 1 + index)).toISOString() }));
      await history(owner);
    }
    const body = await history(owner);
    assert.equal(body.entries.length, 20);
    assert.deepEqual(body.entries.map((entry) => entry.id), ids.slice(7).reverse(), "the oldest seven are gone, the newest is first");
    const file = path.join(server.data.root, "update-history.json");
    assert.ok((await stat(file)).size < 64 * 1024, "bounded");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600, "private");
  });
});

test("P12 history: a release that the server will not offer is a row of its own, with the reason in words, and the same refusal asked again is not another", async () => {
  let answer = { reason: "no_trusted_release", available: false, signed: false, message: "Version 0.2.0 is not offered: its provenance was rejected, the signing certificate names another workflow than the Narrarium publishing workflow." };
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    // The panel's check is remembered for ten minutes; a request to update always asks again (and is refused, as nothing is on offer).
    const askAgain = async () => assert.equal((await owner.call("POST", "/admin/api/updates", { version: "0.2.0", installedVersion: SERVER_VERSION })).status, 409);
    await owner.call("GET", "/admin/api/updates");
    await owner.call("GET", "/admin/api/updates");
    await askAgain();
    let body = await history(owner);
    assert.equal(body.entries.length, 1, "the same refusal, asked three times");
    assert.deepEqual([body.entries[0].kind, body.entries[0].state, body.entries[0].to, body.entries[0].refusal.check, body.entries[0].refusal.kind], ["offer", "refused", "0.2.0", "provenance", "refused"]);
    assert.match(body.entries[0].refusal.reason, /Narrarium publishing workflow/);
    assert.equal(body.entries[0].checks, undefined);

    // Another reason is another row.
    answer = { reason: "no_trusted_release", available: false, signed: false, message: "Version 0.3.0 is not offered: it is older than 0.9.0, the highest version ever installed here." };
    await askAgain();
    body = await history(owner);
    assert.deepEqual(body.entries.map((entry) => [entry.to, entry.refusal.check]), [["0.3.0", "rollback"], ["0.2.0", "provenance"]]);

    // A release that is fine again clears the memory of the last refusal; nothing is added for it.
    answer = { reason: "up_to_date", available: false, signed: false, message: "The server already runs the latest version." };
    await askAgain();
    assert.equal((await history(owner)).entries.length, 2);
    answer = { reason: "no_trusted_release", available: false, signed: false, message: "Version 0.3.0 is not offered: it is older than 0.9.0, the highest version ever installed here." };
    await askAgain();
    assert.equal((await history(owner)).entries.length, 3, "refused again after it was fine: that is news");
  }, {
    checkRelease: async (installedVersion) => ({ packageName: "narrarium-server", installedVersion, ...answer }),
    supervised: true,
  });
});

test("P12 history: the history is there after a restart, and an update that finished while the server was down is told by the server that starts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-history-restart-"));
  const lines = logCollector();
  const options = { dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, log: lines.log };
  try {
    await mkdir(path.join(dataDir, "private"), { recursive: true, mode: 0o700 });
    const request = updateRequest(V, "client");
    await writeFile(path.join(dataDir, "private", "update-request.json"), JSON.stringify(request));
    await writeFile(path.join(dataDir, "private", "update-verification.json"), JSON.stringify(verificationOf(request.requestId, EVERYTHING, { from: "0.1.8" })));
    await writeFile(path.join(dataDir, "private", "update-result.json"), JSON.stringify(resultOf(request.requestId, "completed", { from: "0.1.8" })));
    const first = await startNarrariumServer(options);
    try {
      const owner = await adminLogin(first);
      const entries = (await history(owner)).entries;
      assert.deepEqual(entries.map((entry) => [entry.id, entry.state, entry.by, entry.from]), [[request.requestId, "completed", "client", "0.1.8"]], "the server that came up after the update knows how it went");
      const log = (await owner.call("GET", "/admin/api/log?limit=50")).body.entries.filter((entry) => entry.action === "update.finish");
      assert.equal(log.length, 1);
      assert.deepEqual([log[0].actor.kind, log[0].ok, log[0].object], ["system", true, V]);
    } finally {
      await first.close();
    }
    const second = await startNarrariumServer(options);
    try {
      const owner = await adminLogin(second);
      assert.equal((await history(owner)).entries.length, 1, "kept, and not told twice");
      assert.equal((await owner.call("GET", "/admin/api/log?limit=50")).body.entries.filter((entry) => entry.action === "update.finish").length, 1);
    } finally {
      await second.close();
    }
  } finally {
    await remove(dataDir);
  }
});

test("P12 history: a history that cannot be read never stops the server: it starts again from what the supervisor wrote, and the damaged file is kept", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-history-damaged-"));
  const lines = logCollector();
  const options = { dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, log: lines.log };
  try {
    await writeFile(path.join(dataDir, "update-history.json"), "{ this is not json");
    const running = await startNarrariumServer(options);
    try {
      const owner = await adminLogin(running);
      const body = await history(owner);
      assert.deepEqual(body.entries, []);
      assert.ok((await readFile(path.join(dataDir, "update-history.json.damaged"), "utf8")).includes("this is not json"), "kept for the owner");
      assert.match(lines.text(), /update history/i, "and said in the server's own log");
    } finally {
      await running.close();
    }
  } finally {
    await remove(dataDir);
  }
});

test("P12 history: the route needs the admin session, and answers only to the panel's own origin", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    assert.equal((await fetch(`${origin}/admin/api/updates/history`, { headers: { origin } })).status, 401);
    assert.equal((await fetch(`${origin}/admin/api/updates/history`, { headers: { origin: "https://evil.example" } })).status, 403);
    const clientToken = (await server.auth.issue("c", ["read", "write", "run", "update"])).token;
    assert.equal((await fetch(`${origin}/admin/api/updates/history`, { headers: { origin, authorization: `Bearer ${clientToken}` } })).status, 401);
    assert.equal((await fetch(`${server.url}/api/v1/updates/history`, { headers: { authorization: `Bearer ${clientToken}` } })).status, 404);
    assert.equal((await (await adminLogin(server)).call("GET", "/admin/api/updates/history")).status, 200);
  });
});

test("P12 history: an update the server accepts is a row at once (who asked for it, from which version), and the answer completes it", async () => {
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    const accepted = await client.requestUpdate(V, SERVER_VERSION);
    assert.equal(accepted.accepted, true);
    const request = JSON.parse(await readFile(priv(server, "update-request.json"), "utf8"));
    let body = await history(owner);
    assert.deepEqual(body.entries.map((entry) => [entry.id, entry.state, entry.by, entry.actor, entry.from, entry.to]), [[request.requestId, "requested", "client", "test client", SERVER_VERSION, V]]);
    await writeVerification(server, verificationOf(request.requestId, passed("rollback", "metadata", "provenance")));
    await rm(priv(server, "update-request.json"));
    await writeResult(server, resultOf(request.requestId, "failed"));
    await until(async () => (await history(owner)).entries[0]?.state === "failed");
    body = await history(owner);
    assert.equal(body.entries.length, 1);
    assert.deepEqual([body.entries[0].by, body.entries[0].actor, body.entries[0].checks.length], ["client", "test client", 3], "who asked is not forgotten when the request file goes");
  }, { checkRelease: async (installedVersion) => ({ packageName: "narrarium-server", installedVersion, latestVersion: V, available: true, signed: true, message: `Version ${V} is available.` }), supervised: true, scopes: ["read", "write", "run", "update"] });
});
