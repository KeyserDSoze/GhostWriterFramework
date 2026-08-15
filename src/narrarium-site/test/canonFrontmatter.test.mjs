import assert from "node:assert/strict";
import test from "node:test";
import { PROTECTED_CANON_FIELDS, validateCanonExtraFrontmatter } from "../src/narrarium/canonFrontmatter.ts";

/** @type {import("../src/narrarium/canonFrontmatter.ts").CanonEntityKind[]} */
const kinds = ["character", "location", "faction", "item", "secret", "timeline-event"];

test("every protected identity and lifecycle field is rejected for every entity kind", () => {
  for (const kind of kinds) for (const field of PROTECTED_CANON_FIELDS) assert.throws(() => validateCanonExtraFrontmatter(kind, { [field]: "override" }), new RegExp(field));
});

test("unknown fields are rejected instead of passed through", () => {
  for (const kind of kinds) assert.throws(() => validateCanonExtraFrontmatter(kind, { invented_field: true }), /invented_field/);
});

test("each entity accepts explicit enrichment fields", () => {
  assert.deepEqual(validateCanonExtraFrontmatter("character", { role_tier: "primary" }), { role_tier: "primary" });
  assert.deepEqual(validateCanonExtraFrontmatter("location", { location_kind: "city" }), { location_kind: "city" });
  assert.deepEqual(validateCanonExtraFrontmatter("faction", { faction_kind: "guild" }), { faction_kind: "guild" });
  assert.deepEqual(validateCanonExtraFrontmatter("item", { item_kind: "relic" }), { item_kind: "relic" });
  assert.deepEqual(validateCanonExtraFrontmatter("secret", { stakes: "war" }), { stakes: "war" });
  assert.deepEqual(validateCanonExtraFrontmatter("timeline-event", { date: "1900" }), { date: "1900" });
});
