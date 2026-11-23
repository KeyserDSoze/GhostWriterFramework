import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BOOK_TEMPLATE_COMMAND, BOOK_TEMPLATE_PATH, PACKAGE_NAME_PLACEHOLDER, READER_PACKAGE_NAME_PLACEHOLDER, generateBookTemplate, scaffolderIsBuilt } from "../scripts/generate-book-template.mjs";

/**
 * The template of a complete book repository (`src/narrarium/bookTemplate.generated.json`) is what the real scaffolder writes, not a copy kept by hand: this runs
 * the scaffolder (`create-narrarium-book`, no install, no network) and fails, with the command that fixes it, when the committed bundle is not what it writes
 * now. It needs the scaffolder built (`npm run build:cli -w narrarium-astro-reader && npm run build -w create-narrarium-book`; the CI builds it).
 */

const bundleText = await readFile(BOOK_TEMPLATE_PATH, "utf8");
const bundle = JSON.parse(bundleText);
const paths = Object.keys(bundle.files);

test("the committed template is what the scaffolder writes now", async () => {
  assert.ok(scaffolderIsBuilt(), "the scaffolder is not built: npm run build:cli -w narrarium-astro-reader && npm run build -w create-narrarium-book");
  const fresh = await generateBookTemplate();
  if (fresh !== bundleText) {
    const before = bundle.files;
    const after = JSON.parse(fresh).files;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => JSON.stringify(before[file]) !== JSON.stringify(after[file])).sort();
    assert.fail(`the template is out of date (${changed.length} files differ: ${changed.slice(0, 6).join(", ")}). Regenerate it and commit it: ${BOOK_TEMPLATE_COMMAND}`);
  }
});

test("the template has the whole of a framework book: the reader, the workflow, the agents' instructions, the scripts", () => {
  assert.ok(paths.length >= 110, `${paths.length} files`);
  for (const required of [
    ".github/workflows/deploy-reader-pages.yml",
    ".github/copilot-instructions.md",
    ".opencode/commands/resume-book.md",
    ".claude/skills/narrarium-book/SKILL.md",
    ".vscode/mcp.json",
    "scripts/sync-script-ledger.mjs",
    "opencode.jsonc",
    "manuscript.yaml",
    "package.json",
    "reader/package.json",
    "reader/astro.config.mjs",
    "reader/src/pages/index.astro",
  ]) assert.ok(paths.includes(required), `${required} is in the template`);
});

test("it is sorted, plain text, with no date and no lock file or installed package", () => {
  assert.deepEqual(paths, [...paths].sort());
  for (const [file, content] of Object.entries(bundle.files)) {
    assert.deepEqual(Object.keys(content), ["text"], `${file} is text`);
    assert.doesNotMatch(file, /node_modules\//);
    assert.doesNotMatch(file, /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/);
  }
  assert.doesNotMatch(bundleText, /"(generatedAt|createdAt|timestamp)"/);
});

test("it has no path of the machine that made it and no secret", () => {
  for (const [file, content] of Object.entries(bundle.files)) {
    assert.doesNotMatch(content.text, /\/root\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\|narrarium-book-template-|wt-[a-z]+/, `${file} names a path of this machine`);
    assert.doesNotMatch(content.text, /(ghp_|github_pat_|gh[ousr]_)[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}/, `${file} looks like it carries a secret`);
  }
  const env = bundle.files["reader/.env"].text;
  assert.doesNotMatch(env, /PASSWORD=(?!your-secret-password)\S/, "the reader password is not set");
});

test("the reader depends on the published narrarium of this release, never on a path", async () => {
  const reader = JSON.parse(bundle.files["reader/package.json"].text);
  const core = JSON.parse(await readFile(new URL("../../../packages/core/package.json", import.meta.url), "utf8"));
  assert.equal(reader.dependencies.narrarium, `^${core.version}`);
  assert.doesNotMatch(bundle.files["reader/package.json"].text, /file:|link:|\.\.\//);
  assert.equal(reader.name, READER_PACKAGE_NAME_PLACEHOLDER);
  assert.equal(JSON.parse(bundle.files["package.json"].text).name, PACKAGE_NAME_PLACEHOLDER);
  assert.deepEqual(bundle.placeholders, { package: PACKAGE_NAME_PLACEHOLDER, readerPackage: READER_PACKAGE_NAME_PLACEHOLDER });
});

test("the Pages workflow does not ask for a lock file the repository cannot have (setup-node fails the job when it is missing)", () => {
  const workflow = bundle.files[".github/workflows/deploy-reader-pages.yml"].text;
  assert.doesNotMatch(workflow, /cache:|cache-dependency-path/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /pages: write/);
  assert.doesNotMatch(workflow, /secrets\./, "the workflow needs no secret");
});
