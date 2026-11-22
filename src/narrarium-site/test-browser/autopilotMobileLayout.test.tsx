import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
  save: vi.fn(async () => true),
}));

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
import { freezeClock, runningStep, seedRun, stubWidth } from "./helpers/autopilotBand";
import { longPlan, planOf } from "./helpers/autopilotFixtures";
import { LOCAL_BOOK, T0, makeRuntime, quickGroupName, quickName, t } from "./helpers/quickCommands";

const PREVIEW = "The keeper climbed the stairs counting the steps under his breath, and on every landing the wind changed its note in the stairwell.";
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const RUNNING = { status: "running", running: true, live: { activity: LIVE, characters: PREVIEW.length, preview: PREVIEW } } as const;

function Page({ path = "/app/books/book-1/autopilot" }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const panel = () => screen.getByRole("tabpanel");
const tab = (key: string) => screen.getByRole("tab", { name: t(key) });
const TABS = ["autopilot.tabs.overview", "autopilot.tabs.timeline", "autopilot.tabs.plan", "autopilot.tabs.rules"];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), intervene: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
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

describe("the page on a phone (390 px wide)", () => {
  beforeEach(() => stubWidth(390));

  it("is a page of four tabs: Overview, Timeline, Plan, Rules, with the first open", () => {
    seedRun(RUNNING);
    render(<Page />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual(TABS.map((key) => t(key)));
    expect(tab(TABS[0])).toHaveAttribute("aria-selected", "true");
    expect(tab(TABS[1])).toHaveAttribute("aria-selected", "false");
  });

  it("has a compact band, a few short rows, that is always in sight: what the autopilot is, what it does, how long, how far", () => {
    freezeClock();
    seedRun(RUNNING);
    render(<Page />);
    const band = bandOf();
    expect(band).toHaveAttribute("data-compact");
    expect(band.closest("[data-autopilot-band-wrapper]")!.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(within(band).getByText("Running")).toBeInTheDocument();
    expect(within(band).getByText(LIVE.title)).toBeInTheDocument();
    expect(within(band).getByText("1m 26s")).toBeInTheDocument();
    expect(within(band).getByRole("progressbar", { name: t("autopilot.progress.chapters") })).toHaveAttribute("aria-valuenow", "4");
    // The rest is in the overview, and the actions are at the bottom of the screen.
    expect(within(band).queryByRole("group", { name: quickGroupName() })).not.toBeInTheDocument();
    expect(within(band).queryByRole("list")).not.toBeInTheDocument();
    expect(band.querySelector("[data-band-usage]")).toBeNull();
    expect(band.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("gives the title of the step a row as wide as the band, so that the chapter and the scene at its end are not cut off", () => {
    freezeClock();
    seedRun(RUNNING);
    render(<Page />);
    const band = bandOf();
    const title = within(band).getByText(LIVE.title);
    const pill = within(band).getByText("Running").closest("[data-band-status]") as HTMLElement;
    const firstRow = pill.parentElement as HTMLElement;
    // The first row: what the autopilot is, how many chapters are done, how long the step has gone on. The title has the row under it, alone.
    expect(firstRow).toHaveTextContent(t("autopilot.band.phases.chapters", { done: 4, total: 12 }));
    expect(firstRow).toHaveTextContent("1m 26s");
    expect(firstRow.contains(title)).toBe(false);
    expect(title.parentElement!.contains(pill)).toBe(false);
    expect(title.className).toMatch(/line-clamp-2/);
  });

  it("shows the progress as a bar under those rows, without a label of its own: the numbers are in the first row", () => {
    seedRun(RUNNING);
    render(<Page />);
    const band = bandOf();
    const bar = within(band).getByRole("progressbar", { name: t("autopilot.progress.chapters") });
    expect(bar).toHaveAttribute("aria-valuetext", t("autopilot.band.chaptersValue", { done: 4, total: 12 }));
    expect(within(band).queryByText(t("autopilot.progress.chapters"))).not.toBeInTheDocument();
    // The bar comes last in the band.
    const rows = band.firstElementChild as HTMLElement;
    expect(rows.lastElementChild!.contains(bar)).toBe(true);
  });

  it("has the actions in a bar at the bottom of the screen, the same bar of quick commands as ever", () => {
    seedRun(RUNNING);
    render(<Page />);
    const bar = document.querySelector<HTMLElement>("[data-autopilot-bottom-bar]") as HTMLElement;
    expect(bar, "a bar of actions at the bottom").not.toBeNull();
    expect(bar.className).toMatch(/(^|\s)fixed(\s|$)/);
    expect(bar.className).toMatch(/(^|\s)bottom-0(\s|$)/);
    expect(within(bar).getByRole("group", { name: quickGroupName() })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-quick-commands]")).toHaveLength(1);
  });

  it("has what does not fit in the band in the overview: the text that streams, the phases, the cycle, the cost and the use", () => {
    seedRun({ ...RUNNING, options: { budgetLimit: 2 }, stats: { cost: 0.5 } });
    render(<Page />);
    const overview = panel();
    expect(within(overview).getByRole("list", { name: t("autopilot.band.phases.label") })).toBeInTheDocument();
    expect(within(overview).getByRole("list", { name: t("autopilot.band.cycle.label", { chapter: 5 }) })).toBeInTheDocument();
    expect(overview.querySelector("[data-band-usage]")).not.toBeNull();
    expect(overview.querySelector("[data-band-preview]")).toHaveTextContent("the wind changed its note in the stairwell.");
    expect(within(overview).getByRole("button", { name: t("autopilot.actions.intervene") })).toBeInTheDocument();
    // None of it is repeated: the band does not have it.
    expect(bandOf().querySelector("[data-band-preview]")).toBeNull();
  });

  it("says where it runs at the top of the overview, since the compact band has no room for it, and says it once", () => {
    seedRun(RUNNING);
    render(<Page />);
    expect(within(panel()).getByText(t("autopilot.host.browser"))).toBeInTheDocument();
    expect(within(bandOf()).queryByText(t("autopilot.host.browser"))).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-band-host]")).toHaveLength(1);
  });

  it("has nothing of the history, the plan or the rules in the overview", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(screen.queryByRole("heading", { name: t("autopilot.activity.title") })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: t("autopilot.plan.title") })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: t("autopilot.rules.title") })).not.toBeInTheDocument();
  });

  it("has the history, and nothing else, in the Timeline tab", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    fireEvent.mouseDown(tab(TABS[1]));
    fireEvent.click(tab(TABS[1]));
    await waitFor(() => expect(tab(TABS[1])).toHaveAttribute("aria-selected", "true"));
    expect(within(panel()).getByRole("heading", { name: t("autopilot.activity.title") })).toBeInTheDocument();
    expect(within(panel()).queryByRole("heading", { name: t("autopilot.plan.title") })).not.toBeInTheDocument();
  });

  it("has the plan in the Plan tab", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    fireEvent.mouseDown(tab(TABS[2]));
    fireEvent.click(tab(TABS[2]));
    await waitFor(() => expect(within(panel()).getByRole("heading", { name: t("autopilot.plan.title") })).toBeInTheDocument());
    expect(within(panel()).queryByRole("heading", { name: t("autopilot.activity.title") })).not.toBeInTheDocument();
  });

  it("has the rules, where it runs, the settings and the danger zone in the Rules tab", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    fireEvent.mouseDown(tab(TABS[3]));
    fireEvent.click(tab(TABS[3]));
    await waitFor(() => expect(within(panel()).getByRole("heading", { name: t("autopilot.rules.title") })).toBeInTheDocument());
    expect(within(panel()).getByRole("heading", { name: t("autopilot.where.title") })).toBeInTheDocument();
    expect(within(panel()).getByText(t("autopilot.setup.settingsTitle"))).toBeInTheDocument();
    expect(within(panel()).getByRole("region", { name: t("autopilot.danger.title") })).toBeInTheDocument();
  });

  it("opens on the Plan tab while the plan waits for the author, and keeps whatever tab the person picks afterwards", async () => {
    const planned = longPlan(12, 0, () => "planned");
    seedRun({ status: "paused", chapters: planned, statePatch: { plan: { ...planOf(planned), awaitingAuthor: true } } });
    render(<Page />);
    expect(tab(TABS[2])).toHaveAttribute("aria-selected", "true");
    expect(within(panel()).getByRole("heading", { name: t("autopilot.plan.title") })).toBeInTheDocument();
    fireEvent.mouseDown(tab(TABS[1]));
    fireEvent.click(tab(TABS[1]));
    await waitFor(() => expect(tab(TABS[1])).toHaveAttribute("aria-selected", "true"));
    expect(tab(TABS[2])).toHaveAttribute("aria-selected", "false");
  });

  it("opens on the Overview when the plan does not wait for anyone", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(tab(TABS[0])).toHaveAttribute("aria-selected", "true");
  });

  it("moves from one tab to the next with the arrow keys, as every set of tabs does", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    tab(TABS[0]).focus();
    fireEvent.keyDown(tab(TABS[0]), { key: "ArrowRight" });
    await waitFor(() => expect(tab(TABS[1])).toHaveAttribute("aria-selected", "true"));
    expect(tab(TABS[1])).toHaveFocus();
    fireEvent.keyDown(tab(TABS[1]), { key: "End" });
    await waitFor(() => expect(tab(TABS[3])).toHaveAttribute("aria-selected", "true"));
  });

  it("keeps the question, the errors and the notices above the tabs, whatever tab is open", async () => {
    seedRun({ status: "waiting-author", question: { id: "q-1", kind: "director", question: "Keep the ending open?", context: "", options: [], askedAt: T0 } });
    render(<Page />);
    fireEvent.mouseDown(tab(TABS[1]));
    fireEvent.click(tab(TABS[1]));
    await waitFor(() => expect(tab(TABS[1])).toHaveAttribute("aria-selected", "true"));
    const question = screen.getByText("Keep the ending open?");
    expect(screen.getByRole("tablist").compareDocumentPosition(question) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(panel()).not.toContainElement(question);
  });

  it("opens the tab of what a link points at: “Where it runs” is in the Rules tab, and takes the focus", async () => {
    seedRun({ status: "paused", server: "online" });
    render(<Page path="/app/books/book-1/autopilot#autopilot-where" />);
    await waitFor(() => expect(tab(TABS[3])).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(document.activeElement?.id).toBe("autopilot-where"));
  });

  it("has the progress at the very top of the page, not a screen of figures far below", () => {
    seedRun(RUNNING);
    render(<Page />);
    const bar = within(bandOf()).getByRole("progressbar", { name: t("autopilot.progress.chapters") });
    const everythingBefore = [...document.querySelectorAll("section, details, [role='tablist']")].filter((part) => part.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING && !part.contains(bar));
    expect(everythingBefore.map((part) => part.getAttribute("aria-label") ?? part.className)).toEqual([]);
    expect(document.querySelectorAll("dl")).toHaveLength(0);
  });

  it("says it all in Italian", async () => {
    await i18n.changeLanguage("it");
    seedRun(RUNNING);
    render(<Page />);
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual(["Panoramica", "Cronologia", "Piano", "Regole"]);
  });
});

describe("the page on a screen that is not wide", () => {
  it("has the tabs and a band with room for its actions between 560 and 880 px, and the rest of the figures in the overview", () => {
    stubWidth(700);
    seedRun({ ...RUNNING, options: { budgetLimit: 2 }, stats: { cost: 0.5 } });
    render(<Page />);
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual(TABS.map((key) => t(key)));
    const band = bandOf();
    expect(band).not.toHaveAttribute("data-compact");
    expect(within(band).getByRole("group", { name: quickGroupName() })).toBeInTheDocument();
    expect(document.querySelector("[data-autopilot-bottom-bar]")).toBeNull();
    // The band has the state, the step and the progress of the chapters and of the scenes; the overview has the rest, once.
    expect(within(band).getAllByRole("progressbar")).toHaveLength(2);
    expect(within(band).queryByRole("list")).not.toBeInTheDocument();
    expect(band.querySelector("[data-band-usage]")).toBeNull();
    expect(band.querySelector("[data-band-preview]")).toBeNull();
    const overview = panel();
    expect(within(overview).getByRole("list", { name: t("autopilot.band.phases.label") })).toBeInTheDocument();
    expect(overview.querySelector("[data-band-usage]")).not.toBeNull();
    expect(overview.querySelector("[data-band-preview]")).not.toBeNull();
    expect(within(overview).queryAllByRole("progressbar", { name: t("autopilot.progress.scenes") })).toHaveLength(0);
  });

  it("keeps the first group of the quick commands in the band, and the other two behind “More”", () => {
    stubWidth(700);
    seedRun({ ...RUNNING, server: "online" });
    render(<Page />);
    const group = within(bandOf()).getByRole("group", { name: quickGroupName() });
    expect(within(group).getByRole("button", { name: quickName(t("autopilot.actions.pause")) })).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: quickName(t("autopilot.quick.where.label", { host: t("autopilot.quick.where.hostBrowser") })) })).not.toBeInTheDocument();
    const more = within(group).getByRole("button", { name: quickName(t("autopilot.quick.more")) });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(within(group).getByRole("button", { name: quickName(t("autopilot.quick.where.label", { host: t("autopilot.quick.where.hostBrowser") })) })).toBeInTheDocument();
  });

  it("has two columns and no tabs when the page is wide, with all the figures in the band", () => {
    stubWidth(1000);
    seedRun(RUNNING);
    render(<Page />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(document.querySelector("[data-autopilot-side]")).not.toBeNull();
    const band = bandOf();
    expect(within(band).getByRole("list", { name: t("autopilot.band.phases.label") })).toBeInTheDocument();
    expect(band.querySelector("[data-band-usage]")).not.toBeNull();
    expect(within(band).queryByRole("button", { name: quickName(t("autopilot.quick.more")) })).not.toBeInTheDocument();
  });

  it("has two columns and no tabs when the width is not known (the first draw, a test)", () => {
    seedRun(RUNNING);
    render(<Page />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});
