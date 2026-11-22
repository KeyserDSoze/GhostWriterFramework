import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotSession, DEFAULT_BRIEF, DEFAULT_OPTIONS, summarizeAutopilotState, type AutopilotEvent, type AutopilotState } from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { presentFeedEvent, taskLabel } from "@/autopilot/format";
import { categoryOf } from "@/autopilot/timelineModel";
import { bookFileRoute, isProblemLine, problemLines, profilePageRoute, profilePagesFor } from "@/autopilot/stopReason";
import { ProfileProblemsNotice } from "@/components/autopilot/StopNotices";
import { TimelineGroupView } from "@/components/autopilot/timeline/Group";
import { PlanCard } from "@/pages/AutopilotPage";
import { SetupCard } from "@/components/autopilot/config/SetupCard";
import { useBooksStore } from "@/store/booksStore";
import type { TimelineGroup } from "@/autopilot/timelineModel";
import type { BookEntry } from "@/types/settings";
import { chapter, planOf } from "./helpers/autopilotFixtures";

type Language = "en" | "it";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const fixed = (language: Language) => i18n.getFixedT(language);

const insight = (body: Partial<Extract<AutopilotEvent, { type: "insight" }>>): AutopilotEvent => ({ type: "insight", tone: "info", title: "The engine's own words", bookId: BOOK.id, at: "2026-11-21T10:00:00.000Z", seq: 1, ...body }) as AutopilotEvent;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  useBooksStore.setState({ structures: {} });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("the insights of the engine about the outline", () => {
  it.each<Language>(["en", "it"])("say which chapter they are about, in the language of the app (%s)", (language) => {
    const t = fixed(language);
    for (const code of ["outlineChanged", "outlineRemoved", "outlineWrittenChanged", "outlineWarnings"] as const) {
      const text = presentFeedEvent(t, insight({ code, chapterNumber: 7 }))?.text ?? "";
      expect(text, code).toContain("7");
      expect(text, code).not.toBe("The engine's own words");
      expect(text, code).not.toContain("{{");
    }
    const ghost = presentFeedEvent(t, insight({ code: "outlineGhostwriter", chapterNumber: 3, ghostwriter: "night-owl", tone: "warning" }))?.text ?? "";
    expect(ghost).toContain("3");
    expect(ghost).toContain("night-owl");
  });

  it("keeps the engine's own words when an older event carries the code without the chapter", () => {
    expect(presentFeedEvent(fixed("it"), insight({ code: "outlineChanged" }))?.text).toBe("The engine's own words");
  });

  it("is said differently in Italian, never copied from English", () => {
    for (const code of ["outlineGhostwriter", "outlineChanged", "outlineRemoved", "outlineWrittenChanged", "outlineWarnings"]) {
      expect(fixed("it")(`autopilot.insight.${code}`), code).not.toBe(fixed("en")(`autopilot.insight.${code}`));
    }
  });
});

describe("the step that plans a chapter again from the outline", () => {
  it("has a name with its chapter in both languages and belongs to the writing", () => {
    expect(taskLabel(fixed("en"), "replan", 4)).toBe("Replanning chapter 4");
    expect(taskLabel(fixed("it"), "replan", 4)).toBe("Ripianificazione del capitolo 4");
    expect(categoryOf("replan")).toBe("writing");
  });
});

describe("a stop for an evaluation style that cannot be read", () => {
  const problem = "evaluation-guidelines.md: the frontmatter is not valid YAML (line 2: bad indentation): the profile could not be read as the file says; correct the file.";
  const message = `Correct this profile before resuming: the autopilot does not use a profile it cannot read as it is written. ${problem}`;

  it("lists the file as a problem and leads to the Evaluation style page", () => {
    expect(isProblemLine(problem)).toBe(true);
    expect(problemLines(message)).toEqual([problem]);
    expect(profilePagesFor([problem])).toEqual(["evaluationStyle"]);
    expect(profilePageRoute("book-1", "evaluationStyle")).toBe("/app/books/book-1/evaluation-style");
    expect(bookFileRoute("book-1", "evaluation-guidelines.md")).toBe("/app/books/book-1/evaluation-style");
  });

  it("offers the link next to the director, the ghostwriters and the readers when nothing more precise is named", () => {
    expect(profilePagesFor(["something the page does not recognise"])).toEqual(["director", "ghostwriters", "readers", "evaluationStyle"]);
  });

  it("is what the engine really says when the file is broken", async () => {
    const store = new MemoryBookStore({ ...seedBookFiles(), "evaluation-guidelines.md": "---\ncriteria:\n  voice: [unclosed\n---\n\nBe strict.\n" });
    const session = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "test", retryDelayMs: 0 });
    await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
    await session.waitForIdle();
    const summary = summarizeAutopilotState((await session.snapshot()).state!);
    expect(summary.status).toBe("waiting-author");
    const lines = problemLines(summary.message);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(isProblemLine)).toBe(true);
    expect(profilePagesFor(lines)).toEqual(["evaluationStyle"]);
  });

  it.each<Language>(["en", "it"])("shows the link in the notice (%s)", async (language) => {
    await act(async () => { await i18n.changeLanguage(language); });
    render(<MemoryRouter><ProfileProblemsNotice bookId="book-1" message={message} /></MemoryRouter>);
    const link = screen.getByRole("link", { name: fixed(language)("autopilot.profileProblems.openEvaluationStyle") });
    expect(link).toHaveAttribute("href", "/app/books/book-1/evaluation-style");
  });
});

describe("the files of the outline named in a message", () => {
  it("open the Outline page, on the entry when it is one", () => {
    expect(bookFileRoute("book-1", "outline/book.md")).toBe("/app/books/book-1/outline");
    expect(bookFileRoute("book-1", "outline/chapters/007.md")).toBe("/app/books/book-1/outline#outline-chapter-7");
    expect(bookFileRoute("book-1", "outline/chapters/1500.md")).toBe("/app/books/book-1/outline#outline-chapter-1500");
  });
});

describe("the plan and the history", () => {
  const structure = { ghostwriters: [{ slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" }], chapters: [] };

  it("say the ghostwriter of a chapter when it is not the book's, and only then", () => {
    useBooksStore.setState({ structures: { "book-1": structure as never } });
    render(<MemoryRouter><PlanCard bookId="book-1" plan={planOf([chapter(1, "done"), chapter(2, "planned", { ghostwriter: "night-owl" })])} reviewNumber={undefined} linkedSlugs={new Set()} /></MemoryRouter>);
    const second = screen.getByText("Chapter title 2").closest("summary") as HTMLElement;
    expect(within(second).getByText(fixed("en")("autopilot.plan.ghostwriter", { name: "Night Owl" }))).toBeInTheDocument();
    const first = screen.getByText("Chapter title 1").closest("summary") as HTMLElement;
    expect(within(first).queryByText(/Night Owl/)).toBeNull();
  });

  it("say which chapters left the plan because their entry was deleted from the outline", () => {
    render(<MemoryRouter><PlanCard bookId="book-1" plan={{ ...planOf([chapter(1, "done"), chapter(3, "planned")]), removedChapters: [2, 5] }} reviewNumber={undefined} linkedSlugs={new Set()} /></MemoryRouter>);
    const note = screen.getByText(fixed("en")("autopilot.plan.removed", { count: 2, numbers: "2, 5" }));
    expect(note).toBeInTheDocument();
    expect(screen.getByRole("link", { name: fixed("en")("autopilot.plan.openOutline") })).toHaveAttribute("href", "/app/books/book-1/outline");
  });

  it("names the ghostwriter in the header of a chapter in the history", () => {
    const group = { key: "chapter:2:1", kind: "chapter", chapterNumber: 2, round: 1, rows: [], steps: 0, failed: 0, problems: 0, result: null, running: false, at: 0 } as unknown as TimelineGroup;
    render(<ol><TimelineGroupView group={group} open={false} onToggle={() => undefined} chapterTitle={() => "The key"} chapterGhostwriter={() => "Night Owl"} /></ol>);
    expect(screen.getByText(/Night Owl/)).toHaveTextContent(fixed("en")("autopilot.plan.ghostwriter", { name: "Night Owl" }));
  });
});

describe("the settings of the autopilot", () => {
  const runtime = { start: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
  const run = vi.fn(async (_name: string, action: (runtime: unknown, bookId: string) => Promise<unknown>) => {
    await action(runtime, BOOK.id);
    return true;
  });
  const state = (options: Partial<typeof DEFAULT_OPTIONS> = {}) => ({ brief: { ...DEFAULT_BRIEF, idea: "Glass" }, options: { ...DEFAULT_OPTIONS, ...options } }) as unknown as AutopilotState;

  beforeEach(() => {
    runtime.start.mockClear();
    runtime.configure.mockClear();
  });

  it("fill the outline with the plan unless the author turns it off", async () => {
    render(<MemoryRouter><SetupCard book={BOOK} state={null} existingChapters={0} running={false} busy={false} disabled={false} run={run as never} /></MemoryRouter>);
    const toggle = screen.getByRole("switch", { name: fixed("en")("autopilot.setup.fillOutline") });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: fixed("en")("autopilot.actions.start") }));
    await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
    expect(runtime.start).toHaveBeenCalledWith(BOOK.id, expect.objectContaining({ options: expect.objectContaining({ fillOutline: false }) }));
  });

  it("read an older state without the option as on", () => {
    const older = state();
    delete (older.options as Partial<typeof DEFAULT_OPTIONS>).fillOutline;
    render(<MemoryRouter><SetupCard book={BOOK} state={older} existingChapters={0} running={false} busy={false} disabled={false} run={run as never} /></MemoryRouter>);
    expect(screen.getByRole("switch", { name: fixed("en")("autopilot.setup.fillOutline") })).toHaveAttribute("aria-checked", "true");
  });

  it.each<Language>(["en", "it"])("point from the chapter-by-chapter synopsis to the outline (%s)", async (language) => {
    await act(async () => { await i18n.changeLanguage(language); });
    render(<MemoryRouter><SetupCard book={BOOK} state={null} existingChapters={0} running={false} busy={false} disabled={false} run={run as never} /></MemoryRouter>);
    const synopsis = screen.getByLabelText(fixed(language)("autopilot.setup.synopsis"));
    const note = document.getElementById(synopsis.getAttribute("aria-describedby") ?? "");
    expect(note).toHaveTextContent(fixed(language)("autopilot.setup.synopsisOutline"));
    expect(screen.getByRole("link", { name: fixed(language)("autopilot.setup.useOutline") })).toHaveAttribute("href", "/app/books/book-1/outline");
  });
});
