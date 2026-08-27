import test from "node:test";
import assert from "node:assert/strict";
import { parsePublishedVersion } from "./workspace-publish.mjs";
import { assertSiteReleaseBump, parseReleaseTag, validateReleaseTarget } from "./release-policy.mjs";

test("published workspace versions support npm string and workspace-array output", () => {
  assert.equal(parsePublishedVersion('"0.1.57"\n'), "0.1.57");
  assert.equal(parsePublishedVersion('["0.1.57"]\n'), "0.1.57");
});

test("release tags identify one independently versioned workspace package", () => {
  assert.deepEqual(parseReleaseTag("vnarrarium@0.1.57"), { name: "narrarium", version: "0.1.57" });
  assert.deepEqual(parseReleaseTag("vcreate-narrarium-book@0.1.58"), { name: "create-narrarium-book", version: "0.1.58" });
  assert.equal(parseReleaseTag("v0.1.58"), null);
  assert.equal(parseReleaseTag("vnarrarium@not-a-version"), null);
});

test("release target validation checks dependency ranges and publication order", () => {
  const records = [
    { name: "narrarium", version: "0.1.57", dependencies: {} },
    { name: "narrarium-sdk", version: "0.1.56", dependencies: { narrarium: "^0.1.57" } },
    { name: "narrarium-astro-reader", version: "0.1.58", dependencies: { narrarium: "^0.1.57" } },
    { name: "narrarium-mcp-server", version: "0.1.57", dependencies: { narrarium: "^0.1.57" } },
    { name: "create-narrarium-book", version: "0.1.58", dependencies: { narrarium: "^0.1.57", "narrarium-astro-reader": "^0.1.58" } },
  ];

  assert.equal(validateReleaseTarget({ name: "create-narrarium-book", version: "0.1.58" }, records).name, "create-narrarium-book");
  assert.throws(
    () => validateReleaseTarget({ name: "narrarium-sdk", version: "0.1.56" }, records.map((record) => record.name === "narrarium" ? { ...record, version: "0.1.55" } : record)),
    /requires narrarium@\^0\.1\.57/,
  );
});

test("site application changes require a new site version and lockfile entry", () => {
  assert.throws(
    () => assertSiteReleaseBump({
      changedFiles: ["src/narrarium-site/src/App.tsx"],
      currentVersion: "0.76.94",
      baseVersion: "0.76.94",
      currentLockVersion: "0.76.94",
      baseLockVersion: "0.76.94",
      basePatchNoteVersions: ["0.76.94"],
    }),
    /require a version bump/,
  );
  assert.doesNotThrow(() => assertSiteReleaseBump({
    changedFiles: ["docs/reader-password.md", "src/narrarium-site/src/content/patch-notes.json"],
    currentVersion: "0.76.94",
    baseVersion: "0.76.94",
    currentLockVersion: "0.76.94",
    baseLockVersion: "0.76.94",
    basePatchNoteVersions: ["0.76.94"],
  }));
});
