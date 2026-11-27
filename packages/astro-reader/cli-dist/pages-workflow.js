/**
 * The GitHub Pages workflow of a Narrarium book, and the upgrade of the one an existing repository has. No import of Node here: the
 * Narrarium site (in a browser) and the scaffolders (in Node) use the same text.
 *
 * In a book repository the workflow that runs is `.github/workflows/deploy-reader-pages.yml` at the ROOT (the reader lives in `reader/`);
 * the reader's own `reader/.github/workflows/deploy-pages.yml` is only for a reader kept as a repository of its own, and GitHub never runs
 * it inside a book. Both come from `buildPagesWorkflow`.
 *
 * Passwords: the repository variable READER_PASSWORD_SECRETS lists the names of the secrets that hold them. Secrets cannot be indexed by a
 * variable in an expression, so the build step, and only it, receives the secrets by NAME, one environment variable for each of the 24 password
 * slots (`READER_PASSWORD_001: ${{ secrets.READER_PASSWORD_001 }}` … `READER_PASSWORD_024`); the reader's build reads the listed names and
 * nothing else, and never prints a value (see `src/lib/reader-passwords.ts`).
 *
 * Version 2 gave the build step `${{ toJSON(secrets) }}`, every secret of the repository as JSON. That is the pattern of a workflow that steals
 * secrets, and GitHub holds such a file at «Action required» until someone with write access approves it (the heuristic is not documented, so
 * the cure is probable, not proven). Version 3 names the slots instead. The workflows of version 2 are still recognized, so that the upgrade
 * replaces them as an untouched file, and the reader still reads their JSON.
 */
import { READER_PASSWORD_SLOT_COUNT, readerPasswordSlotNames } from "./lib/reader-secret-names.js";
export { READER_PASSWORD_SLOT_COUNT };
export const PAGES_WORKFLOW_FILE = "deploy-reader-pages.yml";
export const PAGES_WORKFLOW_PATH = `.github/workflows/${PAGES_WORKFLOW_FILE}`;
/** The workflow of a reader that is a repository of its own. */
export const READER_PAGES_WORKFLOW_PATH = ".github/workflows/deploy-pages.yml";
/** The version this file writes; the first line of the workflow says it, so that a later upgrade knows which text it wrote. */
export const PAGES_WORKFLOW_VERSION = 3;
function normalizeReaderDir(readerDir) {
    const value = String(readerDir ?? "reader").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    return value === "" ? "." : value;
}
function resolve(options = {}) {
    const readerDir = normalizeReaderDir(options.readerDir);
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(readerDir)) {
        throw new Error(`The reader folder «${readerDir}» is not a relative folder made of letters, digits, dots, dashes and underscores.`);
    }
    const pagesDomain = options.pagesDomain?.trim() || undefined;
    if (pagesDomain && !/^[A-Za-z0-9.-]+$/.test(pagesDomain))
        throw new Error(`«${pagesDomain}» is not a domain name.`);
    const legacyPasswordSecret = options.legacyPasswordSecret?.trim() || undefined;
    if (legacyPasswordSecret && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(legacyPasswordSecret))
        throw new Error(`«${legacyPasswordSecret}» is not a secret name.`);
    return { readerDir, pagesDomain, npmCache: options.npmCache ?? true, legacyPasswordSecret };
}
/** The workflow text for these options (this version: the password slots, no `toJSON(secrets)`). */
export function buildPagesWorkflow(options = {}) {
    return renderPagesWorkflow(resolve(options), PAGES_WORKFLOW_VERSION);
}
/** The text of version 2 for these options (every secret as JSON), to recognize an untouched workflow of Narrarium that has it. */
function pagesWorkflowV2(options) {
    return renderPagesWorkflow(options, 2);
}
function renderPagesWorkflow(options, version) {
    const { readerDir, pagesDomain, npmCache, legacyPasswordSecret } = options;
    const inBook = readerDir !== ".";
    const dist = inBook ? `${readerDir}/dist` : "dist";
    const cacheLines = npmCache ? ["          cache: npm", ...(inBook ? [`          cache-dependency-path: ${readerDir}/package-lock.json`] : [])] : [];
    const env = [
        ...(inBook ? ["          NARRARIUM_BOOK_ROOT: ."] : []),
        ...(pagesDomain ? ["          SITE_BASE: /", `          SITE_URL: https://${pagesDomain}`] : ["          SITE_BASE: /${{ github.event.repository.name }}/"]),
        "          READER_PASSWORD_SECRETS: ${{ vars.READER_PASSWORD_SECRETS }}",
        ...(version === 2 ? ["          NARRARIUM_READER_SECRETS: ${{ toJSON(secrets) }}"] : readerPasswordSlotNames().map((name) => `          ${name}: \${{ secrets.${name} }}`)),
        ...(legacyPasswordSecret ? [`          NARRARIUM_READER_PASSWORD: \${{ secrets.${legacyPasswordSecret} }}`] : []),
    ];
    return [
        `# Narrarium Pages workflow, version ${version}: builds the reader${inBook ? ` in ${readerDir}/` : ""} and publishes it on GitHub Pages.`,
        "name: Deploy Reader To GitHub Pages",
        "",
        "on:",
        "  workflow_dispatch:",
        "  push:",
        "    branches:",
        "      - main",
        "      - master",
        "",
        "permissions:",
        "  contents: read",
        "  pages: write",
        "  id-token: write",
        "",
        "concurrency:",
        "  group: github-pages",
        "  cancel-in-progress: true",
        "",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Checkout",
        "        uses: actions/checkout@v4",
        "",
        "      - name: Setup Node",
        "        uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        ...cacheLines,
        "",
        "      - name: Install project dependencies",
        `        run: ${inBook ? "npm install" : "npm ci"}`,
        "",
        "      - name: Configure Pages",
        "        uses: actions/configure-pages@v5",
        "",
        "      # Reader passwords: the repository variable READER_PASSWORD_SECRETS lists the names of the repository",
        ...(version === 2
            ? [
                "      # secrets that hold them, for example READER_PASSWORD_001,READER_PASSWORD_002. This step alone receives",
                "      # the secrets as JSON; the build reads only the listed names and never prints a value. No name: a public book.",
            ]
            : [
                "      # secrets that hold them, for example READER_PASSWORD_001,READER_PASSWORD_002. This step alone receives",
                `      # them, one fixed slot each (READER_PASSWORD_001 to READER_PASSWORD_${String(READER_PASSWORD_SLOT_COUNT).padStart(3, "0")}), and none of the other secrets of the repository;`,
                "      # the build reads the listed slots and never prints a value. No name: a public book.",
            ]),
        "      - name: Build reader site",
        "        env:",
        ...env,
        "        run: npm run build",
        "",
        "      - name: Check that the passwords protect the reader",
        "        if: ${{ vars.READER_PASSWORD_SECRETS != '' }}",
        "        run: |",
        `          if ! node -e "process.exit(require('./${dist}/version.json').protected === true ? 0 : 1)"; then`,
        `            echo "::error title=Reader not protected::READER_PASSWORD_SECRETS lists passwords but the reader did not encrypt the book. Update the reader files${inBook ? ` in ${readerDir}/` : ""} to a version that reads them."`,
        "            exit 1",
        "          fi",
        "",
        "      - name: Upload Pages artifact",
        "        uses: actions/upload-pages-artifact@v3",
        "        with:",
        `          path: ${dist}`,
        "",
        "  deploy:",
        "    needs: build",
        "    runs-on: ubuntu-latest",
        "    environment:",
        "      name: github-pages",
        "      url: ${{ steps.deployment.outputs.page_url }}",
        "    steps:",
        "      - name: Deploy to GitHub Pages",
        "        id: deployment",
        "        uses: actions/deploy-pages@v4",
        "",
    ].join("\n");
}
// ── The workflows Narrarium wrote before (version 1), to recognize them untouched ─────────────────────────────────────────────────
/** `buildRootPagesWorkflow` of create-narrarium-book up to 0.1.60 (with GHOSTWRITER_BOOK_ROOT before the rename). */
function rootWorkflowV1(options, bookRootVariable) {
    const env = options.pagesDomain
        ? [`          ${bookRootVariable}: .`, "          SITE_BASE: /", `          SITE_URL: https://${options.pagesDomain}`]
        : [`          ${bookRootVariable}: .`, "          SITE_BASE: /${{ github.event.repository.name }}/"];
    const cacheLines = options.npmCache ? ["          cache: npm", `          cache-dependency-path: ${options.readerDir}/package-lock.json`] : [];
    return [
        "name: Deploy Reader To GitHub Pages",
        "",
        "on:",
        "  workflow_dispatch:",
        "  push:",
        "    branches:",
        "      - main",
        "      - master",
        "",
        "permissions:",
        "  contents: read",
        "  pages: write",
        "  id-token: write",
        "",
        "concurrency:",
        "  group: github-pages",
        "  cancel-in-progress: true",
        "",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Checkout",
        "        uses: actions/checkout@v4",
        "",
        "      - name: Setup Node",
        "        uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        ...cacheLines,
        "",
        "      - name: Install project dependencies",
        "        run: npm install",
        "",
        "      - name: Configure Pages",
        "        uses: actions/configure-pages@v5",
        "",
        "      - name: Build reader site",
        "        env:",
        ...env,
        "        run: npm run build",
        "",
        "      - name: Upload Pages artifact",
        "        uses: actions/upload-pages-artifact@v3",
        "        with:",
        `          path: ${options.readerDir}/dist`,
        "",
        "  deploy:",
        "    needs: build",
        "    runs-on: ubuntu-latest",
        "    environment:",
        "      name: github-pages",
        "      url: ${{ steps.deployment.outputs.page_url }}",
        "    steps:",
        "      - name: Deploy to GitHub Pages",
        "        id: deployment",
        "        uses: actions/deploy-pages@v4",
        "",
    ].join("\n");
}
function normalizeText(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
    while (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
    return `${lines.join("\n")}\n`;
}
const ACTIVE_LEGACY_LINE = /^\s+NARRARIUM_READER_PASSWORD:\s*["']?\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}["']?\s*$/;
const COMMENTED_LEGACY_LINE = /^\s*#\s*NARRARIUM_READER_PASSWORD:.*$/;
function readSettings(text, fallback) {
    const upload = /^\s+path:\s*(?:(\S+)\/)?dist\s*$/m.exec(text);
    const readerDir = upload ? normalizeReaderDir(upload[1] ?? ".") : fallback.readerDir;
    const domain = /^\s+SITE_URL:\s*https?:\/\/([A-Za-z0-9.-]+)\/?\s*$/m.exec(text)?.[1];
    const npmCache = /^\s+cache:\s*npm\s*$/m.test(text);
    const bookRootVariable = /^\s+GHOSTWRITER_BOOK_ROOT:/m.test(text) ? "GHOSTWRITER_BOOK_ROOT" : "NARRARIUM_BOOK_ROOT";
    const legacy = text.split("\n").map((line) => ACTIVE_LEGACY_LINE.exec(line)?.[1]).find(Boolean);
    return { readerDir, pagesDomain: domain, npmCache, legacyPasswordSecret: legacy, bookRootVariable };
}
function lineDifferences(actual, expected) {
    const count = (lines) => lines.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());
    const actualLines = actual.split("\n").filter((line) => line.trim());
    const expectedLines = expected.split("\n").filter((line) => line.trim());
    const expectedCount = count(expectedLines);
    const actualCount = count(actualLines);
    const added = actualLines.filter((line) => {
        const left = expectedCount.get(line) ?? 0;
        if (left > 0) {
            expectedCount.set(line, left - 1);
            return false;
        }
        return true;
    });
    const removed = expectedLines.filter((line) => {
        const left = actualCount.get(line) ?? 0;
        if (left > 0) {
            actualCount.set(line, left - 1);
            return false;
        }
        return true;
    });
    return [...added.map((line) => `+ ${line.trim()}`), ...removed.map((line) => `- ${line.trim()}`)];
}
/**
 * What to commit to bring a repository's Pages workflow to this version, from the text it has now (`null`: no file). Nothing is committed
 * here: the caller shows `changes` (and, for a customized file, `customizations`) and commits `text` as a commit of its own only when the
 * author asks. The single password of an older book (`NARRARIUM_READER_PASSWORD: ${{ secrets.X }}`) is kept as it is, so that the book
 * stays protected by it.
 */
export function planPagesWorkflowUpgrade(existing, options = {}) {
    const defaults = resolve(options);
    if (existing === null || existing === undefined || !existing.trim()) {
        const text = buildPagesWorkflow(defaults);
        return {
            status: "missing",
            safe: true,
            text,
            settings: { readerDir: defaults.readerDir, pagesDomain: defaults.pagesDomain, npmCache: defaults.npmCache },
            changes: ["Adds the workflow that publishes the reader on GitHub Pages, with or without reader passwords."],
            customizations: [],
            path: PAGES_WORKFLOW_PATH,
            fromVersion: null,
        };
    }
    const normalized = normalizeText(existing);
    const found = readSettings(normalized, defaults);
    const settings = { readerDir: found.readerDir, pagesDomain: found.pagesDomain, npmCache: found.npmCache, legacyPasswordSecret: found.legacyPasswordSecret };
    const text = buildPagesWorkflow(settings);
    if (normalized === text) {
        return { status: "current", safe: false, text, settings, changes: [], customizations: [], path: PAGES_WORKFLOW_PATH, fromVersion: 3 };
    }
    const withoutLegacy = normalizeText(normalized.split("\n").filter((line) => !ACTIVE_LEGACY_LINE.test(line) && !COMMENTED_LEGACY_LINE.test(line)).join("\n"));
    const v1Candidates = [rootWorkflowV1(found, found.bookRootVariable), rootWorkflowV1(found, found.bookRootVariable === "NARRARIUM_BOOK_ROOT" ? "GHOSTWRITER_BOOK_ROOT" : "NARRARIUM_BOOK_ROOT")];
    const v2Candidate = pagesWorkflowV2({ ...found, legacyPasswordSecret: undefined });
    const candidates = [...v1Candidates, v2Candidate];
    const legacyChange = found.legacyPasswordSecret ? [`The single password in the secret ${found.legacyPasswordSecret} stays one of the book's passwords.`] : [];
    const slotsChange = `The build step no longer receives every secret of the repository as JSON (toJSON(secrets)), which GitHub can take for a workflow that steals secrets and hold at «Action required» until someone approves it: it receives only the ${READER_PASSWORD_SLOT_COUNT} password slots, READER_PASSWORD_001 to READER_PASSWORD_${String(READER_PASSWORD_SLOT_COUNT).padStart(3, "0")}, and none of the other secrets.`;
    const passwordsChange = "The reader can be protected by several passwords: their names go in the repository variable READER_PASSWORD_SECRETS and the passwords in repository secrets with those names.";
    const checkChange = "A check stops the publication if passwords are listed and the reader did not encrypt the book.";
    const jsonOfSecrets = /toJSON\(\s*secrets\s*\)/.test(normalized);
    const matched = withoutLegacy === normalizeText(v2Candidate) ? 2 : candidates.some((candidate) => normalizeText(candidate) === withoutLegacy) ? 1 : null;
    const fromVersion = matched ?? (jsonOfSecrets ? 2 : null);
    const changes = matched === 2 || (matched === null && jsonOfSecrets)
        ? [slotsChange, "The passwords, their secrets and the variable READER_PASSWORD_SECRETS stay as they are: no secret is renamed.", ...legacyChange]
        : [passwordsChange, slotsChange, checkChange, ...legacyChange];
    if (candidates.some((candidate) => normalizeText(candidate) === withoutLegacy)) {
        return { status: "generated", safe: true, text, settings, changes, customizations: [], path: PAGES_WORKFLOW_PATH, fromVersion };
    }
    const closest = [...candidates, text]
        .map((candidate) => lineDifferences(withoutLegacy, normalizeText(candidate)))
        .sort((left, right) => left.length - right.length)[0];
    return {
        status: "customized",
        safe: false,
        text,
        settings,
        changes,
        customizations: closest,
        path: PAGES_WORKFLOW_PATH,
        fromVersion,
    };
}
//# sourceMappingURL=pages-workflow.js.map