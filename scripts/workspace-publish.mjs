import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const packages = [
  { name: "narrarium", dir: path.join(workspaceRoot, "packages", "core") },
  { name: "narrarium-engine", dir: path.join(workspaceRoot, "packages", "engine") },
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
    const exists = packageExists(pkg.name);
    const published = exists && await isPublished(pkg.name, version);
    plan.push({ ...pkg, version, exists, published });
  }

  return plan;
}

/**
 * npm Trusted Publishing can publish new versions but cannot create a package: a package that was
 * never published needs one first publish by hand, then its trusted publisher on npmjs.com.
 */
export function splitPublishPlan(plan) {
  return {
    publish: plan.filter((pkg) => pkg.exists && !pkg.published),
    firstPublish: plan.filter((pkg) => !pkg.exists),
  };
}

export function firstPublishWarning(pkg) {
  return `::warning title=${pkg.name} is not on npm yet::Publish ${pkg.name}@${pkg.version} once by hand (see docs/publishing.md), then register this workflow as its npm Trusted Publisher. Until then this workflow skips it.`;
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

export function parsePublishedVersion(output) {
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function packageExists(name) {
  try {
    runNpm(["view", name, "name", "--json"], workspaceRoot, true);
    return true;
  } catch (error) {
    // Only a 404 means "never published"; other failures count as existing so that publishing reports them.
    return !/\bE404\b|404 Not Found/.test(`${error?.stderr ?? ""}${error?.message ?? ""}`);
  }
}

async function isPublished(name, version) {
  try {
    const output = runNpm(["view", `${name}@${version}`, "version", "--json"], workspaceRoot, true);
    return parsePublishedVersion(output) === version;
  } catch {
    return false;
  }
}
