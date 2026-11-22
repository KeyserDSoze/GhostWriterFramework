import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotStatus } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { longPlan } from "./helpers/autopilotFixtures";
import { eventOf, finishedEvent, freezeClock, ingest, runningStep, seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, T0, makeRuntime, quickGroupName, quickName, t } from "./helpers/quickCommands";

const PREVIEW = "The keeper climbed the stairs counting the steps under his breath, as he had for thirty years, and on every landing the wind changed its note in the stairwell. On the third floor the door to the gallery stood ajar and a thin line of light lay across the boards.";
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const RUNNING = { status: "running", running: true, live: { activity: LIVE, characters: PREVIEW.length, preview: PREVIEW } } as const;

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const nowOf = () => bandOf().querySelector<HTMLElement>("[data-band-now]") as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.book = LOCAL_BOOK;
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the control band: what happens now, how far it is, what can be done", () => {
  it("is one band at the top of the page that answers the three questions", () => {
    seedRun(RUNNING);
    render(<Page />);
    const band = bandOf();
    expect(band, "the page has a control band").not.toBeNull();
    expect(band).toHaveAccessibleName(t("autopilot.band.label", { book: LOCAL_BOOK.name }));
    // What is happening, how far it is, what the author can do.
    expect(within(band).getByText("Running")).toBeInTheDocument();
    expect(within(band).getByText(LIVE.title)).toBeInTheDocument();
    expect(within(band).getAllByRole("progressbar").length).toBeGreaterThanOrEqual(2);
    expect(within(band).getByRole("group", { name: quickGroupName() })).toBeInTheDocument();
    // It comes before everything else of the page that is not the heading.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(band.compareDocumentPosition(screen.getByText(t("autopilot.activity.title"))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stays under the header of the app while the page scrolls", () => {
    seedRun(RUNNING);
    render(<Page />);
    const wrapper = bandOf().closest("[data-autopilot-band-wrapper]") as HTMLElement;
    expect(wrapper, "the band sits in a wrapper that sticks").not.toBeNull();
    expect(wrapper.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(wrapper.className).toMatch(/(^|\s)top-0(\s|$)/);
    // The page is not drawn behind it: the wrapper has a background of its own.
    expect(wrapper.className).toMatch(/\bbg-background\b/);
  });

  it("is not drawn for a book whose autopilot never started: the form to start is all there is", () => {
    seedRun({ noState: true });
    render(<Page />);
    expect(bandOf()).toBeNull();
  });
});

describe("the state of the autopilot, in words and with an icon", () => {
  it.each<[AutopilotStatus, string]>([
    ["running", "Running"],
    ["paused", "Paused"],
    ["waiting-author", "Waiting for you"],
    ["error", "Stopped by an error"],
    ["completed", "Completed"],
    ["idle", "Ready"],
  ])("%s says %s, with an icon that is only decoration", (status, text) => {
    seedRun({ status, running: status === "running" });
    render(<Page />);
    const label = within(bandOf()).getAllByText(text).find((element) => element.closest("[data-band-status]"));
    expect(label, `"${text}" in the status of the band`).toBeDefined();
    const pill = label!.closest("[data-band-status]") as HTMLElement;
    const icon = pill.querySelector("svg");
    expect(icon, "an icon next to the words").not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(pill.textContent?.trim()).toBe(text);
  });

  it("says where it runs: this browser, or the server", () => {
    seedRun({ status: "paused" });
    const view = render(<Page />);
    expect(within(bandOf()).getByText(t("autopilot.host.browser"))).toBeInTheDocument();
    view.unmount();
    const serverBook = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    mocks.book = serverBook;
    seedRun({ book: serverBook, status: "paused", server: "online" });
    render(<Page />);
    expect(within(bandOf()).getByText(t("autopilot.host.server"))).toBeInTheDocument();
  });
});

describe("the step that runs now", () => {
  it("has one box for it, with the title of the step, where in the book it is and how long it has gone on", () => {
    freezeClock();
    seedRun(RUNNING);
    render(<Page />);
    expect(screen.getAllByText(new RegExp(`^${t("autopilot.band.now")}$`, "i")), "one box for what happens now, on the whole page").toHaveLength(1);
    const now = nowOf();
    expect(now).toContainElement(screen.getByText(LIVE.title));
    expect(within(now).getByText(t("autopilot.band.where.chapterScene", { chapter: 5, scene: 2 }))).toBeInTheDocument();
    expect(within(now).getByText("1m 26s")).toBeInTheDocument();
  });

  it("shows a single line of what is being written: the long text belongs to the history, not to the band", () => {
    seedRun(RUNNING);
    render(<Page />);
    const line = nowOf().querySelector<HTMLElement>("[data-band-preview]") as HTMLElement;
    expect(line, "a line with the text that streams").not.toBeNull();
    expect(line.className).toMatch(/\btruncate\b|\bwhitespace-nowrap\b/);
    expect(line.textContent!.length).toBeLessThanOrEqual(PREVIEW.length / 2);
    // It is the end of the text, the words that are being written now.
    expect(line.textContent).toContain("a thin line of light lay across the boards.");
    expect(line.textContent).not.toContain("The keeper climbed");
  });

  it("has a line to say it is getting ready between two steps, not an empty box", () => {
    seedRun({ status: "running", running: true, live: null });
    render(<Page />);
    expect(within(nowOf()).getByText(t("autopilot.current.preparing"))).toBeInTheDocument();
  });

  it("is announced once, as a status that changes when the step changes: never the timer, never the text that streams", async () => {
    freezeClock();
    seedRun(RUNNING);
    render(<Page />);
    const now = nowOf();
    const statuses = now.querySelectorAll('[role="status"]');
    expect(statuses, "a single status in the box").toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(LIVE.title);
    for (const part of [now.querySelector("[data-band-elapsed]"), now.querySelector("[data-band-preview]")]) {
      expect(part).not.toBeNull();
      expect(part!.closest("[aria-live]")).toBeNull();
      expect(part!.closest('[role="status"]')).toBeNull();
    }
    // The text that streams changes the line, not the announcement.
    const announced = statuses[0].textContent;
    for (let step = 1; step <= 5; step += 1) await ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: PREVIEW.length + step * 10, preview: `${PREVIEW} And then step ${step}.` }, 20 + step));
    expect(now.querySelector("[data-band-preview]")).toHaveTextContent("And then step 5.");
    expect(now.querySelector('[role="status"]')!.textContent).toBe(announced);
    // A new step changes it.
    await ingest(finishedEvent(LIVE, 30));
    await ingest(eventOf({ type: "task-started", activity: runningStep("reader", "Ada reads chapter 5", { id: "live-reader", chapterNumber: 5 }) }, 31));
    expect(nowOf().querySelector('[role="status"]')).toHaveTextContent("Ada reads chapter 5");
  });

  it("says what the status of the band is when nothing runs: the message of the autopilot, once", () => {
    seedRun({ status: "paused", message: "Chapter 4 approved: read it and resume." });
    render(<Page />);
    expect(screen.getAllByText("Chapter 4 approved: read it and resume.")).toHaveLength(1);
    expect(nowOf()).toContainElement(screen.getByText("Chapter 4 approved: read it and resume."));
  });
});

describe("how far the book is", () => {
  it("has real progress bars for the chapters and the scenes, with their numbers in words", () => {
    seedRun(RUNNING);
    render(<Page />);
    const band = bandOf();
    const chapters = within(band).getByRole("progressbar", { name: t("autopilot.progress.chapters") });
    expect(chapters).toHaveAttribute("aria-valuemin", "0");
    expect(chapters).toHaveAttribute("aria-valuemax", "12");
    expect(chapters).toHaveAttribute("aria-valuenow", "4");
    expect(chapters).toHaveAttribute("aria-valuetext", t("autopilot.band.chaptersValue", { done: 4, total: 12 }));
    const scenes = within(band).getByRole("progressbar", { name: t("autopilot.progress.scenes") });
    expect(scenes).toHaveAttribute("aria-valuemax", "24");
    expect(scenes).toHaveAttribute("aria-valuenow", "8");
    expect(scenes).toHaveAttribute("aria-valuetext", t("autopilot.band.scenesValue", { done: 8, total: 24 }));
    expect(within(band).getByText("4/12")).toBeInTheDocument();
    expect(within(band).getByText("8/24")).toBeInTheDocument();
  });

  it("shows the phases as a short list, with the one in progress marked in words and not only by its colour", () => {
    seedRun(RUNNING);
    render(<Page />);
    const phases = within(bandOf()).getByRole("list", { name: t("autopilot.band.phases.label") });
    const items = within(phases).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Concept/),
      expect.stringMatching(/^Plan/),
      expect.stringMatching(/^Chapters 4\/12/),
      expect.stringMatching(/^Final/),
    ]);
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([null, null, "step", null]);
    // Done and current have an icon and a word each; what is still to do has neither.
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[2]).toHaveTextContent(t("autopilot.band.phases.current"));
    expect(items[0]).toHaveTextContent(t("autopilot.band.phases.done"));
    expect(items[3]).not.toHaveTextContent(t("autopilot.band.phases.done"));
  });

  it.each([
    ["write", "Write", "Writing scene 2 of chapter 5"],
    ["scenes", "Write", "Planning the scenes of chapter 5"],
    ["reader", "Readers", "Ada reads chapter 5"],
    ["specialists", "Specialists", "Specialists review chapter 5 (round 1)"],
    ["director-review", "Director", "The director judges chapter 5 (round 1)"],
    ["repair", "Fix", "Applying the director's fixes to scene 2 of chapter 5"],
  ] as const)("shows the cycle of the chapter, with the step %s on %s", (task, stage, title) => {
    seedRun({ status: "running", running: true, live: { activity: runningStep(task, title, { chapterNumber: 5 }) } });
    render(<Page />);
    const cycle = within(bandOf()).getByRole("list", { name: t("autopilot.band.cycle.label", { chapter: 5 }) });
    const items = within(cycle).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " ").trim().split(" ")[0])).toEqual(["Write", "Readers", "Specialists", "Director", "Fix"]);
    const current = items.filter((item) => item.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(stage);
    // The current step has an icon and a word of its own; the steps behind it say they are done.
    expect(current[0].querySelector("svg")).not.toBeNull();
    expect(current[0]).toHaveTextContent(t("autopilot.band.cycle.current"));
    const index = items.indexOf(current[0]);
    for (const behind of items.slice(0, index)) expect(behind).toHaveTextContent(t("autopilot.band.cycle.done"));
    for (const ahead of items.slice(index + 1)) expect(ahead).not.toHaveTextContent(t("autopilot.band.cycle.done"));
  });

  it("says which round of the review it is, when the chapter is in its second round or more", () => {
    const chapters = longPlan(12, 4, (number) => (number === 5 ? "review" : undefined));
    seedRun({
      chapters,
      status: "running",
      running: true,
      review: { chapterNumber: 5, round: 2, readersPending: [], readerScores: [], readersSummaryDone: true, findings: [], specialistsDone: false, directorDone: false, decisions: [], repairQueue: [], previousFixes: [], history: [] } as never,
      live: { activity: runningStep("specialists", "Specialists review chapter 5 (round 2)", { chapterNumber: 5 }) },
    });
    render(<Page />);
    expect(within(bandOf()).getByText(t("autopilot.band.cycle.round", { round: 2 }))).toBeInTheDocument();
  });

  it("shows no cycle while the autopilot does something that is not a chapter: the plan, the final review", () => {
    seedRun({ status: "running", running: true, phase: "plan", chapters: longPlan(12, 0, () => "planned"), live: { activity: runningStep("plan", "Planning the chapters", {}) } });
    render(<Page />);
    expect(within(bandOf()).queryByRole("list", { name: /Steps of chapter|Passi del capitolo/ })).not.toBeInTheDocument();
  });

  it("keeps the cycle of a chapter that is in the middle of its review when the run is paused", () => {
    const chapters = longPlan(12, 4, (number) => (number === 5 ? "review" : undefined));
    seedRun({
      chapters,
      status: "paused",
      review: { chapterNumber: 5, round: 1, readersPending: [], readerScores: [{ slug: "ada" }], readersSummaryDone: true, findings: [], specialistsDone: true, directorDone: false, decisions: [], repairQueue: [], previousFixes: [], history: [] } as never,
    });
    render(<Page />);
    const current = within(within(bandOf()).getByRole("list", { name: t("autopilot.band.cycle.label", { chapter: 5 }) })).getAllByRole("listitem").filter((item) => item.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Director");
  });
});

describe("what it costs and how much it uses", () => {
  it("compares the cost with the budget in a bar when there is a budget", () => {
    seedRun({ ...RUNNING, options: { budgetLimit: 2 }, stats: { cost: 0.5 } });
    render(<Page />);
    const usage = bandOf().querySelector("[data-band-usage]") as HTMLElement;
    expect(usage).not.toBeNull();
    const bar = within(usage).getByRole("progressbar", { name: t("autopilot.band.usage.costBar") });
    expect(bar).toHaveAttribute("aria-valuenow", "0.5");
    expect(bar).toHaveAttribute("aria-valuemax", "2");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(usage).toHaveTextContent(t("autopilot.band.usage.costOf", { value: "$0.50", budget: "$2.00" }));
  });

  it("shows only the value of the cost when there is no budget, and still the tokens and the calls", () => {
    seedRun({ ...RUNNING, options: { budgetLimit: 0, budgetTokens: 0 }, stats: { cost: 0.5, inputTokens: 60_000, outputTokens: 20_000, aiCalls: 40 } });
    render(<Page />);
    const usage = bandOf().querySelector("[data-band-usage]") as HTMLElement;
    expect(within(usage).queryAllByRole("progressbar")).toHaveLength(0);
    expect(usage).toHaveTextContent("$0.50");
    expect(usage).toHaveTextContent(t("autopilot.band.usage.tokens", { value: "80,000" }));
    expect(usage).toHaveTextContent(t("autopilot.band.usage.calls", { count: 40 }));
  });

  it("compares the tokens with their budget too", () => {
    seedRun({ ...RUNNING, options: { budgetLimit: 0, budgetTokens: 220_000 }, stats: { inputTokens: 90_000, outputTokens: 20_000 } });
    render(<Page />);
    const usage = bandOf().querySelector("[data-band-usage]") as HTMLElement;
    const bar = within(usage).getByRole("progressbar", { name: t("autopilot.band.usage.tokensBar") });
    expect(bar).toHaveAttribute("aria-valuenow", "110000");
    expect(bar).toHaveAttribute("aria-valuemax", "220000");
  });

  it("keeps the notices of the calls it cannot count, in the same line, with the reason one step away", () => {
    seedRun({ ...RUNNING, stats: { usageUnknownCalls: 3, costUnknownCalls: 1 } });
    render(<Page />);
    const usage = bandOf().querySelector("[data-band-usage]") as HTMLElement;
    expect(within(usage).getByText("3 calls without a token count")).toBeInTheDocument();
    expect(within(usage).getByText("1 call without a price")).toBeInTheDocument();
    expect(within(usage).getByText(t("autopilot.progress.usageUnknownHint"))).toBeInTheDocument();
    expect(within(usage).getByText(t("autopilot.progress.costUnknownHint"))).toBeInTheDocument();
    // The reasons are in a disclosure: the line stays one line.
    expect(within(usage).getByText(t("autopilot.progress.usageUnknownHint")).closest("details")).not.toBeNull();
  });

  it("has no six tiles of figures any more", () => {
    seedRun(RUNNING);
    render(<Page />);
    expect(document.querySelectorAll("dl")).toHaveLength(0);
    expect(screen.queryByText("AI calls")).not.toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.progress.cost"))).not.toBeInTheDocument();
  });
});

describe("what the author can do: the one main action changes with the state", () => {
  const primary = (group: HTMLElement) => [...group.querySelectorAll<HTMLElement>("button, a[href]")].filter((control) => /(^|\s)bg-primary(\s|$)/.test(control.className));
  const waitingPlan = longPlan(12, 0, () => "planned");

  it.each<[string, Parameters<typeof seedRun>[0], string]>([
    ["pause, while it runs", RUNNING, "autopilot.actions.pause"],
    ["resume, when it is paused", { status: "paused" }, "autopilot.actions.resume"],
    ["approve the plan, when the plan waits for the author", { status: "paused", chapters: waitingPlan, statePatch: { plan: { chapters: waitingPlan, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true } } }, "autopilot.actions.approvePlan"],
    ["answer the question, when the director asked one", { status: "waiting-author", question: { id: "q", kind: "director", question: "Keep the ending open?", context: "", options: [], askedAt: T0 } }, "autopilot.quick.run.answer"],
    ["retry, when it stopped with an error", { status: "error", statePatch: { lastError: { message: "The provider failed.", at: T0, task: "write" } } }, "autopilot.actions.retry"],
  ])("is %s", (_name, seed, key) => {
    seedRun(seed);
    render(<Page />);
    const group = within(bandOf()).getByRole("group", { name: quickGroupName() });
    const button = within(group).getByRole(key === "autopilot.quick.run.answer" ? "link" : "button", { name: quickName(t(key)) });
    expect(button.className, "the main action has the colour of the main action").toMatch(/(^|\s)bg-primary(\s|$)/);
    // The only other control of that colour is the half of the split button that opens the other ways to pause.
    const others = primary(group).filter((control) => control !== button && !control.getAttribute("aria-label")?.startsWith(t("autopilot.quick.run.pauseMore")));
    expect(others.map((control) => control.getAttribute("aria-label"))).toEqual([]);
  });

  it("is the same bar of quick commands as ever, once on the page: nothing was written twice", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(document.querySelectorAll("[data-quick-commands]")).toHaveLength(1);
    expect(bandOf().querySelector("[data-quick-commands]")).not.toBeNull();
  });
});

describe("the page does not draw the band again for every piece of text that streams", () => {
  it("reads the figures of the progress and the cost only when the summary changes, not for every chunk of text", async () => {
    seedRun(RUNNING);
    const summary = useAutopilotStore.getState().summaries["book-1"];
    let reads = 0;
    const progress = summary.progress;
    const done = progress.chaptersDone;
    Object.defineProperty(progress, "chaptersDone", { enumerable: true, configurable: true, get: () => { reads += 1; return done; } });
    render(<Page />);
    const drawn = reads;
    expect(drawn).toBeGreaterThan(0);
    for (let step = 1; step <= 40; step += 1) await ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: step * 10, preview: `${PREVIEW} ${step}` }, 40 + step));
    expect(nowOf().querySelector("[data-band-preview]")).toHaveTextContent("40");
    expect(reads).toBe(drawn);
  });
});

describe("the band in Italian", () => {
  it("speaks the words of the site: passo, capitolo, in corso", async () => {
    await i18n.changeLanguage("it");
    freezeClock();
    seedRun({ ...RUNNING, options: { budgetLimit: 2 }, stats: { cost: 0.5 } });
    render(<Page />);
    const band = bandOf();
    expect(band).toHaveAccessibleName("Stato dell'autopilot — The Glass Harbor");
    expect(within(band).getByText("In esecuzione")).toBeInTheDocument();
    expect(within(band).getByText("Ora")).toBeInTheDocument();
    expect(within(band).getByText("Capitolo 5 · scena 2")).toBeInTheDocument();
    expect(within(band).getByRole("progressbar", { name: "Capitoli approvati" })).toHaveAttribute("aria-valuetext", "4 capitoli approvati su 12");
    expect(within(band).getByRole("progressbar", { name: "Scene scritte" })).toHaveAttribute("aria-valuetext", "8 scene scritte su 24");
    expect(within(band).getByRole("list", { name: "Passi del capitolo 5" })).toBeInTheDocument();
    expect(within(band).getByText("Lettori")).toBeInTheDocument();
    expect(within(band).getByRole("button", { name: "Pausa dopo questo passo — The Glass Harbor" })).toBeInTheDocument();
  });
});

