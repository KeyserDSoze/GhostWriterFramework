import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/generate-precache.mjs", import.meta.url);

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

test("the loaders of the pages of the app are kept with the shell of the app, which asks for them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-app-pages-precache-"));
  try {
    const dist = path.join(root, "dist");
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await mkdir(path.join(dist, ".vite"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(path.join(dist, "index.html"), "index");
    const manifest = {
      "index.html": { file: "assets/entry.js", src: "index.html", isEntry: true, imports: ["framework"] },
      framework: { file: "assets/framework.js" },
      "src/pages/public/PublicBasics.tsx": { file: "assets/home.js", src: "src/pages/public/PublicBasics.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/pages/public/PublicDocs.tsx": { file: "assets/docs.js", src: "src/pages/public/PublicDocs.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/pages/public/McpPage.tsx": { file: "assets/mcp.js", src: "src/pages/public/McpPage.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/routes/AuthProvidersRoute.tsx": { file: "assets/auth.js", name: "AuthProvidersRoute", src: "src/routes/AuthProvidersRoute.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/routes/AppShellRoute.tsx": { file: "assets/app-shell.js", name: "AppShellRoute", src: "src/routes/AppShellRoute.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/pages/BooksPage.tsx": { file: "assets/books.js", name: "BooksPage", src: "src/pages/BooksPage.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/routes/appPages.ts": { file: "assets/appPages-x1.js", name: "appPages", src: "src/routes/appPages.ts", isDynamicEntry: true, imports: ["index.html"], dynamicImports: ["src/pages/CostsPage.tsx"] },
      "src/pages/CostsPage.tsx": { file: "assets/CostsPage-y2.js", name: "CostsPage", src: "src/pages/CostsPage.tsx", isDynamicEntry: true, imports: ["framework"] },
    };
    await writeFile(path.join(dist, ".vite", "manifest.json"), JSON.stringify(manifest));
    for (const entry of Object.values(manifest)) await writeFile(path.join(dist, entry.file), entry.file);
    const script = path.join(root, "scripts", "generate-precache.mjs");
    await writeFile(script, await readFile(SCRIPT));
    const result = await run(script, root);
    assert.equal(result.code, 0, result.output);
    const source = await readFile(path.join(dist, "precache-manifest.js"), "utf8");
    const list = (name) => JSON.parse(new RegExp(`${name}=(\\[[^;]*\\])`).exec(source)?.[1] ?? "[]");
    assert.ok(list("__NARRARIUM_APP_SHELL_ASSETS__").includes("assets/appPages-x1.js"), "kept with the shell");
    assert.ok(!list("__NARRARIUM_PRECACHE__").includes("assets/appPages-x1.js"), "not with the public pages");
    // The pages themselves stay optional: each is kept when it is first opened.
    assert.ok(list("__NARRARIUM_OPTIONAL_ASSETS__").includes("assets/CostsPage-y2.js"));
    assert.ok(!list("__NARRARIUM_APP_SHELL_ASSETS__").includes("assets/CostsPage-y2.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
