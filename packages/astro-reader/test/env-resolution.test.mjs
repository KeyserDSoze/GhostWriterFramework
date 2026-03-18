import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isClearlyInvalidBookRootValue, normalizeReaderEnvValue, readReaderBookRootEnv, readReaderEnv, resolveReaderBookRootCandidate } from "../cli-dist/lib/env.js";

test("reader env helpers trim and dequote values while preserving source precedence", () => {
  assert.equal(normalizeReaderEnvValue('  "C:/Books/My Story"  '), "C:/Books/My Story");
  assert.equal(normalizeReaderEnvValue("  '../book'  "), "../book");
  assert.equal(normalizeReaderEnvValue("   "), undefined);

  const value = readReaderEnv(
    ["NARRARIUM_BOOK_ROOT", "GHOSTWRITER_BOOK_ROOT"],
    [
      { NARRARIUM_BOOK_ROOT: "" },
      { GHOSTWRITER_BOOK_ROOT: '  "C:/Books/Fallback"  ' },
    ],
  );

  assert.equal(value, "C:/Books/Fallback");
});

test("reader book root env ignores empty and drive-root overrides", () => {
  assert.equal(isClearlyInvalidBookRootValue("C:"), true);
  assert.equal(isClearlyInvalidBookRootValue("C:/"), true);
  assert.equal(isClearlyInvalidBookRootValue("/"), true);
  assert.equal(isClearlyInvalidBookRootValue("../book"), false);

  assert.equal(readReaderBookRootEnv([{ NARRARIUM_BOOK_ROOT: "C:/" }]), undefined);
  assert.equal(readReaderBookRootEnv([{ NARRARIUM_BOOK_ROOT: "  '../book' " }]), "../book");
});

test("reader book root candidate resolves only when it points to a real book repo", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-root-check-"));
  const readerRoot = path.join(workspaceRoot, "reader");
  const bookRoot = path.join(workspaceRoot, "book");
  const emptyRoot = path.join(workspaceRoot, "empty");

  try {
    await mkdir(readerRoot, { recursive: true });
    await mkdir(bookRoot, { recursive: true });
    await mkdir(emptyRoot, { recursive: true });
    await writeFile(path.join(bookRoot, "book.md"), "---\ntitle: Test\n---\n", "utf8");

    assert.equal(resolveReaderBookRootCandidate("../book", readerRoot), path.resolve(bookRoot));
    assert.equal(resolveReaderBookRootCandidate("../empty", readerRoot), undefined);
    assert.equal(resolveReaderBookRootCandidate("../../../../../../..", readerRoot), undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
