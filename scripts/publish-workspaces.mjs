import { getPublishPlan, runNpm, workspaceRoot } from "./workspace-publish.mjs";

const plan = await getPublishPlan();
const unpublished = plan.filter((pkg) => !pkg.published);

if (unpublished.length === 0) {
  console.log("No unpublished workspace versions found.");
  process.exit(0);
}

for (const pkg of unpublished) {
  console.log(`Publishing ${pkg.name}@${pkg.version}...`);
  try {
    runNpm(["publish", "-w", pkg.name, "--access", "public", "--provenance"], workspaceRoot);
  } catch (error) {
    console.error(`Failed while publishing ${pkg.name}@${pkg.version}.`);
    console.error("If npm reports EOTP, the GitHub secret NPM_TOKEN must be an npm Automation token, or this repository must use npm Trusted Publishing.");
    console.error("If npm reports E404 on an unscoped package like narrarium, double-check the package name, registry, and authenticated npm account.");
    console.error("If npm reports E422 while publishing with --provenance, make sure the package.json repository.url matches the current GitHub repository URL used by GitHub Actions.");
    throw error;
  }
}
