import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const runtimePath = path.resolve("src/components/ReaderRuntime.astro");

test("reader overlays implement the keyboard-modal contract", async () => {
  const runtime = await readFile(runtimePath, "utf8");

  assert.match(runtime, /function openModalOverlay\(/);
  assert.match(runtime, /function closeModalOverlay\(/);
  assert.match(runtime, /previouslyFocused/);
  assert.match(runtime, /event\.key === "Tab"/);
  assert.match(runtime, /event\.shiftKey/);
  assert.match(runtime, /setAttribute\("inert"/);
  assert.match(runtime, /removeAttribute\("inert"/);
  assert.match(runtime, /data-canon-close/);
  assert.match(runtime, /data-reader-close/);
  assert.match(runtime, /data-search-input/);
});

test("reader canon mode writes the server-recognized cookie before reload", async () => {
  const runtime = await readFile(runtimePath, "utf8");

  assert.match(runtime, /narrarium-canon=full/);
  assert.match(runtime, /narrarium-canon=public/);
  assert.doesNotMatch(runtime, /narrarium-reader-canon/);
  assert.match(runtime, /window\.location\.reload\(\)/);
});
