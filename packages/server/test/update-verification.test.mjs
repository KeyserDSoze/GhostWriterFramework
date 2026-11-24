import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as server from "../dist/testing.mjs";
import { oneUpdateFileAtATime, until } from "./helpers.mjs";
import {
  REAL_RELEASE,
  REAL_REGISTRY_KEYS,
  REAL_VERSION,
  REGISTRY_KEY,
  attestationUrl,
  bootstrapRelease,
  editCertificate,
  fakeNpm,
  fakeRegistry,
  forgeRelease,
  integrityFor,
  keyEntry,
  keysUrl,
  makeRegistryKey,
  npmFailures,
  OID,
  packumentUrl,
  registrySignature,
  sanValue,
  signedVersionDocument,
  der,
  versionUrl,
  withoutPublishAttestation,
  workflowUri,
} from "./release-fixtures.mjs";

// The new exports are read from the namespace: before they exist each test fails by itself instead of breaking the whole file.
const { NpmCommandError, RegistrySignatureError, RegistryUnreadableError, ReleaseVerificationError, RuntimeInstaller, SERVER_VERSION, cliMain, failedOnlyForMissingAttestationKeys, prepareRuntime, superviseServer } = server;

// What the installer does so that an update is verified the same way whatever npm the machine has: the registry's signature of the release is checked by the
// server itself (before the download and again on what was installed), and `npm audit signatures` is still run, but its refusal of a release that has only the
// keyless SLSA provenance (no npm publish attestation, as narrarium-server@0.1.8 was published) is accepted when the server's own checks passed. The first
// release below is the one the registry served for 0.1.8: a signature, the SLSA provenance and no publish attestation.

const V = "0.2.0";
const remove = (directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const runtimeFolder = (dataRoot) => path.join(dataRoot, "private", "npm-runtime");
const json = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const slsaOnly = (version = V) => withoutPublishAttestation(forgeRelease(version));

/** What each read of the registry was, in the words of the events below. */
const label = (url) => {
  const text = String(url);
  return text.includes("/attestations/") ? "attestations" : text === keysUrl ? "keys" : text === packumentUrl ? "dates" : "document";
};
const SEQUENCE = ["npm view", "attestations", "document", "keys", "npm install", "npm audit", "attestations", "document"];

/**
 * An installer wired to a fake npm and a fake registry. `events` is what happened, in order (npm commands and reads of the registry); `log` is what the installer
 * was told to say; `install(version)` installs with that log, as the supervisor and the CLI do.
 */
async function withInstaller(options, run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-verify-"));
  const releases = options.releases ?? [slsaOnly()];
  const latest = options.latest ?? V;
  const npm = fakeNpm({ releases, latest });
  const registry = fakeRegistry({ releases, latest, routes: options.routes, keys: options.keys, published: options.published });
  const events = [];
  const log = [];
  const runner = async (command, args, commandOptions) => {
    events.push(`npm ${args[0]}`);
    return npm.runner(command, args, commandOptions);
  };
  const fetch = async (url, init) => {
    events.push(label(url));
    return registry.fetch(url, init);
  };
  const installer = new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner, fetch });
  try {
    await run({ installer, npm, registry, events, log, dataRoot, install: (version = V, extra = {}) => installer.installVersion(version, { log: (line) => log.push(line), ...extra }) });
  } finally {
    await remove(dataRoot);
  }
}

async function assertNothingActivated(installer, dataRoot) {
  assert.equal(await installer.activeRuntime(), undefined, "nothing was activated");
  assert.equal(existsSync(path.join(runtimeFolder(dataRoot), "active.json")), false);
  const entries = await readdir(runtimeFolder(dataRoot)).catch(() => []);
  assert.deepEqual(entries.filter((name) => name.startsWith("staging-")), [], "no staging folder is left");
  assert.deepEqual(await readdir(path.join(runtimeFolder(dataRoot), "versions")).catch(() => []), [], "no version was installed");
}

const signedBy = (pair, release, version = V) => json(signedVersionDocument(release, [registrySignature(pair, version, release.integrity)]));

// ─── The server checks the registry's signature itself ─────────────────────

test("S8 install: the registry's signature is checked before the download and again on what was installed, with the keys read once; a release with nothing to warn about says nothing", async () => {
  await withInstaller({ releases: [REAL_RELEASE], latest: REAL_VERSION }, async ({ install, events, registry, log, installer }) => {
    assert.equal((await install(REAL_VERSION)).version, REAL_VERSION);
    assert.deepEqual(events, SEQUENCE);
    assert.deepEqual(registry.urls(), [attestationUrl(REAL_VERSION), versionUrl(REAL_VERSION), keysUrl, attestationUrl(REAL_VERSION), versionUrl(REAL_VERSION)]);
    assert.deepEqual(log, [], "nothing to warn about");
    assert.equal((await installer.activeRuntime()).version, REAL_VERSION);
  });
  await withInstaller({ releases: [forgeRelease(V)] }, async ({ install, events, log }) => {
    assert.equal((await install("latest")).version, V, "also as the latest version");
    assert.deepEqual(events, ["npm view", ...SEQUENCE], "the first npm view asks which version is the latest");
    assert.deepEqual(log, []);
  });
});

test("S8 install: narrarium-server@0.1.2 as the registry really serves it (the real signatures, the real keys, the real attestations) passes the whole flow", async () => {
  const routes = { [versionUrl(REAL_VERSION)]: () => json(REAL_RELEASE.packument) };
  await withInstaller({ releases: [REAL_RELEASE], latest: REAL_VERSION, keys: REAL_REGISTRY_KEYS, routes }, async ({ install, events, registry, log, installer }) => {
    assert.equal((await install(REAL_VERSION)).version, REAL_VERSION);
    assert.deepEqual(events, SEQUENCE);
    assert.deepEqual(registry.urls(), [attestationUrl(REAL_VERSION), versionUrl(REAL_VERSION), keysUrl, attestationUrl(REAL_VERSION), versionUrl(REAL_VERSION)], "the current key never expires: no date is read");
    assert.deepEqual(log, []);
    assert.equal((await installer.activeRuntime()).version, REAL_VERSION);
  });
  const dist = REAL_RELEASE.packument.dist;
  const swapped = { ...REAL_RELEASE.packument, dist: { ...dist, signatures: [{ ...dist.signatures[0], keyid: REAL_REGISTRY_KEYS[0].keyid }, dist.signatures[1]] } };
  await withInstaller({ releases: [REAL_RELEASE], latest: REAL_VERSION, keys: REAL_REGISTRY_KEYS, routes: { [versionUrl(REAL_VERSION)]: () => json(swapped) } }, async ({ install, npm, installer, dataRoot }) => {
    await assert.rejects(() => install(REAL_VERSION), (error) => error instanceof RegistrySignatureError && /not valid/.test(error.message));
    assert.equal(npm.names().includes("install"), false, "refused before the download");
    await assertNothingActivated(installer, dataRoot);
  });
});

test("S8 install: the hand-published first release is held to its registry signature too, and still reads no attestation", async () => {
  const release = bootstrapRelease("0.1.0");
  await withInstaller({ releases: [release], latest: "0.1.0" }, async ({ install, events, registry, log }) => {
    assert.equal((await install("0.1.0", { bootstrapRegistryRelease: true })).version, "0.1.0");
    assert.deepEqual(events, ["npm view", "document", "keys", "npm install", "npm audit", "document"]);
    assert.deepEqual(registry.urls(), [versionUrl("0.1.0"), keysUrl, versionUrl("0.1.0")], "no attestation, the keys once");
    assert.deepEqual(log, []);
  });
  const routes = { [versionUrl("0.1.0")]: () => signedBy(makeRegistryKey(), release, "0.1.0") };
  await withInstaller({ releases: [release], latest: "0.1.0", routes }, async ({ install, npm, installer, dataRoot }) => {
    await assert.rejects(() => install("0.1.0", { bootstrapRegistryRelease: true }), (error) => error instanceof RegistrySignatureError && /does not list/.test(error.message));
    assert.equal(npm.names().includes("install"), false, "refused before the download");
    await assertNothingActivated(installer, dataRoot);
  });
});

test("S8 install: a release whose registry signature does not hold is refused before anything is downloaded, whatever else is in order", async () => {
  const release = forgeRelease(V);
  const document = (signatures, patch = {}) => () => json({ ...signedVersionDocument(release, signatures), ...patch });
  const cases = [
    ["a signature that is not valid", { routes: { [versionUrl(V)]: document([registrySignature(REGISTRY_KEY, V, integrityFor("another tarball"))]) } }, RegistrySignatureError, /not valid/],
    ["a signature by a key the registry does not list", { routes: { [versionUrl(V)]: document([registrySignature(makeRegistryKey(), V, release.integrity)]) } }, RegistrySignatureError, /does not list/],
    ["no signature", { routes: { [versionUrl(V)]: document([]) } }, RegistrySignatureError, /no registry signature/],
    ["a key that expired before the release was published", { keys: [keyEntry(REGISTRY_KEY, { expires: "2025-01-29T00:00:00.000Z" })] }, RegistrySignatureError, /expired before this release was published/],
    ["a document of another tarball than the one npm announced", { routes: { [versionUrl(V)]: () => json(signedVersionDocument({ ...release, integrity: integrityFor("a swapped tarball") })) } }, RegistrySignatureError, /another tarball/],
    ["a list of keys that cannot be read", { routes: { [keysUrl]: () => json({ error: "boom" }, 500) } }, RegistryUnreadableError, /list of signing keys/],
    ["a document of the release that cannot be read", { routes: { [versionUrl(V)]: () => json({ error: "boom" }, 500) } }, RegistryUnreadableError, /document of this release/],
    ["a key that expired, and dates that cannot be read", { keys: [keyEntry(REGISTRY_KEY, { expires: "2025-01-29T00:00:00.000Z" })], routes: { [packumentUrl]: () => json({}, 500) } }, RegistryUnreadableError, /publication dates/],
  ];
  for (const [name, options, type, pattern] of cases) {
    await withInstaller({ releases: [release], ...options }, async ({ install, npm, events, log, installer, dataRoot }) => {
      await assert.rejects(() => install(V), (error) => error instanceof type && pattern.test(error.message), name);
      assert.equal(npm.names().includes("install"), false, `${name}: nothing was downloaded`);
      assert.equal(events.includes("npm install"), false);
      assert.deepEqual(log, [], `${name}: nothing was said`);
      await assertNothingActivated(installer, dataRoot);
    });
  }
});

test("S8 install: the provenance is checked first, so a release with both faults is refused for its provenance and its signature is not even looked at", async () => {
  const attacker = forgeRelease(V, { owner: "attacker", repository: "evil-repo" });
  const routes = { [versionUrl(V)]: () => signedBy(makeRegistryKey(), attacker) };
  await withInstaller({ releases: [attacker], routes }, async ({ install, events, installer, dataRoot }) => {
    await assert.rejects(() => install(V), (error) => error instanceof ReleaseVerificationError && /signing certificate names/.test(error.message));
    assert.deepEqual(events, ["npm view", "attestations"]);
    await assertNothingActivated(installer, dataRoot);
  });
});

test("S8 install: a registry that changes its answer between the first check and the last is caught after the audit", async () => {
  const release = forgeRelease(V);
  const second = (answer) => ({ routes: { [versionUrl(V)]: (nth) => (nth === 1 ? json(signedVersionDocument(release)) : answer()) } });
  const cases = [
    ["a signature by a key nobody lists", () => signedBy(makeRegistryKey(), release), RegistrySignatureError, /does not list/],
    ["a signature that is not valid", () => json(signedVersionDocument(release, [registrySignature(REGISTRY_KEY, V, integrityFor("swapped"))])), RegistrySignatureError, /not valid/],
    ["a document that cannot be read", () => json({}, 500), RegistryUnreadableError, /document of this release/],
    ["a document of another tarball than the one that was installed", () => json(signedVersionDocument({ ...release, integrity: integrityFor("another tarball") })), RegistrySignatureError, /another tarball/],
  ];
  for (const [name, answer, type, pattern] of cases) {
    await withInstaller({ releases: [release], ...second(answer) }, async ({ install, events, log, installer, dataRoot }) => {
      await assert.rejects(() => install(V), (error) => error instanceof type && pattern.test(error.message), name);
      assert.deepEqual(events, SEQUENCE, `${name}: it got as far as the final check`);
      assert.deepEqual(log, []);
      await assertNothingActivated(installer, dataRoot);
    });
  }
});

// ─── npm audit signatures that cannot cope with a release that has only the SLSA provenance ──

const ACCEPTED = "Warning: npm audit signatures could not finish for narrarium-server@0.2.0";

test("S8 audit: npm refusing a release that has only the SLSA provenance, because there is no key for an attestation it does not have, is accepted when the server verified the registry signature and the provenance itself, and the log says so", async () => {
  await withInstaller({}, async ({ install, npm, events, log, installer, dataRoot }) => {
    npm.state.auditOutput.set(V, npmFailures.missingAttestationKey(V, { tuf: true }));
    const active = await install(V);
    assert.equal(active.version, V);
    assert.equal((await installer.activeRuntime()).version, V);
    assert.ok(existsSync(path.join(runtimeFolder(dataRoot), "versions", V, "dist", "server.mjs")));
    assert.deepEqual(events, SEQUENCE, "the audit was run, and then every check the server makes itself");
    assert.equal(log.length, 1, "one warning, once");
    assert.ok(log[0].startsWith(ACCEPTED), log[0]);
    assert.match(log[0], /npm publish attestation/);
    assert.match(log[0], /registry signature/);
    assert.match(log[0], /SLSA provenance/);
    assert.equal(log[0].includes("\n"), false, "one line");
    assert.equal(log[0].length < 400, true);
  });
});

test("S8 audit: the failure is recognised in the shapes npm prints it: with or without the line about Sigstore's keys, with Windows line ends, with colours, in an older npm's words, on either stream", async () => {
  const right = npmFailures.missingAttestationKey(V, { tuf: true });
  const shapes = [
    ["as printed", right],
    ["without the line about Sigstore's key service", npmFailures.missingAttestationKey(V)],
    ["with Windows line ends", { ...right, stderr: right.stderr.replace(/\n/g, "\r\n") }],
    ["with colours", { ...right, stderr: right.stderr.replace(/npm error/g, "npm \u001b[31merror\u001b[39m").replace(/npm warn/g, "npm \u001b[93mwarn\u001b[39m") }],
    ["in the words of an older npm", { ...right, stderr: right.stderr.replace(/npm error/g, "npm ERR!").replace(/npm warn/g, "npm WARN") }],
    ["on the standard output", { code: 1, stdout: right.stderr, stderr: "" }],
    ["with notices and blank lines around", { ...right, stderr: `\nnpm notice some notice\n${right.stderr}\nnpm warn another warning\n\n` }],
    ["with another exit code", { ...right, code: 2 }],
  ];
  for (const [name, output] of shapes) {
    await withInstaller({}, async ({ install, npm, log }) => {
      npm.state.auditOutput.set(V, output);
      assert.equal((await install(V)).version, V, name);
      assert.equal(log.length, 1, name);
    });
  }
});

test("S8 audit: any other failure of npm audit signatures still refuses the release, whatever else is in order", async () => {
  const right = npmFailures.missingAttestationKey(V);
  const message = `npm error narrarium-server@${V} has attestations but no corresponding public key(s) can be found`;
  const plus = (line) => ({ ...right, stderr: `${right.stderr}${line}\n` });
  const without = (pattern) => ({ ...right, stderr: right.stderr.split("\n").filter((line) => !pattern.test(line)).join("\n") });
  const cases = [
    ["an invalid registry signature, as npm reports it", npmFailures.invalidSignature(V)],
    ["an invalid attestation, as npm 10 reports it", npmFailures.invalidAttestation(V)],
    ["a registry signature made with a key that is not listed (the same code, another message)", npmFailures.missingSignatureKey(V)],
    ["a key that has expired", npmFailures.expiredSignatureKey(V)],
    ["a registry that answers with an error", npmFailures.registryError()],
    ["a registry that cannot be reached", npmFailures.unreachable()],
    ["the missing key of another version", npmFailures.missingAttestationKey("0.2.1")],
    ["the missing key of another package", { ...right, stderr: right.stderr.replace("narrarium-server@", "left-pad@") }],
    ["the missing key of a package with a longer name", { ...right, stderr: right.stderr.replace("narrarium-server@", "xnarrarium-server@") }],
    ["the missing key of a longer version", { ...right, stderr: right.stderr.replace(`@${V} `, `@${V}0 `) }],
    ["a second error code after the right one", plus("npm error code EINTEGRITYSIGNATURE")],
    ["the right code twice", plus("npm error code EMISSINGSIGNATUREKEY")],
    ["the right message twice", plus(message)],
    ["another line of error", plus("npm error something else went wrong")],
    ["a line that npm did not print", plus("Segmentation fault")],
    ["a line of the stack", plus("npm error     at somewhere (file.js:1:1)")],
    ["a line of npm's log", plus("npm http fetch GET 200 https://registry.npmjs.org/-/npm/v1/keys 12ms")],
    ["a line of a verbose log", plus("npm verbose stack Error: boom")],
    ["the code without the message", without(/has attestations/)],
    ["the message without the code", without(/error code/)],
    ["nothing printed", { code: 1, stdout: "", stderr: "" }],
    ["only blank lines", { code: 1, stdout: "\n", stderr: "\n\n" }],
    ["a report on the standard output beside the right error", { ...right, stdout: "audited 1 package in 0s\n\n1 package has an invalid registry signature:\n" }],
    ["the message in the middle of another sentence", { ...right, stderr: right.stderr.replace(message, `${message}, and more`) }],
  ];
  for (const [name, output] of cases) {
    await withInstaller({}, async ({ install, npm, log, installer, dataRoot }) => {
      npm.state.auditOutput.set(V, output);
      await assert.rejects(() => install(V), (error) => error instanceof NpmCommandError && error.message === "npm audit did not succeed.", name);
      assert.deepEqual(log, [], `${name}: no warning`);
      await assertNothingActivated(installer, dataRoot);
    });
  }
});

test("S8 audit: the failure is tolerated only for a release that has no npm publish attestation: with one, npm's missing key is a real failure; a release without any provenance never gets there", async () => {
  const output = npmFailures.missingAttestationKey(V);
  await withInstaller({ releases: [forgeRelease(V)] }, async ({ install, npm, log, installer, dataRoot }) => {
    assert.equal(forgeRelease(V).attestations.attestations.length, 2, "this release has both attestations, as 0.1.6 and 0.1.7 do");
    npm.state.auditOutput.set(V, output);
    await assert.rejects(() => install(V), /npm audit did not succeed/);
    assert.deepEqual(log, []);
    await assertNothingActivated(installer, dataRoot);
  });
  await withInstaller({ releases: [REAL_RELEASE], latest: REAL_VERSION }, async ({ install, npm, log, installer, dataRoot }) => {
    npm.state.auditOutput.set(REAL_VERSION, npmFailures.missingAttestationKey(REAL_VERSION));
    await assert.rejects(() => install(REAL_VERSION), /npm audit did not succeed/, "the real registry data of a release with both attestations");
    assert.deepEqual(log, []);
    await assertNothingActivated(installer, dataRoot);
  });
  await withInstaller({ releases: [bootstrapRelease("0.1.0")], latest: "0.1.0" }, async ({ install, npm, log, installer, dataRoot }) => {
    npm.state.auditOutput.set("0.1.0", npmFailures.missingAttestationKey("0.1.0"));
    await assert.rejects(() => install("0.1.0", { bootstrapRegistryRelease: true }), /npm audit did not succeed/, "a release without provenance is not one npm meant");
    assert.deepEqual(log, []);
    await assertNothingActivated(installer, dataRoot);
  });
});

test("S8 audit: the tolerance never replaces the server's own checks after the audit: a second read of the registry that is not what the first was refuses the release", async () => {
  const release = slsaOnly();
  const full = forgeRelease(V);
  const attacker = withoutPublishAttestation(forgeRelease(V, { owner: "attacker", repository: "evil-repo" }));
  const attestations = (answer) => ({ [attestationUrl(V)]: (nth) => (nth === 1 ? json(release.attestations) : answer()) });
  const cases = [
    ["a signature that is not valid on the second read", { routes: { [versionUrl(V)]: (nth) => (nth === 1 ? json(signedVersionDocument(release)) : signedBy(makeRegistryKey(), release)) } }, RegistrySignatureError, /does not list/],
    ["a provenance of another repository on the second read", { routes: attestations(() => json(attacker.attestations)) }, ReleaseVerificationError, /signing certificate names/],
    ["a publish attestation that appears on the second read", { routes: attestations(() => json(full.attestations)) }, ReleaseVerificationError, /publish attestation/],
    ["an attestation that cannot be read on the second read", { routes: attestations(() => json({}, 500)) }, Error, /could not be read/],
    ["a certificate of another account on the second read", { routes: attestations(() => json(editCertificate(release.attestations, (certificate) => certificate.set(OID.san, sanValue(der.uri(workflowUri(V, { owner: "Mallory" }))))))) }, ReleaseVerificationError, /signing certificate names/],
  ];
  for (const [name, options, type, pattern] of cases) {
    await withInstaller({ releases: [release], ...options }, async ({ install, npm, events, log, installer, dataRoot }) => {
      npm.state.auditOutput.set(V, npmFailures.missingAttestationKey(V));
      await assert.rejects(() => install(V), (error) => error instanceof type && pattern.test(error.message), name);
      assert.equal(events.includes("npm audit"), true, `${name}: npm audit was run`);
      assert.deepEqual(log, [], `${name}: no warning, for nothing was accepted`);
      await assertNothingActivated(installer, dataRoot);
    });
  }
});

test("S8 audit: an install that fails after a tolerated audit never says it accepted the release", async () => {
  await withInstaller({}, async ({ install, npm, log, installer }) => {
    npm.state.auditOutput.set(V, npmFailures.missingAttestationKey(V));
    await install(V);
    assert.equal(log.length, 1);
    npm.state.content = () => "// a different copy of the same version\n";
    await assert.rejects(() => install(V), /different copy/, "an installed version is never silently replaced");
    assert.equal(log.length, 1, "the second, refused install said nothing");
    assert.equal((await installer.activeRuntime()).version, V);
  });
});

test("S8 audit: a failing npm command is an NpmCommandError that keeps what npm printed for whoever must tell failures apart; its message is the same as ever and says nothing of the output", async () => {
  await withInstaller({}, async ({ install, npm }) => {
    npm.state.failInstall.add(V);
    await assert.rejects(() => install(V), (error) => {
      assert.ok(error instanceof NpmCommandError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, "NpmCommandError");
      assert.equal(error.message, "npm install did not succeed.");
      assert.equal(error.command, "install");
      assert.deepEqual(error.result, { code: 1, stdout: "", stderr: "npm error 404" });
      assert.equal(error.message.includes("404"), false, "the message does not carry npm's output");
      return true;
    });
  });
  await withInstaller({ releases: [slsaOnly()] }, async ({ install, npm }) => {
    npm.state.auditOutput.set(V, { code: 1, stdout: "a secret in the output", stderr: "npm error code EOTHER" });
    await assert.rejects(() => install(V), (error) => error instanceof NpmCommandError && error.message === "npm audit did not succeed." && !error.message.includes("secret") && error.result.stdout === "a secret in the output");
  });
});

// ─── Telling the failure apart ─────────────────────────────────────────────

test("S8 audit: failedOnlyForMissingAttestationKeys says yes to exactly one failure of npm and no to everything else, including what it is not given", () => {
  const name = "narrarium-server";
  const yes = (output, version = "0.1.8") => failedOnlyForMissingAttestationKeys(output, name, version);
  assert.equal(typeof failedOnlyForMissingAttestationKeys, "function");
  assert.equal(yes(npmFailures.missingAttestationKey("0.1.8")), true, "the output as npm printed it");
  assert.equal(yes(npmFailures.missingAttestationKey("0.1.8", { tuf: true })), true);
  assert.equal(yes(npmFailures.missingAttestationKey("0.1.8"), "0.1.7"), false, "for another version");
  assert.equal(failedOnlyForMissingAttestationKeys(npmFailures.missingAttestationKey("0.1.8"), "other-package", "0.1.8"), false, "for another package");
  assert.equal(yes({ ...npmFailures.missingAttestationKey("0.1.8"), code: 0 }), false, "npm did not fail");
  const line = "npm error code EMISSINGSIGNATUREKEY";
  const text = "npm error narrarium-server@0.1.8 has attestations but no corresponding public key(s) can be found";
  assert.equal(yes({ code: 1, stdout: "", stderr: `${line}\n${text}` }), true, "with no log line and no final line end");
  assert.equal(yes({ code: 1, stdout: "", stderr: `${text}\n${line}\n` }), true, "in the other order");
  assert.equal(yes({ code: 1, stdout: "", stderr: `  ${line}  \n\t${text}\t\n` }), true, "with spaces around");
  assert.equal(yes({ code: 1, stdout: line, stderr: text }), true, "split between the two streams");
  assert.equal(yes({ code: 1, stdout: "", stderr: `npm WARN old\n${line.replace("npm error", "npm ERR!")}\n${text.replace("npm error", "npm ERR!")}\nnpm ERR! A complete log of this run can be found in: /x/y.log\n` }), true, "in the old words");
  assert.equal(yes({ code: 1, stdout: "", stderr: `${line}\n${text}\nnpm error A complete log of this run can be found in: C:\\Users\\me\\AppData\\Local\\npm-cache\\_logs\\x-debug-0.log\r\n` }), true, "a Windows path");
  assert.equal(yes({ code: 1, stdout: "", stderr: `npm warn one\nnpm notice two\nnpm warn three\n${line}\n${text}\n` }), true, "warnings and notices are not failures");

  const refused = [
    ["a missing code", { code: 1, stdout: "", stderr: `${text}\n` }],
    ["a missing message", { code: 1, stdout: "", stderr: `${line}\n` }],
    ["another code", { code: 1, stdout: "", stderr: `npm error code ENOTFOUND\n${text}\n` }],
    ["a code that only starts alike", { code: 1, stdout: "", stderr: `${line}X\n${text}\n` }],
    ["a code that only ends alike", { code: 1, stdout: "", stderr: `npm error code XEMISSINGSIGNATUREKEY\n${text}\n` }],
    ["two codes", { code: 1, stdout: "", stderr: `${line}\n${line}\n${text}\n` }],
    ["two messages", { code: 1, stdout: "", stderr: `${line}\n${text}\n${text}\n` }],
    ["a message of the registry-signature kind", { code: 1, stdout: "", stderr: `${line}\nnpm error narrarium-server@0.1.8 has a registry signature with keyid: SHA256:abc but no corresponding public key can be found\n` }],
    ["a message that goes on", { code: 1, stdout: "", stderr: `${line}\n${text}.\n` }],
    ["a message of another version of the package", { code: 1, stdout: "", stderr: `${line}\n${text.replace("0.1.8", "0.1.80")}\n` }],
    ["a message in the middle of a line", { code: 1, stdout: "", stderr: `${line}\nnpm error x ${text.slice("npm error ".length)}\n` }],
    ["a line that is not npm's", { code: 1, stdout: "", stderr: `${line}\n${text}\nsomething\n` }],
    ["an error line of something else", { code: 1, stdout: "", stderr: `${line}\n${text}\nnpm error unrelated\n` }],
    ["a message that is not on a line of npm", { code: 1, stdout: "", stderr: `${line}\n${text.slice("npm error ".length)}\n` }],
    ["a line of something that is not a prefix", { code: 1, stdout: "", stderr: `${line}\nnpmerror ${text.slice("npm error ".length)}\n` }],
    ["a report of invalid signatures", npmFailures.invalidSignature("0.1.8")],
    ["nothing", { code: 1, stdout: "", stderr: "" }],
    ["text that is not text", { code: 1, stdout: 5, stderr: null }],
    ["no output at all", { code: 1 }],
    ["no result at all", undefined],
    ["a result that is null", null],
    ["a result that is text", `${line}\n${text}`],
  ];
  for (const [what, output] of refused) assert.equal(yes(output), false, what);
});

// ─── The log, from the supervisor and from the CLI ─────────────────────────

/** Server processes started by the supervisor; `stopAll` ends every one, and the ones that are started after it, so that a test that fails cannot leave a supervisor running. */
function fakeChildren() {
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
    if (stopped) child.exit(0);
    return child;
  };
  const stopAll = () => {
    stopped = true;
    for (const child of list) child.exit(0);
  };
  return { list, spawn, stopAll };
}

const updateRequest = (version) => ({ schemaVersion: 1, packageName: "narrarium-server", version, requestedAt: new Date().toISOString(), requestId: randomUUID(), source: "client" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** A supervisor over a fake npm and registry, which is stopped whatever the test does. */
async function withSupervisor({ releases, latest, currentVersion, auditOutput = {} }, run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-verify-"));
  const npm = fakeNpm({ releases, latest });
  const registry = fakeRegistry({ releases, latest });
  const installer = oneUpdateFileAtATime(new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, fetch: registry.fetch }));
  for (const [version, output] of Object.entries(auditOutput)) npm.state.auditOutput.set(version, output);
  const lines = [];
  const children = fakeChildren();
  const supervised = superviseServer({ installer, currentVersion, spawnChild: children.spawn, pollMs: 5, stopTimeoutMs: 2000, forwardSignals: false, log: (line) => lines.push(line) });
  supervised.catch(() => undefined);
  try {
    await run({ installer, children, supervised, lines });
  } finally {
    children.stopAll();
    await Promise.race([supervised.catch(() => undefined), sleep(3000)]);
    await remove(dataRoot);
  }
}

test("S8 log: the supervisor writes the warning in its log, before it says the update was done, and an update with nothing to warn about writes none", async () => {
  const releases = [bootstrapRelease("0.1.0"), slsaOnly("0.2.0"), forgeRelease("0.3.0")];
  const auditOutput = { "0.2.0": npmFailures.missingAttestationKey("0.2.0", { tuf: true }) };
  await withSupervisor({ releases, latest: "0.3.0", currentVersion: "0.1.0", auditOutput }, async ({ installer, children, supervised, lines }) => {
    await until(() => children.list.length === 1);
    assert.deepEqual(lines, [], "the first install, of a clean release, said nothing");

    await installer.writeUpdateRequest(updateRequest("0.2.0"));
    await until(() => children.list.length === 2);
    assert.match(children.list[1].serverPath, /versions[\\/]0\.2\.0[\\/]/, "the update was done");
    const warnings = lines.filter((line) => line.startsWith(ACCEPTED));
    assert.equal(warnings.length, 1, lines.join("\n"));
    assert.ok(lines.indexOf(warnings[0]) < lines.indexOf("Updated from 0.1.0 to 0.2.0."), "the warning comes before the line that says it was done");
    assert.deepEqual(lines.filter((line) => !line.startsWith("Warning")), ["Update to 0.2.0 requested: stopping the server.", "Updated from 0.1.0 to 0.2.0."]);
    const result = await installer.readUpdateResult();
    assert.equal(result.state, "completed", "the outcome the clients read is what it always was");
    assert.equal(result.message, server.UPDATE_MESSAGES.completed);

    lines.length = 0;
    await installer.writeUpdateRequest(updateRequest("0.3.0"));
    await until(() => children.list.length === 3);
    assert.deepEqual(lines, ["Update to 0.3.0 requested: stopping the server.", "Updated from 0.2.0 to 0.3.0."], "a clean release warns of nothing");
    children.list[2].exit(0);
    await supervised;
  });
});

test("S8 log: the supervisor tells the warning for its own first install too, and an update that is refused leaves only the reason, no warning", async () => {
  const releases = [slsaOnly("0.2.0"), slsaOnly("0.3.0")];
  const auditOutput = { "0.2.0": npmFailures.missingAttestationKey("0.2.0"), "0.3.0": npmFailures.invalidSignature("0.3.0") };
  await withSupervisor({ releases, latest: "0.3.0", currentVersion: "0.2.0", auditOutput }, async ({ installer, children, supervised, lines }) => {
    await until(() => children.list.length === 1);
    assert.equal(lines.filter((line) => line.startsWith(ACCEPTED)).length, 1, "the first install of the CLI's own version is told too, the same way");
    lines.length = 0;
    await installer.writeUpdateRequest(updateRequest("0.3.0"));
    await until(() => children.list.length === 2);
    assert.match(children.list[1].serverPath, /versions[\\/]0\.2\.0[\\/]/, "the previous version runs again");
    assert.deepEqual(lines, ["Update to 0.3.0 requested: stopping the server.", "Update to 0.3.0 failed: npm audit did not succeed."]);
    assert.equal((await installer.readUpdateResult()).state, "failed");
    children.list[1].exit(0);
    await supervised;
  });
});

test("S8 log: the CLI shows the warning in its own output, from start (prepareRuntime), setup and update", async () => {
  const run = async (command) => {
    const releases = [slsaOnly(V), slsaOnly(SERVER_VERSION)];
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-verify-"));
    const npm = fakeNpm({ releases, latest: V });
    const registry = fakeRegistry({ releases, latest: V });
    const installer = new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, fetch: registry.fetch });
    for (const version of new Set([V, SERVER_VERSION])) npm.state.auditOutput.set(version, npmFailures.missingAttestationKey(version));
    const out = [];
    const err = [];
    try {
      const code = await command({ installer, dataRoot, out, err });
      return { code, out: out.join(""), err: err.join(""), active: (await installer.activeRuntime())?.version };
    } finally {
      await remove(dataRoot);
    }
  };
  const cli = (argv) => ({ installer, dataRoot, out, err }) => cliMain([...argv, "--data-root", dataRoot], {}, { createInstaller: () => installer, stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
  const warned = (text, version) => text.split("\n").filter((line) => line.startsWith(`Warning: npm audit signatures could not finish for narrarium-server@${version}`));

  const prepared = [];
  await run(async ({ installer }) => {
    assert.equal(await prepareRuntime(installer, V, (line) => prepared.push(line)), "supervised");
    return 0;
  });
  assert.equal(prepared.length, 2, prepared.join("\n"));
  assert.match(prepared[0], /^Preparing the verified runtime 0\.2\.0/);
  assert.ok(prepared[1].startsWith(`${ACCEPTED}`), "told through the `say` that start gives it");

  const updated = await run(cli(["update", "--to", V]));
  assert.equal(updated.code, 0, updated.err);
  assert.equal(warned(updated.out, V).length, 1, updated.out);
  assert.ok(updated.out.indexOf("Warning:") < updated.out.indexOf("Runtime (none)"), "before the line that says it was done");
  assert.equal(updated.active, V);

  const installed = await run(cli(["setup"]));
  assert.equal(installed.code, 0, installed.err);
  assert.equal(warned(installed.out, SERVER_VERSION).length, 1, installed.out);
  assert.equal(installed.active, SERVER_VERSION);
  assert.equal(installed.err, "");
});

test("S8 log: a log that throws does not undo an install that was accepted", async () => {
  await withInstaller({}, async ({ installer, npm }) => {
    npm.state.auditOutput.set(V, npmFailures.missingAttestationKey(V));
    const active = await installer.installVersion(V, { log: () => { throw new Error("the log is closed"); } });
    assert.equal(active.version, V);
    assert.equal((await installer.activeRuntime()).version, V);
  });
  await withInstaller({}, async ({ installer, npm }) => {
    npm.state.auditOutput.set(V, npmFailures.missingAttestationKey(V));
    assert.equal((await installer.installVersion(V)).version, V, "and without a log at all, it is accepted just the same");
  });
});
