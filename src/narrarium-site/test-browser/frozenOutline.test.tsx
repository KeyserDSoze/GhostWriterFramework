import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutopilotState, outlineChapterPath, parseOutline, serializeOutlineChapter, type FrozenEditsMode, type PlannedChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  structure: null as unknown,
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: BOOK, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});

import i18n from "@/i18n";
import "@/i18n/outline";
import { OutlinePage } from "@/pages/OutlinePage";
import { entryStatus, frozenChapterSlugs, writtenChapters } from "@/outline/outlineModel";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const slugOf = (number: number) => `${String(number).padStart(3, "0")}-chapter-${number}`;
const RECORD = "frozen:\n  at: 2026-11-21T10:00:00.000Z\n  by: autopilot\n  digest: 0f1e2d3c4b5a6978\n  files:\n    001-the-pier.md: 8a7b6c5d4e3f2a1b\n";
const chapterFile = (number: number, frozen = "") => `---\ntype: chapter\nid: chapter:${slugOf(number)}\nnumber: ${number}\ntitle: Chapter ${number}\n${frozen}---\n\n# Chapter ${number}\n`;

function planned(number: number, patch: Partial<PlannedChapter> = {}): PlannedChapter {
  return { number, title: `Chapter ${number}`, slug: slugOf(number), summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [], outlineDigest: "0123456789abcdef", ...patch } as PlannedChapter;
}

interface BookShape {
  /** The chapters with an entry, all of them written unless `unwritten`. */
  chapters: number;
  frozen?: number[];
  plan?: PlannedChapter[];
  mode?: FrozenEditsMode;
  unwritten?: number[];
}

/** A book whose outline has an entry for every chapter, the chapters written, some of them frozen, and the autopilot's plan of them. */
function bookFiles({ chapters, frozen = [], plan = [], mode }: BookShape): Record<string, string> {
  const files: Record<string, string> = {};
  for (let number = 1; number <= chapters; number += 1) {
    files[outlineChapterPath(number)] = serializeOutlineChapter({ number, title: `Chapter ${number}`, body: `What happens in ${number}.`, origin: "author" });
    files[`chapters/${slugOf(number)}/chapter.md`] = chapterFile(number, frozen.includes(number) ? RECORD : "");
  }
  const state = createAutopilotState(new Date("2026-11-21T00:00:00.000Z"), { idea: "Glass" });
  state.plan = { chapters: plan, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  if (mode) state.options = { ...state.options, frozenEdits: mode };
  files["autopilot/state.json"] = JSON.stringify(state);
  return files;
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/outline"]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

async function open(shape: BookShape) {
  mocks.store = new MemoryBookStore(bookFiles(shape));
  const unwritten = new Set(shape.unwritten ?? []);
  mocks.structure = {
    title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], readerPersonas: [], loadedBranch: "main",
    chapters: Array.from({ length: shape.chapters }, (_, index) => ({ slug: slugOf(index + 1), title: `Chapter ${index + 1}`, paragraphs: unwritten.has(index + 1) ? [] : [{}] })),
  };
  const readMany = vi.spyOn(mocks.store, "readMany");
  render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
  return { chaptersRead: () => readMany.mock.calls.flatMap(([paths]) => paths).filter((path) => path.endsWith("/chapter.md")) };
}

const entryOf = (number: number) => document.getElementById(`outline-chapter-${number}`) as HTMLElement;
const bodyField = (number: number) => screen.getByLabelText(t("outline.entry.body", { number })) as HTMLTextAreaElement;
const saveButton = (number: number) => screen.getByRole("button", { name: t("outline.entry.save", { number }) });
const edit = (number: number) => fireEvent.change(bodyField(number), { target: { value: `Something else happens in ${number}.` } });

beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  useSaveStore.setState({ current: null });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("the freeze of a written chapter, as the Outline reads it", () => {
  it("is the record the engine reads in chapter.md: one that cannot be read, or none, is no freeze", () => {
    const files = [
      { path: "chapters/001-a/chapter.md", content: chapterFile(1, RECORD) },
      { path: "chapters/002-b/chapter.md", content: chapterFile(2, "frozen: yes\n") },
      { path: "chapters/003-c/chapter.md", content: chapterFile(3, "frozen: false\n") },
      { path: "chapters/004-d/chapter.md", content: chapterFile(4) },
      { path: "chapters/005-e/chapter.md", content: "---\ntitle: [unclosed\n---\n" },
    ];
    expect([...frozenChapterSlugs(files)]).toEqual(["001-a"]);
  });

  it("goes with the entry of its chapter, with what the autopilot does when the entry changes once the chapter is closed", async () => {
    const files = [1, 2, 3, 4, 5].map((number) => ({ path: outlineChapterPath(number), content: serializeOutlineChapter({ number, title: `T${number}`, body: "B", origin: "author" }) }));
    const outline = await parseOutline(files);
    const entry = (number: number) => outline.chapters.find((candidate) => candidate.number === number)!;
    const written = writtenChapters([1, 2, 3, 4].map((number) => ({ slug: slugOf(number), title: `T${number}`, paragraphs: [{}] })));
    const plan = new Map([[1, planned(1)], [2, planned(2, { imported: true })], [3, planned(3, { status: "writing" })], [4, planned(4, { outlineDigest: undefined })]]);
    const context = (mode?: FrozenEditsMode) => ({ plan, written, ghostwriters: new Set<string>(), warnings: new Map(), frozen: new Set([slugOf(1)]), ...(mode ? { mode } : {}) });
    expect(entryStatus(entry(1), context())).toMatchObject({ frozen: true, afterChange: "ask" });
    expect(entryStatus(entry(2), context()), "a written chapter that is not frozen is still asked about").toMatchObject({ frozen: false, afterChange: "ask" });
    expect(entryStatus(entry(3), context()).afterChange, "a chapter still being written is decided about once it is closed").toBeNull();
    expect(entryStatus(entry(4), context()).afterChange, "a plan that never knew the entry does not follow its changes").toBeNull();
    expect(entryStatus(entry(5), context()), "no chapter, no plan").toMatchObject({ frozen: false, afterChange: null });
    expect(entryStatus(entry(1), context("auto")).afterChange).toBe("auto");
    expect(entryStatus(entry(2), context("auto")).afterChange, "a chapter of the author is never rewritten for a decision of the autopilot").toBe("notify");
    expect(entryStatus(entry(1), context("notify")).afterChange).toBe("notify");
  });
});

describe.each<Language>(["en", "it"])("the entry of a frozen chapter on the Outline page (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("says that the chapter is frozen, and a written chapter that is not says nothing of the kind", async () => {
    await open({ chapters: 2, frozen: [1], plan: [planned(1), planned(2)] });
    await waitFor(() => expect(within(entryOf(1)).getByText(t("outline.status.frozen"))).toBeInTheDocument());
    expect(within(entryOf(2)).getByText(t("outline.status.written"))).toBeInTheDocument();
    expect(within(entryOf(2)).queryByText(t("outline.status.frozen"))).not.toBeInTheDocument();
    expect(t("outline.status.frozen")).toBe(language === "en" ? "Frozen chapter" : "Capitolo congelato");
  });

  it("says by its Save button that the autopilot will ask whether to rewrite the chapter, and says it again once saved", async () => {
    await open({ chapters: 2, frozen: [1], plan: [planned(1), planned(2)] });
    edit(1);
    const note = t("outline.written.ask", { count: 1, numbers: ["1"] });
    expect(note).toContain(language === "en" ? "the autopilot will ask you whether to rewrite" : "l'autopilot ti chiederà se riscrivere il capitolo secondo la Scaletta");
    expect(within(entryOf(1)).getByText(note)).toBeInTheDocument();
    expect(saveButton(1)).toHaveAccessibleDescription(note);
    fireEvent.click(saveButton(1));
    expect(await screen.findByText(`${t("outline.done.saved", { number: 1 })} ${note}`)).toHaveAttribute("role", "status");
  });

  it("names the chapters saved together, in the language of the app", async () => {
    await open({ chapters: 3, frozen: [1, 2], plan: [planned(1), planned(2), planned(3)], mode: "notify" });
    edit(1);
    edit(2);
    fireEvent.click(screen.getByRole("button", { name: t("outline.actions.saveAll") }));
    const note = t("outline.written.notify", { count: 2, numbers: ["1", "2"] });
    expect(note).toContain(language === "en" ? "Chapters 1 and 2 are already written" : "I capitoli 1 e 2 sono già scritti");
    expect(await screen.findByText(`${t("outline.done.savedAll", { count: 2 })} ${note}`)).toBeInTheDocument();
  });
});

describe("what the Outline page says once the entry of a written chapter is saved", () => {
  it("follows the choice of the Configuration: rewritten without asking, but a chapter of the author only reported", async () => {
    await open({ chapters: 2, frozen: [1, 2], plan: [planned(1), planned(2, { imported: true })], mode: "auto" });
    edit(1);
    edit(2);
    const rewritten = t("outline.written.auto", { count: 1, numbers: ["1"] });
    const reported = t("outline.written.notify", { count: 1, numbers: ["2"] });
    expect(saveButton(1)).toHaveAccessibleDescription(rewritten);
    expect(saveButton(2)).toHaveAccessibleDescription(reported);
    fireEvent.click(screen.getByRole("button", { name: t("outline.actions.saveAll") }));
    expect(await screen.findByText(`${t("outline.done.savedAll", { count: 2 })} ${rewritten} ${reported}`)).toBeInTheDocument();
  });

  it("says nothing more for a chapter the autopilot has not closed, or has no plan of", async () => {
    await open({ chapters: 3, unwritten: [3], plan: [planned(1, { status: "writing" })] });
    for (const number of [1, 2, 3]) edit(number);
    for (const number of [1, 2, 3]) expect(saveButton(number)).not.toHaveAccessibleDescription();
    fireEvent.click(saveButton(1));
    expect(await screen.findByText(t("outline.done.saved", { number: 1 }))).toHaveAttribute("role", "status");
  });

  it("reads the freeze only of the chapters on the screen", async () => {
    const view = await open({ chapters: 60, frozen: [1, 55], plan: [] });
    await waitFor(() => expect(within(entryOf(1)).getByText(t("outline.status.frozen"))).toBeInTheDocument());
    const read = new Set(view.chaptersRead());
    expect(read.size).toBe(50);
    expect(read.has(`chapters/${slugOf(50)}/chapter.md`)).toBe(true);
    expect(read.has(`chapters/${slugOf(55)}/chapter.md`)).toBe(false);
  });
});
