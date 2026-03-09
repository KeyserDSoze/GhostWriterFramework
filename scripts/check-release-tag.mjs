import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
const expectedVersion = rootPackage.version;
const tag = process.env.GITHUB_REF_NAME || process.argv[2];

if (!tag) {
  console.log("No release tag provided; skipping tag validation.");
  process.exit(0);
}

const expectedTag = `v${expectedVersion}`;

if (tag !== expectedTag) {
  throw new Error(`Release tag mismatch. Expected ${expectedTag} but received ${tag}.`);
}

const packageDirs = ["core", "astro-reader", "mcp-server", "create-narrarium-book"];

for (const dir of packageDirs) {
  const packageJson = JSON.parse(
    readFileSync(path.join(workspaceRoot, "packages", dir, "package.json"), "utf8"),
  );

  if (packageJson.version !== expectedVersion) {
    throw new Error(`Version mismatch in ${packageJson.name}. Expected ${expectedVersion} but found ${packageJson.version}.`);
  }
}

console.log(`Release tag ${tag} matches workspace version ${expectedVersion}.`);
