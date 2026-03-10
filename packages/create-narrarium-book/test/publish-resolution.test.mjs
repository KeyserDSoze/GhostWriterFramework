import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../", import.meta.url);

test("published starter build resolves the packaged reader CLI", async () => {
  const distSource = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  const readerPackageJson = JSON.parse(await readFile(new URL("../../astro-reader/package.json", import.meta.url), "utf8"));

  assert.match(distSource, /narrarium-astro-reader\/scaffold/);
  assert.match(distSource, /\.\.\/narrarium-astro-reader\/cli-dist\/cli\.js/);
  assert.match(distSource, /cmd\.exe/);
  assert.match(distSource, /--no-install/);
  assert.equal(readerPackageJson.exports["./scaffold"].require, "./cli-dist/scaffold.js");
  assert.equal(readerPackageJson.exports["./scaffold"].default, "./cli-dist/scaffold.js");
  assert.equal(path.basename(new URL("../dist/index.js", packageRoot).pathname), "index.js");
});

test("starter upgrade mode refreshes managed repo files", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "create-narrarium-upgrade-"));
  const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  try {
    let result = spawnSync(process.execPath, [cliPath, rootPath, "--title", "Upgrade Test", "--language", "en", "--no-reader"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    await writeFile(path.join(rootPath, "opencode.jsonc"), '{"legacy":true}\n', "utf8");

    result = spawnSync(process.execPath, [cliPath, "--upgrade", rootPath, "--no-reader"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const opencodeConfig = await readFile(path.join(rootPath, "opencode.jsonc"), "utf8");
    assert.match(opencodeConfig, /"default_agent": "build"/);
    assert.match(result.stdout, /Narrarium book upgraded at/);
    assert.match(result.stdout, /Backed up replaced files under/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
