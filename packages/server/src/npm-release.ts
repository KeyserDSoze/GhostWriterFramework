import { X509Certificate } from "node:crypto";
import { SERVER_PACKAGE_NAME, type ServerUpdateReason } from "narrarium-engine";
import { certificateExtensions, derGeneralNames, derUtf8String, plainText, type CertificateExtension } from "./der.js";

export const NPM_SERVER_PACKAGE = SERVER_PACKAGE_NAME;
const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_LATEST = `${NPM_REGISTRY}/${NPM_SERVER_PACKAGE}/latest`;
const MAX_REGISTRY_ANSWER_BYTES = 256 * 1024;
const REGISTRY_TIMEOUT_MS = 12_000;
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

/**
 * Who may publish the server, written once. Releases are made by one GitHub Actions workflow (npm Trusted Publishing); an
 * update is trusted only when its provenance names exactly this workflow, at the tag of that release, in this repository.
 * `ownerId` and `repositoryId` are GitHub's own numeric ids: somebody who later takes over the names has other ones.
 */
export const NPM_RELEASE_IDENTITY = Object.freeze({
  owner: "KeyserDSoze",
  repository: "GhostWriterFramework",
  /** Where the package lives in the repository (npm's `repository.directory`). */
  directory: "packages/server",
  workflowFile: "publish-server-npm.yml",
  tagPrefix: "narrarium-server-v",
  /** The OIDC issuer of GitHub Actions, as Fulcio records it in the signing certificate. */
  issuer: "https://token.actions.githubusercontent.com",
  ownerId: "40713438",
  repositoryId: "1176286350",
} as const);

const REPOSITORY_URL = `https://github.com/${NPM_RELEASE_IDENTITY.owner}/${NPM_RELEASE_IDENTITY.repository}`;
const WORKFLOW_PATH = `.github/workflows/${NPM_RELEASE_IDENTITY.workflowFile}`;
const REPOSITORY_URLS = new Set([`git+${REPOSITORY_URL}.git`, `${REPOSITORY_URL}.git`, `git+${REPOSITORY_URL}`, REPOSITORY_URL]);
const releaseRef = (version: string): string => `refs/tags/${NPM_RELEASE_IDENTITY.tagPrefix}${version}`;
/** The name Fulcio writes in the signing certificate of a run of the workflow on the tag of `version`. */
export const releaseWorkflowUri = (version: string): string => `${REPOSITORY_URL}/${WORKFLOW_PATH}@${releaseRef(version)}`;
export const npmAttestationsUrl = (version: string): string => `${NPM_REGISTRY}/-/npm/v1/attestations/${NPM_SERVER_PACKAGE}@${version}`;

/** The first version is published by hand before npm Trusted Publishing exists: registry signature only. */
export const BOOTSTRAP_VERSIONS: ReadonlySet<string> = new Set(["0.1.0"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isExactSemver(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  const match = SEMVER.exec(value);
  if (!match) return false;
  return !match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"));
}

/** SemVer precedence (build metadata ignored); prerelease identifiers compare numerically or in ASCII order. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const core = value.split("+", 1)[0];
    const dash = core.indexOf("-");
    return { numbers: (dash < 0 ? core : core.slice(0, dash)).split("."), prerelease: dash < 0 ? "" : core.slice(dash + 1) };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const l = left.numbers[index];
    const r = right.numbers[index];
    if (l !== r) return l.length !== r.length ? l.length - r.length : l < r ? -1 : 1;
  }
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && !right.prerelease) return 0;
  const l = left.prerelease.split(".");
  const r = right.prerelease.split(".");
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    if (l[index] === undefined) return -1;
    if (r[index] === undefined) return 1;
    if (l[index] === r[index]) continue;
    const ln = /^\d+$/.test(l[index]);
    const rn = /^\d+$/.test(r[index]);
    if (ln && rn) {
      const lv = l[index].replace(/^0+/, "") || "0";
      const rv = r[index].replace(/^0+/, "") || "0";
      return lv.length !== rv.length ? lv.length - rv.length : lv === rv ? 0 : lv < rv ? -1 : 1;
    }
    if (ln !== rn) return ln ? -1 : 1;
    return l[index] < r[index] ? -1 : 1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Untrusted text on its way into a message: printable ASCII only, and short. */
function printable(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : `(${Array.isArray(value) ? "list" : typeof value})`;
  const clean = text.replace(/[^\x20-\x7e]/g, "?");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** The hex digest of an npm `sha512-<base64>` integrity, or `undefined` when it is not exactly one sha512 value. */
export function integrityHex(integrity: unknown): string | undefined {
  if (typeof integrity !== "string") return undefined;
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity);
  if (!match) return undefined;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.length === 64 && bytes.toString("base64") === match[1] ? bytes.toString("hex") : undefined;
}

export interface NpmReleaseMetadata {
  version: string;
  /** The `sha512-…` integrity of the tarball, as the registry announces it. */
  integrity: string;
  /** False only for the hand-published bootstrap release, accepted on its registry signature alone. */
  attested: boolean;
}

/**
 * Registry metadata is untrusted input. A release is usable only when it comes from this repository's server package and
 * carries npm registry signatures AND the pointer to a provenance attestation (the Trusted Publishing workflow). The
 * metadata says who published it, but nobody can be believed on that: whose provenance it is, is checked by
 * `verifyNpmProvenance` on the attestation itself. The hand-published bootstrap version needs only signatures.
 */
export function inspectNpmRelease(value: unknown, expectedVersion?: string, allowRegistryBootstrap = false): NpmReleaseMetadata {
  // npm 12 returns a one-element array for some `npm view --json` calls; only exactly one entry is accepted.
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const manifest = candidate as {
    name?: unknown;
    version?: unknown;
    repository?: { url?: unknown; directory?: unknown };
    dist?: { integrity?: unknown; signatures?: unknown; attestations?: { url?: unknown; provenance?: { predicateType?: unknown } } };
  } | null;
  if (!manifest || typeof manifest !== "object" || manifest.name !== NPM_SERVER_PACKAGE || !isExactSemver(manifest.version)
    || !manifest.repository || !REPOSITORY_URLS.has(String(manifest.repository.url)) || manifest.repository.directory !== NPM_RELEASE_IDENTITY.directory
    || !manifest.dist || integrityHex(manifest.dist.integrity) === undefined) {
    throw new Error("The npm metadata is not valid or does not come from the Narrarium repository.");
  }
  const version = manifest.version;
  if (expectedVersion && version !== expectedVersion) throw new Error("The npm version differs from the requested one.");
  const signatures = Array.isArray(manifest.dist.signatures) ? manifest.dist.signatures : [];
  const signed = signatures.length > 0 && signatures.every((entry) => entry && typeof entry === "object" && typeof (entry as { keyid?: unknown }).keyid === "string" && typeof (entry as { sig?: unknown }).sig === "string" && String((entry as { sig: string }).sig).length >= 20);
  const attested = signed
    && manifest.dist.attestations?.provenance?.predicateType === PROVENANCE_PREDICATE
    && manifest.dist.attestations?.url === npmAttestationsUrl(version);
  if (!attested && !(allowRegistryBootstrap && signed && BOOTSTRAP_VERSIONS.has(version) && version === expectedVersion)) {
    throw new Error("The npm release lacks the registry signature and the provenance attestation that are required.");
  }
  return { version, integrity: manifest.dist.integrity as string, attested };
}

export function trustedNpmReleaseMetadata(value: unknown, expectedVersion?: string, allowRegistryBootstrap = false): { version: string } {
  return { version: inspectNpmRelease(value, expectedVersion, allowRegistryBootstrap).version };
}

/** The attestation was read, and it is not what the publishing workflow produces for this package and version. */
export class ReleaseVerificationError extends Error {
  constructor(readonly version: string, readonly reason: string) {
    super(`The provenance of ${NPM_SERVER_PACKAGE}@${version} was rejected: ${reason}.`);
    this.name = "ReleaseVerificationError";
  }
}

/** The attestation could not be read at all (the registry did not answer, or not with an attestation document). */
export class ReleaseUnreadableError extends Error {
  constructor(readonly version: string, detail: string) {
    super(`The provenance of ${NPM_SERVER_PACKAGE}@${version} could not be read from npm (${detail}).`);
    this.name = "ReleaseUnreadableError";
  }
}

const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_ISSUER_LEGACY = "1.3.6.1.4.1.57264.1.1";
const OID_ISSUER = "1.3.6.1.4.1.57264.1.8";
const OID_REPOSITORY_ID = "1.3.6.1.4.1.57264.1.15";
const OID_OWNER_ID = "1.3.6.1.4.1.57264.1.17";
const MAX_CERTIFICATE_CHARACTERS = 24 * 1024;
const MAX_STATEMENT_CHARACTERS = 96 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The leaf of the certificate the bundle carries: a single `certificate` (bundle v0.3) or the first of a chain (v0.1, v0.2). */
function signingCertificate(material: Record<string, unknown>, reject: (reason: string) => never): Buffer {
  const { certificate, x509CertificateChain: chain } = material;
  if (certificate !== undefined && chain !== undefined) return reject("it carries two kinds of certificate");
  let holder: unknown;
  if (certificate !== undefined) {
    holder = certificate;
  } else {
    const list = isRecord(chain) ? chain.certificates : undefined;
    if (!Array.isArray(list) || list.length === 0) return reject("it has no signing certificate");
    holder = list[0];
  }
  const rawBytes = isRecord(holder) ? holder.rawBytes : undefined;
  if (typeof rawBytes !== "string" || rawBytes.length > MAX_CERTIFICATE_CHARACTERS || !BASE64.test(rawBytes)) return reject("its signing certificate cannot be read");
  return Buffer.from(rawBytes, "base64");
}

/** The OIDC issuer Fulcio recorded: the v2 extension (a DER string) and/or the legacy one (plain text); both, when present, agree. */
function certificateIssuer(extensions: Map<string, CertificateExtension>): string | undefined {
  try {
    const current = extensions.get(OID_ISSUER);
    const legacy = extensions.get(OID_ISSUER_LEGACY);
    const issuer = current ? derUtf8String(current.value) : undefined;
    const old = legacy ? plainText(legacy.value) : undefined;
    if (issuer !== undefined && old !== undefined && issuer !== old) return undefined;
    return issuer ?? old;
  } catch {
    return undefined;
  }
}

function certificateId(extensions: Map<string, CertificateExtension>, oid: string): string | undefined {
  try {
    const extension = extensions.get(oid);
    return extension ? derUtf8String(extension.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The identity check of C8. `document` is what the registry serves at `dist.attestations.url`; `expected` is the version
 * and the tarball integrity (`sha512-…`) that are about to be trusted. The release is accepted only when its SLSA
 * provenance (exactly one) says that
 *  - it was signed with a certificate whose name is exactly this repository's publishing workflow at the tag of this version,
 *    issued to GitHub Actions, for this repository and this account (their numeric ids);
 *  - the signed statement is about this package, this version and this tarball (its sha512), and names the same workflow.
 *
 * What this does NOT do: verify any signature, the certificate chain or the transparency log. `npm audit signatures` does
 * that (it proves that the bundle is validly signed and about the installed tarball, not by whom), and the installer
 * reads the bundle again right after it. We rely on npm for the cryptography and on the registry to serve the same bundle
 * to both reads.
 */
export function verifyNpmProvenance(document: unknown, expected: { version: string; integrity: string }): void {
  const { version } = expected;
  const reject = (reason: string): never => {
    throw new ReleaseVerificationError(printable(version, 100), reason);
  };
  try {
    const digest = integrityHex(expected.integrity);
    if (!isExactSemver(version)) return reject("the version is not valid");
    if (digest === undefined) return reject("the integrity of the package is not a sha512 value");

    if (!isRecord(document) || !Array.isArray(document.attestations) || !document.attestations.every(isRecord)) return reject("the attestation list is not valid");
    const provenance = document.attestations.filter((entry) => entry.predicateType === PROVENANCE_PREDICATE);
    if (provenance.length === 0) return reject("no SLSA provenance attestation is attached");
    if (provenance.length > 1) return reject("more than one SLSA provenance attestation is attached");
    const bundle = isRecord(provenance[0].bundle) ? provenance[0].bundle : {};

    // Who signed.
    const der = signingCertificate(isRecord(bundle.verificationMaterial) ? bundle.verificationMaterial : {}, reject);
    let certificate: X509Certificate;
    let extensions: Map<string, CertificateExtension>;
    try {
      certificate = new X509Certificate(der);
      if (!certificate.raw.equals(der)) return reject("its signing certificate cannot be read");
      extensions = certificateExtensions(der);
    } catch {
      return reject("its signing certificate cannot be read");
    }
    const expectedName = releaseWorkflowUri(version);
    let names: Array<{ tag: number; content: Uint8Array }> | undefined;
    try {
      const alternative = extensions.get(OID_SUBJECT_ALT_NAME);
      names = alternative ? derGeneralNames(alternative.value) : [];
    } catch {
      names = undefined;
    }
    const named = names?.length === 1 && names[0].tag === 0x86 ? Buffer.from(names[0].content).toString("latin1") : undefined;
    // Two readings of the same name (ours, and OpenSSL's through Node) must agree with it: exactly one URI, nothing else.
    if (named !== expectedName || certificate.subjectAltName !== `URI:${expectedName}`) {
      const seen = names === undefined ? "something unreadable" : names.length === 0 ? "nothing" : names.map((name) => printable(Buffer.from(name.content).toString("latin1"))).join(" and ");
      return reject(`the signing certificate names ${seen} and not the Narrarium publishing workflow (${expectedName})`);
    }
    const issuer = certificateIssuer(extensions);
    if (issuer !== NPM_RELEASE_IDENTITY.issuer) return reject(`the signing certificate's issuer is ${issuer === undefined ? "missing or unreadable" : printable(issuer)}, not GitHub Actions (${NPM_RELEASE_IDENTITY.issuer})`);
    if (certificateId(extensions, OID_REPOSITORY_ID) !== NPM_RELEASE_IDENTITY.repositoryId || certificateId(extensions, OID_OWNER_ID) !== NPM_RELEASE_IDENTITY.ownerId) {
      return reject("the signing certificate belongs to another GitHub repository or account (the numeric ids differ)");
    }

    // What was signed.
    const envelope = isRecord(bundle.dsseEnvelope) ? bundle.dsseEnvelope : {};
    const payload = envelope.payload;
    let statement: unknown;
    try {
      if (envelope.payloadType !== "application/vnd.in-toto+json" || typeof payload !== "string" || payload.length > MAX_STATEMENT_CHARACTERS || !BASE64.test(payload)) throw new Error("not a statement");
      statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      return reject("the signed statement cannot be read");
    }
    if (!isRecord(statement)) return reject("the signed statement cannot be read");
    if (statement.predicateType !== PROVENANCE_PREDICATE) return reject("the statement is not an SLSA provenance v1");
    const subjects = statement.subject;
    if (!Array.isArray(subjects) || subjects.length !== 1 || !isRecord(subjects[0])) return reject("the statement must name exactly one subject (the package)");
    const subject = subjects[0];
    const expectedSubject = `pkg:npm/${NPM_SERVER_PACKAGE}@${version}`;
    if (subject.name !== expectedSubject) return reject(`the statement's subject is ${printable(subject.name)}, not ${expectedSubject}`);
    if (!isRecord(subject.digest) || subject.digest.sha512 !== digest) return reject("the digest of the statement's subject is not the one of the package that is installed");
    const predicate = isRecord(statement.predicate) ? statement.predicate : {};
    const definition = isRecord(predicate.buildDefinition) ? predicate.buildDefinition : {};
    const parameters = isRecord(definition.externalParameters) ? definition.externalParameters : {};
    const workflow = isRecord(parameters.workflow) ? parameters.workflow : {};
    if (workflow.repository !== REPOSITORY_URL || workflow.ref !== releaseRef(version) || workflow.path !== WORKFLOW_PATH) {
      return reject(`the statement names another workflow than ${WORKFLOW_PATH} of ${REPOSITORY_URL} at ${releaseRef(version)}`);
    }
  } catch (error) {
    if (error instanceof ReleaseVerificationError) throw error;
    return reject("the attestation could not be examined");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REGISTRY_ANSWER_BYTES)) throw new Error("npm metadata over the limit.");
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REGISTRY_ANSWER_BYTES) throw new Error("npm metadata over the limit.");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** One bounded GET of the public registry: no credentials, no redirect, no cache. A body is read only from a 2xx answer. */
async function readRegistry(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ status: number; body?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal, headers: { accept: "application/json" }, referrerPolicy: "no-referrer" });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { status: response.status };
    }
    return { status: response.status, body: await boundedJson(response) };
  } finally {
    clearTimeout(timer);
  }
}

export interface NpmReadOptions {
  /** Longest wait for each answer of the registry (default 12 seconds). */
  timeoutMs?: number;
}

/** The attestations npm serves for one version of the server package (the document `dist.attestations.url` points at). */
export async function fetchNpmAttestations(version: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init), options: NpmReadOptions = {}): Promise<unknown> {
  if (!isExactSemver(version)) throw new Error("The server version is not an exact semver version.");
  let answer: { status: number; body?: unknown };
  try {
    answer = await readRegistry(npmAttestationsUrl(version), fetchImpl, options.timeoutMs ?? REGISTRY_TIMEOUT_MS);
  } catch {
    throw new ReleaseUnreadableError(version, "the registry did not answer");
  }
  if (answer.status < 200 || answer.status >= 300) throw new ReleaseUnreadableError(version, `the registry answered ${answer.status}`);
  return answer.body;
}

/** Read the attestations of `version` from the registry and verify them against the tarball integrity that is about to be trusted. */
export async function verifyNpmReleaseProvenance(version: string, integrity: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init), options: NpmReadOptions = {}): Promise<void> {
  verifyNpmProvenance(await fetchNpmAttestations(version, fetchImpl, options), { version, integrity });
}

export interface NpmReleaseCheck {
  packageName: typeof NPM_SERVER_PACKAGE;
  installedVersion: string;
  latestVersion?: string;
  available: boolean;
  signed: boolean;
  reason?: ServerUpdateReason;
  message: string;
}

export interface NpmReleaseCheckOptions extends NpmReadOptions {
  /** The highest version this server's data folder ever installed: nothing below it is offered. */
  highestInstalled?: () => Promise<string | undefined>;
}

/**
 * Ask npm for the latest release and say whether it is newer, signed, attested by the publishing workflow and not below
 * the highest version ever installed here. A release whose attestation was not issued by the workflow is never offered,
 * whatever its metadata claims. Never throws (but for an invalid installed version).
 */
export async function checkNpmServerRelease(installedVersion: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init), options: NpmReleaseCheckOptions = {}): Promise<NpmReleaseCheck> {
  if (!isExactSemver(installedVersion)) throw new Error("The server version is not valid.");
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const base: NpmReleaseCheck = { packageName: NPM_SERVER_PACKAGE, installedVersion, available: false, signed: false, reason: "unavailable", message: "npm could not be checked: no update is offered." };
  try {
    // An oversized or unreadable answer means npm could not be checked (the outer catch).
    const answer = await readRegistry(NPM_LATEST, fetchImpl, timeoutMs);
    if (answer.status === 404) return { ...base, reason: "not_published", message: "The server package is not published on npm yet." };
    if (answer.status < 200 || answer.status >= 300) return base;
    const metadata = answer.body;
    // Not newer than what runs: nothing to install, so nothing to trust (e.g. the bootstrap release).
    const announced = ((Array.isArray(metadata) && metadata.length === 1 ? metadata[0] : metadata) as { version?: unknown } | null)?.version;
    if (isExactSemver(announced) && compareSemver(announced, installedVersion) <= 0) {
      return { ...base, reason: "up_to_date", message: "The server already runs the latest version." };
    }
    let release: NpmReleaseMetadata;
    try {
      release = inspectNpmRelease(metadata);
    } catch {
      return { ...base, reason: "no_trusted_release", message: "The latest npm release is not signed and attested by the Narrarium publishing workflow: no update is offered." };
    }
    if (compareSemver(release.version, installedVersion) <= 0) return { ...base, reason: "up_to_date", message: "The server already runs the latest verified version." };
    let highest: string | undefined;
    try {
      highest = await options.highestInstalled?.();
    } catch {
      return { ...base, message: "The record of the versions installed here cannot be read: no update is offered." };
    }
    if (highest !== undefined && compareSemver(release.version, highest) < 0) {
      return { ...base, reason: "no_trusted_release", message: `Version ${release.version} is not offered: it is older than ${highest}, the highest version ever installed here.` };
    }
    // The signer is named in the attestation, not in the metadata: read it before announcing anything (the tarball is not downloaded here).
    try {
      await verifyNpmReleaseProvenance(release.version, release.integrity, fetchImpl, { timeoutMs });
    } catch (error) {
      if (error instanceof ReleaseVerificationError) return { ...base, reason: "no_trusted_release", message: `Version ${release.version} is not offered: its provenance was rejected, ${error.reason}.` };
      return { ...base, message: `The provenance of version ${release.version} could not be read from npm: no update is offered.` };
    }
    return {
      packageName: NPM_SERVER_PACKAGE,
      installedVersion,
      latestVersion: release.version,
      available: true,
      signed: true,
      message: `Version ${release.version} is available, signed by npm and attested by the publishing workflow.`,
    };
  } catch {
    return base;
  }
}
