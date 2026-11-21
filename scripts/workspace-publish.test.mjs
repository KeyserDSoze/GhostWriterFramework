import test from "node:test";
import assert from "node:assert/strict";
import { firstPublishWarning, packages, parsePublishedVersion, splitPublishPlan } from "./workspace-publish.mjs";
import { assertSiteReleaseBump, parseReleaseTag, publishOrder, validateReleaseTarget } from "./release-policy.mjs";

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

test("the shared engine is published after the core", () => {
  assert.deepEqual(packages.map((entry) => entry.name), publishOrder);
  assert.ok(publishOrder.indexOf("narrarium") < publishOrder.indexOf("narrarium-engine"));
  const records = [
    { name: "narrarium", version: "0.1.58", dependencies: {} },
    { name: "narrarium-engine", version: "0.1.0", dependencies: { narrarium: "^0.1.58" } },
  ];
  assert.equal(validateReleaseTarget({ name: "narrarium-engine", version: "0.1.0" }, records).name, "narrarium-engine");
  assert.throws(
    () => validateReleaseTarget({ name: "narrarium-engine", version: "0.1.0" }, records.map((record) => record.name === "narrarium" ? { ...record, version: "0.1.57" } : record)),
    /requires narrarium@\^0\.1\.58/,
  );
});

test("packages never published are left to a first manual publish instead of failing every run", () => {
  const plan = [
    { name: "narrarium", version: "0.1.58", exists: true, published: true },
    { name: "narrarium-engine", version: "0.1.0", exists: false, published: false },
    { name: "narrarium-sdk", version: "0.1.57", exists: true, published: false },
  ];
  const { publish, firstPublish } = splitPublishPlan(plan);
  assert.deepEqual(publish.map((pkg) => pkg.name), ["narrarium-sdk"]);
  assert.deepEqual(firstPublish.map((pkg) => pkg.name), ["narrarium-engine"]);
  assert.match(firstPublishWarning(firstPublish[0]), /^::warning title=narrarium-engine is not on npm yet::Publish narrarium-engine@0\.1\.0 once by hand/);
});

test("the personal server is released only by its own Trusted Publishing workflow", () => {
  assert.equal(publishOrder.includes("narrarium-server"), false, "never published with the shared npm token");
  assert.equal(packages.some((entry) => entry.name === "narrarium-server"), false);
  assert.equal(parseReleaseTag("vnarrarium-server@0.1.0"), null, "server releases use narrarium-server-v<version> tags");
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
