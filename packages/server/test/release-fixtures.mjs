// Release data for the update trust chain tests.
//
// REAL_* are the registry's own answers for narrarium-server@0.1.2, published by the publishing workflow
// (`curl https://registry.npmjs.org/narrarium-server/0.1.2` and `.../-/npm/v1/attestations/narrarium-server@0.1.2`),
// stored untouched under test/fixtures. Releases of other versions, and releases signed by somebody else, are derived
// from them by rewriting the certificate (a small DER tree) and the signed statement, so every claim can be changed
// one at a time. Signatures are never recomputed: the server leaves the cryptography to `npm audit signatures`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

export const REAL_VERSION = "0.1.2";
export const REAL_PACKUMENT = fixture("narrarium-server-0.1.2.packument.json");
export const REAL_ATTESTATIONS = fixture("narrarium-server-0.1.2.attestations.json");
export const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";

/** Written out here, not imported: the tests must notice a wrong identity in the source. */
export const REAL_IDENTITY = {
  owner: "KeyserDSoze",
  repository: "GhostWriterFramework",
  workflowFile: "publish-server-npm.yml",
  tagPrefix: "narrarium-server-v",
  issuer: "https://token.actions.githubusercontent.com",
  ownerId: "40713438",
  repositoryId: "1176286350",
};

export const workflowUri = (version, identity = REAL_IDENTITY) => `https://github.com/${identity.owner}/${identity.repository}/.github/workflows/${identity.workflowFile}@refs/tags/${identity.tagPrefix}${version}`;
export const integrityFor = (version) => `sha512-${createHash("sha512").update(`narrarium-server@${version} tarball`).digest("base64")}`;
export const hexOfIntegrity = (integrity) => Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");

export const OID = {
  san: "2.5.29.17",
  legacyIssuer: "1.3.6.1.4.1.57264.1.1",
  legacyRepository: "1.3.6.1.4.1.57264.1.5",
  legacyRef: "1.3.6.1.4.1.57264.1.6",
  issuer: "1.3.6.1.4.1.57264.1.8",
  buildSigner: "1.3.6.1.4.1.57264.1.9",
  sourceRepository: "1.3.6.1.4.1.57264.1.12",
  sourceRef: "1.3.6.1.4.1.57264.1.14",
  repositoryId: "1.3.6.1.4.1.57264.1.15",
  ownerId: "1.3.6.1.4.1.57264.1.17",
  buildConfig: "1.3.6.1.4.1.57264.1.18",
  environment: "1.3.6.1.4.1.57264.1.23",
  subject: "1.3.6.1.4.1.57264.1.24",
};

// ---------------------------------------------------------------------------------------------
// A small DER tree: enough to rebuild a certificate with other extensions
// ---------------------------------------------------------------------------------------------

export function parseDer(buffer, offset = 0, end = buffer.length) {
  const nodes = [];
  while (offset < end) {
    const tag = buffer[offset];
    let length = buffer[offset + 1];
    let header = 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let index = 0; index < count; index += 1) length = length * 256 + buffer[offset + 2 + index];
      header = 2 + count;
    }
    const start = offset + header;
    nodes.push((tag & 0x20) !== 0 ? { tag, children: parseDer(buffer, start, start + length) } : { tag, content: buffer.subarray(start, start + length) });
    offset = start + length;
  }
  return nodes;
}

export function encodeDer(node) {
  const body = node.children ? Buffer.concat(node.children.map(encodeDer)) : Buffer.from(node.content);
  let length = Buffer.from([body.length]);
  if (body.length >= 0x80) {
    const bytes = [];
    for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([node.tag]), length, body]);
}

export const der = {
  sequence: (...children) => ({ tag: 0x30, children }),
  utf8: (text) => ({ tag: 0x0c, content: Buffer.from(text, "utf8") }),
  uri: (text) => ({ tag: 0x86, content: Buffer.from(text, "ascii") }),
  dns: (text) => ({ tag: 0x82, content: Buffer.from(text, "ascii") }),
  email: (text) => ({ tag: 0x81, content: Buffer.from(text, "ascii") }),
};
/** The value of a Fulcio extension that holds a DER string, and of the subject alternative name. */
export const utf8Value = (text) => encodeDer(der.utf8(text));
export const sanValue = (...names) => encodeDer(der.sequence(...names));

function oidBytes(dotted) {
  const arcs = dotted.split(".").map(Number);
  const out = [];
  // The first two arcs share one sub-identifier, like every other arc written in base 128 (the second may be large when the first is 2).
  for (const arc of [arcs[0] * 40 + arcs[1], ...arcs.slice(2)]) {
    const chunk = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------------------------
// Editing an attestation document (always on a copy)
// ---------------------------------------------------------------------------------------------

export const provenanceEntry = (attestations) => attestations.attestations.find((entry) => entry.predicateType === PROVENANCE_TYPE);

export function editProvenance(attestations, edit) {
  const copy = structuredClone(attestations);
  edit(provenanceEntry(copy), copy);
  return copy;
}

export function editStatement(attestations, edit) {
  return editProvenance(attestations, (entry) => {
    const envelope = entry.bundle.dsseEnvelope;
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    edit(statement);
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  });
}

/** `edit` gets the extensions of the signing certificate: get, set (replace or append), add (append again) and remove. */
export function editCertificate(attestations, edit) {
  return editProvenance(attestations, (entry) => {
    const material = entry.bundle.verificationMaterial;
    const holder = material.certificate ?? material.x509CertificateChain.certificates[0];
    const [certificate] = parseDer(Buffer.from(holder.rawBytes, "base64"));
    const extensions = certificate.children[0].children.find((node) => node.tag === 0xa3).children[0].children;
    const matching = (oid) => extensions.filter((node) => node.children[0].content.equals(oidBytes(oid)));
    const extension = (oid, value) => ({ tag: 0x30, children: [{ tag: 0x06, content: oidBytes(oid) }, { tag: 0x04, content: value }] });
    edit({
      get: (oid) => matching(oid)[0]?.children.at(-1).content,
      add: (oid, value) => void extensions.push(extension(oid, value)),
      remove: (oid) => {
        for (const node of matching(oid)) extensions.splice(extensions.indexOf(node), 1);
      },
      set: (oid, value) => {
        const [existing] = matching(oid);
        if (existing) existing.children.at(-1).content = value;
        else extensions.push(extension(oid, value));
      },
    });
    holder.rawBytes = encodeDer(certificate).toString("base64");
  });
}

// ---------------------------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------------------------

export const REAL_RELEASE = { version: REAL_VERSION, integrity: REAL_PACKUMENT.dist.integrity, packument: REAL_PACKUMENT, attestations: REAL_ATTESTATIONS };

/**
 * A release of `version` shaped exactly like the real one: the certificate and the statement are rewritten for the version.
 * `signer` overrides who signed it (an attacker's repository, other numeric ids, another issuer ...); the packument keeps
 * claiming this repository, as an attacker who controls the package would.
 */
export function forgeRelease(version, signer = {}) {
  const identity = { ...REAL_IDENTITY, ...signer };
  const integrity = signer.integrity ?? integrityFor(version);
  const uri = workflowUri(version, identity);
  const ref = `refs/tags/${identity.tagPrefix}${version}`;
  const repositoryUrl = `https://github.com/${identity.owner}/${identity.repository}`;
  let attestations = editCertificate(REAL_ATTESTATIONS, (certificate) => {
    certificate.set(OID.san, sanValue(der.uri(uri)));
    certificate.set(OID.legacyIssuer, Buffer.from(identity.issuer));
    certificate.set(OID.legacyRepository, Buffer.from(`${identity.owner}/${identity.repository}`));
    certificate.set(OID.legacyRef, Buffer.from(ref));
    certificate.set(OID.issuer, utf8Value(identity.issuer));
    certificate.set(OID.buildSigner, utf8Value(uri));
    certificate.set(OID.buildConfig, utf8Value(uri));
    certificate.set(OID.sourceRepository, utf8Value(repositoryUrl));
    certificate.set(OID.sourceRef, utf8Value(ref));
    certificate.set(OID.repositoryId, utf8Value(identity.repositoryId));
    certificate.set(OID.ownerId, utf8Value(identity.ownerId));
  });
  attestations = editStatement(attestations, (statement) => {
    statement.subject = [{ name: `pkg:npm/narrarium-server@${version}`, digest: { sha512: hexOfIntegrity(integrity) } }];
    const build = statement.predicate.buildDefinition;
    build.externalParameters.workflow = { ref, repository: repositoryUrl, path: `.github/workflows/${identity.workflowFile}` };
    build.internalParameters.github.repository_id = identity.repositoryId;
    build.internalParameters.github.repository_owner_id = identity.ownerId;
    build.resolvedDependencies[0].uri = `git+${repositoryUrl}@${ref}`;
  });
  const packument = structuredClone(REAL_PACKUMENT);
  packument.version = version;
  packument.dist.integrity = integrity;
  packument.dist.tarball = `https://registry.npmjs.org/narrarium-server/-/narrarium-server-${version}.tgz`;
  packument.dist.attestations.url = `https://registry.npmjs.org/-/npm/v1/attestations/narrarium-server@${version}`;
  return { version, integrity, packument, attestations };
}

/** The hand-published first release: a registry signature and no provenance. */
export function bootstrapRelease(version = "0.1.0") {
  const release = forgeRelease(version);
  delete release.packument.dist.attestations;
  return { ...release, attestations: undefined };
}

// ---------------------------------------------------------------------------------------------
// A fake registry (for fetch) and a fake npm (for the installer)
// ---------------------------------------------------------------------------------------------

const REGISTRY = "https://registry.npmjs.org";
const jsonResponse = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

/**
 * What the registry answers: the manifest of `latest` and the attestations of every release. `routes` replaces the answer
 * for one URL: `(nth request of that URL, init) => Response`. Every request is recorded; anything else is a 404.
 */
export function fakeRegistry({ latest, releases = [], routes = {} } = {}) {
  const table = new Map(releases.map((release) => [release.version, release]));
  const requests = [];
  const fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const nth = requests.filter((request) => request.url === url).length;
    if (routes[url]) return routes[url](nth, init);
    if (url === `${REGISTRY}/narrarium-server/latest`) {
      const release = table.get(latest);
      return release ? jsonResponse(release.packument) : jsonResponse({}, 404);
    }
    const attestations = /^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\/narrarium-server@(.+)$/.exec(url);
    if (attestations) {
      const release = table.get(attestations[1]);
      return release?.attestations ? jsonResponse(release.attestations) : jsonResponse({}, 404);
    }
    return jsonResponse({}, 404);
  };
  return { fetch, requests, urls: () => requests.map((request) => request.url) };
}

/** A registry that has a valid release of every version asked for: for the tests that are about something else than the identity. */
export function forgingRegistry() {
  const releases = new Map();
  const requests = [];
  const fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    const match = /\/attestations\/narrarium-server@(.+)$/.exec(url);
    if (!match) return jsonResponse({}, 404);
    if (!releases.has(match[1])) releases.set(match[1], forgeRelease(match[1]));
    return jsonResponse(releases.get(match[1]).attestations);
  };
  return { fetch, requests };
}

/** An answer that never comes: it ends only when the request is aborted, as a real fetch does. */
export const silence = (_nth, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));

export const attestationUrl = (version) => `${REGISTRY}/-/npm/v1/attestations/narrarium-server@${version}`;
export const latestUrl = `${REGISTRY}/narrarium-server/latest`;

/** The package-lock.json npm writes in the staging folder after `npm install narrarium-server@version`. */
export const lockfile = (version, integrity) => JSON.stringify({
  name: "staging",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { dependencies: { "narrarium-server": version } },
    "node_modules/narrarium-server": { version, resolved: `${REGISTRY}/narrarium-server/-/narrarium-server-${version}.tgz`, integrity },
  },
}, null, 2);

/**
 * npm as the installer sees it. `lock` decides what lands in the staging folder's package-lock.json: "normal" (the integrity of
 * the release), "missing", "no-integrity", or a function (version, release) => text. `lockIntegrity` maps a version to another integrity.
 */
export function fakeNpm({ releases = [], latest } = {}) {
  const table = new Map(releases.map((release) => [release.version, release]));
  const calls = [];
  const state = { latest, lock: "normal", lockIntegrity: new Map(), failAudit: new Set(), failInstall: new Set(), content: (version) => `// narrarium-server ${version}\n` };
  const stagedVersion = async (prefix) => JSON.parse(await readFile(path.join(prefix, "node_modules", "narrarium-server", "package.json"), "utf8")).version;
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const spec = args.find((arg) => arg.startsWith("narrarium-server@"));
    const version = spec?.slice("narrarium-server@".length);
    if (args[0] === "view" && args[2] === "version") return { code: 0, stdout: JSON.stringify(state.latest), stderr: "" };
    if (args[0] === "view") {
      const release = table.get(version);
      return release ? { code: 0, stdout: JSON.stringify(release.packument), stderr: "" } : { code: 1, stdout: "", stderr: "npm error 404" };
    }
    if (args[0] === "install") {
      if (state.failInstall.has(version)) return { code: 1, stdout: "", stderr: "npm error 404" };
      const prefix = args[args.indexOf("--prefix") + 1];
      const root = path.join(prefix, "node_modules", "narrarium-server");
      await mkdir(path.join(root, "dist"), { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "narrarium-server", version }));
      await writeFile(path.join(root, "dist", "cli.mjs"), "// cli\n");
      await writeFile(path.join(root, "dist", "server.mjs"), state.content(version));
      const release = table.get(version);
      const integrity = state.lockIntegrity.get(version) ?? release?.integrity ?? integrityFor(version);
      if (typeof state.lock === "function") await writeFile(path.join(prefix, "package-lock.json"), state.lock(version, release));
      else if (state.lock === "normal") await writeFile(path.join(prefix, "package-lock.json"), lockfile(version, integrity));
      else if (state.lock === "no-integrity") await writeFile(path.join(prefix, "package-lock.json"), lockfile(version, undefined));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "audit") {
      const audited = await stagedVersion(args[args.indexOf("--prefix") + 1]);
      return { code: state.failAudit.has(audited) ? 1 : 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected npm command" };
  };
  return { runner, calls, state, names: () => calls.map((call) => call.args[0]) };
}
