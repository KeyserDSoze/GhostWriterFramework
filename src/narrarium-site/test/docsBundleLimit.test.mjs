import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/assert-production-bundle.mjs", import.meta.url);

/** Run the check of the production bundle on a made-up `dist`: its exit code and what it said. */
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

/** A `dist` with the five routes the check measures, and one document of `documentBytes` bytes loaded by the docs route. */
async function fakeDist(root, documentBytes) {
  const dist = path.join(root, "dist");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, ".vite"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), '<!doctype html><script type="module" crossorigin src="/assets/entry.js"></script>');
  const manifest = {
    "index.html": { file: "assets/entry.js", src: "index.html", isEntry: true },
    "src/pages/public/PublicBasics.tsx": { file: "assets/home.js", src: "src/pages/public/PublicBasics.tsx", isDynamicEntry: true, imports: ["index.html"] },
    "src/pages/public/PublicDocs.tsx": { file: "assets/docs.js", src: "src/pages/public/PublicDocs.tsx", isDynamicEntry: true, imports: ["index.html"], dynamicImports: ["../../packages/server/README.md?raw"] },
    "src/pages/public/McpPage.tsx": { file: "assets/mcp.js", src: "src/pages/public/McpPage.tsx", isDynamicEntry: true, imports: ["index.html"] },
    "src/components/auth/LoginScreen.tsx": { file: "assets/login.js", src: "src/components/auth/LoginScreen.tsx", isDynamicEntry: true, imports: ["index.html"] },
    "src/routes/AppShellRoute.tsx": { file: "assets/app-shell.js", src: "src/routes/AppShellRoute.tsx", isDynamicEntry: true, imports: ["index.html"] },
    "../../packages/server/README.md?raw": { file: "assets/README-server.js", name: "README", src: "../../packages/server/README.md?raw", isDynamicEntry: true },
  };
  await writeFile(path.join(dist, ".vite", "manifest.json"), JSON.stringify(manifest));
  for (const entry of Object.values(manifest)) await writeFile(path.join(dist, entry.file), `export default ${JSON.stringify(entry.file)};`);
  let text = "";
  for (let line = 0; text.length < documentBytes; line += 1) text += `Line ${line} of a long document: ${(line * 7919).toString(36)} ${(line * 104729).toString(36)}.\n`;
  await writeFile(path.join(dist, "assets", "README-server.js"), `export default ${JSON.stringify(text.slice(0, documentBytes))};`);
  const script = path.join(root, "scripts", "assert-production-bundle.mjs");
  await writeFile(script, await readFile(SCRIPT));
  return { dist, script };
}

const budgetOf = (source, name) => Number(new RegExp(`${name} = ([\\d_]+)`).exec(source)?.[1].replace(/_/g, ""));

test("the docs route has its limit back where it was before the texts of the documents forced it up", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const docs = /docs: \{ rawBytes: ([\d_]+), gzipBytes: ([\d_]+) \}/.exec(source);
  assert.ok(docs, "the docs route has a limit");
  const [raw, gzip] = [Number(docs[1].replace(/_/g, "")), Number(docs[2].replace(/_/g, ""))];
  assert.ok(raw <= 1_350_000 && gzip <= 420_000, `the docs route is held to ${raw}/${gzip} raw/gzip bytes, not the 1_450_000/480_000 that 0.93.0 had to allow`);
});

test("the largest document has a limit of its own, and the report names it", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const raw = budgetOf(source, "DOCUMENT_CHUNK_RAW_BUDGET");
  const gzip = budgetOf(source, "DOCUMENT_CHUNK_GZIP_BUDGET");
  assert.ok(raw > 0 && gzip > 0, "a raw and a gzip limit for one document");

  const small = await mkdtemp(path.join(tmpdir(), "narrarium-doc-limit-ok-"));
  try {
    const { dist, script } = await fakeDist(small, 2_000);
    const result = await run(script, small);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(await readFile(path.join(dist, "bundle-report.json"), "utf8"));
    assert.equal(report.current.documents.largest.file, "assets/README-server.js");
    assert.equal(report.current.documents.largest.source, "../../packages/server/README.md?raw");
    assert.equal(report.current.documents.count, 1);
    assert.deepEqual(report.budgets.document, { rawBytes: raw, gzipBytes: gzip });
  } finally {
    await rm(small, { recursive: true, force: true });
  }

  const large = await mkdtemp(path.join(tmpdir(), "narrarium-doc-limit-over-"));
  try {
    const { script } = await fakeDist(large, raw + 1_000);
    const result = await run(script, large);
    assert.notEqual(result.code, 0, "a document over the limit fails the build");
    assert.match(result.output, /Document chunk assets\/README-server\.js \(\.\.\/\.\.\/packages\/server\/README\.md\?raw\)/);
  } finally {
    await rm(large, { recursive: true, force: true });
  }
});

test("the /mcp page has a limit of its own, since it carries the list of the tools of a book's MCP, and a page that grows past it fails the build", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /mcp: "src\/pages\/public\/McpPage\.tsx"/, "its route is measured");
  const limit = /\bmcp: \{ rawBytes: ([\d_]+), gzipBytes: ([\d_]+) \}/.exec(source);
  assert.ok(limit, "it has a limit");
  const [raw, gzip] = [Number(limit[1].replace(/_/g, "")), Number(limit[2].replace(/_/g, ""))];
  assert.ok(raw > 0 && gzip > 0 && raw < 900_000 && gzip < 300_000, `a limit that holds the page, not the whole app (${raw}/${gzip})`);

  const small = await mkdtemp(path.join(tmpdir(), "narrarium-mcp-limit-ok-"));
  try {
    const { dist, script } = await fakeDist(small, 2_000);
    const result = await run(script, small);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(await readFile(path.join(dist, "bundle-report.json"), "utf8"));
    assert.deepEqual(report.current.routes.mcp.files, ["assets/entry.js", "assets/mcp.js"], "the graph of the page is measured and named");
    assert.deepEqual(report.budgets.routes.mcp, { rawBytes: raw, gzipBytes: gzip });
  } finally {
    await rm(small, { recursive: true, force: true });
  }

  const large = await mkdtemp(path.join(tmpdir(), "narrarium-mcp-limit-over-"));
  try {
    const { dist, script } = await fakeDist(large, 2_000);
    await writeFile(path.join(dist, "assets", "mcp.js"), `export default ${JSON.stringify("x".repeat(raw + 1_000))};`);
    const result = await run(script, large);
    assert.notEqual(result.code, 0, "a page over its limit fails the build");
    assert.match(result.output, /mcp route graph/);
  } finally {
    await rm(large, { recursive: true, force: true });
  }
});
