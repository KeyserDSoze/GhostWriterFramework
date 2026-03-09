import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);

test("published starter build resolves the packaged reader CLI", async () => {
  const distSource = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  const readerPackageJson = JSON.parse(await readFile(new URL("../../astro-reader/package.json", import.meta.url), "utf8"));

  assert.match(distSource, /narrarium-astro-reader\/scaffold/);
  assert.match(distSource, /\.\.\/narrarium-astro-reader\/cli-dist\/cli\.js/);
  assert.equal(readerPackageJson.exports["./scaffold"].require, "./cli-dist/scaffold.js");
  assert.equal(readerPackageJson.exports["./scaffold"].default, "./cli-dist/scaffold.js");
  assert.equal(path.basename(new URL("../dist/index.js", packageRoot).pathname), "index.js");
});
