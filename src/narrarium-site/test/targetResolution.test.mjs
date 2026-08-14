import assert from "node:assert/strict";
import test from "node:test";
import { resolveChapterTarget, resolveParagraphTarget } from "../src/assistant/targetRules.ts";

const chapters = [
  {
    slug: "001-the-gate",
    title: "The Gate",
    paragraphs: [
      { number: "001", title: "Arrival", path: "chapters/001-the-gate/001-arrival.md" },
      { number: "002", title: "The Warning", path: "chapters/001-the-gate/002-the-warning.md" },
    ],
  },
  {
    slug: "002-the-crossing",
    title: "The Crossing",
    paragraphs: [
      { number: "001", title: "Departure", path: "chapters/002-the-crossing/001-departure.md" },
      { number: "002", title: "Deep Water", path: "chapters/002-the-crossing/002-deep-water.md" },
    ],
  },
  {
    slug: "003-return",
    title: "Return",
    paragraphs: [
      { number: "001", title: "Home", path: "chapters/003-return/001-home.md" },
    ],
  },
];

const ambientChapter = chapters[0];
const ambientParagraph = ambientChapter.paragraphs[0];

test("resolves numeric, ordinal, latest, and named chapter targets", () => {
  assert.equal(resolveChapterTarget("evaluate chapter 2", chapters, ambientChapter).value?.slug, "002-the-crossing");
  assert.equal(resolveChapterTarget("valuta il secondo capitolo", chapters, ambientChapter).value?.slug, "002-the-crossing");
  assert.equal(resolveChapterTarget("read the latest chapter", chapters, ambientChapter).value?.slug, "003-return");
  assert.equal(resolveChapterTarget('audit chapter "The Crossing"', chapters, ambientChapter).value?.slug, "002-the-crossing");
  assert.equal(resolveChapterTarget("review chapter The Crossing", chapters, ambientChapter).value?.slug, "002-the-crossing");
  assert.equal(resolveChapterTarget("review chapter titled The Crossing", chapters, ambientChapter).value?.slug, "002-the-crossing");
});

test("preserves connectors inside names and strips only structural qualifiers", () => {
  const connectorChapter = { ...chapters[2], slug: "004-the-gate-and-beyond", title: "The Gate and Beyond" };
  const extended = [...chapters, connectorChapter];
  assert.equal(resolveChapterTarget("evaluate chapter The Gate and Beyond", extended, ambientChapter).value?.slug, connectorChapter.slug);

  const shadowChapter = { ...chapters[2], slug: "005-the-gate-with-shadows", title: "The Gate with Shadows" };
  const withConnector = [...chapters, shadowChapter];
  assert.equal(resolveChapterTarget("evaluate chapter The Gate with Shadows", withConnector, ambientChapter).value?.slug, shadowChapter.slug);

  const shortOnly = resolveChapterTarget("evaluate chapter The Gate and Beyond", chapters, ambientChapter);
  assert.equal(shortOnly.status, "missing");
  assert.equal(shortOnly.value, null);

  const chapter = resolveChapterTarget("chapter 2", chapters, ambientChapter);
  const paragraph = resolveParagraphTarget("read paragraph Deep Water in chapter 2", chapter, ambientChapter, ambientParagraph);
  assert.equal(paragraph.value?.paragraph.title, "Deep Water");
  assert.equal(resolveChapterTarget("review chapter The Crossing in detail", chapters, ambientChapter).value?.slug, "002-the-crossing");
});

test("explicit missing chapters never fall back to ambient context", () => {
  const numeric = resolveChapterTarget("evaluate chapter 99", chapters, ambientChapter);
  assert.equal(numeric.explicit, true);
  assert.equal(numeric.status, "missing");
  assert.equal(numeric.value, null);

  const ordinal = resolveChapterTarget("valuta il quinto capitolo", chapters, ambientChapter);
  assert.equal(ordinal.explicit, true);
  assert.equal(ordinal.status, "missing");
  assert.equal(ordinal.value, null);

  const named = resolveChapterTarget('read chapter "Unknown Shore"', chapters, ambientChapter);
  assert.equal(named.explicit, true);
  assert.equal(named.status, "missing");
  assert.equal(named.value, null);

  const unquotedNamed = resolveChapterTarget("evaluate chapter Unknown Shore", chapters, ambientChapter);
  assert.equal(unquotedNamed.explicit, true);
  assert.equal(unquotedNamed.status, "missing");
  assert.equal(unquotedNamed.value, null);
});

test("uses ambient chapter only when the prompt has no explicit chapter target", () => {
  const result = resolveChapterTarget("evaluate this chapter", chapters, ambientChapter);
  assert.equal(result.explicit, false);
  assert.equal(result.status, "ambient");
  assert.equal(result.value, ambientChapter);
  assert.equal(resolveChapterTarget("show chapter info", chapters, ambientChapter).value, ambientChapter);
  assert.equal(resolveChapterTarget("evaluate chapter critically", chapters, ambientChapter).value, ambientChapter);
  const paragraph = resolveParagraphTarget("rewrite paragraph to improve pacing", result, ambientChapter, ambientParagraph);
  assert.equal(paragraph.value?.paragraph, ambientParagraph);
});

test("resolves numeric, ordinal, latest, and named paragraphs within the resolved chapter", () => {
  const chapter = resolveChapterTarget("chapter 2", chapters, ambientChapter);
  assert.equal(resolveParagraphTarget("paragraph 2 of chapter 2", chapter, ambientChapter, ambientParagraph).value?.paragraph.title, "Deep Water");
  assert.equal(resolveParagraphTarget("second paragraph of chapter 2", chapter, ambientChapter, ambientParagraph).value?.paragraph.title, "Deep Water");
  assert.equal(resolveParagraphTarget("ultimo paragrafo del capitolo 2", chapter, ambientChapter, ambientParagraph).value?.paragraph.title, "Deep Water");
  assert.equal(resolveParagraphTarget('paragraph "Departure" in chapter 2', chapter, ambientChapter, ambientParagraph).value?.paragraph.title, "Departure");
});

test("explicit missing paragraphs never fall back to the ambient paragraph or chapter", () => {
  const ambient = resolveChapterTarget("evaluate paragraph 99", chapters, ambientChapter);
  const missing = resolveParagraphTarget("evaluate paragraph 99", ambient, ambientChapter, ambientParagraph);
  assert.equal(missing.explicit, true);
  assert.equal(missing.status, "missing");
  assert.equal(missing.value, null);

  const missingChapter = resolveChapterTarget("evaluate paragraph 1 of chapter 99", chapters, ambientChapter);
  const nested = resolveParagraphTarget("evaluate paragraph 1 of chapter 99", missingChapter, ambientChapter, ambientParagraph);
  assert.equal(nested.explicit, true);
  assert.equal(nested.value, null);

  const missingNamed = resolveParagraphTarget("delete paragraph Missing Scene", ambient, ambientChapter, ambientParagraph);
  assert.equal(missingNamed.explicit, true);
  assert.equal(missingNamed.status, "missing");
  assert.equal(missingNamed.value, null);
});

test("uses the ambient paragraph only when neither level has an explicit target", () => {
  const chapter = resolveChapterTarget("review this paragraph", chapters, ambientChapter);
  const paragraph = resolveParagraphTarget("review this paragraph", chapter, ambientChapter, ambientParagraph);
  assert.equal(paragraph.explicit, false);
  assert.equal(paragraph.status, "ambient");
  assert.equal(paragraph.value?.paragraph, ambientParagraph);
});

test("chapter-level deictic requests never collapse to the ambient paragraph", () => {
  const chapter = resolveChapterTarget("evaluate this chapter", chapters, ambientChapter);
  const paragraph = resolveParagraphTarget("evaluate this chapter", chapter, ambientChapter, ambientParagraph);
  assert.equal(chapter.value, ambientChapter);
  assert.equal(paragraph.value, null);

  const italianChapter = resolveChapterTarget("leggi questo capitolo", chapters, ambientChapter);
  const italianParagraph = resolveParagraphTarget("leggi questo capitolo", italianChapter, ambientChapter, ambientParagraph);
  assert.equal(italianParagraph.value, null);
});

test("ordinary command words that equal a title are not treated as bare named targets", () => {
  const chapter = resolveChapterTarget("evaluate this paragraph and return a critical report", chapters, ambientChapter);
  assert.equal(chapter.explicit, false);
  assert.equal(chapter.value, ambientChapter);
});

test("duplicate exact names are ambiguous instead of selecting the current target", () => {
  const duplicateChapters = [...chapters, { ...chapters[2], slug: "004-return" }];
  const chapter = resolveChapterTarget('open chapter "Return"', duplicateChapters, ambientChapter);
  assert.equal(chapter.explicit, true);
  assert.equal(chapter.status, "ambiguous");
  assert.equal(chapter.value, null);

  const duplicateParagraphChapter = {
    ...ambientChapter,
    paragraphs: [...ambientChapter.paragraphs, { number: "003", title: "Arrival", path: "chapters/001-the-gate/003-arrival.md" }],
  };
  const resolvedChapter = resolveChapterTarget("chapter 1", [duplicateParagraphChapter], duplicateParagraphChapter);
  const paragraph = resolveParagraphTarget('read paragraph "Arrival" of chapter 1', resolvedChapter, duplicateParagraphChapter, ambientParagraph);
  assert.equal(paragraph.status, "ambiguous");
  assert.equal(paragraph.value, null);
});
