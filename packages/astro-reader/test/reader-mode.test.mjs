import assert from "node:assert/strict";
import test from "node:test";
import { isFullCanonMode, readerCanonModeFromCookieHeader, runWithReaderCanonMode } from "../cli-dist/lib/reader-mode.js";

test("reader canon cookie parsing fails closed and recognizes explicit modes", () => {
  assert.equal(readerCanonModeFromCookieHeader(""), undefined);
  assert.equal(readerCanonModeFromCookieHeader("other=value"), undefined);
  assert.equal(readerCanonModeFromCookieHeader("narrarium-canon=full"), "full");
  assert.equal(readerCanonModeFromCookieHeader("narrarium-canon=public"), "public");
  assert.equal(readerCanonModeFromCookieHeader("narrarium-canon=FULL; other=value"), "full");
});

test("request-scoped canon mode overrides environment without leaking between requests", async () => {
  const previousMode = process.env.NARRARIUM_READER_CANON_MODE;
  try {
    process.env.NARRARIUM_READER_CANON_MODE = "full";
    assert.equal(isFullCanonMode(), true);
    assert.equal(runWithReaderCanonMode("public", () => isFullCanonMode()), false);
    assert.equal(runWithReaderCanonMode("full", () => isFullCanonMode()), true);

    const [publicResult, fullResult] = await Promise.all([
      runWithReaderCanonMode("public", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return isFullCanonMode();
      }),
      runWithReaderCanonMode("full", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return isFullCanonMode();
      }),
    ]);
    assert.equal(await publicResult, false);
    assert.equal(await fullResult, true);
  } finally {
    if (previousMode === undefined) delete process.env.NARRARIUM_READER_CANON_MODE;
    else process.env.NARRARIUM_READER_CANON_MODE = previousMode;
  }
});
