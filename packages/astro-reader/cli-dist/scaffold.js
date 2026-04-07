import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isClearlyInvalidBookRootValue, normalizeReaderEnvValue, resolveReaderBookRootCandidate } from "./lib/env.js";
export async function scaffoldReaderSite(targetDir, options = {}) {
    const targetRoot = path.resolve(targetDir);
    const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
    const bookRoot = options.bookRoot ?? "..";
    const packageName = options.packageName ?? inferPackageName(targetRoot);
    const coreDependency = options.coreDependency ?? await readNarrariumCoreVersion(packageRoot);
    const pagesDomain = options.pagesDomain?.trim() || undefined;
    await mkdir(path.join(targetRoot, "src", "layouts"), { recursive: true });
    await mkdir(path.join(targetRoot, "src", "lib"), { recursive: true });
    await mkdir(path.join(targetRoot, "src", "pages"), { recursive: true });
    await mkdir(path.join(targetRoot, "src", "components"), { recursive: true });
    await mkdir(path.join(targetRoot, "src", "styles"), { recursive: true });
    await mkdir(path.join(targetRoot, "scripts"), { recursive: true });
    await mkdir(path.join(targetRoot, ".github", "workflows"), { recursive: true });
    await mkdir(path.join(targetRoot, "public", "downloads"), { recursive: true });
    await Promise.all([
        copyFile(path.join(packageRoot, "astro.config.mjs"), path.join(targetRoot, "astro.config.mjs")),
        copyFile(path.join(packageRoot, "tsconfig.json"), path.join(targetRoot, "tsconfig.json")),
        copyFile(path.join(packageRoot, "src", "middleware.ts"), path.join(targetRoot, "src", "middleware.ts")),
        cp(path.join(packageRoot, "scripts"), path.join(targetRoot, "scripts"), { recursive: true }),
        cp(path.join(packageRoot, "src", "components"), path.join(targetRoot, "src", "components"), { recursive: true }),
        cp(path.join(packageRoot, "src", "styles"), path.join(targetRoot, "src", "styles"), { recursive: true }),
        cp(path.join(packageRoot, "src", "lib"), path.join(targetRoot, "src", "lib"), { recursive: true }),
        cp(path.join(packageRoot, "src", "layouts"), path.join(targetRoot, "src", "layouts"), { recursive: true }),
        cp(path.join(packageRoot, "src", "pages"), path.join(targetRoot, "src", "pages"), { recursive: true }),
    ]);
    await writeFile(path.join(targetRoot, "package.json"), JSON.stringify({
        name: packageName,
        private: true,
        type: "module",
        scripts: {
            "export:epub": "node ./scripts/export-epub.mjs",
            doctor: "node ./scripts/doctor.mjs",
            dev: "node ./scripts/dev.mjs",
            build: "npm run export:epub && astro build",
            preview: "astro preview",
        },
        dependencies: {
            "narrarium": coreDependency,
            astro: "^5.14.1",
            chokidar: "^4.0.3",
            "js-yaml": "^3.14.2",
            marked: "^16.3.0",
        },
        devDependencies: {
            "@types/node": "^24.6.0",
            typescript: "^5.9.3",
        },
    }, null, 2) + "\n", "utf8");
    await writeFile(path.join(targetRoot, "src", "lib", "book-config.ts"), `export const defaultBookRoot = ${JSON.stringify(toPosix(bookRoot))};\n`, "utf8");
    await writeFile(path.join(targetRoot, "scripts", "book-config.mjs"), buildBookConfigScript(bookRoot), "utf8");
    await writeFile(path.join(targetRoot, ".github", "workflows", "deploy-pages.yml"), buildPagesWorkflow(pagesDomain), "utf8");
    if (pagesDomain) {
        await writeFile(path.join(targetRoot, "public", "CNAME"), `${pagesDomain}\n`, "utf8");
    }
    await writeFile(path.join(targetRoot, ".env.example"), buildReaderEnvFile(bookRoot), "utf8");
    const envPath = path.join(targetRoot, ".env");
    const existingEnv = await readFile(envPath, "utf8").catch(() => null);
    const nextEnv = mergeReaderEnvFile(existingEnv, bookRoot, targetRoot);
    if (nextEnv !== existingEnv) {
        await writeFile(envPath, nextEnv, "utf8");
    }
    await writeFile(path.join(targetRoot, ".gitignore"), "node_modules/\ndist/\n.astro/\n.env\npublic/downloads/\n", "utf8");
    await writeFile(path.join(targetRoot, "README.md"), buildReaderReadme(bookRoot), "utf8");
    return {
        targetRoot,
        packageName,
        coreDependency,
        bookRoot,
    };
}
function buildReaderReadme(bookRoot) {
    return `# Narrarium Reader Site

This site was scaffolded from \`narrarium-astro-reader\`.

## Configure

The scaffold creates a local \`.env\` with the book root already filled in. Adjust it if this reader should point somewhere else:

\`\`\`bash
NARRARIUM_BOOK_ROOT=${toPosix(bookRoot)}
# NARRARIUM_READER_CANON_MODE=full
# NARRARIUM_READER_PASSWORD=your-secret-password
# EPUBCHECK_CMD=epubcheck
# EPUBCHECK_JAR=/absolute/path/to/epubcheck.jar
\`\`\`

## Run

\`\`\`bash
npm install
npm run dev
\`\`\`

The dev server exports a fresh EPUB to \`public/downloads/book.epub\` before Astro starts.
It also watches the linked book repository, regenerates the EPUB when canon files change, and triggers a full browser reload.

By default the reader uses a spoiler-safe public mode. If you want a private full-canon deployment, enable \`NARRARIUM_READER_CANON_MODE=full\` before running dev or build.

## Password protection

Set \`NARRARIUM_READER_PASSWORD\` to encrypt all prose content at build time using AES-256-GCM.
Visitors must enter the correct password before any text is revealed.

For local development, add the variable to your \`.env\` file:

\`\`\`bash
NARRARIUM_READER_PASSWORD=your-secret-password
\`\`\`

For GitHub Pages deployment, add it to the \`Build site\` step in \`.github/workflows/deploy-pages.yml\`:

\`\`\`yaml
- name: Build site
  env:
    SITE_BASE: /\${{ github.event.repository.name }}/
    NARRARIUM_READER_PASSWORD: \${{ secrets.NARRARIUM_READER_PASSWORD }}
  run: npm run build
\`\`\`

Store the actual password as a repository secret: **Settings → Secrets and variables → Actions → New repository secret**.

## Doctor

\`\`\`bash
npm run doctor
\`\`\`

This checks broken canon references, spoiler thresholds, missing asset metadata, and stale \`plot.md\`, \`resumes/\`, or \`state/\` files.

## Build

\`\`\`bash
npm run build
\`\`\`

The build also refreshes the EPUB automatically and ships a ready-to-deploy static site.

If you want EPUBCheck validation too, set \`EPUBCHECK_JAR=/absolute/path/to/epubcheck.jar\` or \`EPUBCHECK_CMD=epubcheck\` before running export or build.

## GitHub Pages

A starter workflow already exists in \`.github/workflows/deploy-pages.yml\`.
By default it deploys to standard GitHub Pages using the repository name as the base path.
`;
}
function buildBookConfigScript(bookRoot) {
    return `export const defaultBookRoot = ${JSON.stringify(toPosix(bookRoot))};\n`;
}
function buildReaderEnvFile(bookRoot) {
    return [
        `NARRARIUM_BOOK_ROOT=${toPosix(bookRoot)}`,
        "# NARRARIUM_READER_CANON_MODE=full",
        "# NARRARIUM_READER_PASSWORD=your-secret-password",
        "# EPUBCHECK_CMD=epubcheck",
        "# EPUBCHECK_JAR=/absolute/path/to/epubcheck.jar",
        "",
    ].join("\n");
}
function mergeReaderEnvFile(existingContent, bookRoot, targetRoot) {
    const desiredRoot = toPosix(bookRoot);
    if (existingContent === null) {
        return buildReaderEnvFile(bookRoot);
    }
    const lines = existingContent.split(/\r?\n/);
    let handled = false;
    const nextLines = lines.map((line) => {
        const match = line.match(/^(\s*NARRARIUM_BOOK_ROOT\s*=\s*)(.*)$/);
        if (!match) {
            return line;
        }
        handled = true;
        const currentValue = normalizeReaderEnvValue(match[2]);
        if (currentValue && !isClearlyInvalidBookRootValue(currentValue) && resolveReaderBookRootCandidate(currentValue, targetRoot)) {
            return line;
        }
        return `${match[1]}${desiredRoot}`;
    });
    if (handled) {
        return nextLines.join("\n");
    }
    return `${buildReaderEnvFile(bookRoot).trimEnd()}\n${existingContent}`;
}
function buildPagesWorkflow(pagesDomain) {
    const envBlock = pagesDomain
        ? ["          SITE_BASE: /", `          SITE_URL: https://${pagesDomain}`].join("\n")
        : "          SITE_BASE: /${{ github.event.repository.name }}/";
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

      - name: Install dependencies
        run: npm ci

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Build site
        env:
${envBlock}
          # NARRARIUM_READER_PASSWORD: \${{ secrets.NARRARIUM_READER_PASSWORD }}
        run: npm run build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
`;
}
function toPosix(value) {
    return value.split(path.sep).join("/");
}
function inferPackageName(targetRoot) {
    const base = path.basename(targetRoot)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "narrarium-reader-site";
    return base;
}
async function readNarrariumCoreVersion(packageRoot) {
    const raw = await readFile(path.join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.dependencies?.["narrarium"] ?? "^0.1.7";
}
//# sourceMappingURL=scaffold.js.map