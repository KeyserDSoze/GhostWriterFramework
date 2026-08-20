import { expect, test } from "vitest";
import { buildInitialBookFiles } from "@/narrarium/bookScaffold";
import { canDeleteGhostwriter, defaultGhostwriter, ghostwriterPrompt, ghostwriterReferencePaths, parseGhostwriter, serializeGhostwriter } from "@/narrarium/ghostwriter";
import { composeGhostwriterStyleContext, resolveGhostwriterSlug } from "@/narrarium/pipeline";

test("new books include and select a complete default ghostwriter", () => {
  const files = buildInitialBookFiles({ title: "Book", language: "it" });
  const book = files.find((file) => file.path === "book.md")?.content ?? "";
  const ghostwriter = files.find((file) => file.path === "ghostwriters/default.md")?.content ?? "";
  expect(book).toContain("ghostwriter: default");
  expect(ghostwriter).toContain("writing_style:");
  expect(ghostwriter).toContain("punctuation_style:");
  expect(files.some((file) => file.path === "writing-style.md")).toBe(false);
  expect(files.some((file) => file.path === "punctuation-style.md")).toBe(false);
});

test("ghostwriter writing and punctuation rules survive serialization and enter the prompt", () => {
  const profile = defaultGhostwriter("en");
  const parsed = parseGhostwriter(profile.slug, serializeGhostwriter(profile));
  expect(parsed.writingStyle).toBe(profile.writingStyle);
  expect(parsed.punctuationStyle).toBe(profile.punctuationStyle);
  expect(ghostwriterPrompt(parsed)).toContain(`Writing style: ${profile.writingStyle}`);
  expect(ghostwriterPrompt(parsed)).toContain(`Binding punctuation style: ${profile.punctuationStyle}`);
});

test("ghostwriter precedence is explicit, paragraph, chapter, then book", () => {
  const source = {
    structure: { ghostwriter: "book" },
    chapter: { ghostwriter: "chapter" },
    paragraph: { ghostwriter: "paragraph" },
  } as any;
  expect(resolveGhostwriterSlug(source, "explicit")).toBe("explicit");
  expect(resolveGhostwriterSlug(source)).toBe("paragraph");
  expect(resolveGhostwriterSlug({ ...source, paragraph: {} })).toBe("chapter");
  expect(resolveGhostwriterSlug({ ...source, paragraph: {}, chapter: {} })).toBe("book");
});

test("only the selected ghostwriter defines prose and punctuation style", () => {
  const ghostwriter = defaultGhostwriter("en");
  const context = composeGhostwriterStyleContext(ghostwriter);
  expect(context).toContain(ghostwriter.writingStyle);
  expect(context).toContain(ghostwriter.punctuationStyle);
  expect(composeGhostwriterStyleContext(null)).toBe("");
});

test("ghostwriter deletion checks only canonical markdown files for references", () => {
  expect(ghostwriterReferencePaths([
    { path: "book.md" },
    { path: "chapters/001-opening/chapter.md" },
    { path: "drafts/001-opening/001-scene.md" },
    { path: "scripts/001-opening/001-scene.md" },
    { path: "scripts/requirements-manuscript.txt" },
    { path: "chapters/001-opening/research.txt" },
    { path: "ghostwriters/custom.md" },
    { path: "book.md" },
  ])).toEqual([
    "book.md",
    "chapters/001-opening/chapter.md",
    "drafts/001-opening/001-scene.md",
    "scripts/001-opening/001-scene.md",
  ]);
});

test("ghostwriter deletion always preserves the selected default profile", () => {
  expect(canDeleteGhostwriter("default", "default", 2)).toBe(false);
  expect(canDeleteGhostwriter("custom", "custom", 2)).toBe(false);
  expect(canDeleteGhostwriter("default", "custom", 2)).toBe(true);
  expect(canDeleteGhostwriter("custom", "default", 2)).toBe(true);
  expect(canDeleteGhostwriter("only-profile", undefined, 1)).toBe(false);
});
