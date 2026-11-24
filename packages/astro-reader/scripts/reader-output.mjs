import { readdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a protected build may publish: the reader's shell, its code and styles, `version.json` and the encrypted artifacts. Everything else
 * Astro wrote (the canon pages, rendered empty for a protected book; `downloads/book.epub`; any file of `public/`) is removed before the
 * Pages artifact is uploaded, and the result is checked: an artifact in clear, or a page other than the shell, stops the build.
 * A public build is left as it is.
 */

const ALLOWED_FILES = new Set(["index.html", "version.json", "CNAME", ".nojekyll", "robots.txt", "favicon.ico", "favicon.svg"]);
const ALLOWED_DIRECTORIES = ["_astro/", "content/"];

export function isAllowedProtectedFile(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (ALLOWED_FILES.has(normalized)) return true;
  if (normalized.startsWith("_astro/")) return /\.(js|css|woff2?|ttf|otf)$/.test(normalized);
  if (normalized.startsWith("content/")) return /^content\/[a-z]+-[0-9a-f]{16}\.bin$/.test(normalized);
  return false;
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

async function removeEmptyDirectories(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    await removeEmptyDirectories(root, relative);
    await rmdir(path.join(root, relative)).catch(() => undefined);
  }
}

/** Prunes and checks `distDir` when its `version.json` says the book is protected; returns what it removed. */
export async function enforceReaderOutput(distDir) {
  const versionText = await readFile(path.join(distDir, "version.json"), "utf8").catch(() => null);
  if (versionText === null) throw new Error("[narrarium-reader] The build wrote no version.json: the reader cannot open this site.");
  const version = JSON.parse(versionText);
  if (version.protected !== true) return { protected: false, removed: [] };
  if (!Array.isArray(version.protection?.slots) || version.protection.slots.length === 0) {
    throw new Error("[narrarium-reader] version.json says the book is protected but has no key slot.");
  }

  const removed = [];
  for (const file of await listFiles(distDir)) {
    if (isAllowedProtectedFile(file)) continue;
    await rm(path.join(distDir, file), { force: true });
    removed.push(file);
  }
  await removeEmptyDirectories(distDir);

  const left = await listFiles(distDir);
  const artifacts = [version.bundle?.path, version.epub?.path].filter(Boolean);
  for (const artifact of artifacts) {
    if (!left.includes(artifact)) throw new Error(`[narrarium-reader] The encrypted artifact ${artifact} named by version.json is missing.`);
  }
  if (version.bundle?.encoding !== "gzip+aes-256-gcm") throw new Error("[narrarium-reader] The bundle of a protected book is not encrypted.");
  if (version.epub && version.epub.encoding !== "aes-256-gcm") throw new Error("[narrarium-reader] The EPUB of a protected book is not encrypted.");
  for (const file of left.filter((entry) => entry.endsWith(".html"))) {
    if (file !== "index.html") throw new Error(`[narrarium-reader] A protected build would publish the page ${file}.`);
  }
  return { protected: true, removed };
}

/** The Astro integration: after `astro build`, a protected book keeps only the reader. */
export function narrariumReaderOutput() {
  return {
    name: "narrarium-reader-output",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const result = await enforceReaderOutput(fileURLToPath(dir));
        if (result.protected) {
          logger.info(`Protected book: only the reader and its encrypted files are published (${result.removed.length} other files left out).`);
        }
      },
    },
  };
}
