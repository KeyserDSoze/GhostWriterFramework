import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("auth continuity and recovery keys exist in both locales", async () => {
  const [en, it] = await Promise.all([
    readFile(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n/locales/it.ts", import.meta.url), "utf8"),
  ]);
  for (const key of ["continuityHeading", "continuityDescription", "accountMismatch", "recoveryHeading", "recoveryFailed"]) {
    assert.match(en, new RegExp(`${key}:`));
    assert.match(it, new RegExp(`${key}:`));
  }
});
