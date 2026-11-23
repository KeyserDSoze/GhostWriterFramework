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

test("the service worker precaches the page of the MCP with what it imports, as it did when the page was in the docs chunk, and not the chunks that nothing of the public pages needs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-mcp-precache-"));
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
      "src/pages/public/PublicDocs.tsx": { file: "assets/docs.js", src: "src/pages/public/PublicDocs.tsx", isDynamicEntry: true, imports: ["src/lib/generated-docs.ts"] },
      // The page of the MCP: its own chunk, which holds the tools of a book's MCP and its texts, and shares the index of the documents and the hero with the docs.
      "src/pages/public/McpPage.tsx": { file: "assets/mcp.js", src: "src/pages/public/McpPage.tsx", isDynamicEntry: true, imports: ["src/lib/generated-docs.ts", "src/components/public/PageHero.tsx"] },
      "src/lib/generated-docs.ts": { file: "assets/generated-docs.js", src: "src/lib/generated-docs.ts" },
      "src/components/public/PageHero.tsx": { file: "assets/page-hero.js", src: "src/components/public/PageHero.tsx" },
      "src/routes/AuthProvidersRoute.tsx": { file: "assets/auth.js", src: "src/routes/AuthProvidersRoute.tsx", isDynamicEntry: true },
      "src/routes/AppShellRoute.tsx": { file: "assets/app-shell.js", src: "src/routes/AppShellRoute.tsx", isDynamicEntry: true },
      "src/pages/BooksPage.tsx": { file: "assets/books.js", src: "src/pages/BooksPage.tsx", isDynamicEntry: true },
      "../../node_modules/docx/dist/index.mjs": { file: "assets/docx-index.js", name: "index", src: "../../node_modules/docx/dist/index.mjs", isDynamicEntry: true },
    };
    await writeFile(path.join(dist, ".vite", "manifest.json"), JSON.stringify(files));
    for (const entry of Object.values(files)) await writeFile(path.join(dist, entry.file), entry.file);
    const script = path.join(root, "scripts", "generate-precache.mjs");
    await writeFile(script, await readFile(new URL("../scripts/generate-precache.mjs", import.meta.url)));

    await run(script, root);

    const manifest = await readFile(path.join(dist, "precache-manifest.js"), "utf8");
    const precache = JSON.parse(/__NARRARIUM_PRECACHE__=(\[[^;]+\])/.exec(manifest)?.[1] ?? "[]");
    assert.ok(precache.includes("assets/mcp.js"), "the page of the MCP is precached with the public pages");
    assert.ok(precache.includes("assets/page-hero.js"), "and what only it and the docs share");
    assert.ok(precache.includes("assets/docs.js") && precache.includes("assets/home.js"), "next to the other public pages");
    assert.ok(!precache.includes("assets/docx-index.js"), "a lazy chunk of a feature is not");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
