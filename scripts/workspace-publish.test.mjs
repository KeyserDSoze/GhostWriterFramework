import test from "node:test";
import assert from "node:assert/strict";
import { parsePublishedVersion } from "./workspace-publish.mjs";

test("published workspace versions support npm string and workspace-array output", () => {
  assert.equal(parsePublishedVersion('"0.1.57"\n'), "0.1.57");
  assert.equal(parsePublishedVersion('["0.1.57"]\n'), "0.1.57");
});
