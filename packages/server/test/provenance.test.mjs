import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as server from "../dist/testing.mjs";
import {
  OID,
  PROVENANCE_TYPE,
  REAL_ATTESTATIONS,
  REAL_IDENTITY,
  REAL_PACKUMENT,
  REAL_RELEASE,
  REAL_VERSION,
  attestationUrl,
  bootstrapRelease,
  der,
  editCertificate,
  editProvenance,
  editStatement,
  fakeRegistry,
  forgeRelease,
  hexOfIntegrity,
  integrityFor,
  latestUrl,
  provenanceEntry,
  sanValue,
  silence,
  utf8Value,
  workflowUri,
} from "./release-fixtures.mjs";

// The new exports are read from the namespace: before they exist a test fails by itself instead of breaking the whole file.
const { NPM_RELEASE_IDENTITY, ReleaseVerificationError, checkNpmServerRelease, fetchNpmAttestations, inspectNpmRelease, trustedNpmReleaseMetadata, verifyNpmProvenance, verifyNpmReleaseProvenance } = server;

const verify = (attestations, expected = {}) => verifyNpmProvenance(attestations, { version: REAL_VERSION, integrity: REAL_RELEASE.integrity, ...expected });

function assertRejected(run, pattern) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ReleaseVerificationError, `a ReleaseVerificationError, not ${error?.name}: ${error?.message}`);
    assert.match(error.message, pattern);
    return true;
  });
}

const san = (version, signer) => sanValue(der.uri(workflowUri(version, signer)));
const realSan = () => san(REAL_VERSION);

// ---------------------------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------------------------

test("C8: the expected publishing identity is one frozen constant, written the way the real release says", () => {
  for (const [key, value] of Object.entries(REAL_IDENTITY)) assert.equal(NPM_RELEASE_IDENTITY[key], value, key);
  assert.equal(NPM_RELEASE_IDENTITY.directory, "packages/server");
  assert.ok(Object.isFrozen(NPM_RELEASE_IDENTITY));
});

test("C8: the real attestations of narrarium-server@0.1.2, published by the publishing workflow, are accepted", () => {
  assert.deepEqual(trustedNpmReleaseMetadata(REAL_PACKUMENT), { version: REAL_VERSION });
  const release = inspectNpmRelease(REAL_PACKUMENT, REAL_VERSION);
  assert.equal(release.version, REAL_VERSION);
  assert.equal(release.integrity, REAL_PACKUMENT.dist.integrity);
  assert.equal(release.attested, true);
  verify(REAL_ATTESTATIONS);
  verifyNpmProvenance(REAL_ATTESTATIONS, { version: REAL_VERSION, integrity: REAL_PACKUMENT.dist.integrity });
});

test("C8: the real fixture matches the identity claim by claim (what a release must carry, and nothing about its version but the tag)", () => {
  const entry = provenanceEntry(REAL_ATTESTATIONS);
  const statement = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  assert.equal(statement.subject[0].name, `pkg:npm/narrarium-server@${REAL_VERSION}`);
  assert.equal(statement.subject[0].digest.sha512, hexOfIntegrity(REAL_PACKUMENT.dist.integrity));
  assert.equal(statement.predicate.buildDefinition.externalParameters.workflow.ref, `refs/tags/${REAL_IDENTITY.tagPrefix}${REAL_VERSION}`);
  assert.equal(statement.predicate.buildDefinition.externalParameters.workflow.path, `.github/workflows/${REAL_IDENTITY.workflowFile}`);
  assert.equal(statement.predicate.buildDefinition.externalParameters.workflow.repository, `https://github.com/${REAL_IDENTITY.owner}/${REAL_IDENTITY.repository}`);
});

test("C8: the next release of the same workflow passes: the forger only rewrites what depends on the version, and reproduces the real release for 0.1.2", () => {
  // Forging the real version must give back the real claims (the forger models the workflow's output) ...
  const again = forgeRelease(REAL_VERSION, { integrity: REAL_PACKUMENT.dist.integrity });
  const claims = (attestations) => {
    const values = {};
    editCertificate(attestations, (certificate) => {
      for (const oid of [OID.san, OID.legacyIssuer, OID.legacyRepository, OID.legacyRef, OID.issuer, OID.buildSigner, OID.buildConfig, OID.sourceRepository, OID.sourceRef, OID.repositoryId, OID.ownerId]) values[oid] = certificate.get(oid)?.toString("hex");
    });
    const entry = provenanceEntry(attestations);
    values.statement = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
    return values;
  };
  assert.deepEqual(claims(again.attestations), claims(REAL_ATTESTATIONS));
  // ... and a release of any other version is then accepted.
  for (const version of ["0.1.3", "0.1.10", "0.2.0", "0.10.0", "1.0.0", "2.3.4-rc.1"]) {
    const release = forgeRelease(version);
    verifyNpmProvenance(release.attestations, { version, integrity: release.integrity });
    assert.equal(inspectNpmRelease(release.packument, version).integrity, release.integrity);
  }
});

test("C8: a bundle in the older shape (a certificate chain, leaf first) is accepted, and so are claims that are not pinned", () => {
  const chain = editProvenance(REAL_ATTESTATIONS, (entry) => {
    const material = entry.bundle.verificationMaterial;
    material.x509CertificateChain = { certificates: [{ rawBytes: material.certificate.rawBytes }, { rawBytes: Buffer.from("an intermediate the server never reads").toString("base64") }] };
    delete material.certificate;
  });
  verify(chain);

  // Extensions a later Fulcio may add or drop do not matter; the pinned ones do.
  const drifted = editCertificate(REAL_ATTESTATIONS, (certificate) => {
    for (const oid of [OID.environment, OID.subject, OID.buildSigner, OID.buildConfig, OID.sourceRepository, OID.sourceRef, OID.legacyRepository, OID.legacyRef]) certificate.remove(oid);
    certificate.add("1.3.6.1.4.1.57264.1.99", utf8Value("something new"));
    certificate.add("1.3.6.1.4.1.57264.1.100", Buffer.from([0x30, 0x00]));
  });
  verify(drifted);

  // Either issuer extension is enough, the other one may be gone.
  verify(editCertificate(REAL_ATTESTATIONS, (certificate) => certificate.remove(OID.legacyIssuer)));
  verify(editCertificate(REAL_ATTESTATIONS, (certificate) => certificate.remove(OID.issuer)));

  // Other attestations in the list (the npm publish attestation, unknown kinds) and their order are irrelevant.
  const crowded = editProvenance(REAL_ATTESTATIONS, (_entry, document) => {
    document.attestations.unshift({ predicateType: "https://example.com/other", bundle: {} });
    document.attestations.reverse();
  });
  verify(crowded);
});

// ---------------------------------------------------------------------------------------------
// Every claim altered, one at a time (on the real data)
// ---------------------------------------------------------------------------------------------

const certificateCases = [
  ["the certificate names another account", (c) => c.set(OID.san, san(REAL_VERSION, { owner: "Mallory" })), /signing certificate names/],
  ["the certificate names another repository", (c) => c.set(OID.san, san(REAL_VERSION, { repository: "GhostWriterFramework-fork" })), /signing certificate names/],
  ["the certificate names another workflow file", (c) => c.set(OID.san, san(REAL_VERSION, { workflowFile: "publish.yml" })), /signing certificate names/],
  ["the certificate names another workflow directory", (c) => c.set(OID.san, sanValue(der.uri("https://github.com/KeyserDSoze/GhostWriterFramework/.github/other/publish-server-npm.yml@refs/tags/narrarium-server-v0.1.2"))), /signing certificate names/],
  ["the certificate names another tag prefix", (c) => c.set(OID.san, san(REAL_VERSION, { tagPrefix: "v" })), /signing certificate names/],
  ["the certificate names the tag of another version", (c) => c.set(OID.san, san("0.1.3")), /signing certificate names/],
  ["the certificate names a longer version that starts like the installed one", (c) => c.set(OID.san, san("0.1.20")), /signing certificate names/],
  ["the certificate names a branch, not a tag", (c) => c.set(OID.san, sanValue(der.uri("https://github.com/KeyserDSoze/GhostWriterFramework/.github/workflows/publish-server-npm.yml@refs/heads/main"))), /signing certificate names/],
  ["the certificate name has something appended", (c) => c.set(OID.san, sanValue(der.uri(`${workflowUri(REAL_VERSION)}/extra`))), /signing certificate names/],
  ["the certificate names the owner in another case", (c) => c.set(OID.san, san(REAL_VERSION, { owner: "keyserdsoze" })), /signing certificate names/],
  ["the certificate names an e-mail address", (c) => c.set(OID.san, sanValue(der.email("owner@example.com"))), /signing certificate names/],
  ["the certificate has the right name and a second one", (c) => c.set(OID.san, sanValue(der.uri(workflowUri(REAL_VERSION)), der.dns("example.com"))), /signing certificate names/],
  ["the certificate has the right name twice", (c) => c.set(OID.san, sanValue(der.uri(workflowUri(REAL_VERSION)), der.uri(workflowUri(REAL_VERSION)))), /signing certificate names/],
  ["the certificate has an empty name list", (c) => c.set(OID.san, sanValue()), /signing certificate names/],
  ["the certificate has no name at all", (c) => c.remove(OID.san), /signing certificate names/],
  ["the certificate has the right name and, after it, the name of an attacker", (c) => c.add(OID.san, san(REAL_VERSION, { owner: "Mallory" })), /signing certificate/],
  ["the certificate has the name of an attacker and, after it, the right one", (c) => {
    c.set(OID.san, san(REAL_VERSION, { owner: "Mallory" }));
    c.add(OID.san, realSan());
  }, /signing certificate/],
  ["the issuer is another OIDC provider (both extensions)", (c) => {
    c.set(OID.legacyIssuer, Buffer.from("https://accounts.google.com"));
    c.set(OID.issuer, utf8Value("https://accounts.google.com"));
  }, /issuer/],
  ["the issuer is GitHub's with something appended", (c) => {
    c.set(OID.legacyIssuer, Buffer.from("https://token.actions.githubusercontent.com.evil.example"));
    c.set(OID.issuer, utf8Value("https://token.actions.githubusercontent.com.evil.example"));
  }, /issuer/],
  ["the two issuer extensions disagree (the v2 one is another provider)", (c) => c.set(OID.issuer, utf8Value("https://accounts.google.com")), /issuer/],
  ["the two issuer extensions disagree (the legacy one is another provider)", (c) => c.set(OID.legacyIssuer, Buffer.from("https://accounts.google.com")), /issuer/],
  ["there is no issuer extension", (c) => {
    c.remove(OID.legacyIssuer);
    c.remove(OID.issuer);
  }, /issuer/],
  ["the v2 issuer is not a DER string", (c) => c.set(OID.issuer, Buffer.from("https://token.actions.githubusercontent.com")), /issuer/],
  ["the v2 issuer has bytes after its string", (c) => c.set(OID.issuer, Buffer.concat([utf8Value("https://token.actions.githubusercontent.com"), Buffer.from([0])])), /issuer/],
  ["the repository id is another one (the name was taken over by somebody else)", (c) => c.set(OID.repositoryId, utf8Value("999999")), /another GitHub repository or account/],
  ["the owner id is another one (the account name was taken over)", (c) => c.set(OID.ownerId, utf8Value("999999")), /another GitHub repository or account/],
  ["there is no repository id", (c) => c.remove(OID.repositoryId), /another GitHub repository or account/],
  ["there is no owner id", (c) => c.remove(OID.ownerId), /another GitHub repository or account/],
  ["the repository id is not a DER string", (c) => c.set(OID.repositoryId, Buffer.from("1176286350")), /another GitHub repository or account/],
];
for (const [name, edit, pattern] of certificateCases) {
  test(`C8 identity: ${name}: rejected`, () => assertRejected(() => verify(editCertificate(REAL_ATTESTATIONS, edit)), pattern));
}

const containerCases = [
  ["the bundle has no certificate, only a public key", (entry) => {
    delete entry.bundle.verificationMaterial.certificate;
    entry.bundle.verificationMaterial.publicKey = { hint: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U" };
  }, /no signing certificate/],
  ["the verification material is empty", (entry) => void (entry.bundle.verificationMaterial = {}), /no signing certificate/],
  ["there is no verification material", (entry) => void delete entry.bundle.verificationMaterial, /no signing certificate/],
  ["there is no bundle", (entry) => void delete entry.bundle, /no signing certificate/],
  ["the chain is empty", (entry) => void (entry.bundle.verificationMaterial = { x509CertificateChain: { certificates: [] } }), /no signing certificate/],
  ["the certificate has no bytes", (entry) => void (entry.bundle.verificationMaterial.certificate = {}), /cannot be read/],
  ["the certificate is not base64", (entry) => void (entry.bundle.verificationMaterial.certificate.rawBytes = "!!! not base64 !!!"), /cannot be read/],
  ["the certificate is empty", (entry) => void (entry.bundle.verificationMaterial.certificate.rawBytes = ""), /cannot be read/],
  ["the certificate is random bytes", (entry) => void (entry.bundle.verificationMaterial.certificate.rawBytes = randomBytes(900).toString("base64")), /cannot be read/],
  ["the certificate is cut short", (entry) => {
    const material = entry.bundle.verificationMaterial;
    material.certificate.rawBytes = Buffer.from(material.certificate.rawBytes, "base64").subarray(0, 900).toString("base64");
  }, /cannot be read/],
  ["bytes follow the certificate", (entry) => {
    const material = entry.bundle.verificationMaterial;
    material.certificate.rawBytes = Buffer.concat([Buffer.from(material.certificate.rawBytes, "base64"), Buffer.from([0, 0])]).toString("base64");
  }, /cannot be read/],
  ["a single certificate and a chain are both present", (entry) => {
    const material = entry.bundle.verificationMaterial;
    material.x509CertificateChain = { certificates: [{ rawBytes: material.certificate.rawBytes }] };
  }, /two kinds of certificate/],
];
for (const [name, edit, pattern] of containerCases) {
  test(`C8 identity: ${name}: rejected`, () => assertRejected(() => verify(editProvenance(REAL_ATTESTATIONS, edit)), pattern));
}

const flipped = (hex) => `${hex[0] === "0" ? "1" : "0"}${hex.slice(1)}`;
const statementCases = [
  ["the digest is the one of another tarball", (s) => void (s.subject[0].digest.sha512 = hexOfIntegrity(integrityFor("9.9.9"))), /digest/],
  ["one digit of the digest is changed", (s) => void (s.subject[0].digest.sha512 = flipped(s.subject[0].digest.sha512)), /digest/],
  ["there is only a sha256 digest", (s) => void (s.subject[0].digest = { sha256: "ab".repeat(32) }), /digest/],
  ["there is no digest", (s) => void delete s.subject[0].digest, /digest/],
  ["the subject is another package", (s) => void (s.subject[0].name = "pkg:npm/narrarium-server-evil@0.1.2"), /subject/],
  ["the subject is another version", (s) => void (s.subject[0].name = "pkg:npm/narrarium-server@0.1.3"), /subject/],
  ["the subject has no version", (s) => void (s.subject[0].name = "pkg:npm/narrarium-server"), /subject/],
  ["the subject is a scoped look-alike", (s) => void (s.subject[0].name = "pkg:npm/%40evil/narrarium-server@0.1.2"), /subject/],
  ["the statement has two subjects", (s) => void s.subject.push({ name: "pkg:npm/other@1.0.0", digest: { sha512: "ab".repeat(64) } }), /exactly one subject/],
  ["the statement has no subject", (s) => void (s.subject = []), /exactly one subject/],
  ["the statement is not an SLSA provenance v1", (s) => void (s.predicateType = "https://slsa.dev/provenance/v0.2"), /SLSA provenance v1/],
  ["the statement has no predicate", (s) => void delete s.predicate, /workflow/],
  ["the workflow claim names another repository", (s) => void (s.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/Mallory/GhostWriterFramework"), /workflow/],
  ["the workflow claim names another ref", (s) => void (s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/narrarium-server-v0.1.3"), /workflow/],
  ["the workflow claim names a branch", (s) => void (s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"), /workflow/],
  ["the workflow claim names another file", (s) => void (s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/publish.yml"), /workflow/],
  ["the workflow claim is missing", (s) => void delete s.predicate.buildDefinition.externalParameters.workflow, /workflow/],
  ["the external parameters are missing", (s) => void delete s.predicate.buildDefinition.externalParameters, /workflow/],
  ["the workflow claim is not made of strings", (s) => void (s.predicate.buildDefinition.externalParameters.workflow.ref = 5), /workflow/],
];
for (const [name, edit, pattern] of statementCases) {
  test(`C8 identity: ${name}: rejected`, () => assertRejected(() => verify(editStatement(REAL_ATTESTATIONS, edit)), pattern));
}

const entryCases = [
  ["the entry names another predicate type, so no provenance is left", (entry) => void (entry.predicateType = "https://slsa.dev/provenance/v0.2"), /no SLSA provenance/],
  ["the envelope is not an in-toto statement", (entry) => void (entry.bundle.dsseEnvelope.payloadType = "text/plain"), /statement/],
  ["the payload is not base64", (entry) => void (entry.bundle.dsseEnvelope.payload = "***"), /statement/],
  ["the payload is not JSON", (entry) => void (entry.bundle.dsseEnvelope.payload = Buffer.from("not json").toString("base64")), /statement/],
  ["the payload is a JSON array", (entry) => void (entry.bundle.dsseEnvelope.payload = Buffer.from("[]").toString("base64")), /statement/],
  ["there is no envelope", (entry) => void delete entry.bundle.dsseEnvelope, /statement/],
  ["the payload is the npm publish statement", (entry, document) => {
    const publish = document.attestations.find((candidate) => candidate !== entry);
    entry.bundle.dsseEnvelope.payload = publish.bundle.dsseEnvelope.payload;
  }, /SLSA provenance v1/],
  ["a second provenance attestation is attached (the real one)", (_entry, document) => void document.attestations.push(structuredClone(provenanceEntry(document))), /more than one/],
  ["a second provenance attestation is attached (another signer's)", (_entry, document) => void document.attestations.push(forgeRelease(REAL_VERSION, { owner: "Mallory" }).attestations.attestations.find((entry) => entry.predicateType === PROVENANCE_TYPE)), /more than one/],
];
for (const [name, edit, pattern] of entryCases) {
  test(`C8 identity: ${name}: rejected`, () => assertRejected(() => verify(editProvenance(REAL_ATTESTATIONS, edit)), pattern));
}

for (const [name, document, pattern] of [
  ["a string", "oops", /attestation list/],
  ["null", null, /attestation list/],
  ["an array", [], /attestation list/],
  ["an object without the list", {}, /attestation list/],
  ["an empty list", { attestations: [] }, /no SLSA provenance/],
  ["a list with entries that are not objects", { attestations: [null, 5, "x"] }, /attestation list/],
]) {
  test(`C8 identity: the attestation document is ${name}: rejected`, () => assertRejected(() => verify(document), pattern));
}

test("C8 identity: what is installed must be what is attested, for this version, and nothing else", () => {
  assertRejected(() => verify(REAL_ATTESTATIONS, { integrity: integrityFor("0.1.2") }), /digest/);
  assertRejected(() => verify(REAL_ATTESTATIONS, { version: "0.1.3" }), /signing certificate names/);
  assertRejected(() => verify(REAL_ATTESTATIONS, { version: "0.1.20" }), /signing certificate names/);
  assertRejected(() => verify(REAL_ATTESTATIONS, { integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }), /integrity/);
  assertRejected(() => verify(REAL_ATTESTATIONS, { integrity: `sha512-${"A".repeat(10)}` }), /integrity/);
  assertRejected(() => verify(REAL_ATTESTATIONS, { integrity: undefined }), /integrity/);
});

test("C8 identity: damage to the certificate is only ever a rejection, and none of the bytes that carry the signer's name, issuer or ids can change unnoticed", () => {
  const original = Buffer.from(provenanceEntry(REAL_ATTESTATIONS).bundle.verificationMaterial.certificate.rawBytes, "base64");
  const withCertificate = (bytes) => editProvenance(REAL_ATTESTATIONS, (entry) => void (entry.bundle.verificationMaterial.certificate.rawBytes = bytes.toString("base64")));

  // Random damage: a rejection or, where nothing is pinned (the signature, the key, the log's timestamp ...), harmless, since npm checks those.
  let seed = 20260721;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  let rejected = 0;
  for (let round = 0; round < 400; round += 1) {
    const copy = Buffer.from(original);
    for (let hits = 0; hits <= next() % 3; hits += 1) copy[next() % copy.length] = next() & 0xff;
    try {
      verify(withCertificate(copy));
    } catch (error) {
      assert.ok(error instanceof ReleaseVerificationError, `round ${round}: ${error?.name}: ${error?.message}`);
      rejected += 1;
    }
  }
  assert.ok(rejected > 50, `damage in the pinned places is noticed (${rejected} of 400 rounds)`);

  // Targeted: every bit of the name (its first occurrence is the subject alternative name), of both issuer extensions and of both ids.
  const pinned = [workflowUri(REAL_VERSION), REAL_IDENTITY.issuer, REAL_IDENTITY.repositoryId, REAL_IDENTITY.ownerId];
  let checked = 0;
  for (const text of pinned) {
    const needle = Buffer.from(text);
    for (let from = original.indexOf(needle); from >= 0; from = original.indexOf(needle, from + 1)) {
      if (text === workflowUri(REAL_VERSION) && from !== original.indexOf(needle)) continue; // the other copies are not pinned (the SAN is)
      for (let offset = from; offset < from + needle.length; offset += 1) {
        for (const bit of [0x01, 0x20]) {
          const copy = Buffer.from(original);
          copy[offset] ^= bit;
          assertRejected(() => verify(withCertificate(copy)), /./);
          checked += 1;
        }
      }
    }
  }
  // Two bits of every byte of: the name, the issuer (in both extensions), the repository id and the owner id.
  const bytes = workflowUri(REAL_VERSION).length + 2 * REAL_IDENTITY.issuer.length + REAL_IDENTITY.repositoryId.length + REAL_IDENTITY.ownerId.length;
  assert.equal(checked, 2 * bytes, "every pinned byte was changed, and every change was rejected");
});

test("C8: metadata that points at the attestations of another package, version, host or address is refused", () => {
  const release = forgeRelease("0.2.0");
  const pointing = (url) => ({ ...release.packument, dist: { ...release.packument.dist, attestations: { ...release.packument.dist.attestations, url } } });
  inspectNpmRelease(pointing(attestationUrl("0.2.0")), "0.2.0");
  for (const url of [
    attestationUrl("0.2.1"),
    attestationUrl("0.1.2"),
    "https://registry.npmjs.org/-/npm/v1/attestations/narrarium-engine@0.2.0",
    "https://registry.npmjs.org/-/npm/v1/attestations/narrarium-server-evil@0.2.0",
    "https://evil.example/-/npm/v1/attestations/narrarium-server@0.2.0",
    "http://registry.npmjs.org/-/npm/v1/attestations/narrarium-server@0.2.0",
    `${attestationUrl("0.2.0")}?other=1`,
    `${attestationUrl("0.2.0")}/`,
    `${attestationUrl("0.2.0")}#x`,
    undefined,
  ]) assert.throws(() => inspectNpmRelease(pointing(url), "0.2.0"), /provenance/, String(url));
  // ... and so is metadata whose integrity is not one sha512 value (nothing could be pinned to it).
  for (const integrity of ["sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=", `sha512-${"A".repeat(86)}`, `sha512-${"A".repeat(86)}== sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=`, undefined, 5]) {
    assert.throws(() => inspectNpmRelease({ ...release.packument, dist: { ...release.packument.dist, integrity } }), /not valid/, String(integrity));
  }
});

// ---------------------------------------------------------------------------------------------
// Reading the attestations from the registry
// ---------------------------------------------------------------------------------------------

test("C8: the attestations are read from the one URL of this package and version, without credentials, redirects or large bodies", async () => {
  const registry = fakeRegistry({ releases: [REAL_RELEASE] });
  const document = await fetchNpmAttestations(REAL_VERSION, registry.fetch);
  assert.deepEqual(document, REAL_ATTESTATIONS);
  assert.deepEqual(registry.urls(), [attestationUrl(REAL_VERSION)]);
  const { init } = registry.requests[0];
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(new Headers(init.headers).has("authorization"), false);

  const failing = (response) => fakeRegistry({ routes: { [attestationUrl("0.2.0")]: () => response } }).fetch;
  await assert.rejects(() => fetchNpmAttestations("0.2.0", failing(new Response("{}", { status: 404 }))), /could not be read/);
  await assert.rejects(() => fetchNpmAttestations("0.2.0", failing(new Response("oops", { status: 500 }))), /could not be read/);
  await assert.rejects(() => fetchNpmAttestations("0.2.0", failing(new Response("not json", { status: 200 }))), /could not be read/);
  await assert.rejects(() => fetchNpmAttestations("0.2.0", failing(new Response(`{"padding":"${"x".repeat(300 * 1024)}"}`, { status: 200 }))), /could not be read/);
  await assert.rejects(() => fetchNpmAttestations("0.2.0", failing(new Response("{}", { status: 200, headers: { "content-length": String(50 * 1024 * 1024) } }))), /could not be read/);
  await assert.rejects(() => fetchNpmAttestations("0.2.0", async () => {
    throw new TypeError("fetch failed");
  }), /could not be read/);
  await assert.rejects(() => fetchNpmAttestations("0.2.0", fakeRegistry({ routes: { [attestationUrl("0.2.0")]: silence } }).fetch, { timeoutMs: 30 }), /could not be read/);
  await assert.rejects(() => fetchNpmAttestations("latest", registry.fetch), /exact semver|version/);
  await assert.rejects(() => fetchNpmAttestations("1.0.0/../../x", registry.fetch), /exact semver|version/);
});

test("C8: a registry that answers with the bundle of another version is not believed", async () => {
  const other = forgeRelease("0.2.0");
  const confused = fakeRegistry({ routes: { [attestationUrl("0.3.0")]: () => new Response(JSON.stringify(other.attestations)) } });
  await assert.rejects(() => verifyNpmReleaseProvenance("0.3.0", integrityFor("0.3.0"), confused.fetch), (error) => error instanceof ReleaseVerificationError && /signing certificate names/.test(error.message));
  const real = fakeRegistry({ releases: [REAL_RELEASE] });
  await verifyNpmReleaseProvenance(REAL_VERSION, REAL_RELEASE.integrity, real.fetch);
  assert.deepEqual(real.urls(), [attestationUrl(REAL_VERSION)]);
});

// ---------------------------------------------------------------------------------------------
// The offer: an update is announced only when its identity checks out
// ---------------------------------------------------------------------------------------------

test("C8 offer: the real 0.1.2 is offered to an older server after its attestation was read (two small reads, no tarball)", async () => {
  const registry = fakeRegistry({ latest: REAL_VERSION, releases: [REAL_RELEASE] });
  const check = await checkNpmServerRelease("0.1.1", registry.fetch);
  assert.equal(check.available, true);
  assert.equal(check.signed, true);
  assert.equal(check.latestVersion, REAL_VERSION);
  assert.equal(check.reason, undefined);
  assert.deepEqual(registry.urls(), [latestUrl, attestationUrl(REAL_VERSION)]);
  for (const { init } of registry.requests) {
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
  }
});

test("C8 offer: a release is offered only when the attestation names the publishing workflow", async () => {
  const release = forgeRelease("0.2.0");
  const registry = fakeRegistry({ latest: "0.2.0", releases: [release] });
  const check = await checkNpmServerRelease("0.1.2", registry.fetch);
  assert.equal(check.available, true);
  assert.equal(check.latestVersion, "0.2.0");
  assert.deepEqual(registry.urls(), [latestUrl, attestationUrl("0.2.0")]);
});

test("C8 offer: signed by another repository, a release is never offered, although its metadata says it comes from this one", async () => {
  const attacker = forgeRelease("0.2.0", { owner: "attacker", repository: "evil-repo", workflowFile: "publish.yml", ownerId: "6666", repositoryId: "7777" });
  assert.equal(attacker.packument.repository.url, "git+https://github.com/KeyserDSoze/GhostWriterFramework.git");
  assert.equal(attacker.packument.repository.directory, "packages/server");
  // What the offer trusted until now: signatures present, a provenance pointer of the right shape, this repository claimed.
  assert.deepEqual(trustedNpmReleaseMetadata(attacker.packument), { version: "0.2.0" });

  const registry = fakeRegistry({ latest: "0.2.0", releases: [attacker] });
  const check = await checkNpmServerRelease("0.1.2", registry.fetch);
  assert.equal(check.available, false);
  assert.equal(check.signed, false);
  assert.equal(check.reason, "no_trusted_release");
  assert.equal(check.latestVersion, undefined, "an unverified version is never reported as the latest");
  assert.match(check.message, /0\.2\.0 is not offered/);
  assert.match(check.message, /signing certificate names/);
  assert.match(check.message, /attacker\/evil-repo/);
});

test("C8 offer: a repository name taken over by somebody else (same names, other numeric ids) is not offered", async () => {
  const taken = forgeRelease("0.2.0", { ownerId: "31337", repositoryId: "424242" });
  const check = await checkNpmServerRelease("0.1.2", fakeRegistry({ latest: "0.2.0", releases: [taken] }).fetch);
  assert.equal(check.available, false);
  assert.equal(check.reason, "no_trusted_release");
  assert.match(check.message, /another GitHub repository or account/);
});

test("C8 offer: an attestation for another tarball, for another version, or by another issuer is not offered", async () => {
  const cases = [
    ["another tarball", forgeRelease("0.2.0"), (release) => ({ ...release, packument: { ...release.packument, dist: { ...release.packument.dist, integrity: integrityFor("0.2.0 tampered") } } }), /digest/],
    ["another version", forgeRelease("0.2.0"), (release) => ({ ...release, attestations: forgeRelease("0.2.1").attestations }), /signing certificate names/],
    ["another issuer", forgeRelease("0.2.0", { issuer: "https://accounts.google.com" }), (release) => release, /issuer/],
  ];
  for (const [name, release, alter, pattern] of cases) {
    const altered = alter(release);
    const check = await checkNpmServerRelease("0.1.2", fakeRegistry({ latest: "0.2.0", releases: [altered] }).fetch);
    assert.equal(check.available, false, name);
    assert.equal(check.reason, "no_trusted_release", name);
    assert.match(check.message, pattern, name);
  }
});

test("C8 offer: an attestation that cannot be read is reported as unavailable, never offered", async () => {
  const release = forgeRelease("0.2.0");
  const routes = (route) => fakeRegistry({ latest: "0.2.0", releases: [release], routes: { [attestationUrl("0.2.0")]: route } }).fetch;
  for (const [name, route] of [
    ["a 404", () => new Response("{}", { status: 404 })],
    ["a 500", () => new Response("oops", { status: 500 })],
    ["invalid JSON", () => new Response("not json")],
    ["an oversized answer", () => new Response(`{"padding":"${"x".repeat(300 * 1024)}"}`)],
    ["a network error", () => {
      throw new TypeError("fetch failed");
    }],
  ]) {
    const check = await checkNpmServerRelease("0.1.2", routes(route));
    assert.equal(check.available, false, name);
    assert.equal(check.reason, "unavailable", name);
    assert.equal(check.latestVersion, undefined, name);
    assert.match(check.message, /0\.2\.0/, name);
  }
  const slow = fakeRegistry({ latest: "0.2.0", releases: [release], routes: { [attestationUrl("0.2.0")]: silence } });
  const started = Date.now();
  const timedOut = await checkNpmServerRelease("0.1.2", slow.fetch, { timeoutMs: 40 });
  assert.equal(timedOut.reason, "unavailable");
  assert.ok(Date.now() - started < 5000);
});

test("C8 offer: the attestation is read only for a newer version whose manifest is trusted", async () => {
  const release = forgeRelease("0.2.0");
  const unattested = { ...forgeRelease("0.2.0"), packument: bootstrapRelease("0.2.0").packument };
  for (const [name, installed, releases] of [
    ["the server runs that version", "0.2.0", [release]],
    ["the server runs a newer one", "0.3.0", [release]],
    ["the manifest has no provenance pointer", "0.1.2", [unattested]],
  ]) {
    const registry = fakeRegistry({ latest: "0.2.0", releases });
    const check = await checkNpmServerRelease(installed, registry.fetch);
    assert.equal(check.available, false, name);
    assert.deepEqual(registry.urls(), [latestUrl], `${name}: nothing but the manifest was read`);
  }
  const bootstrap = fakeRegistry({ latest: "0.1.0", releases: [bootstrapRelease("0.1.0")] });
  assert.equal((await checkNpmServerRelease("0.1.0", bootstrap.fetch)).reason, "up_to_date");
  assert.deepEqual(bootstrap.urls(), [latestUrl]);
});
