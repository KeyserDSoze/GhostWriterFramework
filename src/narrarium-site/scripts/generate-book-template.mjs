import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The template of a complete book repository: what the real scaffolder (`create-narrarium-book`: `initializeBookRepo`, the reader scaffold and the
 * root files of its CLI) writes for a new book, as one JSON bundle (`src/narrarium/bookTemplate.generated.json`) that the site loads when it creates a
 * repository on GitHub. Nothing of the scaffolder runs in the browser and nothing is written by hand: this script runs the CLI (no install, no network)
 * into a temporary folder and keeps its files, with the three changes below that are not the CLI's choice.
 *
 *   node scripts/generate-book-template.mjs           writes the bundle
 *   node scripts/generate-book-template.mjs --check   fails when the bundle is not what the scaffolder writes now (CI)
 *
 * The three changes, each asserted (the script stops if the scaffolder no longer writes what it expects) and each repeated by name in the parity test:
 *  1. the name of the book's package and the reader's package are placeholders, filled with the title of the book when the files are built;
 *  2. the reader's `narrarium` dependency is the published range of this release, never the `file:` path of the checkout that ran the scaffolder
 *     (a path of this machine, and a package that does not exist in a repository made in a browser);
 *  3. the Pages workflow has no `cache: npm` and no `cache-dependency-path`: `reader/package-lock.json` exists only after an `npm install`, and
 *     `actions/setup-node` stops the job with «Some specified paths were not resolved, unable to cache dependencies» when the lock file is missing
 *     (source: actions/setup-node `src/cache-restore.ts`), so a repository made in a browser would fail its first deploy. Without `cache` the job
 *     only installs without a cache, a few seconds slower.
 */

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
export const BOOK_TEMPLATE_PATH = path.join(siteRoot, "src", "narrarium", "bookTemplate.generated.json");
export const BOOK_TEMPLATE_COMMAND = "npm run template:generate -w narrarium-site";
export const PACKAGE_NAME_PLACEHOLDER = "__NARRARIUM_BOOK_PACKAGE__";
export const READER_PACKAGE_NAME_PLACEHOLDER = "__NARRARIUM_READER_PACKAGE__";
/** The title the scaffolder runs with: it is in no file of the bundle (the files that carry the title are written by the site). */
const PROBE_TITLE = "Narrarium Template";
const PROBE_PACKAGE = "narrarium-template";
const CACHE_LINES = "          cache: npm\n          cache-dependency-path: reader/package-lock.json\n";

export function scaffolderPaths() {
  return {
    cli: path.join(workspaceRoot, "packages", "create-narrarium-book", "dist", "index.js"),
    reader: path.join(workspaceRoot, "packages", "astro-reader", "cli-dist", "cli.js"),
  };
}

export function scaffolderIsBuilt() {
  const paths = scaffolderPaths();
  return existsSync(paths.cli) && existsSync(paths.reader);
}

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(directory, relative));
    else files.push(relative);
  }
  return files;
}

function isText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function replaceOnce(text, from, to, what) {
  const index = text.indexOf(from);
  if (index < 0 || text.indexOf(from, index + 1) >= 0) throw new Error(`The scaffolder no longer writes ${what} exactly once; update scripts/generate-book-template.mjs.`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

function applyChanges(files, corePublishedRange) {
  const rootPackage = JSON.parse(files.get("package.json"));
  if (rootPackage.name !== PROBE_PACKAGE) throw new Error(`The scaffolder named the book package «${rootPackage.name}», not «${PROBE_PACKAGE}».`);
  rootPackage.name = PACKAGE_NAME_PLACEHOLDER;
  files.set("package.json", `${JSON.stringify(rootPackage, null, 2)}\n`);

  const readerPackage = JSON.parse(files.get("reader/package.json"));
  if (readerPackage.name !== `${PROBE_PACKAGE}-reader`) throw new Error(`The scaffolder named the reader package «${readerPackage.name}».`);
  readerPackage.name = READER_PACKAGE_NAME_PLACEHOLDER;
  const dependency = readerPackage.dependencies?.narrarium;
  if (typeof dependency !== "string") throw new Error("The reader package has no `narrarium` dependency.");
  if (dependency.startsWith("file:")) readerPackage.dependencies.narrarium = corePublishedRange;
  else if (!/^[\^~]?\d+\.\d+\.\d+/.test(dependency)) throw new Error(`The reader's narrarium dependency «${dependency}» is neither a file: path nor a version range.`);
  files.set("reader/package.json", `${JSON.stringify(readerPackage, null, 2)}\n`);

  const workflowPath = ".github/workflows/deploy-reader-pages.yml";
  files.set(workflowPath, replaceOnce(files.get(workflowPath), CACHE_LINES, "", "the npm cache of the Pages workflow"));
}

/** The files the real scaffolder writes for a new book, as `path → text` (only text: a binary file would be a second encoding the template does not need yet). */
export async function runScaffolder() {
  const paths = scaffolderPaths();
  for (const [name, file] of Object.entries(paths)) {
    if (!existsSync(file)) throw new Error(`The ${name} scaffolder is not built (${path.relative(workspaceRoot, file)}). Run: npm run build:cli -w narrarium-astro-reader && npm run build -w create-narrarium-book`);
  }
  const corePackage = JSON.parse(await readFile(path.join(workspaceRoot, "packages", "core", "package.json"), "utf8"));
  const temp = await mkdtemp(path.join(os.tmpdir(), "narrarium-book-template-"));
  try {
    execFileSync(process.execPath, [paths.cli, "book", "--title", PROBE_TITLE, "--language", "en", "--no-install"], { cwd: temp, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
    const root = path.join(temp, "book");
    const files = new Map();
    for (const relative of (await filesUnder(root)).sort()) {
      const bytes = await readFile(path.join(root, relative));
      if (!isText(bytes)) throw new Error(`The scaffolder wrote a binary file (${relative}); the template only carries text.`);
      files.set(relative, bytes.toString("utf8"));
    }
    return { files, corePublishedRange: `^${corePackage.version}` };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function assertNothingToHide(files) {
  for (const [file, text] of files) {
    if (/(^|\/)node_modules\//.test(file)) throw new Error(`The template would carry ${file}.`);
    if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file)) throw new Error(`The template would carry the lock file ${file}.`);
    if (/(\/root\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\|narrarium-book-template-|\/tmp\/)/.test(text)) throw new Error(`${file} carries a path of this machine.`);
    if (/(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(text)) throw new Error(`${file} looks like it carries a secret.`);
  }
}

/** The bundle as the text that is written: one file per line, sorted, no date, no path of the machine. */
export async function generateBookTemplate() {
  const { files, corePublishedRange } = await runScaffolder();
  applyChanges(files, corePublishedRange);
  assertNothingToHide(files);
  const lines = [...files.keys()].sort().map((file) => `${JSON.stringify(file)}:${JSON.stringify({ text: files.get(file) })}`);
  return `{"format":1,"placeholders":{"package":${JSON.stringify(PACKAGE_NAME_PLACEHOLDER)},"readerPackage":${JSON.stringify(READER_PACKAGE_NAME_PLACEHOLDER)}},"files":{\n${lines.join(",\n")}\n}}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  if (check && !scaffolderIsBuilt() && process.env.CI !== "true") {
    console.warn("[book-template] The scaffolder is not built here, so the template was not checked. Build it with: npm run build:cli -w narrarium-astro-reader && npm run build -w create-narrarium-book");
    return;
  }
  const generated = await generateBookTemplate();
  if (check) {
    const current = await readFile(BOOK_TEMPLATE_PATH, "utf8").catch(() => "");
    if (current === generated) return;
    const before = JSON.parse(current || '{"files":{}}').files;
    const after = JSON.parse(generated).files;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => JSON.stringify(before[file]) !== JSON.stringify(after[file])).sort();
    console.error(`[book-template] ${path.relative(workspaceRoot, BOOK_TEMPLATE_PATH)} is not what the scaffolder writes now (${changed.length} file${changed.length === 1 ? "" : "s"} differ: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ", …" : ""}).\nRegenerate it and commit it: ${BOOK_TEMPLATE_COMMAND}`);
    process.exitCode = 1;
    return;
  }
  await writeFile(BOOK_TEMPLATE_PATH, generated, "utf8");
  console.log(`[book-template] ${path.relative(workspaceRoot, BOOK_TEMPLATE_PATH)}: ${Object.keys(JSON.parse(generated).files).length} files, ${generated.length} bytes.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
