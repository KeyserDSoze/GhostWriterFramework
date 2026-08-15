import assert from "node:assert/strict";
import test from "node:test";
import { parseBookSearchQuery, searchBookTexts } from "../src/assistant/bookSearch.ts";

test("parses bilingual queries without requiring generic stopwords", () => {
  assert.deepEqual(parseBookSearchQuery("find memory and debt").terms, ["memory", "debt"]);
  assert.deepEqual(parseBookSearchQuery("cerca memoria e debito").terms, ["memoria", "debito"]);
  assert.deepEqual(parseBookSearchQuery("cerca nel libro capitolo personaggio memoria debito").terms, ["memoria", "debito"]);
  assert.deepEqual(parseBookSearchQuery("cerca l'ombra nel testo dell'ultimo capitolo").phrases, []);
  assert.ok(parseBookSearchQuery("cerca l'ombra nel testo dell'ultimo capitolo").terms.includes("ombra"));
});

test("large Italian queries rank full-coverage late files above partial matches", () => {
  const files = Array.from({ length: 60 }, (_, index) => ({ path: `capitoli/${index + 1}.md`, role: "paragrafo", content: index === 59 ? "La memoria del debito ritorna alla porta." : index === 10 ? "La memoria svanisce." : "Testo neutro." }));
  const result = searchBookTexts(files, "cerca memoria e debito");
  assert.equal(result.results[0].path, "capitoli/60.md");
});

test("searches every file, ranks coverage, and returns paths with excerpts", () => {
  const files = Array.from({ length: 40 }, (_, index) => ({ path: `chapters/001/chapter-${index + 1}.md`, role: index === 0 ? "chapter intro" : "paragraph", content: index === 39 ? "The hidden lantern debt returns at the final gate." : `Paragraph ${index + 1}` }));
  files.push({ path: "research/lanterns.md", role: "research", content: "Historical lantern construction and memory rituals." });
  files.push({ path: "characters/lyra.md", role: "character", content: "Lyra carries a debt and fears the lantern." });
  const result = searchBookTexts(files, "search lantern debt", 10);
  assert.equal(result.total, 3);
  assert.equal(result.results[0].path, "chapters/001/chapter-40.md");
  assert.match(result.results[0].excerpt, /lantern debt/);
  assert.ok(result.results.some((entry) => entry.path.startsWith("research/")));
});

test("quoted phrases receive ranking priority", () => {
  const result = searchBookTexts([{ path: "a.md", role: "note", content: "memory debt" }, { path: "b.md", role: "note", content: "memory and debt" }], 'find "memory and debt"');
  assert.equal(result.results[0].path, "b.md");
});

test("path-only matches do not fabricate an unrelated excerpt", () => {
  const result = searchBookTexts([{ path: "notes/lantern.md", role: "note", content: "Unrelated opening text." }], "lantern");
  assert.equal(result.results[0].excerpt, "");
});
