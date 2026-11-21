import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { remoteBookStore, syncBookStores } from "narrarium-engine";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { BOOTSTRAP_VERSIONS, UPDATE_MESSAGES, checkNpmServerRelease, compareSemver, isExactSemver, trustedNpmReleaseMetadata } from "../dist/testing.mjs";
import { adminLogin, gatedAi, npmMetadata, releaseAvailable, until, withServer } from "./helpers.mjs";

const ALL_SCOPES = ["read", "write", "run", "update"];

test("only releases of this repository, signed by npm and attested by the publishing workflow, are trusted", () => {
  assert.deepEqual(trustedNpmReleaseMetadata(npmMetadata("0.2.0")), { version: "0.2.0" });
  assert.deepEqual(trustedNpmReleaseMetadata([npmMetadata("0.2.0")]), { version: "0.2.0" }, "npm 12 may wrap one result in an array");
  assert.throws(() => trustedNpmReleaseMetadata([npmMetadata("0.2.0"), npmMetadata("0.2.1")]));
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0", { attested: false })), /provenance/);
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0", { signed: false })));
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0", { repository: "git+https://github.com/someone/fork.git" })));
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0", { directory: "packages/engine" })));
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0", { name: "narrarium-server-evil" })));
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0", { predicateType: "https://example.com/other" })));
  assert.throws(() => trustedNpmReleaseMetadata({ ...npmMetadata("0.2.0"), dist: { ...npmMetadata("0.2.0").dist, attestations: npmMetadata("0.2.1").dist.attestations } }), "the attestation must be for this version");
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0"), "0.2.1"), /differs/);
  assert.deepEqual(trustedNpmReleaseMetadata(npmMetadata("0.2.0", { repository: "https://github.com/KeyserDSoze/GhostWriterFramework" })), { version: "0.2.0" });

  // The very first version is published by hand, before Trusted Publishing: registry signature only.
  assert.ok(BOOTSTRAP_VERSIONS.has("0.1.0"));
  assert.deepEqual(trustedNpmReleaseMetadata(npmMetadata("0.1.0", { attested: false }), "0.1.0", true), { version: "0.1.0" });
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.1.0", { attested: false }), "0.1.0"), "only when the installer asks for the bootstrap release");
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.1.0", { attested: false }), undefined, true), "never as the 'latest' answer");
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.1.0", { attested: false, signed: false }), "0.1.0", true));
  assert.throws(() => trustedNpmReleaseMetadata(npmMetadata("0.2.0", { attested: false }), "0.2.0", true), "later versions always need provenance");
});

test("versions are exact SemVer and compared by precedence", () => {
  for (const valid of ["0.1.0", "1.2.3", "1.2.3-0", "1.2.3-rc.1", "1.2.3-rc.1+build.5", "10.20.30"]) assert.equal(isExactSemver(valid), true, valid);
  for (const invalid of ["1.2", "01.2.3", "1.2.3-01", "v1.2.3", "latest", "1.2.3 ", "", 1]) assert.equal(isExactSemver(invalid), false, String(invalid));
  assert.ok(compareSemver("1.0.0", "0.9.9") > 0);
  assert.ok(compareSemver("0.10.0", "0.9.0") > 0);
  assert.ok(compareSemver("1.0.0-alpha", "1.0.0") < 0);
  assert.ok(compareSemver("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0, "numeric identifiers sort before alphanumeric ones");
  assert.ok(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10") < 0);
  assert.ok(compareSemver("1.0.0-beta.11", "1.0.0-rc.1") < 0);
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0, "build metadata does not count");
});

test("the npm check never offers an untrusted, older or unreadable release", async () => {
  const seen = [];
  const answer = (status, body, headers = {}) => async (url, init) => {
    seen.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  const newer = await checkNpmServerRelease("0.1.0", answer(200, npmMetadata("0.2.0")));
  assert.equal(newer.available, true);
  assert.equal(newer.signed, true);
  assert.equal(newer.latestVersion, "0.2.0");
  assert.equal(seen[0].url, "https://registry.npmjs.org/narrarium-server/latest");
  assert.equal(seen[0].init.redirect, "error");
  assert.equal(seen[0].init.credentials, "omit");

  assert.equal((await checkNpmServerRelease("0.1.0", answer(404, {}))).reason, "not_published");
  const untrusted = await checkNpmServerRelease("0.1.0", answer(200, npmMetadata("0.2.0", { attested: false })));
  assert.equal(untrusted.available, false);
  assert.equal(untrusted.reason, "no_trusted_release");
  assert.equal((await checkNpmServerRelease("0.2.0", answer(200, npmMetadata("0.2.0")))).reason, "up_to_date");
  const bootstrap = await checkNpmServerRelease("0.1.0", answer(200, npmMetadata("0.1.0", { attested: false })));
  assert.equal(bootstrap.reason, "up_to_date", "the hand-published first release is current, not untrusted");
  assert.equal(bootstrap.latestVersion, undefined, "an unattested version is never reported as verified");
  const older = await checkNpmServerRelease("0.3.0", answer(200, npmMetadata("0.2.0")));
  assert.equal(older.available, false, "never a downgrade");
  assert.equal(older.reason, "up_to_date");
  assert.equal((await checkNpmServerRelease("0.1.0", answer(500, "oops"))).reason, "unavailable");
  assert.equal((await checkNpmServerRelease("0.1.0", answer(200, npmMetadata("0.2.0"), { "content-length": String(10 * 1024 * 1024) }))).reason, "unavailable");
  assert.equal((await checkNpmServerRelease("0.1.0", answer(200, `{"padding":"${"x".repeat(300 * 1024)}"}`))).reason, "unavailable", "metadata over 256 KiB is refused");
  assert.equal((await checkNpmServerRelease("0.1.0", async () => {
    throw new TypeError("fetch failed");
  })).reason, "unavailable");
  await assert.rejects(() => checkNpmServerRelease("latest", answer(200, {})));
});

test("without the supervisor or the update permission a newer version is shown but cannot be requested", async () => {
  await withServer(async (_server, client) => {
    const info = await client.updates();
    assert.equal(info.available, true);
    assert.equal(info.latestVersion, "0.2.0");
    assert.equal(info.installedVersion, "0.1.0");
    assert.equal(info.supervised, false);
    assert.equal(info.canRequest, false);
    assert.equal(info.reason, "no_supervisor");
    await assert.rejects(() => client.requestUpdate("0.2.0", "0.1.0"), (error) => error.status === 409 && error.code === "no_supervisor");
  }, { checkRelease: releaseAvailable("0.2.0"), scopes: ALL_SCOPES });

  await withServer(async (_server, client) => {
    const info = await client.updates();
    assert.equal(info.supervised, true);
    assert.equal(info.hasUpdateScope, false);
    assert.equal(info.canRequest, false);
    assert.equal(info.reason, "missing_scope");
    await assert.rejects(() => client.requestUpdate("0.2.0", "0.1.0"), (error) => error.status === 403 && error.code === "scope");
  }, { checkRelease: releaseAvailable("0.2.0"), supervised: true });
});

test("an accepted update is written for the supervisor and the server stops taking new work", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("before", { title: "Before", storage: { kind: "local" } });
    const info = await client.updates();
    assert.equal(info.canRequest, true);
    assert.equal(info.reason, undefined);
    await assert.rejects(() => client.requestUpdate("0.3.0", "0.1.0"), (error) => error.status === 409 && error.code === "release", "only the latest verified release");
    await assert.rejects(() => client.requestUpdate("0.2.0", "0.0.9"), (error) => error.status === 412, "the client saw another installed version");

    const accepted = await client.requestUpdate("0.2.0", "0.1.0");
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.version, "0.2.0");
    const file = path.join(server.data.root, "private", "update-request.json");
    const request = JSON.parse(await readFile(file, "utf8"));
    assert.equal(request.version, "0.2.0");
    assert.equal(request.source, "client");
    assert.equal(request.packageName, "narrarium-server");
    assert.match(request.requestId, /^[0-9a-f-]{36}$/);

    const waiting = await client.updates();
    assert.deepEqual(waiting.pending?.version, "0.2.0");
    assert.equal(waiting.canRequest, false);
    await assert.rejects(() => client.registerBook("late", { title: "Late", storage: { kind: "local" } }), (error) => error.status === 503 && error.code === "maintenance");
    await assert.rejects(() => client.startAutopilot("before"), (error) => error.status === 503);
    await assert.rejects(() => client.requestUpdate("0.2.0", "0.1.0"), (error) => error.status === 503);
    assert.equal((await client.listBooks()).length, 1, "reading still works");

    // The supervisor gives up (the server did not stop in time): the server accepts work again.
    await writeFile(path.join(server.data.root, "private", "update-result.json"), JSON.stringify({ schemaVersion: 1, requestId: request.requestId, state: "failed", outcome: "stopping", version: "0.2.0", fromVersion: "0.1.0", at: new Date().toISOString(), message: UPDATE_MESSAGES.stopping }));
    await until(async () => {
      try {
        await client.registerBook("late", { title: "Late", storage: { kind: "local" } });
        return true;
      } catch (error) {
        if (error.status === 503) return false;
        throw error;
      }
    });
    const after = await client.updates();
    assert.equal(after.pending, undefined, "an answered request is no longer pending");
    assert.equal(after.lastUpdate.state, "failed");
    assert.equal(after.lastUpdate.outcome, "stopping");
    assert.equal(after.canRequest, true);
  }, { checkRelease: releaseAvailable("0.2.0"), supervised: true, scopes: ALL_SCOPES });
});

test("an update waits for running autopilots, and a stale request of another version does not block a newer one", async () => {
  const slow = gatedAi();
  let latest = "0.2.0";
  await withServer(async (server, client) => {
    await client.registerBook("busy", { title: "Busy", storage: { kind: "local" } });
    await syncBookStores({ local: new MemoryBookStore(seedBookFiles()), remote: remoteBookStore(client, "busy"), base: new Map() });
    await client.startAutopilot("busy", { brief: { idea: "A busy harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
    await slow.started;
    await assert.rejects(() => client.requestUpdate("0.2.0", "0.1.0"), (error) => error.status === 409 && error.code === "running");
    await client.pauseAutopilot("busy", "now");
    slow.release();
    await until(async () => !(await client.autopilot("busy")).running);

    // A request written earlier for 0.2.0 and never processed blocks another version...
    const requestFile = path.join(server.data.root, "private", "update-request.json");
    const stale = { schemaVersion: 1, packageName: "narrarium-server", version: "0.2.0", requestedAt: new Date().toISOString(), requestId: "00000000-0000-4000-8000-000000000001", source: "client" };
    await writeFile(requestFile, JSON.stringify(stale));
    latest = "0.3.0";
    await assert.rejects(() => client.requestUpdate("0.3.0", "0.1.0"), (error) => error.status === 409 && error.code === "update_pending");
    // ...until the supervisor answers it.
    await writeFile(path.join(server.data.root, "private", "update-result.json"), JSON.stringify({ schemaVersion: 1, requestId: stale.requestId, state: "failed", outcome: "failed", version: "0.2.0", fromVersion: "0.1.0", at: new Date().toISOString(), message: UPDATE_MESSAGES.failed }));
    await client.requestUpdate("0.3.0", "0.1.0");
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    assert.equal(request.version, "0.3.0");
    assert.notEqual(request.requestId, stale.requestId);
  }, { ai: slow.ai, checkRelease: async (installed) => releaseAvailable(latest)(installed), supervised: true, scopes: ALL_SCOPES });
});

test("the owner can update from the admin panel", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const info = await admin.call("GET", "/admin/api/updates");
    assert.equal(info.status, 200);
    assert.equal(info.body.canRequest, true);
    assert.equal(info.body.hasUpdateScope, true);
    const accepted = await admin.call("POST", "/admin/api/updates", { version: "0.2.0", installedVersion: "0.1.0" });
    assert.equal(accepted.status, 202);
    const request = JSON.parse(await readFile(path.join(server.data.root, "private", "update-request.json"), "utf8"));
    assert.equal(request.source, "admin");
    assert.equal((await admin.call("GET", "/admin/api/status")).body.maintenance, true);
  }, { checkRelease: releaseAvailable("0.2.0"), supervised: true });
});
