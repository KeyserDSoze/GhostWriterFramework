import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity, AutopilotEvent } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
  save: vi.fn(async () => true),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { AutopilotSettingsPage } from "@/pages/AutopilotSettingsPage";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { judgedPlan, longPlan, planOf } from "./helpers/autopilotFixtures";
import { activityOf, eventOf, finishedEvent, runningStep, seedRun, stubWidth } from "./helpers/autopilotBand";
import { richHistory } from "./helpers/autopilotTimeline";
import { LOCAL_BOOK, T0, makeRuntime, quickName, t } from "./helpers/quickCommands";

const PREVIEW = "The keeper climbed the stairs counting the steps under his breath and on every landing the wind changed its note in the stairwell.";
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });

/** A run that has gone on for a while: finished steps in the log and in the feed, so that every place that lists them has something to list. */
function history(): { activities: AutopilotActivity[]; feed: AutopilotEvent[] } {
  const activities = [1, 2, 3].map((index) => activityOf("write", { id: `done-${index}`, title: `Writing scene ${index} of chapter 4 «Scene ${index}»`, chapterNumber: 4, sceneNumber: index, summary: `What happened in scene ${index} of the fourth chapter.`, model: "fake-model" }));
  return { activities, feed: activities.map((activity, index) => finishedEvent(activity, index + 1)) };
}

function Page({ path = "/app/books/book-1/autopilot" }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

function PageWithDock() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<><AutopilotPage /><AutopilotDock /></>} /></Routes>
    </MemoryRouter>
  );
}

const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const section = (title: string) => screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;

function insideClosedDetails(element: Element): boolean {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
      const summary = node.querySelector(":scope > summary");
      if (!(summary && summary.contains(element))) return true;
    }
  }
  return false;
}

/** Every text of 15 characters or more that is written more than once on the screen, outside the parts that are left out. */
function repeatedTexts(ignored: Element[] = []): string[] {
  const seen = new Map<string, number>();
  for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
    if (element.children.length > 0 || ignored.some((part) => part.contains(element))) continue;
    if (element.closest("[aria-hidden='true'], .sr-only, [hidden], script, style, option") || insideClosedDetails(element)) continue;
    const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (text.length >= 15) seen.set(text, (seen.get(text) ?? 0) + 1);
  }
  return [...seen].filter(([, count]) => count > 1).map(([text]) => text);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), intervene: vi.fn(async () => undefined), reset: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = undefined;
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("what used to be on the page twice", () => {
  // Changed on purpose (the owner asked for the last lines of the text in the band): the band shows the end of the text that streams in its lines, and the
  // timeline adds the text whole only when there is more of it than the lines hold. Never the same text twice.
  it("has one box for what happens now, wherever the history is listed", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: PREVIEW.length, preview: PREVIEW }, ...history() });
    const short = render(<Page />);
    expect(screen.getAllByText(/^Now$/i)).toHaveLength(1);
    // A short text is said once, in the lines of the band.
    const once = screen.getAllByText(PREVIEW.slice(-60), { exact: false });
    expect(once).toHaveLength(1);
    expect(bandOf()).toContainElement(once[0]);
    short.unmount();

    const long = Array.from({ length: 4 }, () => PREVIEW).join(" ");
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: long.length, preview: long }, ...history() });
    render(<Page />);
    // A longer one: its end in the band, the whole in the timeline. Two places, and never the same text twice.
    const places = screen.getAllByText(long.slice(-60), { exact: false });
    expect(places).toHaveLength(2);
    expect(new Set(places.map((place) => place.textContent)).size).toBe(2);
    expect(bandOf().contains(places[0]) || bandOf().contains(places[1])).toBe(true);
  });

  it("says once that the plan is ready, and once what the author can do about it", () => {
    const chapters = longPlan(12, 0, () => "planned");
    seedRun({
      status: "paused",
      chapters,
      message: "The plan is ready: read it and resume when you want.",
      statePatch: { plan: { ...planOf(chapters), awaitingAuthor: true } },
    });
    render(<Page />);
    expect(screen.getAllByText(/^The plan is ready/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: quickName(t("autopilot.actions.approvePlan")) })).toHaveLength(1);
  });

  it.each(["concept", "plan", "write", "review", "final"] as const)("has no card titled after the phase (%s), so that the plan is never on the page twice", (phase) => {
    const chapters = longPlan(12, phase === "final" ? 12 : 3, phase === "plan" ? () => "planned" : undefined);
    seedRun({ status: "paused", phase, chapters });
    render(<Page />);
    const names = screen.getAllByRole("heading").map((heading) => heading.textContent?.trim());
    expect(names.filter((name, index) => names.indexOf(name) !== index), "headings used twice").toEqual([]);
    // The card that says what the plan is has the name of the plan; no other has the name of the phase.
    const label = t(`autopilot.phase.${phase}`);
    if (label !== t("autopilot.plan.title")) expect(names).not.toContain(label);
  });

  it("says the message about the state once: the one the autopilot left when it paused at the end of a chapter", () => {
    seedRun({ status: "paused", message: "Chapter 4 approved: read it and resume.", activities: [activityOf("consolidate", { chapterNumber: 4 })] });
    render(<Page />);
    expect(screen.getAllByText("Chapter 4 approved: read it and resume.")).toHaveLength(1);
  });

  it("does not say that the run is complete three times: the status, the message and the result say it together, in different words", () => {
    seedRun({ status: "completed", phase: "completed", chapters: longPlan(12, 12), message: "The book is complete.", statePatch: { finalDone: true } });
    render(<Page />);
    expect(screen.queryByText("The book is complete.")).not.toBeInTheDocument();
    expect(within(bandOf()).getAllByText("Completed")).toHaveLength(1);
  });

  /** A run that stopped on an error of a kind the engine told, after the same step failed `count` times in a row. */
  function classifiedError(kind: "network" | "rate_limit" = "network", count = 4): Parameters<typeof seedRun>[0] {
    const detail = { endpoint: "https://api.openai.com", model: "gpt-4.1", provider: "openai", integration: "ai-1", ...(kind === "rate_limit" ? { status: 429 } : {}), attempt: Math.min(count, 3), retries: 3 };
    const message = kind === "network" ? "Connection error." : "429 Rate limit reached for gpt-4.1.";
    const log = Array.from({ length: count }, (_, index) => activityOf("write", { id: `fail-${index}`, title: "Writing scene 2 of chapter 5 «Scene 2»", chapterNumber: 5, sceneNumber: 2, status: "failed", error: message, errorKind: kind, errorDetail: detail, startedAt: `2026-11-21T10:0${index}:00.000Z`, endedAt: `2026-11-21T10:0${index}:10.000Z` }));
    return { status: "error", activities: log, feed: log.map((activity, index) => eventOf({ type: "task-finished", activity }, index + 1)), statePatch: { lastError: { message, at: "2026-11-21T10:03:10.000Z", task: "write", errorKind: kind, errorDetail: detail } } };
  }

  const withHistory = (seed: Parameters<typeof seedRun>[0]): Parameters<typeof seedRun>[0] => {
    const rich = richHistory();
    return { ...seed, activities: [...(seed.activities ?? []), ...rich.activities], feed: [...(seed.feed ?? []), ...rich.feed] };
  };

  const SCENES: Array<[string, Parameters<typeof seedRun>[0]]> = [
    ["a run in the middle of a chapter", { status: "running", running: true, live: { activity: LIVE, characters: PREVIEW.length, preview: PREVIEW }, ...history() }],
    ["a plan that waits for the author", { status: "paused", message: "The plan is ready: read it and resume when you want.", chapters: longPlan(12, 0, () => "planned"), statePatch: { plan: { ...planOf(longPlan(12, 0, () => "planned")), awaitingAuthor: true } } }],
    ["a question from the director", { status: "waiting-author", message: "The director has a question for you.", question: { id: "q-1", kind: "director", question: "Keep the ending open?", context: "The readers disagree.", options: ["Yes", "No"], askedAt: T0 } }],
    ["a chapter that was just closed", { status: "paused", message: "Chapter 4 approved: read it and resume.", activities: [activityOf("consolidate", { chapterNumber: 4, title: "Closing chapter 4" })] }],
    ["an error", { status: "error", message: "The provider answered 429: rate limit exceeded.", statePatch: { lastError: { message: "The provider answered 429: rate limit exceeded.", at: T0, task: "write" } } }],
    ["an error the engine classified, said four times in a row", classifiedError()],
    ["a failure that the runner is going to try again", { ...classifiedError("rate_limit", 2), status: "running", running: true, statePatch: {}, retry: { at: "2026-11-21T10:00:36.000Z", attempt: 2, retries: 3 } }],
    ["a wait of «Retry later», between two restarts", { ...classifiedError("rate_limit", 4), status: "running", running: true, statePatch: {}, options: { longRetry: { everyMinutes: 10, cycles: 3 } }, retry: { at: "2026-11-21T10:13:10.000Z", attempt: 3, retries: 3, longTerm: { cycle: 2, cycles: 3 } } }],
    ["a book that is complete", { status: "completed", phase: "completed", chapters: longPlan(12, 12), message: "The book is complete.", statePatch: { finalDone: true }, activities: [activityOf("final", { summary: "approve 8/10 — The arc holds." })] }],
    ["a book that is complete, with everything the engine says of it", { status: "completed", phase: "completed", chapters: judgedPlan(12).map((entry, index) => ({ ...entry, score: [8, 8, 9, 6, 9, 7, 8, 5, 9, 8, 9, 8][index] })), message: "The book is complete.", statePatch: { finalDone: true, finalReview: { verdict: "revise", score: 7, text: "Good, but the middle drags: chapters 8 to 11 repeat the same beat.", at: T0 } }, stats: { workedMs: 13_260_000, cost: 17.62, aiCalls: 366 }, activities: [activityOf("final", { summary: "revise 7/10 — Good, but the middle drags." })] }],
  ];

  // The history is one list now, and part of the scan: nothing on the page is said twice, from the band to the last group.
  it.each(SCENES)("shows no text twice on the screen, the history included: %s", (name, seed) => {
    seedRun(withHistory(seed));
    render(<Page />);
    // Changed on purpose (the approval of the plan): while the plan waits for the author its own screen takes the place of the history, and is part of the scan.
    const main = name === "a plan that waits for the author" ? t("autopilot.approval.title") : t("autopilot.activity.title");
    expect(screen.getByRole("heading", { name: main })).toBeInTheDocument();
    expect(repeatedTexts()).toEqual([]);
  });

  it.each(["a run in the middle of a chapter", "a book that is complete"])("shows no text twice on the screen in Italian, too: %s", async (name) => {
    await i18n.changeLanguage("it");
    const seed = SCENES.find(([title]) => title === name)![1];
    seedRun(withHistory(seed));
    render(<Page />);
    expect(screen.getByRole("heading", { name: "Tutto ciò che è successo" })).toBeInTheDocument();
    expect(repeatedTexts()).toEqual([]);
  });

  it("says what is empty in the rules card in its own words, one for the rules and one for the guidance of the director", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const rules = section(t("autopilot.rules.title"));
    const texts = [t("autopilot.rules.noConstraints"), t("autopilot.rules.noNotes")];
    expect(new Set(texts).size).toBe(2);
    for (const text of texts) expect(within(rules).getByText(text)).toBeInTheDocument();
  });

  it("shows no text twice with the Timeline tab open, on a page that has tabs", async () => {
    stubWidth(700);
    seedRun(withHistory({ status: "running", running: true, live: { activity: LIVE, characters: PREVIEW.length, preview: PREVIEW } }));
    render(<Page />);
    const tab = screen.getByRole("tab", { name: t("autopilot.tabs.timeline") });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
    expect(repeatedTexts()).toEqual([]);
  });

  it("has one history, one list, and no second card for the live feed, in the two columns and in the tabs", async () => {
    seedRun(withHistory({ status: "running", running: true, live: { activity: LIVE } }));
    const wide = render(<Page />);
    expect(document.querySelectorAll("[data-autopilot-timeline]")).toHaveLength(1);
    expect(document.querySelector("[data-autopilot-main]")).toContainElement(document.querySelector("[data-autopilot-timeline]") as HTMLElement);
    expect(screen.queryByRole("heading", { name: t("autopilot.dockLive") })).not.toBeInTheDocument();
    wide.unmount();

    stubWidth(700);
    render(<Page />);
    const tab = screen.getByRole("tab", { name: t("autopilot.tabs.timeline") });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(document.querySelectorAll("[data-autopilot-timeline]")).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: t("autopilot.dockLive") })).not.toBeInTheDocument();
  });
});

describe("the band and the mini-player on the screen together (the author brought the mini-player back on the page)", () => {
  const nameOf = (element: Element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  const together = () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: PREVIEW.length, preview: PREVIEW }, ...history() });
    act(() => { useAutopilotStore.getState().setPageDockOpen(true); });
    render(<PageWithDock />);
    return screen.getByRole("region", { name: t("autopilot.dockTitle") });
  };

  it("have names of their own: the progress bars, the groups of commands, the buttons and the links of one are told from the other's", () => {
    const dock = together();
    const names = [bandOf(), dock].flatMap((part) => ["progressbar", "group", "button", "link"].flatMap((role) => within(part).queryAllByRole(role).map(nameOf)));
    expect(names.length).toBeGreaterThan(8);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("announce the step that runs once: the band does it, and the mini-player on the page leaves it to the band", () => {
    together();
    expect(document.querySelectorAll("[data-band-now] [role='status']")).toHaveLength(1);
  });
});

describe("what comes first on the page", () => {
  it("puts the question of the director right under the band, and the history after it", () => {
    // The history is a card once the book has run a step: a book that never ran has one line in its place (see the tests of the empty cards at rest).
    seedRun({ status: "waiting-author", message: "The director has a question for you.", question: { id: "q-1", kind: "director", question: "Keep the ending open?", context: "", options: ["Yes", "No"], askedAt: T0 }, activities: [activityOf("consolidate", { chapterNumber: 4 })] });
    render(<Page />);
    const question = screen.getByText("Keep the ending open?").closest("section") as HTMLElement;
    expect(bandOf().compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(question.compareDocumentPosition(section(t("autopilot.activity.title"))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(question.compareDocumentPosition(section(t("autopilot.plan.title"))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The main action of the band points at it.
    expect(within(bandOf()).getByRole("link", { name: quickName(t("autopilot.quick.run.answer")) })).toHaveAttribute("href", "/app/books/book-1/autopilot#autopilot-question");
  });

  it("puts the error with its action under the band, and not twice", () => {
    seedRun({ status: "error", message: "The provider failed.", statePatch: { lastError: { message: "The provider failed. See book/chapter-1/001.md.", at: T0, task: "write" } } });
    render(<Page />);
    const notice = screen.getByText(/The provider failed/, { selector: "p span, p" }).closest('[role="alert"]') as HTMLElement;
    expect(bandOf().compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(/The provider failed/)).toHaveLength(1);
  });

  // Changed on purpose (the menu in groups): the settings moved to the configuration of the autopilot, a page of their own.
  it("keeps the secondary things in a column of their own, after the history: the plan, the rules and where it runs", () => {
    seedRun({ status: "paused", activities: [activityOf("consolidate", { chapterNumber: 4 })] });
    render(<Page />);
    const side = document.querySelector<HTMLElement>("[data-autopilot-side]") as HTMLElement;
    expect(side, "a secondary column").not.toBeNull();
    for (const title of [t("autopilot.plan.title"), t("autopilot.rules.title"), t("autopilot.where.title")]) expect(side).toContainElement(screen.getByRole("heading", { name: title }));
    expect(screen.queryByLabelText(t("autopilot.setup.idea")), "the brief is in the configuration").not.toBeInTheDocument();
    const main = document.querySelector<HTMLElement>("[data-autopilot-main]") as HTMLElement;
    expect(main).toContainElement(section(t("autopilot.activity.title")));
    expect(main).not.toContainElement(section(t("autopilot.plan.title")));
  });

  it("makes the secondary cards quieter than the band: smaller titles, no shadow", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const rules = section(t("autopilot.rules.title"));
    expect(rules.className).not.toMatch(/\bshadow-/);
    expect(screen.getByRole("heading", { name: t("autopilot.rules.title") }).className).toMatch(/\btext-sm\b/);
    expect(bandOf().className).toMatch(/\bshadow-(sm|md|lg)\b/);
  });
});

describe("intervening", () => {
  it("is a button that opens its own form, not a card with a form as tall as the state", async () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE } });
    render(<Page />);
    expect(screen.queryByPlaceholderText(t("autopilot.intervention.placeholder"))).not.toBeInTheDocument();
    const open = screen.getByRole("button", { name: t("autopilot.actions.intervene") });
    expect(open).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(open);

    const dialog = await screen.findByRole("dialog", { name: t("autopilot.intervention.title") });
    const text = within(dialog).getByPlaceholderText(t("autopilot.intervention.placeholder"));
    fireEvent.change(text, { target: { value: "Keep the tone ironic." } });
    fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(t("autopilot.intervention.scope.from_now")) }));
    fireEvent.click(within(dialog).getByRole("button", { name: t("autopilot.intervention.recordWhileRunning") }));
    await waitFor(() => expect(mocks.runtime.intervene).toHaveBeenCalledWith("book-1", { scope: "from_now", text: "Keep the tone ironic.", interrupt: false }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("is where it was in the page for a run that is stopped: record, or record and continue", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.intervene") }));
    const dialog = await screen.findByRole("dialog", { name: t("autopilot.intervention.title") });
    fireEvent.change(within(dialog).getByPlaceholderText(t("autopilot.intervention.placeholder")), { target: { value: "Shorter scenes." } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("autopilot.intervention.recordAndContinue") }));
    await waitFor(() => expect(mocks.runtime.intervene).toHaveBeenCalledWith("book-1", { scope: "next_step", text: "Shorter scenes.", interrupt: false }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });
});

describe("the danger zone", () => {
  // Changed on purpose (the menu in groups): the reset is the last section of the configuration of the autopilot, with the same question
  // before it forgets anything (see autopilotSettingsPage.test.tsx). The live page has none.
  it("is not on the live page: it is in the configuration", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(screen.queryByRole("region", { name: t("autopilot.danger.title") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.actions.reset") })).not.toBeInTheDocument();
  });

  it("is not there while the autopilot runs: it cannot be reset then", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE } });
    render(<Page />);
    expect(screen.queryByRole("region", { name: t("autopilot.danger.title") })).not.toBeInTheDocument();
  });
});

describe("the end of a chapter", () => {
  const closed = () => ({ status: "paused" as const, message: "Chapter 4 approved: read it and resume.", activities: [activityOf("consolidate", { chapterNumber: 4 })] });
  const structure = (slugs: string[]) => ({ chapters: slugs.map((slug) => ({ slug, title: slug, paragraphs: [{}] })) });

  it("has a button to read the chapter next to Resume, so that “read it and resume” can be done", () => {
    mocks.structure = structure(["004-chapter-4"]);
    seedRun(closed());
    render(<Page />);
    const resume = within(bandOf()).getByRole("button", { name: quickName(t("autopilot.actions.resume")) });
    const read = within(bandOf()).getByRole("link", { name: t("autopilot.actions.readChapter", { number: 4 }) });
    expect(read).toHaveAttribute("href", "/app/books/book-1/chapters/004-chapter-4");
    expect(resume.parentElement).toBe(read.parentElement);
  });

  it("has no button for a chapter the book does not have", () => {
    mocks.structure = structure(["001-chapter-1"]);
    seedRun(closed());
    render(<Page />);
    expect(screen.queryByRole("link", { name: /Read chapter/ })).not.toBeInTheDocument();
  });

  it("has none while the run goes on, or when the last step was not the closing of a chapter", () => {
    mocks.structure = structure(["004-chapter-4"]);
    seedRun({ status: "running", running: true, live: { activity: LIVE }, activities: [activityOf("consolidate", { chapterNumber: 4 })] });
    const view = render(<Page />);
    expect(screen.queryByRole("link", { name: /Read chapter/ })).not.toBeInTheDocument();
    view.unmount();
    seedRun({ status: "paused", activities: [activityOf("consolidate", { chapterNumber: 4 }), activityOf("write", { chapterNumber: 5 })] });
    render(<Page />);
    expect(screen.queryByRole("link", { name: /Read chapter/ })).not.toBeInTheDocument();
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    mocks.structure = structure(["004-chapter-4"]);
    seedRun(closed());
    render(<Page />);
    expect(within(bandOf()).getByRole("link", { name: "Leggi il capitolo 4" })).toBeInTheDocument();
  });
});

describe("a book that is finished", () => {
  const FINAL = activityOf("final", { phase: "final", title: "The director reviews the whole book", summary: "approve 8/10 — The arc holds: the ledger pays off in the last chapter.", startedAt: "2026-11-21T10:00:00.000Z", endedAt: "2026-11-21T10:00:41.000Z" })
  const done = (patch: Parameters<typeof seedRun>[0] = {}) => seedRun({
    status: "completed",
    phase: "completed",
    chapters: longPlan(12, 12),
    message: "The book is complete.",
    statePatch: { finalDone: true },
    stats: { cost: 17.62, aiCalls: 366 },
    activities: [activityOf("write", { startedAt: "2026-11-21T09:00:00.000Z", endedAt: "2026-11-21T10:01:00.000Z" }), FINAL],
    ...patch,
  });
  const resultOf = () => document.querySelector<HTMLElement>("[data-autopilot-result]") as HTMLElement;
  const figure = (label: string) => within(resultOf()).getByText(label, { selector: "dt" }).closest("div")?.querySelector("dd") as HTMLElement;

  it("does not offer to resume a book that is complete: the main action is to add chapters", () => {
    done();
    render(<Page />);
    const group = within(bandOf()).getByRole("group", { name: /Quick commands/ });
    expect(within(group).queryByRole("button", { name: quickName(t("autopilot.actions.resume")) })).not.toBeInTheDocument();
    const add = within(group).getByRole("link", { name: quickName(t("autopilot.actions.addChapters")) });
    expect(add.className).toMatch(/(^|\s)bg-primary(\s|$)/);
    // Changed on purpose: the chapters are added in the Scaletta, where their entries are written; the configuration has no number of chapters.
    expect(add).toHaveAttribute("href", "/app/books/book-1/outline");
  });

  it("says how it went in a card of its own, right under the band: the verdict of the director on the whole book, the time, the cost, the words", () => {
    done();
    render(<Page />);
    expect(resultOf(), "a card of the result").not.toBeNull();
    expect(resultOf().closest("[data-autopilot-band]"), "not in the band").toBeNull();
    expect(resultOf()).toHaveTextContent(t("autopilot.result.verdict.approve"));
    expect(resultOf().querySelector("[data-result-score]")).toHaveTextContent("8/10");
    expect(resultOf()).toHaveTextContent("The arc holds: the ledger pays off in the last chapter.");
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent("1h 01m");
    expect(figure(t("autopilot.result.numbers.cost"))).toHaveTextContent("$17.62");
  });

  it("puts the card at the top of the content: after the band and the notices, before the history and the plan", () => {
    done();
    render(<Page />);
    const after = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(bandOf(), resultOf())).toBe(true);
    expect(after(resultOf(), section(t("autopilot.activity.title")))).toBe(true);
    expect(after(resultOf(), section(t("autopilot.plan.title")))).toBe(true);
    expect(document.querySelectorAll("[data-autopilot-result]")).toHaveLength(1);
  });

  it("has the band go on saying how far the book is, and nothing of the result: it is said once, in the card", () => {
    done();
    render(<Page />);
    expect(within(bandOf()).getByRole("progressbar", { name: t("autopilot.progress.chapters") })).toHaveAttribute("aria-valuenow", "12");
    expect(bandOf().querySelector("[data-band-result]")).toBeNull();
    expect(within(bandOf()).queryByText("The arc holds: the ledger pays off in the last chapter.")).not.toBeInTheDocument();
    expect(screen.getAllByText("The arc holds: the ledger pays off in the last chapter.")).toHaveLength(1);
  });

  it("says the working time is a minimum when the engine did not count it and the log of the steps is full: the oldest ones are no longer in it", () => {
    done({ activities: [...Array.from({ length: 199 }, (_, index) => activityOf("write", { id: `w-${index}`, startedAt: "2026-11-21T09:00:00.000Z", endedAt: "2026-11-21T09:01:00.000Z" })), FINAL] });
    render(<Page />);
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent(t("autopilot.result.numbers.timeAtLeast", { time: "3h 19m" }));
  });

  it("has no verdict to show when the final review is no longer in the log and the engine said none, and says nothing instead of making one up", () => {
    done({ activities: [] });
    render(<Page />);
    expect(resultOf().querySelector("[data-result-score]")).toBeNull();
    expect(within(resultOf()).queryByText(t("autopilot.result.verdict.title"))).not.toBeInTheDocument();
    expect(figure(t("autopilot.result.numbers.cost"))).toHaveTextContent("$17.62");
  });

  it("uses what the engine says of the book, and not the words of the log: the verdict it saved, the time it counted, the rounds it recorded", () => {
    done({
      chapters: judgedPlan(12),
      statePatch: { finalDone: true, finalReview: { verdict: "revise", score: 7, text: "Good, but the middle drags.", at: T0 } },
      stats: { cost: 17.62, aiCalls: 366, workedMs: 13_260_000 },
    });
    render(<Page />);
    expect(resultOf()).toHaveTextContent(t("autopilot.result.verdict.revise"));
    expect(resultOf().querySelector("[data-result-score]")).toHaveTextContent("7/10");
    expect(resultOf()).toHaveTextContent("Good, but the middle drags.");
    expect(resultOf()).not.toHaveTextContent("The arc holds");
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent("3h 41m");
    expect(within(resultOf()).getByRole("columnheader", { name: t("autopilot.result.scores.round", { number: 3 }) })).toBeInTheDocument();
  });

  // Changed on purpose (the menu in groups): the settings are a page of their own, the configuration; the number of chapters takes the focus there.
  it("takes the author to the Scaletta, where the chapters are added", async () => {
    done();
    render(
      <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
        <Routes>
          <Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} />
          <Route path="/app/books/:bookId/autopilot/settings" element={<AutopilotSettingsPage />} />
          <Route path="/app/books/:bookId/outline" element={<p>The Scaletta page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(within(bandOf()).getByRole("link", { name: quickName(t("autopilot.actions.addChapters")) }));
    expect(await screen.findByText("The Scaletta page")).toBeInTheDocument();
  });

  it("offers the same way to the settings in the card, under a name of its own: two links of one name would be one too many for a screen reader", () => {
    done();
    render(<Page />);
    const inCard = within(resultOf()).getByRole("link", { name: t("autopilot.result.actions.add") });
    const inBand = within(bandOf()).getByRole("link", { name: quickName(t("autopilot.actions.addChapters")) });
    expect(inCard).toHaveAttribute("href", inBand.getAttribute("href"));
    expect(inCard.getAttribute("aria-label") ?? inCard.textContent).not.toBe(inBand.getAttribute("aria-label"));
  });

  it("offers to add chapters to a complete book: the band does not read the Scaletta, so it never offers to write chapters that may not be there", async () => {
    done({ statePatch: { finalDone: true } });
    render(<Page />);
    const group = within(bandOf()).getByRole("group", { name: /Quick commands/ });
    expect(within(group).queryByRole("button", { name: quickName(t("autopilot.actions.writeNewChapters")) })).not.toBeInTheDocument();
    expect(within(group).getByRole("link", { name: quickName(t("autopilot.actions.addChapters")) })).toBeInTheDocument();
  });

  it("has no card of the result while the book is not finished", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(resultOf()).toBeNull();
    expect(bandOf().querySelector("[data-band-result]")).toBeNull();
  });

  it("says the card in Italian, and leads to the pages of the book in its own words", async () => {
    await i18n.changeLanguage("it");
    done();
    render(<Page />);
    expect(within(resultOf()).getByRole("heading", { level: 2, name: "Com'è venuto il libro" })).toBeInTheDocument();
    expect(within(resultOf()).getByRole("link", { name: "Leggi il libro" })).toHaveAttribute("href", "/app/books/book-1/reader");
    expect(within(resultOf()).getByRole("link", { name: "Esporta" })).toHaveAttribute("href", "/app/books/book-1/export");
  });
});

describe("a run that stopped on an error", () => {
  const failures = (count: number, message = "Connection error.") => Array.from({ length: count }, (_, index) => activityOf("write", { id: `fail-${index}`, title: "Writing scene 2 of chapter 5 «Scene 2»", chapterNumber: 5, sceneNumber: 2, status: "failed", error: message, errorKind: "network", errorDetail: { endpoint: "https://api.openai.com", model: "gpt-4.1", provider: "openai", integration: "ai-1", attempt: 3, retries: 3 }, startedAt: `2026-11-21T10:0${index}:00.000Z`, endedAt: `2026-11-21T10:0${index}:10.000Z` }));
  const failed = (count = 4) => {
    const log = failures(count);
    return seedRun({
      status: "error",
      activities: log,
      feed: [...log.map((activity, index) => eventOf({ type: "task-finished", activity }, index + 1)), eventOf({ type: "run-ended", runId: "run-1", status: "error", message: "Connection error." }, 20)],
      statePatch: { lastError: { message: "Connection error.", at: "2026-11-21T10:03:10.000Z", task: "write", errorKind: "network", errorDetail: { endpoint: "https://api.openai.com", model: "gpt-4.1", provider: "openai", integration: "ai-1", attempt: 3, retries: 3 } } },
    });
  };
  const panelOf = () => document.querySelector<HTMLElement>("[data-autopilot-error]") as HTMLElement;

  it("is one panel under the band, with one alert, where there used to be a red banner and the words said again", () => {
    failed();
    render(<Page />);
    expect(panelOf()).not.toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(screen.getByRole("alert")).getByRole("heading", { level: 2, name: t("autopilot.failure.kind.network.title") })).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.lastError"), { exact: false }), "no banner of the last error").not.toBeInTheDocument();
    expect(bandOf().compareDocumentPosition(panelOf()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says the words of the provider once on the whole page, though the step failed four times and the run ended with them: the history groups the attempts and does not say them again", () => {
    failed(4);
    render(<Page />);
    expect(screen.getAllByText("Connection error.")).toHaveLength(1);
    expect(within(panelOf()).getByText(t("autopilot.failure.repeats", { count: 4 }))).toBeInTheDocument();
  });

  it("has a band that the program can give the focus to, so that the panel can hand it over when it goes away", () => {
    failed();
    render(<Page />);
    expect(bandOf()).toHaveAttribute("tabindex", "-1");
    expect(bandOf()).toHaveAccessibleName();
  });

  it("keeps the panel above the history and the plan", () => {
    failed();
    render(<Page />);
    expect(panelOf().compareDocumentPosition(section(t("autopilot.activity.title"))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panelOf().compareDocumentPosition(section(t("autopilot.plan.title"))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is above the tabs on a page that has them, whatever tab is open", async () => {
    stubWidth(700);
    failed();
    render(<Page />);
    const tab = screen.getByRole("tab", { name: t("autopilot.tabs.timeline") });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tablist").compareDocumentPosition(panelOf()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getByRole("tabpanel")).not.toContainElement(panelOf());
  });

  it("retries with the button of the panel as the band does, and the band keeps its own", async () => {
    failed();
    render(<Page />);
    expect(within(bandOf()).getByRole("button", { name: quickName(t("autopilot.actions.retry")) })).toBeInTheDocument();
    fireEvent.click(within(panelOf()).getByRole("button", { name: quickName(t("autopilot.failure.actions.retry")) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("keeps the message of the dock short, with the way to the page that has the panel", () => {
    failed();
    useAutopilotStore.setState({ dockOpen: true, dockTab: "book" });
    render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
    const brief = screen.getAllByRole("alert");
    expect(brief).toHaveLength(1);
    expect(brief[0]).toHaveTextContent(t("autopilot.failure.kind.network.title"));
    expect(within(brief[0]).getByRole("link", { name: t("autopilot.failure.seeDetails") })).toHaveAttribute("href", "/app/books/book-1/autopilot");
    expect(screen.queryByRole("button", { name: t("autopilot.failure.actions.copy") }), "the buttons of the panel are on the page").not.toBeInTheDocument();
  });

  it("is the same panel in Italian", async () => {
    await i18n.changeLanguage("it");
    failed();
    render(<Page />);
    expect(within(screen.getByRole("alert")).getByRole("heading", { level: 2, name: "Problema di connessione" })).toBeInTheDocument();
    expect(screen.getByText("Non è riuscito 4 volte di fila.")).toBeInTheDocument();
  });
});
