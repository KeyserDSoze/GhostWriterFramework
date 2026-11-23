// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import template from "@/narrarium/bookTemplate.generated.json";
import { buildInitialBookFiles } from "@/narrarium/bookScaffold";
import { composeCompleteBookFiles, isSiteOwnedPath, packageNameForTitle, templateFilesMissingFrom, type BookTemplate } from "@/narrarium/bookTemplate";
import { isWorkflowPath, PAGES_WORKFLOW_PATH } from "@/github/bookRepository";

// GOLDEN PARITY: what the site writes into a new GitHub repository is what the real scaffolder (`create-narrarium-book`) writes for the same title and
// language, file by file, except for the three changes of the template (see `scripts/generate-book-template.mjs`) and the files the site owns.
// The scaffolder is run here, into a temporary folder: if it changed, this fails and says how to regenerate the template.

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPOSITORY_ROOT, "packages/create-narrarium-book/dist/index.js");
const bundle = template as unknown as BookTemplate;
const temp = mkdtempSync(path.join(tmpdir(), "narrarium-parity-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function walk(directory: string, base = directory, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** The files the CLI writes, then the three changes the template makes, written here once more and independently. */
function cliFiles(name: string, title: string, language: string, author?: string): Map<string, string> {
  execFileSync(process.execPath, [CLI, name, "--title", title, "--language", language, ...(author ? ["--author", author] : []), "--no-install"], { cwd: temp, stdio: "pipe", env: { ...process.env, NODE_OPTIONS: "" } });
  const root = path.join(temp, name);
  const files = new Map(walk(root).map((file) => [file, readFileSync(path.join(root, file), "utf8")]));
  const core = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "packages/core/package.json"), "utf8")) as { version: string };
  const reader = files.get("reader/package.json")!;
  files.set("reader/package.json", reader.replace(/"narrarium": "file:[^"]*"/, `"narrarium": "^${core.version}"`));
  const workflow = files.get(PAGES_WORKFLOW_PATH)!;
  files.set(PAGES_WORKFLOW_PATH, workflow.replace("          cache: npm\n          cache-dependency-path: reader/package-lock.json\n", ""));
  return files;
}

const cases = [
  { title: "The Glass Harbor", language: "en", author: "Ada Byron" },
  { title: "Il Giardino dell'Èra", language: "it", author: undefined },
  { title: "Le Jardin d'Été", language: "fr", author: undefined },
  { title: "日本の庭", language: "en", author: undefined },
];

describe("the files of a new repository equal what the scaffolder writes", () => {
  it.each(cases)("for «$title» in $language", ({ title, language, author }) => {
    const expected = cliFiles(`book-${cases.findIndex((entry) => entry.title === title)}`, title, language, author);
    const composed = new Map(composeCompleteBookFiles(bundle, { title, language, author }).map((file) => [file.path, "content" in file ? file.content : ""]));
    const site = new Map(buildInitialBookFiles({ title, language, author }).map((file) => [file.path, file.content]));

    // Every file the scaffolder writes that the site does not own is the same, byte for byte.
    const differing = [...expected].filter(([file, content]) => !isSiteOwnedPath(file) && composed.get(file) !== content).map(([file]) => file);
    expect(differing).toEqual([]);
    // The files the site owns are the site's, and are the only ones that are not the scaffolder's.
    for (const [file, content] of composed) {
      if (isSiteOwnedPath(file)) expect(content, file).toBe(site.get(file));
      else expect(expected.has(file) || site.has(file), `${file} is in neither`).toBe(true);
    }
    // Nothing the scaffolder writes is lost but what the site replaces with its own.
    const lost = [...expected.keys()].filter((file) => !composed.has(file));
    expect(lost.every(isSiteOwnedPath)).toBe(true);
    // The site's files that are not the scaffolder's own are a short list that is known: its extras, and nothing else.
    const extras = [...composed.keys()].filter((file) => !expected.has(file) && !isSiteOwnedPath(file));
    expect(extras).toEqual([]);
    expect(composed.get("package.json")).toContain(`"name": "${packageNameForTitle(title)}"`);
    expect(composed.get("reader/package.json")).toContain(`"name": "${packageNameForTitle(title)}-reader"`);
    expect(composed.get(PAGES_WORKFLOW_PATH)).not.toMatch(/cache/);
  });

  it("owns only the files the scaffolder writes for the title and the language, and the personas and the ghostwriter of the app", () => {
    const expected = cliFiles("book-owned", "Owned", "en");
    const owned = [...expected.keys()].filter(isSiteOwnedPath);
    expect(owned).toEqual(["book.md", "ghostwriters/default.md", "personas/casual-reader.md", "personas/empathetic-reader.md", "personas/genre-fan.md", "personas/impatient-skimmer.md", "personas/literary-critic.md"]);
    const siteOnly = buildInitialBookFiles({ title: "Owned", language: "en" }).map((file) => file.path).filter((file) => !expected.has(file));
    expect(siteOnly.filter((file) => !isSiteOwnedPath(file))).toEqual([]);
  });

  it("carries every file of the template into the repository unless the site owns its path", () => {
    const composed = new Set(composeCompleteBookFiles(bundle, { title: "Any", language: "en" }).map((file) => file.path));
    for (const file of Object.keys(bundle.files)) expect(composed.has(file) || isSiteOwnedPath(file), file).toBe(true);
    expect(composed.size).toBeGreaterThan(130);
    expect([...composed].filter(isWorkflowPath).sort()).toEqual([PAGES_WORKFLOW_PATH, "reader/.github/workflows/deploy-pages.yml"].sort());
  });

  it("puts the outline of the chosen size over everything else, and sorts by path", () => {
    const files = composeCompleteBookFiles(bundle, { title: "Any", language: "en", files: [{ path: "outline/_brief.md", content: "brief" }, { path: "plot.md", content: "mine" }] });
    expect(files.find((file) => file.path === "outline/_brief.md")).toMatchObject({ content: "brief" });
    expect(files.find((file) => file.path === "plot.md")).toMatchObject({ content: "mine" });
    const paths = files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("adds to the files a book already has only the ones it lacks, never replacing one", () => {
    const missing = templateFilesMissingFrom(bundle, ["book.md", "context.md", "personas/mine.md"], "Any");
    expect(missing.map((file) => file.path)).not.toContain("context.md");
    expect(missing.map((file) => file.path)).toContain("reader/package.json");
    expect(missing.map((file) => file.path)).toContain(PAGES_WORKFLOW_PATH);
    expect(missing.some((file) => isSiteOwnedPath(file.path))).toBe(false);
  });
});
