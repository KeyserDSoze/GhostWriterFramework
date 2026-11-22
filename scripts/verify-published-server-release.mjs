// Run by the "Publish narrarium-server" workflow AFTER `npm publish`: read the published release the way an installed
// server does (metadata, then the provenance attestation) and fail loudly if it would be refused. The registry may take a
// moment to serve a new version and its attestations (between one and four minutes so far), so it is tried for ten minutes.
//
// An installed server's supervisor also runs `npm audit signatures` with the npm that ships with its Node (npm 10 on Node 22),
// and that npm refuses a package whose attestations lack the registry's own publish attestation ("has attestations but no
// corresponding public key(s)"): narrarium-server@0.1.8 was published without it, and servers on npm 10 could not update to it.
// So the release must carry both attestations, and `npm audit signatures` of that older npm must accept it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NPM_RELEASE_IDENTITY as identity, inspectNpmRelease, verifyNpmReleaseProvenance } from "../packages/server/dist/testing.mjs";

const PUBLISH_PREDICATE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
/** The oldest npm an installed server may verify with: the one Node 22 ships. */
const OLDEST_NPM = process.env.VERIFY_OLDEST_NPM ?? "10";

const tag = process.env.RELEASE_TAG ?? "";
if (!tag.startsWith(identity.tagPrefix)) throw new Error(`The tag ${tag || "(none)"} does not start with ${identity.tagPrefix}.`);
const version = tag.slice(identity.tagPrefix.length);
const attempts = Number(process.env.VERIFY_ATTEMPTS ?? 40);
const pause = Number(process.env.VERIFY_PAUSE_MS ?? 15_000);

/** The registry serves both the SLSA provenance and its own publish attestation for this version. */
async function assertBothAttestations() {
  const response = await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/narrarium-server@${version}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`the attestations are not served yet (HTTP ${response.status})`);
  const document = await response.json();
  const kinds = new Set((Array.isArray(document?.attestations) ? document.attestations : []).map((entry) => entry?.predicateType));
  if (!kinds.has(PROVENANCE_PREDICATE)) throw new Error("the SLSA provenance attestation is missing");
  if (!kinds.has(PUBLISH_PREDICATE)) throw new Error("the registry's publish attestation is missing: npm 10 (Node 22) refuses such a release in `npm audit signatures`");
}

/** Install the release in an empty folder and run `npm audit signatures` with the oldest npm an installed server may use. */
function auditWithOldestNpm() {
  const folder = mkdtempSync(path.join(os.tmpdir(), "narrarium-server-audit-"));
  try {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
    execFileSync(npx, ["--yes", `npm@${OLDEST_NPM}`, "install", "--prefix", folder, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--package-lock=true", `narrarium-server@${version}`], quiet);
    execFileSync(npx, ["--yes", `npm@${OLDEST_NPM}`, "audit", "signatures", "--prefix", folder], quiet);
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).split("\n").filter((line) => /npm error|npm ERR/.test(line)).slice(0, 4).join(" ");
    throw new Error(`npm@${OLDEST_NPM} audit signatures refuses the release${detail ? `: ${detail}` : ""}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

let last;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const raw = execFileSync("npm", ["view", `narrarium-server@${version}`, "--json"], { encoding: "utf8" });
    const release = inspectNpmRelease(JSON.parse(raw), version);
    await verifyNpmReleaseProvenance(version, release.integrity);
    await assertBothAttestations();
    auditWithOldestNpm();
    console.log(`narrarium-server@${version}: the published release passes the checks of an installed server, npm@${OLDEST_NPM} audit signatures included.`);
    process.exit(0);
  } catch (error) {
    last = error;
    console.log(`Attempt ${attempt} of ${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    if (attempt < attempts) await sleep(pause);
  }
}
console.error(`narrarium-server@${version} is published but does NOT pass the checks of an installed server: ${last instanceof Error ? last.message : String(last)}`);
process.exit(1);
