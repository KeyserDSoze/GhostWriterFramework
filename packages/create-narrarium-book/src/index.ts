#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createChapter,
  createCharacterProfile,
  createParagraph,
  initializeBookRepo,
  readBook,
  seedDefaultPersonas,
  syncChapterEvaluation,
  syncChapterResume,
  syncTotalResume,
  upgradeBookRepo,
} from "narrarium";

type ParsedArgs = {
  targetDir?: string;
  title?: string;
  author?: string;
  language?: string;
  sample?: boolean;
  withReader?: boolean;
  noReader?: boolean;
  readerDir?: string;
  skipInstall?: boolean;
  pagesDomain?: string;
  upgrade?: boolean;
};

const args = parseArgs(process.argv.slice(2));
await main(args);

async function main(args: ParsedArgs) {
  if (args.upgrade) {
    await runUpgrade(args);
    return;
  }

  await runCreate(args);
}

async function runCreate(args: ParsedArgs) {
  const resolved = await resolveInputs(args);
  const targetPath = path.resolve(process.cwd(), resolved.targetDir);

  await initializeBookRepo(targetPath, {
    title: resolved.title,
    author: resolved.author || undefined,
    language: resolved.language,
    createSkills: true,
  });

  await seedDefaultPersonas(targetPath, resolved.language);

  let readerPath = "";
  let readerInstalled = false;

  if (resolved.withReader) {
    const readerDir = path.join(targetPath, resolved.readerDir);
    const readerBookRoot = path.relative(readerDir, targetPath) || ".";
    readerPath = await runReaderScaffold(readerDir, readerBookRoot, `${slugifyForPackage(resolved.title)}-reader`, resolved.pagesDomain);
    await writeRootPackageJson(targetPath, resolved.title, resolved.readerDir);
    await writeRootPagesWorkflow(targetPath, resolved.readerDir, resolved.pagesDomain);
    if (!resolved.skipInstall) {
      installNodeDependencies(readerPath);
      readerInstalled = true;
    }
  }

  if (resolved.sample) {
    await createCharacterProfile(targetPath, {
      name: "Lyra Vale",
      roleTier: "main",
      storyRole: "protagonist",
      speakingStyle: "Measured, observant, and precise. She rarely wastes words and often hides emotion behind controlled language.",
      backgroundSummary: "Raised around trade routes and political intrigue, Lyra learned early how to read rooms, hide motives, and survive by listening harder than everyone else.",
      functionInBook: "Primary viewpoint anchor for the opening movement and the reader's first sustained window into the world.",
      age: 29,
      occupation: "Broker of information",
      origin: "Gray Harbor",
      firstImpression: "Competent, composed, and hard to read.",
      traits: ["observant", "guarded", "adaptable"],
      desires: ["protect her leverage", "learn the truth behind the missing archive"],
      fears: ["becoming predictable", "failing the few people she trusts"],
      relationships: ["Has unfinished history with the Night Syndicate.", "Treats alliances as temporary until proven otherwise."],
      arc: "Moves from strategic distance toward costly emotional commitment.",
      internalConflict: "She wants intimacy but trusts control more than honesty.",
      externalConflict: "Several factions want the same information she is trying to bury and decode.",
    });

    await createChapter(targetPath, {
      number: 1,
      title: "The Arrival",
      frontmatter: {
        summary: "Lyra returns to Gray Harbor and realizes the city is already waiting for her.",
        pov: ["character:lyra-vale"],
      },
    });

    await createParagraph(targetPath, {
      chapter: "chapter:001-the-arrival",
      number: 1,
      title: "At The Gate",
      frontmatter: {
        summary: "Lyra arrives at the city gate and notices the altered guard routine.",
        viewpoint: "character:lyra-vale",
      },
      body: [
        "Gray Harbor had changed its posture.",
        "",
        "The walls were the same color as memory, but the men on the gate no longer looked bored. They watched the road like they expected a confession to come walking out of the fog.",
        "",
        "Lyra slowed before the archway and let the city study her first.",
      ].join("\n"),
    });

    await syncChapterResume(targetPath, "chapter:001-the-arrival");
    await syncChapterEvaluation(targetPath, "chapter:001-the-arrival");
    await syncTotalResume(targetPath);
  }

  output.write(
    [
      `Narrarium book created at ${targetPath}`,
      "",
      "Next steps:",
      `- Open the repo in OpenCode and enable the local MCP server`,
      `- Run \`npm run build\` in the Narrarium Framework repo if you changed the framework`,
      `- Use \`init_book_repo\` only for new repos; this repo is already initialized`,
      `- Point the reader to this repo with NARRARIUM_BOOK_ROOT=${targetPath}`,
      ...(readerPath ? [`- Reader scaffold created at ${readerPath}`] : []),
      ...(readerInstalled ? ["- Reader dependencies were installed automatically"] : []),
      ...(readerPath ? ["- From the book root you can now run `npm run dev`, `npm run build`, or `npm run export:epub`"] : []),
      ...(readerPath ? ["- `npm run dev` watches the book files, refreshes the EPUB, and reloads the site while you write"] : []),
      ...(readerPath ? ["- The generated reader already includes auto-EPUB export and a GitHub Pages workflow"] : []),
      ...(resolved.pagesDomain ? [`- GitHub Pages custom domain preset: https://${resolved.pagesDomain}`] : []),
    ].join("\n"),
  );
}

async function runUpgrade(args: ParsedArgs) {
  const resolved = await resolveUpgradeInputs(args);
  const targetPath = path.resolve(process.cwd(), resolved.targetDir);
  const upgrade = await upgradeBookRepo(targetPath, { createSkills: true });
  const migrated = (upgrade as { migrated?: string[] }).migrated ?? [];
  const book = await readBook(targetPath);

  let readerPath = "";
  let readerInstalled = false;

  if (resolved.withReader) {
    const readerDir = path.join(targetPath, resolved.readerDir);
    const readerBookRoot = inferReaderBookRoot(readerDir, targetPath);
    const readerPackageName = inferReaderPackageName(targetPath, resolved.readerDir, book?.frontmatter.title ?? path.basename(targetPath));
    const pagesDomain = resolved.pagesDomain ?? inferReaderPagesDomain(targetPath, resolved.readerDir);
    readerPath = await runReaderScaffold(readerDir, readerBookRoot, readerPackageName, pagesDomain);
    await writeManagedRootPackageJson(targetPath, book?.frontmatter.title ?? path.basename(targetPath), resolved.readerDir);
    await writeManagedRootPagesWorkflow(targetPath, resolved.readerDir, pagesDomain);
    if (!resolved.skipInstall) {
      installNodeDependencies(readerPath);
      readerInstalled = true;
    }
  }

  output.write(
    [
      `Narrarium book upgraded at ${targetPath}`,
      upgrade.created.length > 0 ? `- Created missing scaffold files: ${upgrade.created.join(", ")}` : "- No scaffold files were missing.",
      upgrade.updated.length > 0 ? `- Updated managed files: ${upgrade.updated.join(", ")}` : "- Managed repo files were already up to date.",
      migrated.length > 0
        ? `- Migrated story prose links to plain-text canon mentions: ${migrated.join(", ")}`
        : "- No legacy story prose links needed migration.",
      ...(readerPath ? [`- Reader scaffold upgraded at ${readerPath}`] : ["- Reader scaffold not touched. Pass `--with-reader` to refresh it too."]),
      ...(readerInstalled ? ["- Reader dependencies were reinstalled automatically"] : []),
      "",
      "Next steps:",
      "- Reopen OpenCode in this repo so the updated commands and plugins load",
      "- Run `/resume-book` in a fresh session if you want to restart from repo state",
      ...(resolved.withReader ? ["- Run `npm run dev` from the book root to verify the reader still behaves as expected"] : []),
    ].join("\n"),
  );
}

async function resolveInputs(args: ParsedArgs) {
  if (args.targetDir && args.title && args.language) {
    return {
      targetDir: args.targetDir,
      title: args.title,
      author: args.author ?? "",
      language: args.language,
      sample: Boolean(args.sample),
        withReader: args.noReader ? false : args.withReader ?? true,
        readerDir: args.readerDir ?? "reader",
        skipInstall: Boolean(args.skipInstall),
        pagesDomain: args.pagesDomain,
      };
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Missing required arguments. Use create-narrarium-book <dir> --title <title> --language <lang> [--author <name>] [--sample] [--with-reader|--no-reader] [--reader-dir <name>] [--pages-domain <domain>], or create-narrarium-book --upgrade <dir>.");
  }

  const rl = createInterface({ input, output });
  try {
    const targetDir = (args.targetDir ?? (await rl.question("Target folder: "))) || "my-book";
    const title = args.title ?? (await rl.question("Book title: "));
    const author = args.author ?? (await rl.question("Author (optional): "));
    const language = args.language ?? ((await rl.question("Language [en]: ")) || "en");
    const sampleAnswer = await rl.question("Create sample content? [y/N]: ");
    const readerAnswer = await rl.question("Scaffold Astro reader too? [Y/n]: ");
    const wantsReader = args.noReader
      ? false
      : readerAnswer.trim()
        ? /^y(es)?$/i.test(readerAnswer.trim())
        : args.withReader ?? true;
    const readerDir = wantsReader
      ? (await rl.question("Reader folder [reader]: ")) || args.readerDir || "reader"
      : args.readerDir ?? "reader";
    const installAnswer = wantsReader ? await rl.question("Install reader dependencies now? [Y/n]: ") : "n";
    const pagesDomain = wantsReader ? ((await rl.question("GitHub Pages custom domain (optional): ")) || args.pagesDomain || undefined) : undefined;
    return {
      targetDir,
      title,
      author,
      language,
      sample: /^y(es)?$/i.test(sampleAnswer.trim()) || Boolean(args.sample),
      withReader: wantsReader,
      readerDir,
      skipInstall: wantsReader ? /^n(o)?$/i.test(installAnswer.trim()) || Boolean(args.skipInstall) : true,
      pagesDomain,
    };
  } finally {
    rl.close();
  }
}

async function resolveUpgradeInputs(args: ParsedArgs) {
  if (args.targetDir) {
    const targetPath = path.resolve(process.cwd(), args.targetDir);
    const readerDir = args.readerDir ?? "reader";
    return {
      targetDir: args.targetDir,
      withReader: args.noReader ? false : args.withReader ?? existsSync(path.join(targetPath, readerDir)),
      readerDir,
      skipInstall: Boolean(args.skipInstall),
      pagesDomain: args.pagesDomain,
    };
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Missing target directory. Use create-narrarium-book --upgrade <dir> [--with-reader|--no-reader] [--reader-dir <name>] [--no-install] [--pages-domain <domain>].");
  }

  const rl = createInterface({ input, output });
  try {
    const targetDir = (await rl.question("Repo folder to upgrade [.]: ")) || ".";
    const targetPath = path.resolve(process.cwd(), targetDir);
    const defaultReaderDir = args.readerDir ?? "reader";
    const hasReader = existsSync(path.join(targetPath, defaultReaderDir));
    const readerAnswer = await rl.question(`Upgrade Astro reader too? [${hasReader ? "Y/n" : "y/N"}]: `);
    const wantsReader = args.noReader
      ? false
      : readerAnswer.trim()
        ? /^y(es)?$/i.test(readerAnswer.trim())
        : args.withReader ?? hasReader;
    const readerDir = wantsReader ? ((await rl.question(`Reader folder [${defaultReaderDir}]: `)) || defaultReaderDir) : defaultReaderDir;
    const installAnswer = wantsReader ? await rl.question("Install reader dependencies after upgrade? [Y/n]: ") : "n";
    const pagesDomain = wantsReader ? ((await rl.question("GitHub Pages custom domain (optional, blank keeps current): ")) || args.pagesDomain || undefined) : undefined;
    return {
      targetDir,
      withReader: wantsReader,
      readerDir,
      skipInstall: wantsReader ? /^n(o)?$/i.test(installAnswer.trim()) || Boolean(args.skipInstall) : true,
      pagesDomain,
    };
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("-")) {
      if (!parsed.targetDir) parsed.targetDir = token;
      continue;
    }

    switch (token) {
      case "--title":
        parsed.title = argv[++index];
        break;
      case "--author":
        parsed.author = argv[++index];
        break;
      case "--language":
      case "--lang":
        parsed.language = argv[++index];
        break;
      case "--sample":
        parsed.sample = true;
        break;
      case "--with-reader":
        parsed.withReader = true;
        break;
      case "--no-reader":
        parsed.noReader = true;
        break;
      case "--reader-dir":
        parsed.readerDir = argv[++index];
        break;
      case "--skip-install":
      case "--no-install":
        parsed.skipInstall = true;
        break;
      case "--pages-domain":
        parsed.pagesDomain = argv[++index];
        break;
      case "--upgrade":
        parsed.upgrade = true;
        break;
      default:
        break;
    }
  }

  return parsed;
}

function slugifyForPackage(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "narrarium-book";
}

async function runReaderScaffold(targetDir: string, bookRoot: string, packageName: string, pagesDomain?: string): Promise<string> {
  const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const require = createRequire(import.meta.url);
  const readerCliPath = resolveReaderCliPath(require, packageRoot);
  const coreDependency = resolveCoreDependency(targetDir, packageRoot);
  const result = spawnSync(
    process.execPath,
    [
      readerCliPath,
      targetDir,
      "--book-root",
      bookRoot,
      "--package-name",
      packageName,
      "--core-dependency",
      coreDependency,
      ...(pagesDomain ? ["--pages-domain", pagesDomain] : []),
    ],
    {
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Reader scaffold failed.");
  }

  return path.resolve(targetDir);
}

function installNodeDependencies(targetDir: string): void {
  const { command, args } = getNpmInstallInvocation();
  const result = spawnSync(command, args, {
    cwd: targetDir,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`Failed to start npm install in ${targetDir}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Failed to install reader dependencies in ${targetDir}. You can rerun the starter with --no-install and then run npm install manually inside the reader folder.`);
  }
}

function getNpmInstallInvocation(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm install"],
    };
  }

  return {
    command: "npm",
    args: ["install"],
  };
}

async function writeRootPackageJson(targetPath: string, title: string, readerDir: string): Promise<void> {
  await writeFile(path.join(targetPath, "package.json"), buildRootPackageJson(title, readerDir), "utf8");
}

async function writeRootPagesWorkflow(targetPath: string, readerDir: string, pagesDomain?: string): Promise<void> {
  const workflowDir = path.join(targetPath, ".github", "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(path.join(workflowDir, "deploy-reader-pages.yml"), buildRootPagesWorkflow(readerDir, pagesDomain), "utf8");
}

function buildRootPackageJson(title: string, readerDir: string): string {
  const normalizedReaderDir = readerDir.split(path.sep).join("/");
  return JSON.stringify(
    {
      name: slugifyForPackage(title),
      private: true,
      scripts: {
        dev: `npm run dev --prefix ${normalizedReaderDir}`,
        build: `npm run build --prefix ${normalizedReaderDir}`,
        preview: `npm run preview --prefix ${normalizedReaderDir}`,
        "export:epub": `npm run export:epub --prefix ${normalizedReaderDir}`,
        doctor: `npm run doctor --prefix ${normalizedReaderDir}`,
        install: `npm install --prefix ${normalizedReaderDir}`,
      },
    },
    null,
    2,
  ) + "\n";
}

async function writeManagedRootPackageJson(targetPath: string, title: string, readerDir: string): Promise<void> {
  await writeManagedFile(targetPath, "package.json", buildRootPackageJson(title, readerDir));
}

async function writeManagedRootPagesWorkflow(targetPath: string, readerDir: string, pagesDomain: string | undefined): Promise<void> {
  // Never overwrite an existing workflow — the user may have uncommented the
  // password secret or made other manual edits that must be preserved.
  await writeOnceFile(targetPath, path.join(".github", "workflows", "deploy-reader-pages.yml"), buildRootPagesWorkflow(readerDir, pagesDomain));
}

async function writeManagedFile(targetRoot: string, relativePath: string, content: string): Promise<void> {
  const targetFilePath = path.join(targetRoot, relativePath);
  const existing = await readFile(targetFilePath, "utf8").catch(() => null);
  if (existing === content) {
    return;
  }

  await mkdir(path.dirname(targetFilePath), { recursive: true });
  await writeFile(targetFilePath, content, "utf8");
}

/** Write a file only if it does not already exist. Used for user-editable files like workflow YAMLs. */
async function writeOnceFile(targetRoot: string, relativePath: string, content: string): Promise<void> {
  const targetFilePath = path.join(targetRoot, relativePath);
  const existing = await readFile(targetFilePath, "utf8").catch(() => null);
  if (existing !== null) {
    return;
  }
  await mkdir(path.dirname(targetFilePath), { recursive: true });
  await writeFile(targetFilePath, content, "utf8");
}

function inferReaderBookRoot(readerDir: string, targetPath: string): string {
  const readerRoot = path.resolve(readerDir);
  const fallback = path.relative(readerRoot, targetPath) || ".";
  const bookConfigCandidates = [
    path.join(readerRoot, "scripts", "book-config.mjs"),
    path.join(readerRoot, "src", "lib", "book-config.ts"),
  ];

  for (const candidate of bookConfigCandidates) {
    if (!existsSync(candidate)) continue;
    const raw = readFileSync(candidate, "utf8");
    const match = raw.match(/defaultBookRoot\s*=\s*["'`](.+?)["'`]/);
    if (match?.[1]) {
      const resolvedCandidate = path.resolve(readerRoot, match[1]);
      if (samePath(resolvedCandidate, targetPath)) {
        return match[1];
      }
    }
  }

  return fallback;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.resolve(value).replace(/[\\/]+/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  return normalize(left) === normalize(right);
}

function inferReaderPackageName(targetPath: string, readerDir: string, fallbackTitle: string): string {
  const packageJsonPath = path.join(targetPath, readerDir, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
      if (parsed.name?.trim()) {
        return parsed.name;
      }
    } catch {
      // fall through
    }
  }

  return `${slugifyForPackage(fallbackTitle)}-reader`;
}

function inferReaderPagesDomain(targetPath: string, readerDir: string): string | undefined {
  const cnamePath = path.join(targetPath, readerDir, "public", "CNAME");
  if (!existsSync(cnamePath)) {
    return undefined;
  }

  const value = readFileSync(cnamePath, "utf8").trim();
  return value || undefined;
}

function buildRootPagesWorkflow(readerDir: string, pagesDomain?: string): string {
  const normalizedReaderDir = readerDir.split(path.sep).join("/");
  const envLines = pagesDomain
    ? [`          NARRARIUM_BOOK_ROOT: .`, `          SITE_BASE: /`, `          SITE_URL: https://${pagesDomain}`]
    : [`          NARRARIUM_BOOK_ROOT: .`, `          SITE_BASE: /\${{ github.event.repository.name }}/`];
  return `name: Deploy Reader To GitHub Pages

on:
  workflow_dispatch:
  push:
    branches:
      - main
      - master

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: github-pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: ${normalizedReaderDir}/package-lock.json

      - name: Install project dependencies
        run: npm install

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Build reader site
        env:
${envLines.join("\n")}
        run: npm run build

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ${normalizedReaderDir}/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

function resolveReaderCliPath(require: NodeRequire, packageRoot: string): string {
  try {
    const scaffoldPath = require.resolve("narrarium-astro-reader/scaffold");
    return path.resolve(path.dirname(scaffoldPath), "cli.js");
  } catch {
    const publishedCliPath = path.resolve(packageRoot, "../narrarium-astro-reader/cli-dist/cli.js");
    if (existsSync(publishedCliPath)) {
      return publishedCliPath;
    }

    return path.resolve(packageRoot, "../astro-reader/cli-dist/cli.js");
  }
}

function resolveCoreDependency(targetDir: string, packageRoot: string): string {
  const localCorePath = path.resolve(packageRoot, "../core");
  if (isWorkspaceDevelopmentInstall(packageRoot) && existsSync(path.join(localCorePath, "package.json"))) {
    const relative = path.relative(targetDir, localCorePath).split(path.sep).join("/");
    return `file:${relative.startsWith(".") ? relative : `./${relative}`}`;
  }

  return `^${readPackageVersion(packageRoot)}`;
}

function isWorkspaceDevelopmentInstall(packageRoot: string): boolean {
  const workspacePackageJsonPath = path.resolve(packageRoot, "..", "..", "package.json");
  if (!existsSync(workspacePackageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(workspacePackageJsonPath, "utf8")) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces) && parsed.workspaces.includes("packages/*");
  } catch {
    return false;
  }
}

function readPackageVersion(packageRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: string };
    return parsed.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}
