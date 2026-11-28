import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, designSnapshotChange, outlineChapterPath, readDesignSnapshot, serializeOutlineBook, serializeOutlineChapter, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// Phase 4 of #108 in the Studio: the versions of the Synopsis and the Bible, kept when the author approves a design or asks, compared with the files as they are, and
// restored only once confirmed.

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  book: null as unknown,
  structure: null as unknown,
  runtime: {
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    pause: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    refresh: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  },
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/autopilot/useBookFiles", () => ({ useBookFiles: () => ({ files: new Map(), failed: false }) }));

import i18n from "@/i18n";
import "@/i18n/outline";
import "@/i18n/design";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotStore } from "@/autopilot/store";
import { OutlinePage } from "@/pages/OutlinePage";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const at = "2026-11-26T09:00:00.000Z";

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/outline?tab=studio"]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<OutlinePage />} /></Routes>
    </MemoryRouter>
  );
}

async function open(files: Record<string, string>) {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main" };
  render(<Page />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
}

/** A design the director approved at its second review, with what the reviewers said in each. */
function readyState(): AutopilotState {
  const state = createAutopilotState(new Date(at), { idea: IDEA });
  state.concept = { done: true, generated: true, secrets: [] };
  state.plan = { chapters: [1, 2].map((number) => ({ number, title: `Chapter ${number}`, slug: `00${number}-chapter-${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [] }) as PlannedChapter), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true };
  state.design = {
    startedAt: at, chapters: 2, endedAt: at, outcome: "target", review: { targetScore: 8 },
    rounds: [
      { round: 1, score: 6.5, verdict: "revise", readers: 7, critical: 1, findings: 0, at, texts: { summary: "The reveal costs Mira nothing.", counterProposal: "Reveal the wall in chapter 3, through Orrin.", changes: ["Chapter 2: make the reveal cost Mira her trust."], critical: ["Critical — Chapter 1: Orrin cannot know yet."], readers: [{ slug: "tess", name: "Tess", score: 7, text: "I would read it.", counterProposal: "Open on the flood." }] } },
      { round: 2, score: 8.5, verdict: "approve", readers: 7.5, critical: 0, findings: 0, at, texts: { summary: "Now the reveal hurts." } },
    ],
  };
  state.status = "paused";
  return state;
}

const entry = (number: number, body: string) => serializeOutlineChapter({ number, title: `Chapter ${number}`, body, origin: "author" });
const BIBLE_WORLD = "---\ntype: bible\nid: bible:world\nrules:\n  - Glass breaks.\n---\n";

beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.book = { ...BOOK };
  mocks.runtime.start = vi.fn(async () => undefined);
  mocks.runtime.pause = vi.fn(async () => undefined);
  mocks.runtime.refresh = vi.fn(async () => null);
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
});

afterEach(() => cleanup());

const history = () => waitFor(() => {
  const found = document.querySelector<HTMLElement>("[data-design-history]");
  if (!found) throw new Error("no history yet");
  return found;
});
const versionsIn = (store: MemoryBookStore) => [...store.files.keys()].filter((path) => path.startsWith("history/design/")).sort();

describe("the versions of the Synopsis and the Bible", () => {
  it("are kept when the author approves the design and when the author asks, the newest first", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), [outlineChapterPath(1)]: entry(1, "One."), "bible/world.md": BIBLE_WORLD, "autopilot/state.json": JSON.stringify(readyState()) });
    const section = await history();
    await waitFor(() => expect(section).toHaveTextContent(t("design.history.none")));
    const ready = document.querySelector<HTMLElement>("[data-design-ready]")!;
    fireEvent.click(within(ready).getByRole("button", { name: t("design.studio.ready.approve") }));
    await waitFor(() => expect(versionsIn(mocks.store)).toHaveLength(1));
    const approved = readDesignSnapshot(mocks.store.files.get(versionsIn(mocks.store)[0]))!;
    expect(approved.reason).toBe("approved");
    expect(approved.run).toBe(at);
    expect(Object.keys(approved.files)).toEqual(["bible/world.md", "outline/book.md", "outline/chapters/001.md"]);
    expect(approved.files["outline/book.md"], "the version is of the design as it was approved").toContain("design_approved");
    fireEvent.click(within(section).getByRole("button", { name: t("design.history.save") }));
    await waitFor(() => expect(section.querySelector("[data-history-outcome='saved']")).not.toBeNull());
    await waitFor(() => expect(section.querySelectorAll("[data-history-version]")).toHaveLength(2));
    expect([...section.querySelectorAll("[data-history-version]")].map((item) => item.getAttribute("data-history-version"))).toEqual(["request", "approved"]);
  });

  it("are compared with the files as they are now, file by file, and restored only once the author confirms, keeping the files as they were in a version first", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), [outlineChapterPath(1)]: entry(1, "One."), "bible/world.md": BIBLE_WORLD });
    const section = await history();
    fireEvent.click(within(section).getByRole("button", { name: t("design.history.save") }));
    await waitFor(() => expect(section.querySelectorAll("[data-history-version]")).toHaveLength(1));
    // Meanwhile chapter 1 is rewritten and chapter 2 is added.
    const one = await mocks.store.read(outlineChapterPath(1));
    await mocks.store.commit([{ path: outlineChapterPath(1), content: entry(1, "One, rewritten."), expectedHash: one!.hash }, { path: outlineChapterPath(2), content: entry(2, "Two."), expectedHash: null }], "The author writes");
    const version = section.querySelector<HTMLElement>("[data-history-version]")!;
    fireEvent.click(within(version).getByRole("button", { name: t("design.history.compare") }));
    await waitFor(() => expect(version).toHaveTextContent(t("design.history.differences", { count: 2 })));
    expect([...version.querySelectorAll("[data-history-item]")].map((item) => [item.getAttribute("data-history-item"), item.querySelector("code")?.textContent])).toEqual([["changed", "outline/chapters/001.md"], ["removed", "outline/chapters/002.md"]]);
    fireEvent.click(within(version.querySelector<HTMLElement>("[data-history-item='changed']")!).getByText("outline/chapters/001.md"));
    expect(version.querySelector("[data-history-item='changed']")).toHaveTextContent("One, rewritten.");
    fireEvent.click(within(version).getByRole("button", { name: t("design.history.restore") }));
    await waitFor(() => expect(within(version).getByText(t("design.history.ask", { count: 2 })), "the question takes the focus of the button it replaces").toHaveFocus());
    fireEvent.click(within(version).getByRole("button", { name: t("design.history.cancel") }));
    await waitFor(() => expect(within(version).getByRole("button", { name: t("design.history.restore") }), "and gives it back when the author lets it be").toHaveFocus());
    fireEvent.click(within(version).getByRole("button", { name: t("design.history.restore") }));
    expect(mocks.store.files.get(outlineChapterPath(2)), "nothing is written before the confirmation").toBeDefined();
    fireEvent.click(within(version).getByRole("button", { name: t("design.history.confirm") }));
    await waitFor(() => expect(section.querySelector("[data-history-outcome='restored']")).toHaveTextContent(t("design.history.outcome.restored", { count: 2 })));
    expect(section.querySelector("[data-history-outcome='restored']"), "the outcome has the focus once the confirmation is gone").toHaveFocus();
    expect(mocks.store.files.get(outlineChapterPath(1))).toBe(entry(1, "One."));
    expect(mocks.store.files.has(outlineChapterPath(2))).toBe(false);
    const journal = mocks.store.files.get("outline/changes.yml")!;
    expect(journal, "the restore is a series of the journal of the Synopsis, by the author").toMatch(/by: author/);
    expect(journal).toContain("Restore the version of");
    const kept = versionsIn(mocks.store).map((path) => readDesignSnapshot(mocks.store.files.get(path))!);
    const before = kept.find((snapshot) => snapshot.reason === "restore")!;
    expect(before.files[outlineChapterPath(2)], "the files as they were before the restore are a version of their own").toBe(entry(2, "Two."));
  });

  it("list the newest twenty, and say how many older ones are kept in the folder", async () => {
    const versions = Object.fromEntries(Array.from({ length: 22 }, (_, index) => {
      const change = designSnapshotChange([{ path: OUTLINE_BOOK_FILE, content: serializeOutlineBook({ body: `${IDEA} ${index}`, origin: "author" }) }], { at: new Date(Date.UTC(2026, 10, 1 + index, 12)).toISOString(), reason: "request" })!;
      return [change.path, change.content!];
    }));
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), ...versions });
    const section = await history();
    await waitFor(() => expect(section.querySelectorAll("[data-history-version]")).toHaveLength(20));
    expect(section.querySelector("[data-history-older]")).toHaveTextContent(t("design.history.older", { count: 2, folder: "history/design/" }));
    expect(section.querySelector("[data-history-version] .font-medium")).toHaveTextContent(/22/);
  });

  it("say there is nothing to restore when a version is the files as they are", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), [outlineChapterPath(1)]: entry(1, "One.") });
    const section = await history();
    fireEvent.click(within(section).getByRole("button", { name: t("design.history.save") }));
    await waitFor(() => expect(section.querySelectorAll("[data-history-version]")).toHaveLength(1));
    const version = section.querySelector<HTMLElement>("[data-history-version]")!;
    fireEvent.click(within(version).getByRole("button", { name: t("design.history.compare") }));
    await waitFor(() => expect(version).toHaveTextContent(t("design.history.same")));
    expect(within(version).queryByRole("button", { name: t("design.history.restore") })).toBeNull();
  });
});

