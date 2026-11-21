// Run by the "Publish narrarium-server" workflow AFTER `npm publish`: read the published release the way an installed
// server does (metadata, then the provenance attestation) and fail loudly if it would be refused. The registry may take a
// moment to serve the attestation, so it is tried for a few minutes.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { NPM_RELEASE_IDENTITY as identity, inspectNpmRelease, verifyNpmReleaseProvenance } from "../packages/server/dist/testing.mjs";

const tag = process.env.RELEASE_TAG ?? "";
if (!tag.startsWith(identity.tagPrefix)) throw new Error(`The tag ${tag || "(none)"} does not start with ${identity.tagPrefix}.`);
const version = tag.slice(identity.tagPrefix.length);
const attempts = Number(process.env.VERIFY_ATTEMPTS ?? 12);
const pause = Number(process.env.VERIFY_PAUSE_MS ?? 15_000);
let last;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const raw = execFileSync("npm", ["view", `narrarium-server@${version}`, "--json"], { encoding: "utf8" });
    const release = inspectNpmRelease(JSON.parse(raw), version);
    await verifyNpmReleaseProvenance(version, release.integrity);
    console.log(`narrarium-server@${version}: the published release passes the checks of an installed server.`);
    process.exit(0);
  } catch (error) {
    last = error;
    console.log(`Attempt ${attempt} of ${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    if (attempt < attempts) await sleep(pause);
  }
}
console.error(`narrarium-server@${version} is published but does NOT pass the checks of an installed server: ${last instanceof Error ? last.message : String(last)}`);
process.exit(1);
