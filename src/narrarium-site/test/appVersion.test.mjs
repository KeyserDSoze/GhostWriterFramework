import assert from "node:assert/strict";
import test from "node:test";
import { isNewerAppVersion } from "../src/lib/appVersion.ts";

test("recognizes newer patch, minor, and major app versions", () => {
  assert.equal(isNewerAppVersion("0.75.10", "0.75.9"), true);
  assert.equal(isNewerAppVersion("0.76.0", "0.75.9"), true);
  assert.equal(isNewerAppVersion("1.0.0", "0.75.9"), true);
});

test("ignores equal, stale, and malformed version manifests", () => {
  assert.equal(isNewerAppVersion("0.75.9", "0.75.9"), false);
  assert.equal(isNewerAppVersion("0.75.8", "0.75.9"), false);
  assert.equal(isNewerAppVersion("latest", "0.75.9"), false);
});
