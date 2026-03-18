import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonHrefIndex,
  normalizeCanonEntityHref,
  resolveCanonEntryIdFromHref,
} from "../cli-dist/lib/canon-mentions.js";

test("canon mention helpers normalize legacy internal canon hrefs", () => {
  assert.equal(normalizeCanonEntityHref("../../characters/mariamne-ii/"), "characters/mariamne-ii/");
  assert.equal(normalizeCanonEntityHref("../items/brass-key.md"), "items/brass-key/");
  assert.equal(normalizeCanonEntityHref("/timelines/events/harbor-lockdown/"), "timeline/harbor-lockdown/");
  assert.equal(normalizeCanonEntityHref("https://reader.example/locations/gray-harbor/"), "locations/gray-harbor/");
  assert.equal(normalizeCanonEntityHref("https://example.com/docs/setup"), null);
});

test("canon mention helpers resolve glossary entries from legacy hrefs", () => {
  const entries = [
    { id: "character:mariamne-ii", href: "characters/mariamne-ii/" },
    { id: "item:brass-key", href: "items/brass-key/" },
    { id: "timeline-event:harbor-lockdown", href: "timeline/harbor-lockdown/" },
  ];

  const hrefIndex = buildCanonHrefIndex(entries);

  assert.equal(hrefIndex.get("characters/mariamne-ii/"), "character:mariamne-ii");
  assert.equal(resolveCanonEntryIdFromHref("../../characters/mariamne-ii/", entries), "character:mariamne-ii");
  assert.equal(resolveCanonEntryIdFromHref("../timelines/events/harbor-lockdown/", entries), "timeline-event:harbor-lockdown");
  assert.equal(resolveCanonEntryIdFromHref("../../secrets/hidden-dossier/", entries), null);
});
