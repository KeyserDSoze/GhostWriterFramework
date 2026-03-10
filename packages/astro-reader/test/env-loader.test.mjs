import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadReaderEnvFiles } from "../scripts/env-loader.mjs";

test("reader env loader honors shell variables before .env.local before .env", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-env-"));
  const originalBookRoot = process.env.NARRARIUM_BOOK_ROOT;
  const originalCanonMode = process.env.NARRARIUM_READER_CANON_MODE;
  const originalTheme = process.env.NARRARIUM_THEME_TEST;

  try {
    await writeFile(
      path.join(rootPath, ".env"),
      "NARRARIUM_BOOK_ROOT=from-env\nNARRARIUM_READER_CANON_MODE=public\n",
      "utf8",
    );
    await writeFile(
      path.join(rootPath, ".env.local"),
      "NARRARIUM_BOOK_ROOT=from-env-local\nNARRARIUM_THEME_TEST=local-only\n",
      "utf8",
    );

    process.env.NARRARIUM_BOOK_ROOT = "from-shell";
    delete process.env.NARRARIUM_READER_CANON_MODE;
    delete process.env.NARRARIUM_THEME_TEST;

    loadReaderEnvFiles(rootPath);

    assert.equal(process.env.NARRARIUM_BOOK_ROOT, "from-shell");
    assert.equal(process.env.NARRARIUM_READER_CANON_MODE, "public");
    assert.equal(process.env.NARRARIUM_THEME_TEST, "local-only");
  } finally {
    if (originalBookRoot === undefined) delete process.env.NARRARIUM_BOOK_ROOT;
    else process.env.NARRARIUM_BOOK_ROOT = originalBookRoot;

    if (originalCanonMode === undefined) delete process.env.NARRARIUM_READER_CANON_MODE;
    else process.env.NARRARIUM_READER_CANON_MODE = originalCanonMode;

    if (originalTheme === undefined) delete process.env.NARRARIUM_THEME_TEST;
    else process.env.NARRARIUM_THEME_TEST = originalTheme;

    await rm(rootPath, { recursive: true, force: true });
  }
});
