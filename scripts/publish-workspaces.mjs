import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packages = [
  { name: "@ghostwriter/core", dir: path.join(workspaceRoot, "packages", "core") },
  { name: "@ghostwriter/astro-reader", dir: path.join(workspaceRoot, "packages", "astro-reader") },
  { name: "@ghostwriter/mcp-server", dir: path.join(workspaceRoot, "packages", "mcp-server") },
  { name: "@ghostwriter/create-book", dir: path.join(workspaceRoot, "packages", "create-ghostwriter-book") },
];

for (const pkg of packages) {
  const packageJson = JSON.parse(readFileSync(path.join(pkg.dir, "package.json"), "utf8"));
  const version = packageJson.version;

  if (await isPublished(pkg.name, version)) {
    console.log(`Skipping ${pkg.name}@${version}; already published.`);
    continue;
  }

  console.log(`Publishing ${pkg.name}@${version}...`);
  runNpm(["publish", "-w", pkg.name, "--access", "public", "--provenance"], workspaceRoot);
}

async function isPublished(name, version) {
  try {
    const output = runNpm(["view", `${name}@${version}`, "version", "--json"], workspaceRoot, true);
    const normalized = output.trim().replace(/^"|"$/g, "");
    return normalized === version;
  } catch {
    return false;
  }
}

function runNpm(args, cwd, capture = false) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(command, args, {
    cwd,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
}
