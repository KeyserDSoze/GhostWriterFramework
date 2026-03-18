import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const packages = [
  { name: "narrarium", dir: path.join(workspaceRoot, "packages", "core") },
  { name: "narrarium-sdk", dir: path.join(workspaceRoot, "packages", "sdk-typescript") },
  { name: "narrarium-astro-reader", dir: path.join(workspaceRoot, "packages", "astro-reader") },
  { name: "narrarium-mcp-server", dir: path.join(workspaceRoot, "packages", "mcp-server") },
  { name: "create-narrarium-book", dir: path.join(workspaceRoot, "packages", "create-narrarium-book") },
];

export async function getPublishPlan() {
  const plan = [];

  for (const pkg of packages) {
    const packageJson = JSON.parse(readFileSync(path.join(pkg.dir, "package.json"), "utf8"));
    const version = packageJson.version;
    const published = await isPublished(pkg.name, version);
    plan.push({ ...pkg, version, published });
  }

  return plan;
}

export function runNpm(args, cwd, capture = false) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(command, args, {
    cwd,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
}

export function writeGithubOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;

  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
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
