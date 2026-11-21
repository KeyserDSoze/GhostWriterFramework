import { firstPublishWarning, getPublishPlan, runNpm, splitPublishPlan, workspaceRoot } from "./workspace-publish.mjs";

const plan = await getPublishPlan();
const { publish: unpublished, firstPublish } = splitPublishPlan(plan);
for (const pkg of firstPublish) console.log(firstPublishWarning(pkg));

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
    console.error("If npm reports EOTP or E401/E403, register this workflow as the package's npm Trusted Publisher (repository KeyserDSoze/GhostWriterFramework, workflow publish-npm.yml, environment production).");
    console.error("If npm reports E404 on an unscoped package like narrarium, double-check the package name, registry, and authenticated npm account.");
    console.error("If npm reports E422 while publishing with --provenance, make sure the package.json repository.url matches the current GitHub repository URL used by GitHub Actions.");
    throw error;
  }
}
