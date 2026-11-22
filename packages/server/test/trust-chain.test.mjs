import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as server from "../dist/testing.mjs";
import {
  OID,
  REAL_RELEASE,
  REAL_VERSION,
  attestationUrl,
  bootstrapRelease,
  der,
  editCertificate,
  editProvenance,
  editStatement,
  fakeNpm,
  fakeRegistry,
  forgeRelease,
  integrityFor,
  keysUrl,
  lockfile,
  sanValue,
  utf8Value,
  versionUrl,
  workflowUri,
} from "./release-fixtures.mjs";

const { RuntimeInstaller, ReleaseVerificationError } = server;

const remove = (directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const runtimeFolder = (dataRoot) => path.join(dataRoot, "private", "npm-runtime");

/** An installer wired to a fake npm and a fake registry; `events` is what happened, in order. */
async function withInstaller(options, run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-trust-"));
  const npm = fakeNpm({ releases: options.releases, latest: options.latest });
  const registry = fakeRegistry({ releases: options.releases, latest: options.latest, routes: options.routes });
  const events = [];
  const runner = async (command, args, commandOptions) => {
    events.push(`npm ${args[0]}`);
    return npm.runner(command, args, commandOptions);
  };
  const fetch = async (url, init) => {
    events.push(String(url).includes("/attestations/") ? "attestations" : "registry");
    return registry.fetch(url, init);
  };
  try {
    await run({ installer: new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner, fetch }), npm, registry, events, dataRoot });
  } finally {
    await remove(dataRoot);
  }
}

const refused = (pattern) => (error) => {
  assert.ok(error instanceof ReleaseVerificationError, `a ReleaseVerificationError, not ${error?.name}: ${error?.message}`);
  assert.match(error.message, pattern);
  return true;
};

async function assertNothingActivated(installer, dataRoot) {
  assert.equal(await installer.activeRuntime(), undefined, "nothing was activated");
  assert.equal(existsSync(path.join(runtimeFolder(dataRoot), "active.json")), false);
  const entries = await readdir(path.join(runtimeFolder(dataRoot))).catch(() => []);
  assert.deepEqual(entries.filter((name) => name.startsWith("staging-")), [], "no staging folder is left");
  assert.deepEqual(await readdir(path.join(runtimeFolder(dataRoot), "versions")).catch(() => []), [], "no version was installed");
}

// ---------------------------------------------------------------------------------------------
// The real release goes through the whole install
// ---------------------------------------------------------------------------------------------

test("C8 install: the real registry data of narrarium-server@0.1.2 passes the whole flow; the identity is read before the download and again after the audit, each time with the registry's signature (S8: two reads of the release's document and one of the keys, which are cached)", async () => {
  await withInstaller({ releases: [REAL_RELEASE], latest: REAL_VERSION }, async ({ installer, events, registry, dataRoot }) => {
    const active = await installer.installVersion(REAL_VERSION);
    assert.equal(active.version, REAL_VERSION);
    assert.deepEqual(events, ["npm view", "attestations", "registry", "registry", "npm install", "npm audit", "attestations", "registry"]);
    assert.deepEqual(registry.urls(), [attestationUrl(REAL_VERSION), versionUrl(REAL_VERSION), keysUrl, attestationUrl(REAL_VERSION), versionUrl(REAL_VERSION)]);
    assert.equal((await installer.activeRuntime()).version, REAL_VERSION);
    assert.equal(JSON.parse(await readFile(path.join(dataRoot, "private", "npm-install.json"), "utf8")).activeVersion, REAL_VERSION);
  });
  await withInstaller({ releases: [REAL_RELEASE], latest: REAL_VERSION }, async ({ installer }) => {
    assert.equal((await installer.installVersion("latest")).version, REAL_VERSION, "also as the latest version");
  });
});

test("C8 install: a release the next run of the workflow produces passes too (any version, same signer)", async () => {
  for (const version of ["0.1.3", "0.2.0", "1.0.0"]) {
    const release = forgeRelease(version);
    await withInstaller({ releases: [release], latest: version }, async ({ installer }) => {
      assert.equal((await installer.installVersion("latest")).version, version);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The identity, at install
// ---------------------------------------------------------------------------------------------

test("C8 install: a release signed by another repository is refused before anything is downloaded, whatever its metadata claims", async () => {
  const attacker = forgeRelease("0.2.0", { owner: "attacker", repository: "evil-repo", workflowFile: "publish.yml", ownerId: "6666", repositoryId: "7777" });
  await withInstaller({ releases: [attacker], latest: "0.2.0" }, async ({ installer, npm, dataRoot }) => {
    await assert.rejects(() => installer.installVersion("0.2.0"), refused(/signing certificate names/));
    await assert.rejects(() => installer.installVersion("latest"), refused(/attacker\/evil-repo/));
    assert.equal(npm.names().includes("install"), false, "the package was never downloaded");
    await assertNothingActivated(installer, dataRoot);
  });
});

test("C8 install: each altered claim keeps a release out (nothing is downloaded)", async () => {
  const alterations = [
    ["another account in the certificate", (release) => editCertificate(release.attestations, (c) => c.set(OID.san, sanValue(der.uri(workflowUri("0.2.0", { owner: "Mallory" }))))), /signing certificate names/],
    ["another issuer", (release) => editCertificate(release.attestations, (c) => {
      c.set(OID.legacyIssuer, Buffer.from("https://accounts.google.com"));
      c.set(OID.issuer, utf8Value("https://accounts.google.com"));
    }), /issuer/],
    ["another repository id", (release) => editCertificate(release.attestations, (c) => c.set(OID.repositoryId, utf8Value("1"))), /another GitHub repository or account/],
    ["another subject", (release) => editStatement(release.attestations, (s) => void (s.subject[0].name = "pkg:npm/narrarium-server@0.2.1")), /subject/],
    ["another tarball digest", (release) => editStatement(release.attestations, (s) => void (s.subject[0].digest.sha512 = "ab".repeat(64))), /digest/],
    ["another workflow ref in the statement", (release) => editStatement(release.attestations, (s) => void (s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main")), /workflow/],
    ["no certificate", (release) => editProvenance(release.attestations, (entry) => {
      delete entry.bundle.verificationMaterial.certificate;
      entry.bundle.verificationMaterial.publicKey = { hint: "SHA256:x" };
    }), /no signing certificate/],
  ];
  for (const [name, alter, pattern] of alterations) {
    const release = forgeRelease("0.2.0");
    await withInstaller({ releases: [{ ...release, attestations: alter(release) }], latest: "0.2.0" }, async ({ installer, npm, dataRoot }) => {
      await assert.rejects(() => installer.installVersion("0.2.0"), refused(pattern), name);
      assert.equal(npm.names().includes("install"), false, `${name}: nothing was downloaded`);
      await assertNothingActivated(installer, dataRoot);
    });
  }
});

test("C8 install: the attestation is read again after the audit; a registry that changes its answer in between is caught", async () => {
  const good = forgeRelease("0.2.0");
  const attacker = forgeRelease("0.2.0", { owner: "attacker", repository: "evil-repo" });
  const routes = { [attestationUrl("0.2.0")]: (nth) => new Response(JSON.stringify(nth === 1 ? good.attestations : attacker.attestations)) };
  await withInstaller({ releases: [good], latest: "0.2.0", routes }, async ({ installer, events, dataRoot }) => {
    await assert.rejects(() => installer.installVersion("0.2.0"), refused(/signing certificate names/));
    assert.deepEqual(events, ["npm view", "attestations", "registry", "registry", "npm install", "npm audit", "attestations"], "it got as far as the final check of the identity, which comes before the last read of the registry's signature");
    await assertNothingActivated(installer, dataRoot);
  });
});

test("C8 install: an attestation that cannot be read stops the install, before the download or after the audit", async () => {
  const release = forgeRelease("0.2.0");
  const failing = (nthFailing) => ({ [attestationUrl("0.2.0")]: (nth) => (nth >= nthFailing ? new Response("oops", { status: 500 }) : new Response(JSON.stringify(release.attestations))) });
  await withInstaller({ releases: [release], latest: "0.2.0", routes: failing(1) }, async ({ installer, npm, dataRoot }) => {
    await assert.rejects(() => installer.installVersion("0.2.0"), /could not be read/);
    assert.equal(npm.names().includes("install"), false);
    await assertNothingActivated(installer, dataRoot);
  });
  await withInstaller({ releases: [release], latest: "0.2.0", routes: failing(2) }, async ({ installer, npm, dataRoot }) => {
    await assert.rejects(() => installer.installVersion("0.2.0"), /could not be read/);
    assert.deepEqual(npm.names(), ["view", "install", "audit"]);
    await assertNothingActivated(installer, dataRoot);
  });
});

test("C8 install: a failing npm audit still stops the install", async () => {
  const release = forgeRelease("0.2.0");
  await withInstaller({ releases: [release], latest: "0.2.0" }, async ({ installer, npm, dataRoot }) => {
    npm.state.failAudit.add("0.2.0");
    await assert.rejects(() => installer.installVersion("0.2.0"), /npm audit did not succeed/);
    await assertNothingActivated(installer, dataRoot);
  });
});

// ---------------------------------------------------------------------------------------------
// The pin: what npm view judged is what npm installed
// ---------------------------------------------------------------------------------------------

test("C8 pin: an install that resolves to another tarball than the one npm view judged is refused (before the audit)", async () => {
  const release = forgeRelease("0.2.0");
  await withInstaller({ releases: [release], latest: "0.2.0" }, async ({ installer, npm, dataRoot }) => {
    npm.state.lockIntegrity.set("0.2.0", integrityFor("0.2.0 swapped for something else"));
    await assert.rejects(() => installer.installVersion("0.2.0"), /integrity/);
    assert.deepEqual(npm.names(), ["view", "install"], "refused right after the install, before the audit");
    await assertNothingActivated(installer, dataRoot);
  });
});

test("C8 pin: a staging lockfile that is missing, without integrity, for another version or unreadable is refused", async () => {
  const release = forgeRelease("0.2.0");
  const lockCases = [
    ["missing", "missing"],
    ["without an integrity", "no-integrity"],
    ["with a sha1 integrity only", () => lockfile("0.2.0", "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=")],
    ["for another version", () => lockfile("0.2.1", release.integrity)],
    ["without the package", () => JSON.stringify({ lockfileVersion: 3, packages: { "": {} } })],
    ["with the package of another name", () => JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/other": { version: "0.2.0", integrity: release.integrity } } })],
    ["that is not JSON", () => "not json"],
    ["that is an array", () => "[]"],
  ];
  for (const [name, lock] of lockCases) {
    await withInstaller({ releases: [release], latest: "0.2.0" }, async ({ installer, npm, dataRoot }) => {
      npm.state.lock = lock;
      await assert.rejects(() => installer.installVersion("0.2.0"), /integrity|lockfile/, name);
      assert.equal(npm.names().includes("audit"), false, `${name}: refused before the audit`);
      await assertNothingActivated(installer, dataRoot);
    });
  }
});

test("C8 pin: the lockfile of a larger tree is read for the package it is about", async () => {
  const release = forgeRelease("0.2.0");
  await withInstaller({ releases: [release], latest: "0.2.0" }, async ({ installer, npm }) => {
    npm.state.lock = () => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.0.0", integrity: integrityFor("left-pad") }, "node_modules/narrarium-server": { version: "0.2.0", integrity: release.integrity } } });
    assert.equal((await installer.installVersion("0.2.0")).version, "0.2.0");
  });
});

// ---------------------------------------------------------------------------------------------
// The hand-published bootstrap release
// ---------------------------------------------------------------------------------------------

test("C8 bootstrap: 0.1.0 still installs on request with its registry signature alone, reads no attestation, and is held to the pin", async () => {
  const release = bootstrapRelease("0.1.0");
  await withInstaller({ releases: [release], latest: "0.1.0" }, async ({ installer, npm, registry, dataRoot }) => {
    await assert.rejects(() => installer.installVersion("0.1.0"), /provenance/, "only with the explicit flag");
    assert.equal(npm.names().includes("install"), false);
    const active = await installer.installVersion("0.1.0", { bootstrapRegistryRelease: true });
    assert.equal(active.version, "0.1.0");
    assert.deepEqual(registry.urls(), [versionUrl("0.1.0"), keysUrl, versionUrl("0.1.0")], "there is no attestation to read: only the registry's signature is checked, the keys once");
    assert.deepEqual(npm.names().filter((name) => name !== "view"), ["install", "audit"]);
    assert.ok(existsSync(path.join(runtimeFolder(dataRoot), "versions", "0.1.0", "dist", "server.mjs")));
  });
  await withInstaller({ releases: [release], latest: "0.1.0" }, async ({ installer, npm, dataRoot }) => {
    npm.state.lockIntegrity.set("0.1.0", integrityFor("0.1.0 swapped"));
    await assert.rejects(() => installer.installVersion("0.1.0", { bootstrapRegistryRelease: true }), /integrity/);
    await assertNothingActivated(installer, dataRoot);
  });
  await withInstaller({ releases: [{ ...forgeRelease("0.2.0"), packument: bootstrapRelease("0.2.0").packument, attestations: undefined }], latest: "0.2.0" }, async ({ installer }) => {
    await assert.rejects(() => installer.installVersion("0.2.0", { bootstrapRegistryRelease: true }), /provenance/, "a later version always needs its provenance");
  });
});

test("C8 install: without an injected fetch the attestations are read through the global fetch (looked up at the time of the call), the way the registry is always read", async () => {
  const release = forgeRelease("0.2.0");
  const registry = fakeRegistry({ releases: [release], latest: "0.2.0" });
  const npm = fakeNpm({ releases: [release], latest: "0.2.0" });
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-trust-"));
  const original = globalThis.fetch;
  try {
    const installer = new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner });
    globalThis.fetch = registry.fetch;
    assert.equal((await installer.installVersion("0.2.0")).version, "0.2.0");
  } finally {
    globalThis.fetch = original;
    await remove(dataRoot);
  }
  assert.deepEqual(registry.urls(), [attestationUrl("0.2.0"), versionUrl("0.2.0"), keysUrl, attestationUrl("0.2.0"), versionUrl("0.2.0")]);
  for (const { init } of registry.requests) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error", "a redirect is never followed");
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).has("authorization"), false, "no credential reaches the registry");
  }
});
