import { beforeEach, describe, expect, it, vi } from "vitest";
import { triggerCurrentSave, useSaveStore } from "@/store/saveStore";
import { triggerCurrentRepositorySync, useRepositorySyncStore } from "@/store/repositorySyncStore";
import { buildBookExportArtifacts, epubModifiedTimestamp, normalizeMarkdownLineBreaks } from "@/export/bookExport";
import { buildChapterDocuments } from "@/narrarium/canon";
import { buildChapterDraftArtifactDocuments } from "@/narrarium/workspace";
import JSZip from "jszip";
import { DEFAULT_BOOK_EXPORT_SETTINGS } from "@/types/settings";

beforeEach(() => {
  useSaveStore.setState({ current: null });
  useRepositorySyncStore.setState({ current: null });
});

describe("editor persistence coordination", () => {
  it("coalesces concurrent saves", async () => {
    let finish!: (value: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    useSaveStore.setState({ current: { dirty: true, save } });

    const first = triggerCurrentSave();
    const second = triggerCurrentSave();
    expect(save).toHaveBeenCalledTimes(1);
    finish(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("aborts repository sync when the active save fails", async () => {
    const sync = vi.fn();
    useSaveStore.setState({ current: { dirty: true, save: () => false } });
    useRepositorySyncStore.setState({ current: { busy: false, sync } });

    await expect(triggerCurrentRepositorySync()).resolves.toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  it("flushes the active editor before repository sync", async () => {
    const order: string[] = [];
    useSaveStore.setState({ current: { dirty: true, save: () => { order.push("save"); return true; } } });
    useRepositorySyncStore.setState({ current: { busy: false, sync: () => { order.push("sync"); } } });

    await expect(triggerCurrentRepositorySync()).resolves.toBe(true);
    expect(order).toEqual(["save", "sync"]);
  });
});

describe("EPUB line-break normalization", () => {
  it("joins prose blocks in book flow but preserves source mode", () => {
    const source = "First line.\n\nSecond line.";
    expect(normalizeMarkdownLineBreaks(source, "book")).toBe("First line. Second line.");
    expect(normalizeMarkdownLineBreaks(source, "source")).toBe(source);
  });

  it("keeps dialogue as separate paragraphs", () => {
    expect(normalizeMarkdownLineBreaks("Narration.\n\n\"Hello.\"\n\nAfter.", "dialogue"))
      .toBe("Narration.\n\n\"Hello.\"\n\nAfter.");
  });

  it("builds an EPUB 3 package with valid UTC modified metadata and required entries", async () => {
    expect(epubModifiedTimestamp(new Date("2026-08-17T12:34:56.789Z"))).toBe("2026-08-17T12:34:56Z");
    const snapshot = {
      title: "Book", author: "Author", language: "en", frontmatterRecord: {}, chapters: [{
        slug: "001-start", number: 1, title: "Start", frontmatterRecord: {}, body: "", paragraphs: [{ number: "001", title: "Scene", frontmatterRecord: {}, body: "Line one.\n\n---\n\nLine two." }],
      }], wordCount: 5,
    };
    const [artifact] = await buildBookExportArtifacts({ snapshot: snapshot as never, scope: "full", settings: DEFAULT_BOOK_EXPORT_SETTINGS, formats: ["epub"] });
    const zip = await JSZip.loadAsync(await artifact.blob.arrayBuffer());
    expect(await zip.file("mimetype")?.async("string")).toBe("application/epub+zip");
    expect(zip.files["META-INF/container.xml"]).toBeDefined();
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(() => new DOMParser().parseFromString(chapter, "application/xml")).not.toThrow();
    expect(new DOMParser().parseFromString(chapter, "application/xml").querySelector("parsererror")).toBeNull();
  });
});

describe("atomic artifact plans", () => {
  it("builds the complete chapter plan before writing", () => {
    expect(buildChapterDocuments({ number: 2, title: "Second" }).documents.map((entry) => entry.path)).toEqual([
      "chapters/002-second/chapter.md",
      "resumes/chapters/002-second.md",
      "evaluations/chapters/002-second.md",
    ]);
  });

  it("builds all chapter draft buckets before writing", () => {
    expect(buildChapterDraftArtifactDocuments({ number: 2, title: "Second" }).documents.map((entry) => entry.path)).toEqual([
      "drafts/002-second/chapter.md",
      "drafts/002-second/notes.md",
      "drafts/002-second/ideas.md",
      "drafts/002-second/promoted.md",
    ]);
  });
});
