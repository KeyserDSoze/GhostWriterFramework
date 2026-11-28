// The release lanes of the Narrarium site (see AGENTS.md, "Release lanes").
//
//   express  manual only (Deploy, `workflow_dispatch` with `fast_track`): build and publish, no tests. Texts, docs, translations,
//            patch notes, and a rollback to a commit that was already verified (`ref`).
//   quick    automatic, from a `Fast-Track: <reason>` trailer in the head commit message of a push to main: the deploy waits for the
//            related tests and a smoke subset of the E2E suite only; the full checks run in the same run and their result is reported.
//            Refused (the push goes the full lane) when the change touches what a quick lane must not judge: see QUICK_GUARDS.
//   full     every other push: the deploy waits for the full checks.
//
// `node scripts/release-lane.mjs decide` decides the lane of a run on GitHub Actions; `node scripts/release-lane.mjs explain --base <ref>`
// says, locally, which lane a change would take and why. The decision itself is the pure function `decideLane`.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TRAILER = "Fast-Track";

/**
 * What a quick lane never takes: each entry is a reason and the paths it covers. A push that touches any of them goes the full lane,
 * whatever its trailer says. Conservative on purpose: a quick lane is for the site's own small fixes.
 */
export const QUICK_GUARDS = [
  { reason: "the engine", test: (file) => file.startsWith("packages/engine/") },
  { reason: "the personal server", test: (file) => file.startsWith("packages/server/") },
  { reason: "the core package", test: (file) => file.startsWith("packages/core/") },
  { reason: "the reader package", test: (file) => file.startsWith("packages/astro-reader/") },
  // The other published packages (SDK, MCP server, book scaffolder) as well, their READMEs included: a README is in the package.
  { reason: "a published package", test: (file) => file.startsWith("packages/") },
  { reason: "the workflows", test: (file) => file.startsWith(".github/") },
  { reason: "the release and lane scripts", test: (file) => file.startsWith("scripts/") },
  {
    reason: "the configuration of the checks",
    test: (file) => file === "playwright.config.ts"
      || file === "tsconfig.base.json"
      || /^src\/narrarium-site\/(vite|vitest)\.config\.ts$/.test(file)
      || /^src\/narrarium-site\/tsconfig[^/]*\.json$/.test(file)
      || file.startsWith("src/narrarium-site/scripts/")
      || file.startsWith("e2e/helpers/"),
  },
  {
    reason: "authentication or security code",
    test: (file) => file.startsWith("src/narrarium-site/auth/")
      || file.startsWith("src/narrarium-site/src/auth/")
      || file.startsWith("src/narrarium-site/src/account/")
      || file.startsWith("src/narrarium-site/src/github/")
      || file.startsWith("src/narrarium-site/src/readerAccess/")
      || /^src\/narrarium-site\/(csp\.ts|msal-popup\.html|src\/msalPopup\.ts|src\/microsoftCallback\.ts)$/.test(file)
      || /(auth|oauth|token|credential|secret|vault|crypt|passkey|password|security|csp|permission|sanitiz)/i.test(file.split("/").pop() ?? ""),
  },
  // Everything under src/ but the site: the auth proxy and whatever else is deployed on its own.
  { reason: "a service other than the site", test: (file) => file.startsWith("src/") && !file.startsWith("src/narrarium-site/") },
  { reason: "the serverless API", test: (file) => file.startsWith("api/") || file === "vercel.json" },
];

/** The `Fast-Track` trailer of a commit message: its reason, or null. Only the last paragraph holds trailers, as git reads them. */
export function fastTrackReason(message) {
  const paragraphs = String(message ?? "").replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  if (paragraphs.length < 2) return null;
  const last = paragraphs.at(-1).split("\n");
  for (const line of last) {
    const match = /^fast-track:[ \t]*(.*)$/i.exec(line.trim());
    if (match) return match[1].trim() || null;
  }
  return null;
}

const WORKSPACE_VERSION_KEYS = new Set(["version"]);

/** What changed in a package.json besides its own version: the names of the fields (dependencies, scripts, ...). */
export function packageJsonChanges(before, after) {
  const a = JSON.parse(before ?? "{}");
  const b = JSON.parse(after ?? "{}");
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => !WORKSPACE_VERSION_KEYS.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
}

/**
 * What changed in package-lock.json besides the versions of the workspace packages (which every site release bumps): the entries of the
 * installed dependencies that differ. An empty list: no dependency changed.
 */
export function lockfileChanges(before, after) {
  const strip = (text) => {
    const lock = JSON.parse(text ?? "{}");
    const { version: _version, ...rest } = lock;
    const packages = {};
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      const workspace = key === "" || !key.includes("node_modules/");
      if (workspace) {
        const { version: _ignored, ...kept } = entry;
        packages[key] = kept;
      } else packages[key] = entry;
    }
    return { ...rest, packages };
  };
  const a = strip(before);
  const b = strip(after);
  const changed = [];
  for (const key of new Set([...Object.keys(a.packages), ...Object.keys(b.packages)])) {
    if (JSON.stringify(a.packages[key]) !== JSON.stringify(b.packages[key])) changed.push(key || "(root)");
  }
  const { packages: _a, ...restA } = a;
  const { packages: _b, ...restB } = b;
  if (JSON.stringify(restA) !== JSON.stringify(restB)) changed.push("(lockfile header)");
  return changed.sort();
}

/**
 * The lane of a run.
 * - `express`: a manual run that asked for it.
 * - `quick`: the head commit has a `Fast-Track` trailer, the changed files are known, none is guarded, and no dependency changed.
 * - `full`: everything else; `refused` says why a trailer was not honoured.
 * `files` is null when the changed files cannot be known (a new branch, a force push): a trailer is then refused.
 * `packageChanges` maps a changed package.json to the fields that changed besides `version`; `lockChanges` lists the lockfile entries.
 */
export function decideLane({ express = false, message = "", files = null, packageChanges = {}, lockChanges = [] }) {
  if (express) return { lane: "express", reason: "a manual run without the tests", refused: [] };
  const reason = fastTrackReason(message);
  if (!reason) return { lane: "full", reason: "no Fast-Track trailer", refused: [] };
  const refused = [];
  if (!Array.isArray(files)) refused.push("the changed files are not known (a new branch or a force push)");
  else {
    if (files.length === 0) refused.push("no file changed");
    for (const guard of QUICK_GUARDS) {
      const hit = files.filter((file) => guard.test(file));
      if (hit.length) refused.push(`${guard.reason}: ${hit.slice(0, 5).join(", ")}${hit.length > 5 ? `, and ${hit.length - 5} more` : ""}`);
    }
    for (const [file, fields] of Object.entries(packageChanges)) {
      if (fields.length) refused.push(`dependencies or scripts: ${file} changes ${fields.join(", ")}`);
    }
    if (lockChanges.length) refused.push(`dependencies: package-lock.json changes ${lockChanges.slice(0, 5).join(", ")}${lockChanges.length > 5 ? `, and ${lockChanges.length - 5} more` : ""}`);
  }
  if (refused.length) return { lane: "full", reason: `Fast-Track refused (${reason})`, refused };
  return { lane: "quick", reason, refused: [] };
}

/** The site files a quick lane gives to `vitest related`, relative to the site folder: its sources and its component tests. */
export function siteTestTargets(files) {
  return (files ?? [])
    .filter((file) => /^src\/narrarium-site\/(src|test-browser)\/.+\.(ts|tsx|js|jsx|mjs|json|css|md)$/.test(file))
    .map((file) => file.slice("src/narrarium-site/".length));
}

// ---------------------------------------------------------------------------------------------
// git: what a range changed
// ---------------------------------------------------------------------------------------------

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const ZERO = /^0+$/;

export function knownCommit(ref) {
  if (!ref || ZERO.test(ref)) return false;
  try {
    git("cat-file", "-e", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** The files changed from `base` to `head`, or null when `base` is not a known commit. */
export function changedFiles(base, head) {
  if (!knownCommit(base) || !knownCommit(head)) return null;
  return git("diff", "--name-only", "--no-renames", base, head).split("\n").filter(Boolean);
}

const show = (ref, file) => {
  try {
    return git("show", `${ref}:${file}`);
  } catch {
    return undefined;
  }
};

/** What `decideLane` needs about a range: its files, and how its package.json files and lockfile changed. */
export function describeRange(base, head) {
  const files = changedFiles(base, head);
  const packageChanges = {};
  let lockChanges = [];
  for (const file of files ?? []) {
    if (/(^|\/)package\.json$/.test(file)) packageChanges[file] = packageJsonChanges(show(base, file), show(head, file));
    if (file === "package-lock.json") lockChanges = lockfileChanges(show(base, file), show(head, file));
  }
  return { files, packageChanges, lockChanges };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key.startsWith("--")) values[key.slice(2)] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? "true" : argv[(index += 1)];
  }
  return values;
}

function main(argv) {
  const [command, ...rest] = argv;
  const flags = options(rest);
  const head = flags.head || "HEAD";
  // A push says the commit it started from; a manual run, or a push whose start is unknown, is judged against the head's first parent.
  const base = knownCommit(flags.base) ? flags.base : command === "decide" && flags.event === "push" ? flags.base : `${head}^`;
  const message = git("log", "-1", "--format=%B", head);
  const range = describeRange(base, head);
  const decision = decideLane({ express: flags.express === "true", message, ...range });
  const targets = siteTestTargets(range.files);
  const lines = [
    `Lane: ${decision.lane} (${decision.reason})`,
    ...decision.refused.map((why) => `  refused: ${why}`),
    `Range: ${base}..${head}, ${range.files ? `${range.files.length} files` : "files unknown"}`,
  ];
  console.log(lines.join("\n"));
  if (command === "decide") {
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `lane=${decision.lane}\nbase=${base}\nrelated=${JSON.stringify(targets)}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Release lane: ${decision.lane}`, "", decision.reason, ...decision.refused.map((why) => `- refused: ${why}`), ""].join("\n"));
    }
    if (decision.refused.length && process.env.GITHUB_ACTIONS === "true") {
      console.log(`::warning title=Fast-Track refused::${decision.refused.join("; ")}. This push takes the full lane.`);
    }
  } else if (command !== "explain") {
    console.error("usage: node scripts/release-lane.mjs decide|explain [--base <ref>] [--head <ref>] [--event <name>] [--express true]");
    process.exit(2);
  }
  return decision;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
