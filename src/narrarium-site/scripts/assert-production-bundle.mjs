import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.NARRARIUM_E2E_BUILD === "1") process.exit(0);

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, "dist");
const forbidden = ["e2e-google-token", "e2e-google-user", "E2E builds use a deterministic local identity", "NARRARIUM_E2E_BUILD", "VITE_E2E"];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else files.push(target);
  }
  return files;
}

for (const file of await filesUnder(distRoot)) {
  const content = await readFile(file, "utf8").catch(() => "");
  const match = forbidden.find((value) => content.includes(value));
  if (match) throw new Error(`[production-bundle] Forbidden E2E marker '${match}' found in ${path.relative(distRoot, file)}.`);
}

console.log("[production-bundle] No E2E auth markers found.");
