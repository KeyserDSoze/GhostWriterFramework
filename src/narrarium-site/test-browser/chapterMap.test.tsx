import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { chapterFreezeRecord, createAutopilotState, renderMarkdown, serializeOutlineChapter, type AutopilotEvent, type AutopilotState, type ChapterReview, type PlannedChapter, type RevisionRequest } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.store,
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { ChapterMap } from "@/components/autopilot/map/ChapterMap";
import { useAutopilotStore } from "@/autopilot/store";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { chapter, longPlan, planOf, scene } from "./helpers/autopilotFixtures";
import { runningStep } from "./helpers/autopilotBand";
import { LOCAL_BOOK, T0, t } from "./helpers/quickCommands";

const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

/** Six chapters, between them every state a scene can be in. */
const CHAPTERS: PlannedChapter[] = [
  chapter(1, "done", { imported: true, title: "Before the storm", scenes: [scene(1, "reviewed", 1200)] }),
  chapter(2, "done", { title: "The key", score: 8.5, rounds: [{ director: 6, readers: 7.2, verdict: "revise", accepted: 3, rejected: 1 }, { director: 8.5, verdict: "approve", accepted: 0, rejected: 0 }], scenes: [scene(1, "reviewed", 900), { ...scene(2, "reviewed", 880), title: "The bell", revisions: 1 }] }),
  chapter(3, "done", { title: "The wall", score: 7, rounds: [{ director: 7, readers: 6.8, verdict: "approve", accepted: 1, rejected: 0 }], scenes: [scene(1, "reviewed", 700), scene(2, "reviewed", 650)] }),
  chapter(4, "review", { title: "The light", summary: "The lighthouse goes dark.", goal: "Close the first movement.", keyEvents: ["The light goes out"], rounds: [{ director: 5.5, readers: 6, verdict: "revise", accepted: 2, rejected: 1 }], scenes: [scene(1, "written", 800), scene(2, "written", 760), { ...scene(3, "written", 810), title: "The council" }] }),
  chapter(5, "writing", { title: "The tide", scenes: [scene(1, "written", 900), scene(2, "planned"), scene(3, "planned")] }),
  chapter(6, "planned", { title: "The council", ghostwriter: "night-owl" }),
];

const REVIEW = {
  chapterNumber: 4,
  round: 2,
  readersPending: [],
  readerScores: [{ slug: "anna", name: "Anna", score: 6, mainProblem: "The middle drags.", prioritySuggestion: "Cut the council scene short.", path: "evaluations/readers/chapters/004-chapter-4/anna.md" }],
  readersSummaryDone: true,
  findings: [
    { id: "S2-1", source: "specialist", category: "pacing", severity: "major", sceneNumber: 3, evidence: "The council talked.", anchored: true, problem: "The council scene stalls.", remediation: "Cut it to one exchange." },
    { id: "S2-2", source: "specialist", category: "continuity", severity: "critical", sceneNumber: 2, evidence: "The lamp was lit.", anchored: false, problem: "The lamp is lit and dark at once.", remediation: "Keep it dark." },
    { id: "R2-1", source: "reader", category: "character", severity: "minor", sceneNumber: 1, anchored: false, problem: "Mira's motive is unclear.", remediation: "Show why she cares.", reader: "Anna" },
  ],
  specialistsDone: true,
  directorDone: true,
  verdict: "revise",
  score: 5.5,
  summary: "Tighten the council.",
  decisions: [
    { findingId: "S2-1", action: "accept", rationale: "It stalls the chapter.", remediation: "Cut it to one exchange.", sceneNumber: 3 },
    { findingId: "S2-2", action: "accept", rationale: "A real contradiction.", remediation: "Keep it dark.", sceneNumber: 3 },
    { findingId: "R2-1", action: "reject", rationale: "Her motive is clear from chapter 2.", remediation: "" },
    { findingId: "D2-1", action: "accept", rationale: "A sharper ending.", remediation: "End on the bell.", sceneNumber: 3 },
  ],
  repairQueue: [3],
  previousFixes: [],
  history: [{ round: 1, verdict: "revise", score: 5.5, accepted: 2, rejected: 1 }],
} as ChapterReview;

const REVISION = { id: "revision-1", instruction: "Make the bell ring twice.", createdAt: T0, targets: [{ chapterNumber: 2, sceneNumber: 2, instruction: "The bell rings twice." }], cursor: 0 } as RevisionRequest;

function stateOf(chapters: PlannedChapter[] = CHAPTERS, patch: Partial<AutopilotState> = {}): AutopilotState {
  return { ...createAutopilotState(new Date(T0)), status: "paused", phase: "write", plan: planOf(chapters), review: REVIEW, revision: REVISION, version: 7, ...patch };
}

const frozen = (slug: string, title: string) => renderMarkdown({ type: "chapter", id: `chapter:${slug}`, title, frozen: chapterFreezeRecord({ at: T0, by: "autopilot", chapterBody: `# ${title}`, scenes: [{ name: "001-scene.md", body: "Text." }] }) }, `# ${title}`);

function bookFiles(): Record<string, string> {
  return {
    "chapters/001-chapter-1/chapter.md": frozen("001-chapter-1", "Before the storm"),
    "chapters/002-chapter-2/chapter.md": renderMarkdown({ type: "chapter", id: "chapter:002-chapter-2", title: "The key" }, "# The key"),
    "chapters/003-chapter-3/chapter.md": frozen("003-chapter-3", "The wall"),
    "outline/chapters/003.md": serializeOutlineChapter({ number: 3, title: "The wall", body: "The wall cracks.", origin: "author" }),
    "evaluations/director/chapters/002-chapter-2.md": renderMarkdown({ type: "director-opinion", id: "director-opinion:chapter:002-chapter-2", target_type: "chapter", target_id: "chapter:002-chapter-2", title: "2. The key", verdict: "approve", score: 8.5, source: "autopilot", created_at: at(500) }, "# Director's opinion — 2. The key\n\n## Verdict\n\n**Approve** — 8.5/10\n\nThe key turns at the right moment.\n\n## Concerns\n\n- **Major** — The ending rushes. «He ran.»\n  → Scene 2: slow the bell down.\n\n## Decisions\n\n- Accepted S1-1: the ending rushes.\n"),
  };
}

function show(state: AutopilotState = stateOf(), linked: string[] = ["002-chapter-2", "004-chapter-4"]) {
  return render(<MemoryRouter><ChapterMap bookId={LOCAL_BOOK.id} state={state} linkedSlugs={new Set(linked)} /></MemoryRouter>);
}

const grid = () => screen.getByRole("grid");
const rowOf = (number: number) => grid().querySelector<HTMLElement>(`[data-chapter="${number}"]`) as HTMLElement;
const headerOf = (number: number) => within(rowOf(number)).getByRole("rowheader");
const cellsOf = (number: number) => within(rowOf(number)).queryAllByRole("gridcell");
const statesOf = (number: number) => cellsOf(number).map((cell) => cell.getAttribute("data-state"));
const word = (state: string) => t(`autopilot.map.scene.${state}`);

beforeAll(async () => {
  await loadAutopilotTranslations();
  await import("@/autopilot/browserStore");
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  mocks.store = new MemoryBookStore(bookFiles());
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [LOCAL_BOOK] } });
  useBooksStore.setState({ structures: { [LOCAL_BOOK.id]: { ghostwriters: [{ slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" }], chapters: [] } as never } });
  useAutopilotStore.setState({ live: { [LOCAL_BOOK.id]: { activity: runningStep("write", "Writing scene 2 of chapter 5", { chapterNumber: 5, sceneNumber: 2 }), characters: 0, preview: "" } }, feed: [] });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useBooksStore.setState({ structures: {} });
  await i18n.changeLanguage("en");
});

describe("the map of the chapters", () => {
  it("is a grid of a row for each chapter and a cell for each scene, with the state of each in words, in a symbol and in colour", async () => {
    show();
    expect(grid()).toHaveAccessibleName(t("autopilot.map.label", { from: "1", to: "6", total: "6" }));
    await waitFor(() => expect(statesOf(3)).toEqual(["frozen", "frozen"]));
    expect(statesOf(1)).toEqual(["frozen"]);
    expect(statesOf(2)).toEqual(["approved", "rewrite"]);
    expect(statesOf(4)).toEqual(["review", "review", "rewrite"]);
    expect(statesOf(5)).toEqual(["written", "writing", "todo"]);
    expect(statesOf(6)).toEqual([]);
    expect(rowOf(6)).toHaveTextContent(t("autopilot.map.noScenes"));
    // Each cell says its state in words (not only in a label), and draws its symbol.
    const writing = cellsOf(5)[1];
    expect(writing).toHaveTextContent(t("autopilot.map.cell", { number: 2, state: word("writing") }));
    expect(writing.getAttribute("aria-label")).toBeNull();
    expect(writing.querySelector("svg")).not.toBeNull();
    // The symbols differ from one state to another.
    const symbols = new Set(["frozen", "approved", "rewrite", "review", "written", "writing", "todo"].map((state) => grid().querySelector(`[data-state="${state}"] svg`)?.getAttribute("class")?.match(/lucide-[\w-]+/)?.[0]));
    expect(symbols.size).toBe(7);
    // The legend says every state in words, with its symbol.
    const legend = screen.getByRole("list", { name: t("autopilot.map.legend") });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["todo", "writing", "written", "review", "approved", "rewrite", "frozen"].map(word));
  });

  it("says the state of each chapter in words, the director's vote and the rounds of review", () => {
    show();
    expect(headerOf(2)).toHaveTextContent(t("autopilot.map.chapter.rewrite"));
    expect(headerOf(2)).toHaveTextContent(t("autopilot.map.score", { score: "8.5" }));
    expect(headerOf(2)).toHaveTextContent(t("autopilot.map.rounds", { count: 2 }));
    expect(headerOf(4)).toHaveTextContent(t("autopilot.map.chapter.reviewRound", { round: 2 }));
    expect(headerOf(4)).toHaveTextContent(t("autopilot.map.rounds", { count: 1 }));
    expect(headerOf(5)).toHaveTextContent(t("autopilot.map.chapter.writing"));
    expect(headerOf(5)).toHaveTextContent(t("autopilot.map.current"));
    expect(headerOf(6)).toHaveTextContent(t("autopilot.map.chapter.planned"));
    expect(headerOf(6)).toHaveTextContent(t("autopilot.map.noScore"));
    expect(headerOf(1)).toHaveTextContent(t("autopilot.map.chapter.imported"));
  });

  it("marks the frozen chapters and the ones that follow an entry of the author's Outline", async () => {
    show();
    await waitFor(() => expect(headerOf(3)).toHaveTextContent(t("autopilot.map.frozen")));
    expect(headerOf(1)).toHaveTextContent(t("autopilot.map.frozen"));
    expect(headerOf(2)).not.toHaveTextContent(t("autopilot.map.frozen"));
    await waitFor(() => expect(headerOf(3)).toHaveTextContent(t("autopilot.map.outline")));
    expect(headerOf(2)).not.toHaveTextContent(t("autopilot.map.outline"));
  });
});

describe("the panel of a chapter", () => {
  it("opens with a click on the chapter in review: its rounds, the readers' cards, the findings with their gravity and scene, the director's decisions", () => {
    show();
    fireEvent.click(cellsOf(4)[0]);
    const panel = screen.getByRole("dialog", { name: t("autopilot.chapterPanel.title", { number: 4, title: "The light" }) });
    const rounds = within(panel).getByRole("table", { name: t("autopilot.chapterPanel.rounds.title") });
    expect(within(rounds).getAllByRole("row")).toHaveLength(2);
    expect(within(rounds).getAllByRole("row")[1]).toHaveTextContent("5.5");
    expect(within(rounds).getAllByRole("row")[1]).toHaveTextContent(t("autopilot.chapterPanel.rounds.revise"));
    expect(within(rounds).getAllByRole("row")[1]).toHaveTextContent(t("autopilot.chapterPanel.rounds.fixesValue", { accepted: 2, rejected: 1 }));

    const current = within(panel).getByRole("region", { name: t("autopilot.chapterPanel.current.title") });
    expect(current).toHaveTextContent(t("autopilot.chapterPanel.current.round", { round: 2 }));
    const anna = within(current).getByRole("article", { name: "Anna" });
    expect(anna).toHaveTextContent("6/10");
    expect(anna).toHaveTextContent("The middle drags.");
    expect(anna).toHaveTextContent("Cut the council scene short.");
    const findings = within(current).getByRole("list", { name: t("autopilot.chapterPanel.current.findings") });
    const items = within(findings).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(t("director.opinion.severity.major"));
    expect(items[0]).toHaveTextContent(t("autopilot.chapterPanel.current.scene", { number: 3 }));
    expect(items[0]).toHaveTextContent("The council scene stalls.");
    expect(items[0]).toHaveTextContent("Cut it to one exchange.");
    expect(items[1]).toHaveTextContent(t("director.opinion.severity.critical"));
    expect(items[1]).toHaveTextContent(t("autopilot.chapterPanel.current.unanchored"));
    expect(items[2]).toHaveTextContent("Anna");
    expect(items[2]).not.toHaveTextContent(t("autopilot.chapterPanel.current.unanchored"));
    const decisions = within(current).getByRole("list", { name: t("autopilot.chapterPanel.current.decisions") });
    const decided = within(decisions).getAllByRole("listitem");
    expect(decided[0]).toHaveTextContent(t("autopilot.chapterPanel.current.accepted"));
    expect(decided[0]).toHaveTextContent("It stalls the chapter.");
    expect(decided[2]).toHaveTextContent(t("autopilot.chapterPanel.current.rejected"));
    expect(decided[2]).toHaveTextContent("Her motive is clear from chapter 2.");
    expect(decided[3]).toHaveTextContent(t("autopilot.chapterPanel.current.added"));
    expect(decided[3]).toHaveTextContent("End on the bell.");
    expect(current).toHaveTextContent(t("autopilot.chapterPanel.current.verdict", { verdict: t("autopilot.chapterPanel.rounds.revise"), score: "5.5" }));
    expect(within(panel).getByRole("link", { name: t("autopilot.chapterPanel.open") })).toHaveAttribute("href", "/app/books/book-1/chapters/004-chapter-4");
  });

  it("opens with Enter on any cell, closes with Escape, and gives the focus back to the cell", async () => {
    show();
    const cell = cellsOf(2)[1];
    cell.focus();
    fireEvent.keyDown(cell, { key: "Enter" });
    const panel = screen.getByRole("dialog", { name: t("autopilot.chapterPanel.title", { number: 2, title: "The key" }) });
    // The scene the cell is: its state in words, its title, its words, how many times it was fixed.
    const scenes = within(panel).getByRole("list", { name: t("autopilot.chapterPanel.scenes.title") });
    expect(within(scenes).getAllByRole("listitem")[1]).toHaveTextContent("The bell");
    expect(within(scenes).getAllByRole("listitem")[1]).toHaveTextContent(word("rewrite"));
    expect(within(scenes).getAllByRole("listitem")[1]).toHaveTextContent(t("autopilot.chapterPanel.scenes.revisions", { count: 1 }));
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(cell).toHaveFocus());
  });

  it("shows how the votes went from round to round, as a picture said in words and as a table, and the director's last opinion when asked", async () => {
    show();
    fireEvent.click(headerOf(2));
    const panel = screen.getByRole("dialog");
    expect(within(panel).getByRole("img", { name: `${t("autopilot.chapterPanel.rounds.chart", { votes: "6 → 8.5" })} ${t("autopilot.chapterPanel.rounds.chartReaders", { score: "7.2" })}` })).toBeInTheDocument();
    const rows = within(within(panel).getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("7.2");
    expect(rows[2]).toHaveTextContent(t("autopilot.chapterPanel.rounds.approve"));
    expect(within(panel).queryByRole("region", { name: t("autopilot.chapterPanel.current.title") })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent(t("autopilot.chapterPanel.closed"));
    expect(within(panel).getByRole("link", { name: t("autopilot.chapterPanel.readers") })).toHaveAttribute("href", "/app/books/book-1/chapters/002-chapter-2/reader-evaluations");
    fireEvent.click(within(panel).getByRole("button", { name: t("autopilot.chapterPanel.opinion.show") }));
    expect(await within(panel).findByText(/The ending rushes/, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(panel).toHaveTextContent("The key turns at the right moment.");
  });

  it("says when no opinion of the director is saved for a chapter", async () => {
    show();
    fireEvent.click(headerOf(3));
    const panel = screen.getByRole("dialog");
    fireEvent.click(within(panel).getByRole("button", { name: t("autopilot.chapterPanel.opinion.show") }));
    expect(await within(panel).findByText(t("autopilot.chapterPanel.opinion.missing"), undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("of a chapter not reviewed yet says so, with what the plan says of it and its ghostwriter", () => {
    show();
    fireEvent.click(headerOf(6));
    const panel = screen.getByRole("dialog", { name: t("autopilot.chapterPanel.title", { number: 6, title: "The council" }) });
    expect(panel).toHaveTextContent(t("autopilot.chapterPanel.rounds.none"));
    expect(panel).toHaveTextContent(t("autopilot.plan.ghostwriter", { name: "Night Owl" }));
    expect(within(panel).queryByRole("link", { name: t("autopilot.chapterPanel.open") })).not.toBeInTheDocument();
  });
});

describe("the keys of the map", () => {
  it("move between the cells with the arrows, Home and End, and only one cell is in the order of the Tab key", () => {
    show();
    const focusable = () => grid().querySelectorAll("[tabindex='0']");
    expect(focusable()).toHaveLength(1);
    // The map starts on the chapter in progress.
    expect(focusable()[0]).toBe(headerOf(5));
    headerOf(1).focus();
    fireEvent.keyDown(headerOf(1), { key: "ArrowRight" });
    expect(cellsOf(1)[0]).toHaveFocus();
    fireEvent.keyDown(cellsOf(1)[0], { key: "ArrowDown" });
    expect(cellsOf(2)[0]).toHaveFocus();
    fireEvent.keyDown(cellsOf(2)[0], { key: "End" });
    expect(cellsOf(2)[1]).toHaveFocus();
    fireEvent.keyDown(cellsOf(2)[1], { key: "ArrowDown" });
    expect(cellsOf(3)[1]).toHaveFocus();
    fireEvent.keyDown(cellsOf(3)[1], { key: "ArrowDown" });
    fireEvent.keyDown(cellsOf(4)[1], { key: "ArrowDown" });
    fireEvent.keyDown(cellsOf(5)[1], { key: "ArrowDown" });
    // A chapter whose scenes are not planned has only its own cell.
    expect(headerOf(6)).toHaveFocus();
    fireEvent.keyDown(headerOf(6), { key: "Home", ctrlKey: true });
    expect(headerOf(1)).toHaveFocus();
    expect(focusable()).toHaveLength(1);
    expect(focusable()[0]).toBe(headerOf(1));
    fireEvent.keyDown(headerOf(1), { key: " " });
    expect(screen.getByRole("dialog", { name: t("autopilot.chapterPanel.title", { number: 1, title: "Before the storm" }) })).toBeInTheDocument();
  });

  it("are said once, under the map", () => {
    show();
    expect(grid().getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(grid().getAttribute("aria-describedby")!)).toHaveTextContent(t("autopilot.map.keys"));
  });
});

describe("a book of three thousand chapters", () => {
  it("is drawn fifty chapters at a time, fast, around the chapter in progress, without reading the book", async () => {
    const store = mocks.store as MemoryBookStore;
    const list = vi.spyOn(store, "list");
    const readMany = vi.spyOn(store, "readMany");
    const state = stateOf(longPlan(3000, 1234), { review: null, revision: null });
    useAutopilotStore.setState({ live: { [LOCAL_BOOK.id]: { activity: runningStep("write", "Writing scene 1 of chapter 1235", { chapterNumber: 1235, sceneNumber: 1 }), characters: 0, preview: "" } } });
    const timings: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cleanup();
      const started = performance.now();
      show(state);
      timings.push(performance.now() - started);
    }
    // Generous: a busy machine slows one draw down.
    expect(Math.min(...timings)).toBeLessThan(400);
    expect(grid().querySelectorAll("[role='row']")).toHaveLength(50);
    expect(rowOf(1235)).not.toBeNull();
    expect(screen.getByText(t("autopilot.map.window.range", { from: "1,201", to: "1,250", total: "3,000" }))).toBeInTheDocument();
    expect(grid()).toHaveAttribute("aria-rowcount", "3000");
    expect(rowOf(1201)).toHaveAttribute("aria-rowindex", "1201");

    fireEvent.click(screen.getByRole("button", { name: t("autopilot.map.window.next", { count: 50 }) }));
    expect(rowOf(1251)).not.toBeNull();
    expect(rowOf(1201)).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: t("autopilot.map.window.jump") }), { target: { value: "2750" } });
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.map.window.go") }));
    await waitFor(() => expect(headerOf(2750)).toHaveFocus());

    fireEvent.change(screen.getByRole("searchbox", { name: t("autopilot.map.window.filter") }), { target: { value: "Title 2999" } });
    expect(grid().querySelectorAll("[role='row']")).toHaveLength(1);
    expect(rowOf(2999)).not.toBeNull();

    await waitFor(() => expect(readMany).toHaveBeenCalled());
    expect(list).not.toHaveBeenCalled();
    for (const [paths] of readMany.mock.calls) expect((paths as string[]).length).toBeLessThanOrEqual(100);
  });

  it("is not drawn again for the text that streams, three times a second", async () => {
    let commits = 0;
    render(
      <MemoryRouter>
        <Profiler id="map" onRender={() => { commits += 1; }}>
          <ChapterMap bookId={LOCAL_BOOK.id} state={stateOf(longPlan(3000, 1234), { review: null, revision: null })} linkedSlugs={new Set()} />
        </Profiler>
      </MemoryRouter>,
    );
    await waitFor(() => expect((mocks.store as MemoryBookStore).files.size).toBeGreaterThan(0));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    commits = 0;
    for (let step = 1; step <= 30; step += 1) {
      act(() => {
        useAutopilotStore.getState().ingest({ type: "task-progress", activityId: "live-write", characters: step * 40, preview: `Words so far ${step}`, bookId: LOCAL_BOOK.id, at: at(step), seq: step } as AutopilotEvent, LOCAL_BOOK.name);
      });
    }
    expect(commits).toBe(0);
  });
});

describe("the table of the chapters", () => {
  it("says the same as the map in a real table, and opens the same panel", async () => {
    show();
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.map.view.table") }));
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    const table = screen.getByRole("table", { name: t("autopilot.map.table.caption", { from: "1", to: "6", total: "6" }) });
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["chapter", "state", "scenes", "director", "rounds", "notes", "details"].map((key) => t(`autopilot.map.table.${key}`)));
    const row = within(table).getByRole("row", { name: /4\. The light/ });
    expect(row).toHaveTextContent(t("autopilot.map.chapter.reviewRound", { round: 2 }));
    expect(row).toHaveTextContent(`2 ${word("review")}`);
    expect(row).toHaveTextContent(`1 ${word("rewrite")}`);
    const second = within(table).getByRole("row", { name: /2\. The key/ });
    expect(second).toHaveTextContent("8.5");
    await waitFor(() => expect(within(table).getByRole("row", { name: /3\. The wall/ })).toHaveTextContent(t("autopilot.map.frozen")));
    expect(within(table).getByRole("row", { name: /6\. The council/ })).toHaveTextContent(t("autopilot.map.noScenes"));
    fireEvent.click(within(row).getByRole("button", { name: t("autopilot.map.table.open", { number: 4 }) }));
    expect(screen.getByRole("dialog", { name: t("autopilot.chapterPanel.title", { number: 4, title: "The light" }) })).toBeInTheDocument();
    // The choice is kept for the next time.
    cleanup();
    show();
    expect(screen.getByRole("radio", { name: t("autopilot.map.view.table") })).toBeChecked();
  });
});

describe("in Italian", () => {
  it("says the states, the keys and the panel in Italian", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    show();
    expect(screen.getByRole("heading", { name: "Mappa dei capitoli" })).toBeInTheDocument();
    const legend = screen.getByRole("list", { name: "Cosa dicono i simboli" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["da scrivere", "in scrittura", "scritta", "in revisione", "approvata", "da riscrivere", "congelata"]);
    expect(cellsOf(5)[1]).toHaveTextContent("Scena 2: in scrittura");
    fireEvent.click(cellsOf(4)[0]);
    expect(screen.getByRole("dialog", { name: "Capitolo 4 · «The light»" })).toHaveTextContent("Il giro in corso");
  });
});
