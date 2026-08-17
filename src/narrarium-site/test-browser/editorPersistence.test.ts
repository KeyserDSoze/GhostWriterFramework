import { beforeEach, describe, expect, it, vi } from "vitest";
import { triggerCurrentSave, useSaveStore } from "@/store/saveStore";
import { triggerCurrentRepositorySync, useRepositorySyncStore } from "@/store/repositorySyncStore";
import { normalizeMarkdownLineBreaks } from "@/export/bookExport";
import { buildChapterDocuments } from "@/narrarium/canon";
import { buildChapterDraftArtifactDocuments } from "@/narrarium/workspace";

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
