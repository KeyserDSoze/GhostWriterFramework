import assert from "node:assert/strict";
import test from "node:test";
import { isClearlyInvalidBookRootValue, normalizeReaderEnvValue, readReaderBookRootEnv, readReaderEnv } from "../cli-dist/lib/env.js";

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
