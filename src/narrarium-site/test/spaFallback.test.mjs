import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

function run(script, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Fallback generator exited with ${code}.`)));
  });
}

test("SPA fallback emits physical 200 entry points for update and patch-note routes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-spa-fallback-"));
  try {
    const scripts = path.join(root, "scripts");
    const dist = path.join(root, "dist");
    await mkdir(scripts);
    await mkdir(dist);
    const source = new URL("../scripts/write-spa-fallback.mjs", import.meta.url);
    const script = path.join(scripts, "write-spa-fallback.mjs");
    await writeFile(script, await readFile(source));
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Narrarium</title>");

    await run(script, root);

    for (const file of ["404.html", "app/index.html", "app/patch-notes/index.html", "login/index.html"]) {
      assert.equal(await readFile(path.join(dist, file), "utf8"), "<!doctype html><title>Narrarium</title>");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
