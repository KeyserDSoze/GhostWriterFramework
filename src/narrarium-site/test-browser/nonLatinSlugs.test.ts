import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { slugCode } from "narrarium/slug";
import { buildCanonEntityDocument, buildChapterDocuments, buildParagraphDocument, ENTITY_DIRECTORY, type EntityKind } from "@/narrarium/canon";
import { buildChapterDraftArtifactDocuments, buildParagraphDraftArtifact, buildParagraphScriptArtifact } from "@/narrarium/workspace";
import { slugifyNote } from "@/narrarium/notes";
import { slugifyResearch } from "@/research/engine";
import { buildBookExportArtifacts } from "@/export/bookExport";
import { resolveBookExportSettings } from "@/types/settings";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NUMBERED = /^\d{3,}-[a-z0-9]+(-[a-z0-9]+)*$/;

/** One title or name in each of the scripts the framework has to work in. */
const SCRIPTS = {
  Russian: "Тихая гавань",
  Greek: "Η μικρή πόλη",
  Chinese: "李明",
  Japanese: "海辺の朝",
  Arabic: "الميناء",
} as const;
const OTHER_SCRIPTS = { Korean: "바닷가의 아침", Hebrew: "נמל שקט", Hindi: "शांत बंदरगाह", Thai: "ท่าเรือเงียบสงบ" } as const;
const KINDS: EntityKind[] = ["character", "location", "faction", "item", "secret", "timeline-event"];

describe("canon files created from names in every script", () => {
  it.each(KINDS)("%s: a readable, stable name for each script, different for each name", (kind) => {
    const slugs = Object.entries({ ...SCRIPTS, ...OTHER_SCRIPTS }).map(([script, label]) => {
      const document = buildCanonEntityDocument({ kind, label });
      expect(document.slug, script).toMatch(SLUG);
      expect(document.path, script).toBe(`${ENTITY_DIRECTORY[kind]}/${document.slug}.md`);
      expect(document.id, script).toBe(`${kind}:${document.slug}`);
      expect(document.content, script).toContain(label);
      expect(buildCanonEntityDocument({ kind, label }).slug, `${script}: the same name always gives the same slug`).toBe(document.slug);
      return document.slug;
    });
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("reads Cyrillic and Greek, and keeps a stable code for the scripts it cannot read", () => {
    expect(buildCanonEntityDocument({ kind: "location", label: SCRIPTS.Russian }).slug).toBe("tikhaya-gavan");
    expect(buildCanonEntityDocument({ kind: "location", label: SCRIPTS.Greek }).slug).toBe("i-mikri-poli");
    expect(buildCanonEntityDocument({ kind: "character", label: SCRIPTS.Chinese })).toMatchObject({ slug: "character-0crj2m", path: "characters/character-0crj2m.md", id: "character:character-0crj2m" });
    expect(buildCanonEntityDocument({ kind: "timeline-event", label: SCRIPTS.Chinese }).slug).toBe(`timeline-event-${slugCode(SCRIPTS.Chinese)}`);
    expect(buildCanonEntityDocument({ kind: "secret", label: SCRIPTS.Arabic }).slug).toBe(`secret-${slugCode(SCRIPTS.Arabic)}`);
  });

  it("names a secret or a timeline event with a title and the others with a name", () => {
    expect(buildCanonEntityDocument({ kind: "secret", label: SCRIPTS.Japanese }).content).toMatch(/^title: 海辺の朝$/m);
    expect(buildCanonEntityDocument({ kind: "timeline-event", label: SCRIPTS.Japanese }).content).toMatch(/^title: 海辺の朝$/m);
    expect(buildCanonEntityDocument({ kind: "character", label: SCRIPTS.Japanese }).content).toMatch(/^name: 海辺の朝$/m);
  });

  it.each([
    ["Lyra Vale", "lyra-vale"],
    ["Città di sale", "citta-di-sale"],
    ["José Smith", "jose-smith"],
    ["The Clockmaker's Daughter", "the-clockmaker-s-daughter"],
    ["Crème brûlée", "creme-brulee"],
    ["Zoë D’Angelo", "zoe-d-angelo"],
    ["Глава 1", "1"],
  ])("keeps the name every book already has: %s", (label, slug) => {
    for (const kind of KINDS) expect(buildCanonEntityDocument({ kind, label }).slug).toBe(slug);
  });

  it("still refuses a blank name", () => {
    expect(() => buildCanonEntityDocument({ kind: "character", label: "   " })).toThrow("A valid name or title is required.");
    expect(() => buildCanonEntityDocument({ kind: "location", label: "" })).toThrow("A valid name or title is required.");
  });
});

describe("chapters and scenes created from titles in every script", () => {
  it("never produces an empty or invisible chapter folder", () => {
    const folders = Object.entries({ ...SCRIPTS, ...OTHER_SCRIPTS }).map(([script, title]) => {
      const created = buildChapterDocuments({ number: 2, title });
      expect(created.slug, script).toMatch(NUMBERED);
      expect(created.id).toBe(`chapter:${created.slug}`);
      expect(created.chapterFilePath).toBe(`chapters/${created.slug}/chapter.md`);
      expect(created.documents[0].content, script).toMatch(new RegExp(`^title: ${title}$`, "m"));
      expect(buildChapterDocuments({ number: 2, title }).slug).toBe(created.slug);
      return created.slug;
    });
    expect(folders).toContain("002-tikhaya-gavan");
    expect(folders).toContain("002-i-mikri-poli");
    expect(folders).toContain("002-chapter");
    // The title is kept in the file; the folder only needs a name and the number.
    expect(buildChapterDocuments({ number: 1000, title: SCRIPTS.Japanese }).slug).toBe("1000-chapter");
  });

  it("never produces an empty or invisible scene file", () => {
    for (const [script, title] of Object.entries({ ...SCRIPTS, ...OTHER_SCRIPTS })) {
      const created = buildParagraphDocument({ chapterSlug: "001-chapter", number: 3, title });
      expect(created.slug, script).toMatch(NUMBERED);
      expect(created.slug).not.toMatch(/-$/);
      expect(created.paragraphFilePath).toBe(`chapters/001-chapter/${created.slug}.md`);
      expect(created.content).toContain(`title: ${title}`);
    }
    expect(buildParagraphDocument({ chapterSlug: "001-chapter", number: 3, title: SCRIPTS.Japanese }).slug).toBe("003-scene");
  });

  it("gives the draft and script of a scene the same name the scene would have", () => {
    for (const [script, title] of Object.entries({ ...SCRIPTS, ...OTHER_SCRIPTS })) {
      const scene = buildParagraphDocument({ chapterSlug: "001-chapter", number: 4, title }).slug;
      const draft = buildParagraphDraftArtifact({ chapterSlug: "001-chapter", number: 4, title });
      const scriptFile = buildParagraphScriptArtifact({ chapterSlug: "001-chapter", number: 4, title });
      expect(draft.slug, script).toBe(scene);
      expect(scriptFile.slug, script).toBe(scene);
      expect(draft.path).toBe(`drafts/001-chapter/${scene}.md`);
      expect(scriptFile.path).toBe(`scripts/001-chapter/${scene}.md`);
      expect(draft.content).toContain(`id: draft:paragraph:001-chapter:${scene}`);
      expect(scriptFile.content).toContain(`id: script:001-chapter:${scene}`);
    }
  });

  it("keeps the name of an existing scene when it is given", () => {
    expect(buildParagraphDraftArtifact({ chapterSlug: "001-chapter", number: 4, title: SCRIPTS.Chinese, paragraphSlug: "004-海辺の朝" }).path).toBe("drafts/001-chapter/004-海辺の朝.md");
    expect(buildParagraphScriptArtifact({ chapterSlug: "001-chapter", number: 4, title: SCRIPTS.Chinese, paragraphSlug: "004-海辺の朝" }).path).toBe("scripts/001-chapter/004-海辺の朝.md");
  });

  it("names a chapter draft after the chapter, whatever its script", () => {
    for (const [script, title] of Object.entries({ ...SCRIPTS, ...OTHER_SCRIPTS })) {
      const created = buildChapterDraftArtifactDocuments({ number: 5, title });
      expect(created.slug, script).toMatch(NUMBERED);
      expect(created.path).toBe(`drafts/${created.slug}/chapter.md`);
    }
  });

  it.each([
    [1, "The Arrival", "001-the-arrival", "001-the-arrival"],
    [12, "Città di sale", "012-citta-di-sale", "012-citta-di-sale"],
    [7, "Crème brûlée", "007-creme-brulee", "007-creme-brulee"],
    [3, "Don't Stop", "003-don-t-stop", "003-don-t-stop"],
    [1000, "The End", "1000-the-end", "1000-the-end"],
  ])("keeps the folder and the file every book already has: %s %s", (number, title, chapter, scene) => {
    expect(buildChapterDocuments({ number, title }).slug).toBe(chapter);
    expect(buildChapterDraftArtifactDocuments({ number, title }).slug).toBe(chapter);
    expect(buildParagraphDocument({ chapterSlug: "001-x", number, title }).slug).toBe(scene);
    expect(buildParagraphDraftArtifact({ chapterSlug: "001-x", number, title }).slug).toBe(scene);
    expect(buildParagraphScriptArtifact({ chapterSlug: "001-x", number, title }).slug).toBe(scene);
  });
});

describe("notes and research documents named from what the author typed", () => {
  const NOTE_TITLES = { ...SCRIPTS, ...OTHER_SCRIPTS };

  it("gives every note title in a script it cannot read a name of its own", () => {
    const names = Object.entries(NOTE_TITLES).map(([script, title]) => {
      const slug = slugifyNote(title);
      expect(slug, script).toMatch(SLUG);
      expect(slugifyNote(title), `${script}: stable`).toBe(slug);
      return slug;
    });
    expect(new Set(names).size).toBe(names.length);
    expect(slugifyNote(SCRIPTS.Russian)).toBe("tikhaya-gavan");
    expect(slugifyNote(SCRIPTS.Chinese)).toBe(`note-${slugCode(SCRIPTS.Chinese)}`);
  });

  it("never lets two different Chinese notes share a file", () => {
    expect(slugifyNote("李明的日记")).not.toBe(slugifyNote("王芳的日记"));
    expect(slugifyNote("李明的日记")).toMatch(/^note-[0-9a-z]{6,7}$/);
  });

  it("keeps the names of Latin notes and the 60 characters they were cut at", () => {
    expect(slugifyNote("Plot ideas for chapter two")).toBe("plot-ideas-for-chapter-two");
    expect(slugifyNote("Appunti: la città di sale")).toBe("appunti-la-citta-di-sale");
    const long = "A very long note title that keeps going and going well beyond sixty characters";
    expect(slugifyNote(long)).toBe("a-very-long-note-title-that-keeps-going-and-going-well-beyond".slice(0, 60));
    expect(slugifyNote(long)).toHaveLength(60);
  });

  it("names a research document after a query in any script", () => {
    const names = Object.entries(NOTE_TITLES).map(([script, query]) => {
      const slug = slugifyResearch(query);
      expect(slug, script).toMatch(SLUG);
      expect(slugifyResearch(query), `${script}: stable`).toBe(slug);
      return slug;
    });
    expect(new Set(names).size).toBe(names.length);
    expect(slugifyResearch("罗马水道的建造")).toBe(`research-${slugCode("罗马水道的建造")}`);
    expect(`2026-11-21-${slugifyResearch("罗马水道的建造")}`).toMatch(/^2026-11-21-research-[0-9a-z]{6,7}$/);
  });

  it("keeps the names of Latin research documents", () => {
    expect(slugifyResearch("Roman aqueduct construction")).toBe("roman-aqueduct-construction");
    expect(slugifyResearch("Come si costruivano gli acquedotti romani? È vero")).toBe("come-si-costruivano-gli-acquedotti-romani-e-vero");
    expect(slugifyResearch("x".repeat(80))).toBe("x".repeat(60));
  });
});

describe("exported files named after the title of the book", () => {
  const snapshot = (title: string): Parameters<typeof buildBookExportArtifacts>[0]["snapshot"] => ({
    title,
    author: "Anna",
    language: "en",
    frontmatterRecord: {},
    chapters: [{ slug: "001-chapter", number: 1, title: "Chapter", frontmatterRecord: {}, body: "", paragraphs: [{ number: "001", title: "Scene", frontmatterRecord: {}, body: "Text." }] }],
    wordCount: 1,
  });
  const settings = { ...resolveBookExportSettings({} as Parameters<typeof resolveBookExportSettings>[0]), includeTitlePage: false };

  async function epubIdentifier(title: string, scope: "full" | "draft" = "full") {
    const [artifact] = await buildBookExportArtifacts({ snapshot: snapshot(title), scope, settings, formats: ["epub"] });
    const zip = await JSZip.loadAsync(await artifact.blob.arrayBuffer());
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    const ncx = await zip.file("OEBPS/toc.ncx")!.async("string");
    return { fileName: artifact.fileName, opf: /<dc:identifier id="bookid">([^<]*)<\/dc:identifier>/.exec(opf)?.[1], ncx: /name="dtb:uid" content="([^"]*)"/.exec(ncx)?.[1] };
  }

  it("never gives two different books the same file name or the same EPUB identifier", async () => {
    const seen = new Set<string>();
    for (const [script, title] of Object.entries({ ...SCRIPTS, ...OTHER_SCRIPTS })) {
      const { fileName, opf, ncx } = await epubIdentifier(title);
      expect(fileName, script).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.epub$/);
      expect(opf, script).toMatch(/^urn:narrarium:[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ncx, script).toBe(opf);
      expect(fileName).toBe(`${opf!.slice("urn:narrarium:".length)}.epub`);
      expect(seen.has(fileName), `${script} is a new name`).toBe(false);
      seen.add(fileName);
    }
    expect((await epubIdentifier(SCRIPTS.Russian)).fileName).toBe("tikhaya-gavan.epub");
    expect((await epubIdentifier(SCRIPTS.Chinese)).fileName).toBe(`book-${slugCode(SCRIPTS.Chinese)}.epub`);
    expect((await epubIdentifier(SCRIPTS.Chinese, "draft")).fileName).toBe(`book-${slugCode(SCRIPTS.Chinese)}-draft.epub`);
  });

  it("keeps the file names of Latin books", async () => {
    expect((await epubIdentifier("The Clockmaker's Daughter"))).toMatchObject({ fileName: "the-clockmaker-s-daughter.epub", opf: "urn:narrarium:the-clockmaker-s-daughter" });
    expect((await epubIdentifier("Città di sale", "draft")).fileName).toBe("citta-di-sale-draft.epub");
    expect((await epubIdentifier("")).fileName).toBe("book.epub");
    expect((await epubIdentifier("")).opf).toBe("urn:narrarium:book");
  });

  it("names a Word document after a title in any script", async () => {
    const [docx] = await buildBookExportArtifacts({ snapshot: snapshot(SCRIPTS.Japanese), scope: "full", settings, formats: ["docx"] });
    expect(docx.fileName).toBe(`book-${slugCode(SCRIPTS.Japanese)}.docx`);
    const [latin] = await buildBookExportArtifacts({ snapshot: snapshot("Storie — multilingual"), scope: "full", settings, formats: ["docx"] });
    expect(latin.fileName).toBe("storie-multilingual.docx");
  }, 60_000);
});
