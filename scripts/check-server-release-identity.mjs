// Run by the "Publish narrarium-server" workflow BEFORE `npm publish`: the release must be signed by the identity that
// installed servers accept (the owner, repository, workflow file and tag in `NPM_RELEASE_IDENTITY`). A release published
// from anywhere else would carry valid provenance and still be refused by every server, so it is stopped here.
import { NPM_RELEASE_IDENTITY as identity, releaseWorkflowUri } from "../packages/server/dist/testing.mjs";

const tag = process.env.RELEASE_TAG ?? "";
if (!tag.startsWith(identity.tagPrefix)) throw new Error(`The tag ${tag || "(none)"} does not start with ${identity.tagPrefix}.`);
const version = tag.slice(identity.tagPrefix.length);
const expected = releaseWorkflowUri(version);
const actual = `https://github.com/${process.env.GITHUB_WORKFLOW_REF ?? ""}`;
const problems = [];
if (actual !== expected) problems.push(`This run is ${actual}, but servers accept only ${expected}.`);
if (process.env.GITHUB_REPOSITORY !== `${identity.owner}/${identity.repository}`) problems.push(`The repository is ${process.env.GITHUB_REPOSITORY}, not ${identity.owner}/${identity.repository}.`);
if (process.env.GITHUB_REPOSITORY_ID !== identity.repositoryId) problems.push(`The repository id is ${process.env.GITHUB_REPOSITORY_ID}, not ${identity.repositoryId}.`);
if (process.env.GITHUB_REPOSITORY_OWNER_ID !== identity.ownerId) problems.push(`The owner id is ${process.env.GITHUB_REPOSITORY_OWNER_ID}, not ${identity.ownerId}.`);
if (problems.length) {
  console.error(`${problems.join("\n")}\nA release published like this would be refused by every installed server (see packages/server/README.md, "Protect the release path").`);
  process.exit(1);
}
console.log(`The signing identity of this run is the one installed servers accept: ${expected}`);
