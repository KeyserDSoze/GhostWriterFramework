import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/assert-production-bundle.mjs", import.meta.url);

function run(script, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NARRARIUM_E2E_BUILD;
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

/**
 * A `dist` whose entry imports the home (a route of a first visit, which needs a shared chunk too) and a page of the app, the way Vite writes it: the
 * names of the files once at the top, and the list of what an imported chunk needs where it is imported. When `pageNeedsMore` the page imports the
 * shared chunk as well, so its import in the entry carries a list; `entryText` replaces what Vite would have written.
 * @param {string} root
 * @param {{ pageNeedsMore?: boolean, entryText?: string }} [options]
 */
async function fakeDist(root, options = {}) {
  const { pageNeedsMore = false, entryText } = options;
  const dist = path.join(root, "dist");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, ".vite"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), '<!doctype html><script type="module" crossorigin src="/assets/entry.js"></script>');
  const manifest = {
    "index.html": { file: "assets/entry.js", src: "index.html", isEntry: true, dynamicImports: ["src/pages/public/PublicBasics.tsx", "src/pages/CostsPage.tsx", "src/pages/CostsPage.tsx"] },
    "src/pages/public/PublicBasics.tsx": { file: "assets/PublicBasics-a1.js", name: "PublicBasics", src: "src/pages/public/PublicBasics.tsx", isDynamicEntry: true, imports: ["index.html", "_shared-b2.js"] },
    "_shared-b2.js": { file: "assets/shared-b2.js", name: "shared" },
    "src/pages/CostsPage.tsx": { file: "assets/CostsPage-c3.js", name: "CostsPage", src: "src/pages/CostsPage.tsx", isDynamicEntry: true, imports: pageNeedsMore ? ["index.html", "_shared-b2.js"] : ["index.html"] },
    "src/pages/public/PublicDocs.tsx": { file: "assets/PublicDocs-d4.js", name: "PublicDocs", src: "src/pages/public/PublicDocs.tsx", isDynamicEntry: true, imports: ["index.html"] },
    "src/pages/public/McpPage.tsx": { file: "assets/McpPage-e5.js", name: "McpPage", src: "src/pages/public/McpPage.tsx", isDynamicEntry: true, imports: ["index.html"] },
    "src/components/auth/LoginScreen.tsx": { file: "assets/LoginScreen-f6.js", name: "LoginScreen", src: "src/components/auth/LoginScreen.tsx", isDynamicEntry: true, imports: ["index.html"] },
    "src/routes/AppShellRoute.tsx": { file: "assets/AppShellRoute-g7.js", name: "AppShellRoute", src: "src/routes/AppShellRoute.tsx", isDynamicEntry: true, imports: ["index.html"] },
  };
  await writeFile(path.join(dist, ".vite", "manifest.json"), JSON.stringify(manifest));
  for (const entry of Object.values(manifest)) await writeFile(path.join(dist, entry.file), `export default ${JSON.stringify(entry.file)};`);
  const text = entryText ?? [
    `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/PublicBasics-a1.js","assets/shared-b2.js"${pageNeedsMore ? ',"assets/CostsPage-c3.js"' : ""}])))=>i.map(i=>d[i]);`,
    "const p=(f,d)=>f();",
    'export const home=()=>p(()=>import("./PublicBasics-a1.js"),__vite__mapDeps([0,1]));',
    `export const costs=()=>p(()=>import("./CostsPage-c3.js"),${pageNeedsMore ? "__vite__mapDeps([2,1])" : "[]"});`,
  ].join("\n");
  await writeFile(path.join(dist, "assets", "entry.js"), text);
  const script = path.join(root, "scripts", "assert-production-bundle.mjs");
  await writeFile(script, await readFile(SCRIPT));
  return { dist, script };
}

async function inTemporaryRoot(prefix, body) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the entry carries the lists of files of the routes of a first visit only, and the report says what they weigh", async () => {
  await inTemporaryRoot("narrarium-entry-preload-ok-", async (root) => {
    const { dist, script } = await fakeDist(root);
    const result = await run(script, root);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(await readFile(path.join(dist, "bundle-report.json"), "utf8"));
    assert.deepEqual(report.current.entryPreload.routes, ["src/pages/public/PublicBasics.tsx"]);
    assert.equal(report.current.entryPreload.files, 2);
    assert.equal(report.current.entryPreload.listBytes, "__vite__mapDeps([0,1])".length);
    assert.equal(report.current.entryPreload.rawBytes, report.current.entryPreload.mapBytes + report.current.entryPreload.listBytes);
    assert.ok(report.budgets.entryPreload.rawBytes > 0);
    assert.match(result.output, /preload map of the entry \d+\/\d+ raw bytes \(2 files, the lists of 1 imports\)/);
  });
});

test("a page of the app whose list of files is in the entry stops the build, and says where the page belongs", async () => {
  await inTemporaryRoot("narrarium-entry-preload-page-", async (root) => {
    const { script } = await fakeDist(root, { pageNeedsMore: true });
    const result = await run(script, root);
    assert.notEqual(result.code, 0, "the build stops");
    assert.match(result.output, /preload list of src\/pages\/CostsPage\.tsx:/, "named once, though the router imported it twice");
    assert.match(result.output, /src\/routes\/appPages\.ts/);
  });
});

test("an entry whose preload map the check cannot read stops the build rather than passing unmeasured", async () => {
  await inTemporaryRoot("narrarium-entry-preload-format-", async (root) => {
    const { script } = await fakeDist(root, { entryText: 'export const home=()=>import("./PublicBasics-a1.js");' });
    const result = await run(script, root);
    assert.notEqual(result.code, 0, "the build stops");
    assert.match(result.output, /Vite writes it differently now/);
  });
});
