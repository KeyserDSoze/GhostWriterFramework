import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import reviewEn from "../src/i18n/locales/designReview.en.ts";
import reviewIt from "../src/i18n/locales/designReview.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const engineSource = (path) => readFileSync(new URL(`../../../packages/engine/src/autopilot/${path}`, import.meta.url), "utf8");

/** The files of the Studio and of its dialog that show these texts. */
function studioFiles() {
  const folder = new URL("../src/components/outline/studio/", import.meta.url);
  return existsSync(folder) ? readdirSync(folder).filter((name) => /\.tsx?$/.test(name)).map((name) => `components/outline/studio/${name}`) : [];
}

const PAIRS = [["the reviews of a design", reviewEn, reviewIt, "designReview"]];

for (const [name, english, italian, root] of PAIRS) {
  test(`the texts of ${name} speak both languages, with the same keys and the same placeholders`, () => {
    const left = new Map(leaves(english));
    const right = new Map(leaves(italian));
    assert.deepEqual(Object.keys(english), [root]);
    assert.deepEqual([...right.keys()].sort(), [...left.keys()].sort());
    for (const [key, value] of left) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.trim(), `${key} is not empty`);
      assert.deepEqual(placeholders(right.get(key)), placeholders(value), `${key}: placeholders`);
    }
  });

  test(`the Italian of ${name} is written in Italian, not copied from English`, () => {
    const right = new Map(leaves(italian));
    // A text made only of its placeholders (a list of figures) is the same in both languages, and so are the names Italian keeps: Brainstormer, and the pitch it proposes.
    const words = (text) => /\p{L}/u.test(text.replace(/\{\{[^}]*\}\}/g, ""));
    const kept = new Set(["Brainstormer", "Pitch {{id}}: {{title}}"]);
    const same = leaves(english).filter(([key, value]) => right.get(key) === value && words(value) && !kept.has(value)).map(([key]) => key);
    assert.deepEqual(same, []);
  });
}

test("every text the Studio asks of the reviews is in the catalogue, in every form a dynamic key takes", () => {
  const catalogue = new Map(leaves(reviewEn));
  const used = studioFiles().flatMap((file) => [...source(file).matchAll(/\bt\("(designReview\.[\w.]+)"/g)].map((match) => match[1]));
  assert.ok(used.length > 40, `texts read: ${used.length}`);
  // A plural is asked for by its stem: its `_one` and `_other` say it.
  assert.deepEqual(used.filter((key) => !catalogue.has(key) && !catalogue.has(`${key}_other`)), []);

  // The keys that are made up at the time (``t(`designReview.kind.${kind}`)``): each value they take has its text.
  const kinds = /COHERENCE_KINDS = \[([^\]]+)\]/.exec(engineSource("design-review-types.ts"));
  assert.ok(kinds, "the engine declares the kinds of finding");
  const kindNames = [...kinds[1].matchAll(/"([\w-]+)"/g)].map((match) => match[1]);
  assert.ok(kindNames.includes("plot-hole") && kindNames.includes("early-reveal"), `kinds read: ${kindNames.join(", ")}`);
  const dynamic = {
    "designReview.kind": kindNames,
    "designReview.severity": ["critical", "major", "minor"],
    "designReview.status": ["open", "fixing", "fixed", "dismissed", "mine"],
    "designReview.findings.source": ["check", "ai"],
    "designReview.findings.who": ["author", "director"],
    "designReview.findings.groups": ["open", "fixing", "mine", "dismissed", "fixed"],
    "designReview.findings.announce": ["fix", "mine", "dismiss", "reopen"],
    "designReview.rubric.verdict": ["ok", "revise"],
    "designReview.alternatives.chosenBy": ["director", "author"],
    "designReview.alternatives.fields": ["premise", "protagonist", "stakes", "twist", "tone", "difference"],
    "designReview.request.blocked": ["chapters", "running", "designing", "server"],
  };
  for (const [prefix, values] of Object.entries(dynamic)) for (const value of values) assert.ok(catalogue.has(`${prefix}.${value}`), `${prefix}.${value}`);
  for (const key of ["chapterReview", "coherence", "rubric"]) for (const part of ["label", "hint"]) assert.ok(catalogue.has(`designReview.dialog.${key}.${part}`), `${key}.${part}`);
  // Every refusal the site tells apart has a text, and the engine gives no other for the choices and the decisions: the codes of the engine's error are the ones the site names, bar the ones the design had before.
  const refusals = /DESIGN_REVIEW_ERROR_CODES = \[([^\]]+)\]/.exec(source("autopilot/designReview.ts"));
  assert.ok(refusals, "the site declares the refusals of the reviews");
  const codes = [...refusals[1].matchAll(/"(\w+)"/g)].map((match) => match[1]);
  assert.ok(codes.includes("pitch_locked") && codes.includes("not_fixable"), `codes read: ${codes.join(", ")}`);
  for (const code of codes) assert.ok(catalogue.has(`designReview.errors.${code}`), code);
  const engineCodes = /AutopilotDesignErrorCode =((?:\s*\|?\s*"\w+")+)/.exec(engineSource("design.ts"));
  assert.ok(engineCodes, "the engine declares the codes of its design errors");
  const given = [...engineCodes[1].matchAll(/"(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(given.filter((code) => !codes.includes(code)).sort(), ["design_no_description", "design_written"]);
});

test("the texts of the reviews come with the Studio and its dialog, never with the app", () => {
  for (const locale of [en, it]) {
    assert.equal("designReview" in locale, false);
  }
  assert.match(source("i18n/design.ts"), /designReview\.en/);
  assert.match(source("i18n/design.ts"), /designReview\.it/);
  assert.match(source("components/outline/studio/StudioReviews.tsx"), /^import "@\/i18n\/design";$/m);
  assert.doesNotMatch(source("pages/OutlinePage.tsx"), /@\/i18n\/design/);
  // The Studio reaches the reviews through one lazy import: they are not part of the Studio's own chunk, nor of the app's.
  assert.match(source("components/outline/studio/StudioTab.tsx"), /lazy\(\(\) => import\("@\/components\/outline\/studio\/StudioReviews"\)\)/);
  assert.doesNotMatch(source("components/outline/studio/StudioTab.tsx"), /^import .*StudioReviews/m);
});
