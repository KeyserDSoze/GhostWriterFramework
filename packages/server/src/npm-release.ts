import { SERVER_PACKAGE_NAME, type ServerUpdateReason } from "narrarium-engine";

export const NPM_SERVER_PACKAGE = SERVER_PACKAGE_NAME;
const NPM_LATEST = `https://registry.npmjs.org/${NPM_SERVER_PACKAGE}/latest`;
const MAX_PACKUMENT_BYTES = 256 * 1024;
const REPOSITORY_URLS = new Set([
  "git+https://github.com/KeyserDSoze/GhostWriterFramework.git",
  "https://github.com/KeyserDSoze/GhostWriterFramework.git",
  "git+https://github.com/KeyserDSoze/GhostWriterFramework",
  "https://github.com/KeyserDSoze/GhostWriterFramework",
]);
const REPOSITORY_DIRECTORY = "packages/server";
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

/**
 * Registry metadata is untrusted input. A release is usable only when it comes from this
 * repository's server package and carries npm registry signatures AND a provenance attestation
 * (the Trusted Publishing workflow). The hand-published bootstrap version needs only signatures.
 */
export function trustedNpmReleaseMetadata(value: unknown, expectedVersion?: string, allowRegistryBootstrap = false): { version: string } {
  // npm 12 returns a one-element array for some `npm view --json` calls; only exactly one entry is accepted.
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const manifest = candidate as {
    name?: unknown;
    version?: unknown;
    repository?: { url?: unknown; directory?: unknown };
    dist?: { integrity?: unknown; signatures?: unknown; attestations?: { url?: unknown; provenance?: { predicateType?: unknown } } };
  } | null;
  if (!manifest || typeof manifest !== "object" || manifest.name !== NPM_SERVER_PACKAGE || !isExactSemver(manifest.version)
    || !manifest.repository || !REPOSITORY_URLS.has(String(manifest.repository.url)) || manifest.repository.directory !== REPOSITORY_DIRECTORY
    || !manifest.dist || typeof manifest.dist.integrity !== "string" || manifest.dist.integrity.length < 20 || manifest.dist.integrity.length > 500) {
    throw new Error("The npm metadata is not valid or does not come from the Narrarium repository.");
  }
  const version = manifest.version;
  if (expectedVersion && version !== expectedVersion) throw new Error("The npm version differs from the requested one.");
  const signatures = Array.isArray(manifest.dist.signatures) ? manifest.dist.signatures : [];
  const signed = signatures.length > 0 && signatures.every((entry) => entry && typeof entry === "object" && typeof (entry as { keyid?: unknown }).keyid === "string" && typeof (entry as { sig?: unknown }).sig === "string" && String((entry as { sig: string }).sig).length >= 20);
  const predicateType = manifest.dist.attestations?.provenance?.predicateType;
  const attested = signed
    && (predicateType === "https://slsa.dev/provenance/v1" || predicateType === "https://slsa.dev/provenance/v0.2")
    && manifest.dist.attestations?.url === `https://registry.npmjs.org/-/npm/v1/attestations/${NPM_SERVER_PACKAGE}@${version}`;
  if (!attested && !(allowRegistryBootstrap && signed && BOOTSTRAP_VERSIONS.has(version) && version === expectedVersion)) {
    throw new Error("The npm release lacks the registry signature and the provenance attestation that are required.");
  }
  return { version };
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

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_PACKUMENT_BYTES)) throw new Error("npm metadata over the limit.");
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PACKUMENT_BYTES) throw new Error("npm metadata over the limit.");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Ask npm for the latest release and say whether it is newer, signed and attested. Never throws. */
export async function checkNpmServerRelease(installedVersion: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<NpmReleaseCheck> {
  if (!isExactSemver(installedVersion)) throw new Error("The server version is not valid.");
  const base: NpmReleaseCheck = { packageName: NPM_SERVER_PACKAGE, installedVersion, available: false, signed: false, reason: "unavailable", message: "npm could not be checked: no update is offered." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(NPM_LATEST, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal, headers: { accept: "application/json" }, referrerPolicy: "no-referrer" });
    if (response.status === 404) return { ...base, reason: "not_published", message: "The server package is not published on npm yet." };
    if (!response.ok) return base;
    // An oversized or unreadable answer means npm could not be checked (the outer catch).
    const metadata = await boundedJson(response);
    // Not newer than what runs: nothing to install, so nothing to trust (e.g. the bootstrap release).
    const announced = ((Array.isArray(metadata) && metadata.length === 1 ? metadata[0] : metadata) as { version?: unknown } | null)?.version;
    if (isExactSemver(announced) && compareSemver(announced, installedVersion) <= 0) {
      return { ...base, reason: "up_to_date", message: "The server already runs the latest version." };
    }
    let latest: string;
    try {
      latest = trustedNpmReleaseMetadata(metadata).version;
    } catch {
      return { ...base, reason: "no_trusted_release", message: "The latest npm release is not signed and attested by the Narrarium publishing workflow: no update is offered." };
    }
    const newer = compareSemver(latest, installedVersion) > 0;
    return {
      packageName: NPM_SERVER_PACKAGE,
      installedVersion,
      latestVersion: latest,
      available: newer,
      signed: true,
      ...(newer ? {} : { reason: "up_to_date" as const }),
      message: newer ? `Version ${latest} is available, signed by npm and attested by the publishing workflow.` : "The server already runs the latest verified version.",
    };
  } catch {
    return base;
  } finally {
    clearTimeout(timer);
  }
}
