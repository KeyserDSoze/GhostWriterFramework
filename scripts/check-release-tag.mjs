import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseTag, publishOrder, validateReleaseTarget } from "./release-policy.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.env.GITHUB_REF_NAME || process.argv[2];

if (!tag) {
  console.log("No release tag provided; skipping tag validation.");
  process.exit(0);
}

const target = parseReleaseTag(tag);
if (!target) {
  throw new Error(`Invalid release tag ${tag}. Use v<package>@<version>, for example vnarrarium@0.1.57.`);
}

const packageRecords = publishOrder.map((name) => {
  const packageJson = JSON.parse(readFileSync(path.join(workspaceRoot, "packages", packageDirectory(name), "package.json"), "utf8"));
  return {
    name: packageJson.name,
    version: packageJson.version,
    dependencies: packageJson.dependencies,
  };
});

validateReleaseTarget(target, packageRecords);
console.log(`Release tag ${tag} matches ${target.name}@${target.version}; workspace packages use independent versions.`);

function packageDirectory(name) {
  return {
    narrarium: "core",
    "narrarium-sdk": "sdk-typescript",
    "narrarium-astro-reader": "astro-reader",
    "narrarium-mcp-server": "mcp-server",
    "create-narrarium-book": "create-narrarium-book",
  }[name];
}
