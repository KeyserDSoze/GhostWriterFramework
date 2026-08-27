import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { assertSiteReleaseBump } from "../../../scripts/release-policy.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const patchNotes = JSON.parse(await readFile(new URL("../src/content/patch-notes.json", import.meta.url), "utf8"));
const current = patchNotes.find((note) => note.version === packageJson.version);

if (!current) {
  console.error(`[patch-notes] Missing patch note for narrarium-site@${packageJson.version}.`);
  process.exit(1);
}

for (const language of ["en", "it"]) {
  const localized = current[language];
  if (!localized?.title || !localized?.summary || !Array.isArray(localized.changes) || localized.changes.length === 0) {
    console.error(`[patch-notes] Incomplete ${language} patch note for narrarium-site@${packageJson.version}.`);
    process.exit(1);
  }
}

console.log(`[patch-notes] Found bilingual patch note for narrarium-site@${packageJson.version}.`);

const baseRevision = resolveReleaseBaseRevision();
if (baseRevision) {
  const basePackageJson = readGitJson(baseRevision, "src/narrarium-site/package.json");
  const baseLockfile = readGitJson(baseRevision, "package-lock.json");
  const basePatchNotes = readGitJson(baseRevision, "src/narrarium-site/src/content/patch-notes.json");
  const currentLockVersion = readLockfileSiteVersion(JSON.parse(await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8")));
  const baseLockVersion = readLockfileSiteVersion(baseLockfile);
  const changedFiles = gitChangedFiles(baseRevision);

  assertSiteReleaseBump({
    changedFiles,
    currentVersion: packageJson.version,
    baseVersion: basePackageJson.version,
    currentLockVersion,
    baseLockVersion,
    basePatchNoteVersions: basePatchNotes.map((note) => note.version),
  });
  console.log(`[patch-notes] Site release gate passed against ${baseRevision}.`);
}

function resolveReleaseBaseRevision() {
  if (process.env.NARRARIUM_RELEASE_BASE) return process.env.NARRARIUM_RELEASE_BASE;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return process.env.GITHUB_ACTIONS === "true" ? "HEAD^" : null;
}

function readGitJson(revision, filePath) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${revision}:${filePath}`], { encoding: "utf8" }));
  } catch (error) {
    throw new Error(`Cannot read ${filePath} from release base ${revision}. Check out the base revision before running the site release gate.`, { cause: error });
  }
}

function gitChangedFiles(revision) {
  return execFileSync("git", ["diff", "--name-only", `${revision}...HEAD`], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((filePath) => filePath.trim())
    .filter(Boolean);
}

function readLockfileSiteVersion(lockfile) {
  return lockfile.packages?.["src/narrarium-site"]?.version;
}
