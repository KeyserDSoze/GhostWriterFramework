import { getPublishPlan, writeGithubOutputs } from "./workspace-publish.mjs";

const plan = await getPublishPlan();
const unpublished = plan.filter((pkg) => !pkg.published);

if (unpublished.length === 0) {
  console.log("No unpublished workspace versions found.");
  writeGithubOutputs({
    has_changes: "false",
    packages: "",
  });
  process.exit(0);
}

console.log("Unpublished workspace versions detected:");
for (const pkg of unpublished) {
  console.log(`- ${pkg.name}@${pkg.version}`);
}

writeGithubOutputs({
  has_changes: "true",
  packages: unpublished.map((pkg) => `${pkg.name}@${pkg.version}`).join(","),
});
