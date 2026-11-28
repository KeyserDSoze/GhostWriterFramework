import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, outlineChapterPath, outlineEntryDigest, parseMarkdown, readOutlineChapter, serializeBibleWorld, captureDecision, setDecisionStatus, readBibleDecisions, readBibleThreads, serializeOutlineBook, serializeOutlineChapter, wholeDesignPatch, outlineDesignOf, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { polyfillRadix } from "./helpers/radix";

// The Synopsis page with its tabs: the design of an entry in its card, the Studio (the design run of the autopilot: the dialog that starts it, its progress, the design ready
// to approve or to write from) and the Bible (the book's files composed, the rules of the world edited, the findings of the checks).

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
import "@/i18n/bibleStudio";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotStore } from "@/autopilot/store";
import { OutlinePage } from "@/pages/OutlinePage";
import type { BookEntry } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const at = "2026-11-26T09:00:00.000Z";
let search = "";
function Where() {
  search = useLocation().search;
  return null;
}

function Page({ path = "/app/books/book-1/outline" }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/books/:bookId/outline" element={<><OutlinePage /><Where /></>} /></Routes>
    </MemoryRouter>
  );
}

async function open(files: Record<string, string>, path?: string) {
  mocks.store = new MemoryBookStore(files);
  mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriter: "default", ghostwriters: [], chapters: [], readerPersonas: [], loadedBranch: "main" };
  render(<Page path={path} />);
  await screen.findByRole("heading", { level: 1, name: t("outline.title") });
  await waitFor(() => expect(screen.queryByText(t("outline.loading"))).not.toBeInTheDocument());
}

async function designed(number: number, title: string) {
  const design = { goal: `Goal of chapter ${number}.`, pov: ["Mira Vale"], characters: ["Mira Vale"], setting: "Glass Harbor", events: [`Event ${number}`], ending: "A door closes.", reveals: number === 2 ? ["The Wall Is Failing"] : [] };
  const patch = wholeDesignPatch(design);
  const body = `Summary of chapter ${number}.`;
  const digest = await outlineEntryDigest({ title, body, design: outlineDesignOf({ design: patch }) });
  return serializeOutlineChapter({ number, title, body, design: patch, origin: "autopilot", digest });
}

function readyState(): AutopilotState {
  const state = createAutopilotState(new Date(at), { idea: IDEA });
  state.concept = { done: true, generated: true, secrets: [{ slug: "the-wall", title: "The Wall Is Failing", revealChapter: 2 }] };
  state.plan = { chapters: [1, 2].map((number) => ({ number, title: `Chapter ${number}`, slug: `00${number}-chapter-${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [] }) as PlannedChapter), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true };
  state.design = { startedAt: at, chapters: 2, rounds: [{ round: 1, score: 7, verdict: "revise", critical: 1, findings: 2, at }, { round: 2, score: 8.5, verdict: "approve", critical: 0, findings: 0, at }], endedAt: at, outcome: "target" };
  state.status = "paused";
  return state;
}


vi.mock("@/autopilot/browserStore", async (original) => ({ ...await original<typeof import("@/autopilot/browserStore")>(), createBrowserBookStore: () => mocks.store }));

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

const NOW = new Date("2026-11-28T08:00:00.000Z");
const BIBLE = "/app/books/book-1/outline?tab=bible";

async function bible(files: Record<string, string>, path = BIBLE) {
  await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), ...files }, path);
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-bible]");
    if (!found) throw new Error("not read yet");
    return found;
  });
}

const content = (result: unknown) => (result as { content: string }).content;
/** A log with two decisions (one locked) and one open question. */
function log(): string {
  let text = content(captureDecision(null, { decision: "Elio is the keeper's son.", reason: "The second act depends on it.", chapters: [3], by: "author", status: "locked" }, NOW));
  text = content(captureDecision(text, { decision: "Mara leaves in the end.", by: "brainstorming" }, NOW));
  return text.replace(/\n---\n/, "\nquestions:\n  - { id: q-001, question: Who sent the letter?, by: director, date: 2026-11-27 }\n---\n");
}

describe("the decisions and the open questions", () => {
  it("lists the log with who made each decision and what it covers, and locks one at the author's word: the file is written, a lock is the author's act", async () => {
    const root = await bible({ "bible/decisions.md": log() });
    const section = root.querySelector<HTMLElement>("#bible-decisions")!;
    const rows = [...section.querySelectorAll<HTMLElement>("[data-decision]")];
    expect(rows.map((row) => [row.dataset.decision, row.dataset.decisionStatus])).toEqual([["d-001", "locked"], ["d-002", "open"]]);
    expect(rows[0]).toHaveTextContent("Elio is the keeper's son.");
    expect(rows[0]).toHaveTextContent("Why: The second act depends on it.");
    expect(rows[0]).toHaveTextContent("Covers: chapters 3");
    expect(rows[1]).toHaveTextContent("by Brainstorming");
    fireEvent.click(within(section).getByRole("button", { name: t("bibleStudio.decisions.lockFor", { id: "d-002" }) }));
    await waitFor(() => expect(readBibleDecisions(mocks.store.files.get("bible/decisions.md")).value.decisions.map((decision) => decision.status)).toEqual(["locked", "locked"]));
    expect(await within(section).findByText(t("bibleStudio.decisions.locking", { id: "d-002" }))).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: t("bibleStudio.decisions.unlockFor", { id: "d-001" }) }));
    await waitFor(() => expect(readBibleDecisions(mocks.store.files.get("bible/decisions.md")).value.decisions.map((decision) => decision.status)).toEqual(["open", "locked"]));
    // The filter shows only the locked ones.
    fireEvent.change(within(section).getByLabelText(t("bibleStudio.decisions.filterLabel")), { target: { value: "locked" } });
    expect([...section.querySelectorAll<HTMLElement>("[data-decision]")].map((row) => row.dataset.decision)).toEqual(["d-002"]);
  });

  it("warns that a lock does not bind the autopilot of a book on a server that does not announce the decisions, and says nothing when it does", async () => {
    mocks.book = { ...BOOK, autopilotHost: "server" };
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { features: ["autopilot", "autopilot-design"] } as never } }));
    let root = await bible({ "bible/decisions.md": log() });
    expect(root.querySelector("[data-server-without-decisions]")).toHaveTextContent(t("bibleStudio.decisions.serverWithout"));
    cleanup();
    useAutopilotStore.setState((state) => ({ server: { ...state.server, info: { features: ["autopilot", "bible-decisions"] } as never } }));
    root = await bible({ "bible/decisions.md": log() });
    expect(root.querySelector("[data-server-without-decisions]")).toBeNull();
  });

  it("captures a decision with its chapters and the phrases it forbids, open or locked at once, in a book that has no log yet", async () => {
    const root = await bible({});
    const section = root.querySelector<HTMLElement>("#bible-decisions")!;
    expect(section).toHaveTextContent(t("bibleStudio.decisions.empty"));
    fireEvent.change(within(section).getByLabelText(t("bibleStudio.decisions.add.decision")), { target: { value: "The sea is never named." } });
    fireEvent.change(within(section).getByLabelText(t("bibleStudio.decisions.add.chapters")), { target: { value: "1, 2; 2" } });
    fireEvent.change(within(section).getByLabelText(t("bibleStudio.decisions.add.avoid")), { target: { value: "the Atlantic\nthe North Sea" } });
    fireEvent.click(within(section).getByRole("button", { name: t("bibleStudio.decisions.add.captureLocked") }));
    await waitFor(() => expect(mocks.store.files.has("bible/decisions.md")).toBe(true));
    const [decision] = readBibleDecisions(mocks.store.files.get("bible/decisions.md")).value.decisions;
    expect(decision).toMatchObject({ id: "d-001", decision: "The sea is never named.", by: "author", status: "locked", chapters: [1, 2], avoid: ["the Atlantic", "the North Sea"] });
    await waitFor(() => expect(section.querySelector("[data-decision='d-001'][data-decision-status='locked']")).not.toBeNull());
    expect(within(section).getByLabelText(t("bibleStudio.decisions.add.decision"))).toHaveValue("");
  });

  it("answers an open question, and records the answer as a locked decision when the author says so", async () => {
    const root = await bible({ "bible/decisions.md": log() });
    const questions = root.querySelector<HTMLElement>("[data-bible-questions]")!;
    expect(questions.querySelector("[data-question='q-001']")).toHaveTextContent("Who sent the letter?");
    expect(questions.querySelector("[data-question='q-001']")).toHaveTextContent("by the director");
    fireEvent.change(within(questions).getByLabelText(t("bibleStudio.questions.answerFor", { id: "q-001" })), { target: { value: "The harbour master." } });
    fireEvent.click(within(questions).getByLabelText(t("bibleStudio.questions.alsoDecision")));
    fireEvent.click(within(questions).getByRole("button", { name: t("bibleStudio.questions.send") }));
    await waitFor(() => expect(readBibleDecisions(mocks.store.files.get("bible/decisions.md")).value.questions[0].status).toBe("answered"));
    const value = readBibleDecisions(mocks.store.files.get("bible/decisions.md")).value;
    expect(value.questions[0].answer).toBe("The harbour master.");
    expect(value.decisions[value.decisions.length - 1]).toMatchObject({ decision: "The harbour master.", status: "locked", by: "author" });
  });

  it("does not overwrite a log that changed elsewhere: it says so, reads it again, and nothing is lost", async () => {
    const root = await bible({ "bible/decisions.md": log() });
    const section = root.querySelector<HTMLElement>("#bible-decisions")!;
    // Another tab locks a decision first.
    mocks.store.files.set("bible/decisions.md", setDecisionStatus(log(), "d-002", "locked")!);
    fireEvent.click(within(section).getByRole("button", { name: t("bibleStudio.decisions.lockFor", { id: "d-002" }) }));
    expect(await within(section).findByText(t("design.bible.conflict"))).toBeInTheDocument();
    expect(readBibleDecisions(mocks.store.files.get("bible/decisions.md")).value.decisions[1].status).toBe("locked");
  });
});

describe("the threads of setup and payoff", () => {
  it("adds a thread, saves the file, and the checks say when a thread is planted and never paid", async () => {
    const root = await bible({});
    const section = root.querySelector<HTMLElement>("#bible-threads")!;
    expect(section).toHaveTextContent(t("bibleStudio.threads.empty"));
    fireEvent.click(within(section).getByRole("button", { name: t("bibleStudio.threads.add") }));
    fireEvent.change(within(section).getByLabelText(t("bibleStudio.threads.title")), { target: { value: "The keeper's lamp" } });
    fireEvent.change(within(section).getByLabelText(t("bibleStudio.threads.setup")), { target: { value: "2" } });
    fireEvent.click(within(section).getByRole("button", { name: t("bibleStudio.threads.save") }));
    await waitFor(() => expect(mocks.store.files.has("bible/threads.md")).toBe(true));
    expect(readBibleThreads(mocks.store.files.get("bible/threads.md")).value.threads).toEqual([{ id: "t-001", title: "The keeper's lamp", setup: { chapter: 2, note: "" }, status: "open" }]);
    const checks = root.querySelector<HTMLElement>("[data-bible-checks]")!;
    await waitFor(() => expect(checks.querySelector("[data-design-finding='thread-without-payoff']")).not.toBeNull());
    expect(checks).toHaveTextContent("The thread «The keeper's lamp» is set up in chapter 2 and has no payoff");
  });
});

describe("tone and audience, the timeline and the guidelines", () => {
  it("saves the audience beside the tone, keeping what the file has", async () => {
    const root = await bible({ "bible/themes.md": "---\ntype: bible\nid: bible:themes\nthemes:\n  - truth\ntone: Tense\nowner: me\n---\n\nMy notes.\n" });
    const section = root.querySelector<HTMLElement>("#bible-themes")!;
    fireEvent.change(within(section).getByLabelText(t("bibleStudio.themes.audience")), { target: { value: "Adults who read slow mysteries" } });
    fireEvent.click(within(section).getByRole("button", { name: t("design.bible.themes.save") }));
    await waitFor(() => expect(mocks.store.files.get("bible/themes.md")).toContain("audience: Adults who read slow mysteries"));
    expect(mocks.store.files.get("bible/themes.md")).toMatch(/owner: me[\s\S]*My notes\./);
  });

  it("shows the events of the timeline in the order of their dates, with their chapter, and what the checks say when an event disagrees with its chapter", async () => {
    const root = await bible({
      "timelines/events/fair.md": "---\ntype: timeline-event\ntitle: The fair\ndate: 1348-06-01\nparticipants: [Mira Vale]\n---\n\nThe fair opens.\n",
      "timelines/events/storm.md": "---\ntype: timeline-event\ntitle: The great storm\ndate: 1348-03-15\nreveal_in: chapter:002-storm\n---\n\nThe storm.\n",
      "timelines/events/ghost.md": "---\ntype: timeline-event\ntitle: An undated event\n---\n",
      [outlineChapterPath(2)]: serializeOutlineChapter({ number: 2, title: "Storm", body: "x", design: wholeDesignPatch({ goal: "g", pov: ["Mira Vale"], events: ["e"], ending: "x", time: "1348-04-02" }), origin: "author" }),
      "characters/mira-vale.md": "---\ntype: character\nname: Mira Vale\n---\n",
    });
    const section = root.querySelector<HTMLElement>("#bible-timeline")!;
    expect([...section.querySelectorAll<HTMLElement>("[data-timeline-event]")].map((row) => row.dataset.timelineEvent)).toEqual(["storm", "fair", "ghost"]);
    const storm = section.querySelector<HTMLElement>("[data-timeline-event='storm']")!;
    expect(storm).toHaveTextContent("1348-03-15");
    expect(storm).toHaveTextContent(t("bibleStudio.timeline.chapter", { number: 2 }));
    await waitFor(() => expect(storm).toHaveTextContent("The timeline event «The great storm», anchored to chapter 2, has another date than the time of the chapter"));
    expect(section.querySelector("[data-timeline-event='ghost']")).toHaveTextContent(t("bibleStudio.timeline.noDate"));
  });

  it("edits a guideline in place, keeping its frontmatter", async () => {
    const root = await bible({ "guidelines/voice.md": "---\ntype: guideline\ntitle: The voice\nkeep: yes\n---\n\nWrite plainly.\n" });
    const section = root.querySelector<HTMLElement>("#bible-guidelines")!;
    const item = section.querySelector<HTMLElement>("[data-guideline='voice']")!;
    expect(item).toHaveTextContent("The voice");
    fireEvent.click(within(item).getByText("The voice"));
    fireEvent.change(within(item).getByLabelText(t("bibleStudio.guidelines.text", { title: "The voice" })), { target: { value: "Write plainly.\nNever use adverbs." } });
    fireEvent.click(within(item).getByRole("button", { name: t("bibleStudio.guidelines.save", { title: "The voice" }) }));
    await waitFor(() => expect(mocks.store.files.get("guidelines/voice.md")).toContain("Never use adverbs."));
    expect(mocks.store.files.get("guidelines/voice.md")).toMatch(/title: The voice[\s\S]*keep: yes/);
  });
});

describe("the design of every chapter, at once", () => {
  const entry = (number: number, design: Record<string, unknown>) => serializeOutlineChapter({ number, title: `Chapter ${number}`, body: `Summary ${number}`, design: wholeDesignPatch(design), origin: "author" });

  async function seeded() {
    return bible({
      [outlineChapterPath(1)]: entry(1, { goal: "Open", pov: ["Mira Vale"], events: ["She lands"], ending: "A door closes", cliffhanger: true, notes: "Slow" }),
      [outlineChapterPath(2)]: entry(2, { goal: "Turn", pov: ["Mira Vale"], events: ["The storm"] }),
      [outlineChapterPath(3)]: entry(3, { clues: ["A wet footprint"] }),
    });
  }

  it("is a table with a row for each chapter and a column for each field, the gaps in the needed fields marked in words", async () => {
    const root = await seeded();
    const table = await waitFor(() => {
      const found = root.querySelector<HTMLElement>("[data-design-table] table");
      if (!found) throw new Error("not loaded");
      return found;
    });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(18);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(table.querySelector("[data-design-row='1'] [data-field]")).toBeNull();
    const second = table.querySelector<HTMLElement>("[data-design-row='2']")!;
    // Chapter 2 has no ending: a needed field, a gap marked in words for a screen reader and in colour.
    const gaps = [...second.querySelectorAll<HTMLElement>("td[data-gap='key']")];
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toHaveTextContent(`${t("outline.design.fields.ending")} of chapter 2: ${t("bibleStudio.table.gap")}`);
    expect(table.querySelectorAll("[data-design-row='3'] td[data-gap='key']")).toHaveLength(4);
    expect(root.querySelector("[data-design-table] [role='region']")).toHaveAttribute("tabindex", "0");
  });

  it("filters the chapters: the search, only the gaps in a needed field, only the chapters missing one field, only those with a finding", async () => {
    const root = await seeded();
    const view = await waitFor(() => {
      const found = root.querySelector<HTMLElement>("[data-design-table]");
      if (!found || !found.querySelector("table")) throw new Error("not loaded");
      return found;
    });
    const rows = () => [...view.querySelectorAll<HTMLElement>("tbody tr")].map((row) => row.dataset.designRow);
    expect(rows()).toEqual(["1", "2", "3"]);
    fireEvent.click(within(view).getByLabelText(t("bibleStudio.table.filters.gaps")));
    expect(rows()).toEqual(["2", "3"]);
    fireEvent.click(within(view).getByLabelText(t("bibleStudio.table.filters.gaps")));
    fireEvent.change(within(view).getByLabelText(t("bibleStudio.table.filters.field")), { target: { value: "ending" } });
    expect(rows()).toEqual(["2", "3"]);
    fireEvent.change(within(view).getByLabelText(t("bibleStudio.table.filters.field")), { target: { value: "" } });
    fireEvent.change(within(view).getByLabelText(t("bibleStudio.table.filters.search")), { target: { value: "footprint" } });
    expect(rows()).toEqual(["3"]);
    expect(within(view).getByRole("status")).toHaveTextContent(t("bibleStudio.table.caption", { shown: 1, total: 3 }));
    fireEvent.change(within(view).getByLabelText(t("bibleStudio.table.filters.search")), { target: { value: "nothing like this" } });
    expect(within(view).getByText(t("bibleStudio.table.nothing"))).toBeInTheDocument();
    fireEvent.click(within(view).getByRole("button", { name: t("bibleStudio.table.filters.reset") }));
    expect(rows()).toEqual(["1", "2", "3"]);
  });

  it("opens a chapter in the Synopsis from its row, and says nothing but that no chapter has a design when none has", async () => {
    const root = await seeded();
    const view = await waitFor(() => {
      const found = root.querySelector<HTMLElement>("[data-design-table] table");
      if (!found) throw new Error("not loaded");
      return found;
    });
    fireEvent.click(within(view).getByRole("button", { name: t("bibleStudio.table.show", { number: 2 }) }));
    await waitFor(() => expect(search).toBe(""));
    cleanup();
    const bare = await bible({ [outlineChapterPath(1)]: serializeOutlineChapter({ number: 1, title: "One", body: "x", origin: "author" }) });
    expect(bare.querySelector("#bible-table")).toHaveTextContent(t("bibleStudio.table.empty"));
  });
});

describe("the findings of the checks and the spoilers in written text", () => {
  it("filters the findings by severity, and says them in Italian when the interface is in Italian", async () => {
    await i18n.changeLanguage("it");
    const root = await bible({
      "secrets/the-wreck.md": "---\ntype: secret\ntitle: Il naufragio\nreveal_in: chapter:003-x\n---\n\nIl custode lo ha affondato.\n",
      [outlineChapterPath(2)]: serializeOutlineChapter({ number: 2, title: "Due", body: "x", design: wholeDesignPatch({ goal: "g", pov: ["Mara"], events: ["e"], ending: "x", reveals: ["secret:the-wreck", "Il naufragio"] }), origin: "author" }),
      [outlineChapterPath(3)]: serializeOutlineChapter({ number: 3, title: "Tre", body: "x", design: wholeDesignPatch({ goal: "g", pov: ["Mara"], events: ["e"], ending: "x" }), origin: "author" }),
    });
    const checks = root.querySelector<HTMLElement>("#bible-checks")!;
    await waitFor(() => expect(checks.querySelector("[data-design-finding='reveal-too-early']")).not.toBeNull());
    expect(checks).toHaveTextContent("Il capitolo 2 fa scoprire al lettore il segreto «Il naufragio», che si rivela solo dal capitolo 3");
    const all = checks.querySelectorAll("[data-design-finding]").length;
    fireEvent.change(within(checks).getByLabelText(t("bibleStudio.decisions.filterLabel")), { target: { value: "warning" } });
    const warnings = [...checks.querySelectorAll<HTMLElement>("[data-design-finding]")];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.length).toBeLessThanOrEqual(all);
    expect(warnings.every((row) => row.dataset.findingSeverity === "warning")).toBe(true);
  });

  it("reads the written chapters when the author asks, and lists a sentence that states a secret before its reveal", async () => {
    const truth = "The keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse.";
    const root = await bible({
      "secrets/the-wreck.md": `---\ntype: secret\ntitle: The wreck of the Aurora\nreveal_in: chapter:005-the-reveal\n---\n\n${truth}\n`,
      "chapters/002-the-pier/chapter.md": "---\ntype: chapter\nid: chapter:002-the-pier\nnumber: 2\ntitle: The pier\n---\n\n# The pier\n",
      "chapters/002-the-pier/001-dinner.md": `---\ntype: paragraph\nid: paragraph:002-the-pier:001-dinner\nchapter: chapter:002-the-pier\nnumber: 1\ntitle: Dinner\n---\n\nTam said it plainly. ${truth}\n`,
    });
    const checks = root.querySelector<HTMLElement>("#bible-checks")!;
    const button = await within(checks).findByRole("button", { name: t("bibleStudio.checks.spoilers.run") });
    expect(checks.querySelector("[data-design-finding='spoiler-in-prose']")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(checks.querySelector("[data-design-finding='spoiler-in-prose']")).not.toBeNull());
    expect(checks).toHaveTextContent("The written text of chapter 2 states the secret «The wreck of the Aurora» before its reveal (chapter 5)");
    expect(checks.querySelector("[data-spoiler-summary]")).toHaveTextContent("Read 1 written chapters: 1 possible early statements.");
  });
});

describe("the Studio says what the book has agreed", () => {
  it("counts the locked decisions, the open questions and the findings, and opens the Bible", async () => {
    await open({ [OUTLINE_BOOK_FILE]: serializeOutlineBook({ body: IDEA, origin: "author" }), "bible/decisions.md": log() }, "/app/books/book-1/outline?tab=studio");
    const agreed = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-studio-agreed]");
      if (!found) throw new Error("not read yet");
      return found;
    });
    expect(agreed.querySelector("[data-agreed='locked']")).toHaveTextContent("1 locked decision");
    expect(agreed.querySelector("[data-agreed='questions']")).toHaveTextContent("1 open question");
    fireEvent.click(within(agreed).getByRole("button", { name: t("bibleStudio.studio.open") }));
    await screen.findByRole("heading", { name: t("design.bible.title") });
    expect(search).toBe("?tab=bible");
  });
});
