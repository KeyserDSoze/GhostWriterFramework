import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function run(script, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`generate-precache exited with ${code}`))));
  });
}

test("the service worker precaches the text of every document, as it did when the texts were in the docs chunk, and no other lazy chunk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-docs-precache-"));
  try {
    const dist = path.join(root, "dist");
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await mkdir(path.join(dist, ".vite"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(path.join(dist, "index.html"), "index");
    const files = {
      "src/main.tsx": { file: "assets/entry.js", src: "src/main.tsx", isEntry: true },
      "src/pages/public/PublicBasics.tsx": { file: "assets/home.js", src: "src/pages/public/PublicBasics.tsx", isDynamicEntry: true },
      "src/pages/public/PublicDocs.tsx": { file: "assets/docs.js", src: "src/pages/public/PublicDocs.tsx", isDynamicEntry: true, dynamicImports: ["../../packages/server/README.md?raw", "src/content/guides/autopilot.it.md?raw"] },
      "src/pages/public/McpPage.tsx": { file: "assets/mcp.js", src: "src/pages/public/McpPage.tsx", isDynamicEntry: true },
      "src/routes/AuthProvidersRoute.tsx": { file: "assets/auth.js", src: "src/routes/AuthProvidersRoute.tsx", isDynamicEntry: true },
      "src/routes/AppShellRoute.tsx": { file: "assets/app-shell.js", src: "src/routes/AppShellRoute.tsx", isDynamicEntry: true },
      "src/pages/BooksPage.tsx": { file: "assets/books.js", src: "src/pages/BooksPage.tsx", isDynamicEntry: true },
      "src/routes/appPages.ts": { file: "assets/app-pages.js", src: "src/routes/appPages.ts", isDynamicEntry: true },
      // A document written in the repository, and a guide of the app: one chunk each.
      "../../packages/server/README.md?raw": { file: "assets/README-server.js", name: "README", src: "../../packages/server/README.md?raw", isDynamicEntry: true },
      "src/content/guides/autopilot.it.md?raw": { file: "assets/autopilot.it.js", name: "autopilot.it", src: "src/content/guides/autopilot.it.md?raw", isDynamicEntry: true },
      // Another lazy chunk, loaded by a feature: it stays out of the install.
      "../../node_modules/docx/dist/index.mjs": { file: "assets/docx-index.js", name: "index", src: "../../node_modules/docx/dist/index.mjs", isDynamicEntry: true },
    };
    await writeFile(path.join(dist, ".vite", "manifest.json"), JSON.stringify(files));
    for (const entry of Object.values(files)) await writeFile(path.join(dist, entry.file), entry.file);
    const script = path.join(root, "scripts", "generate-precache.mjs");
    await writeFile(script, await readFile(new URL("../scripts/generate-precache.mjs", import.meta.url)));

    await run(script, root);

    const manifest = await readFile(path.join(dist, "precache-manifest.js"), "utf8");
    const precache = JSON.parse(/__NARRARIUM_PRECACHE__=(\[[^;]+\])/.exec(manifest)?.[1] ?? "[]");
    assert.ok(precache.includes("assets/docs.js"), "the docs route is precached");
    assert.ok(precache.includes("assets/README-server.js"), "the text of a repository document is precached with it");
    assert.ok(precache.includes("assets/autopilot.it.js"), "the text of a guide of the app is precached with it");
    assert.ok(!precache.includes("assets/docx-index.js"), "a lazy chunk that is not a document is not");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
