import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { AutopilotLauncher } from "@/components/autopilot/AutopilotLauncher";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { activityOf, finishedEvent, freezeClock, runningStep, seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, quickGroupName, t } from "./helpers/quickCommands";

const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const PREVIEW = "The keeper climbed the stairs counting the steps under his breath.";

/** Finished steps of the book, in the log and in the feed: the dock must not list them again. */
function finished(count: number): { activities: AutopilotActivity[]; feed: ReturnType<typeof finishedEvent>[] } {
  const activities = Array.from({ length: count }, (_, index) => activityOf("write", { id: `done-${index}`, title: `Writing scene ${index + 1} of chapter 4`, chapterNumber: 4, sceneNumber: index + 1, summary: `What happened in scene ${index + 1}, in words that take a long line.`, model: "fake-model" }));
  return { activities, feed: activities.map((activity, index) => finishedEvent(activity, index + 1)) };
}

const RUNNING = { status: "running", running: true, dockOpen: true, live: { activity: LIVE, characters: PREVIEW.length, preview: PREVIEW } } as const;
const dock = () => screen.queryByRole("region", { name: t("autopilot.dockTitle") });
const open = () => dock() as HTMLElement;

function Dock({ path, launcher = false }: { path: string; launcher?: boolean }) {
  return <MemoryRouter initialEntries={[path]}>{launcher && <AutopilotLauncher />}<AutopilotDock /></MemoryRouter>;
}

/** The panel open on a tab: set before it is drawn, so that nothing changes under the test while it is looked at. */
function show(path: string, tab: "live" | "book", launcher = false) {
  useAutopilotStore.setState({ dockTab: tab });
  return render(<Dock path={path} launcher={launcher} />);
}

// Changed on purpose (0.110.0): the name of the launcher says which autopilots run and how many wait ("Show what the autopilot is doing: 1 autopilot running (…)"): it is found by the words it starts with.
const launcherName = () => new RegExp(`^${t("autopilot.openDock")}`);
// Changed on purpose (0.110.0): the “Live” tab has a card for every book whose autopilot is active above the feed; the feed is what is left.
const feedItems = (panel: HTMLElement) => within(panel).queryAllByRole("listitem").filter((item) => !item.closest("[data-dock-active]"));

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ autopilotText: "full" });
  await i18n.changeLanguage("en");
});

describe("the live panel on the pages of the autopilot", () => {
  it.each(["/app/books/book-1/autopilot", "/app/autopilot"])("hides itself on %s: the page shows everything the panel would", (path) => {
    seedRun(RUNNING);
    render(<Dock path={path} />);
    expect(dock()).not.toBeInTheDocument();
  });

  it.each(["/app/books/book-1", "/app/books", "/app/books/book-1/director", "/app/settings/ai-integrations"])("stays as it was on %s", (path) => {
    seedRun(RUNNING);
    render(<Dock path={path} />);
    expect(dock()).toBeInTheDocument();
  });

  it("has a small button to bring it back, and the author can close it again, without changing what they chose for the other pages", () => {
    freezeClock();
    seedRun(RUNNING);
    render(<Dock path="/app/books/book-1/autopilot" launcher />);
    const reopen = screen.getByRole("button", { name: launcherName() });
    // A small button: an icon, without the title of the step that the band of the page already says.
    expect(reopen.textContent?.trim()).toBe("");
    expect(screen.queryByText(LIVE.title)).not.toBeInTheDocument();
    expect(reopen).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(reopen);
    expect(dock()).toBeInTheDocument();
    expect(reopen).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(within(dock()!).getByRole("button", { name: t("autopilot.close") }));
    expect(dock()).not.toBeInTheDocument();
    expect(useAutopilotStore.getState().dockOpen, "what the author chose for the other pages is left alone").toBe(true);
  });

  it("keeps the launcher as it was, with the step in words, on the other pages", () => {
    seedRun({ ...RUNNING, dockOpen: false });
    render(<Dock path="/app/books/book-1" launcher />);
    expect(screen.getByRole("button", { name: launcherName() })).toHaveTextContent(LIVE.title);
  });
});

describe("the live panel as a mini-player", () => {
  it("says what the autopilot is, what it does now, how far it is, and has its commands and the way to the page", () => {
    freezeClock();
    seedRun(RUNNING);
    show("/app/books/book-1", "book");
    const panel = open();
    expect(within(panel).getByText("Running")).toBeInTheDocument();
    expect(within(panel).getByText(LIVE.title)).toBeInTheDocument();
    expect(within(panel).getByText("1m 26s")).toBeInTheDocument();
    expect(within(panel).getByRole("progressbar", { name: t("autopilot.band.named", { label: t("autopilot.progress.chapters"), context: t("autopilot.dockTitle") }) })).toHaveAttribute("aria-valuenow", "4");
    expect(within(panel).getByRole("group", { name: quickGroupName("dock") })).toBeInTheDocument();
    expect(within(panel).getAllByRole("link", { name: t("autopilot.openPage") }).map((link) => link.getAttribute("href"))).toContain("/app/books/book-1/autopilot");
  });

  // Changed on purpose (the owner asked for «the last 2 or 3 things that were done» in the mini-player): it lists the last three steps that are over, each a
  // way to it on the page of the book, and still not the steps of the book, which are on its page, nor what they did, in long texts.
  it("lists the last three steps that are over, each a way to it on the page of the book, and not the steps of the book or their long texts", () => {
    seedRun({ ...RUNNING, ...finished(5) });
    show("/app/books/book-1", "book");
    const list = within(open()).getByRole("list", { name: t("autopilot.liveText.lastDone") });
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([expect.stringContaining("Writing scene 5 of chapter 4"), expect.stringContaining("Writing scene 4 of chapter 4"), expect.stringContaining("Writing scene 3 of chapter 4")]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["done-4", "done-3", "done-2"].map((id) => `/app/books/book-1/autopilot#task-${id}`));
    expect(screen.queryByText(/Writing scene 1 of chapter 4/)).not.toBeInTheDocument();
    expect(within(open()).queryByText(/What happened in scene/)).not.toBeInTheDocument();
  });

  it("does not list the steps of the book with «Show the text» off: they are on its page, and in the feed of everything", () => {
    act(() => { useUiStore.getState().setAutopilotText("compact"); });
    seedRun({ ...RUNNING, ...finished(5) });
    show("/app/books/book-1", "book");
    expect(screen.queryByText(/Writing scene 1 of chapter 4/)).not.toBeInTheDocument();
    expect(within(open()).queryByRole("list")).not.toBeInTheDocument();
    expect(within(open()).queryByText(/What happened in scene/)).not.toBeInTheDocument();
  });

  it("announces the step as a status that changes with the step, on a page that does not say it", () => {
    freezeClock();
    seedRun(RUNNING);
    show("/app/books/book-1", "book");
    expect(within(open()).getByText(LIVE.title).closest('[role="status"]')).not.toBeNull();
    expect(within(open()).getByText("1m 26s", { exact: false }).closest("[aria-live], [role='status']")).toBeNull();
  });

  it("does not announce it when it is brought back on the page of the autopilot: the band of the page says it, and only one place of the screen speaks", () => {
    seedRun({ ...RUNNING, dockOpen: false });
    show("/app/books/book-1/autopilot", "book", true);
    fireEvent.click(screen.getByRole("button", { name: launcherName() }));
    expect(within(open()).getByText(LIVE.title).closest('[role="status"], [aria-live]')).toBeNull();
  });

  it("shows the question of the director with a way to it, and the notices of the run, as it did", () => {
    seedRun({ status: "waiting-author", dockOpen: true, question: { id: "q-1", kind: "director", question: "Keep the ending open?", context: "", options: [], askedAt: "2026-11-21T10:00:00.000Z" } });
    show("/app/books/book-1", "book");
    expect(within(open()).getByRole("link", { name: new RegExp("Keep the ending open\\?") })).toHaveAttribute("href", "/app/books/book-1/autopilot");
  });
});

describe("the live panel, tab “Live”: the feed of every book, in short", () => {
  it("shows the last events only, one line each, without the long texts", () => {
    seedRun({ ...RUNNING, ...finished(40) });
    show("/app/books/book-1", "live");
    const items = feedItems(open());
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(12);
    for (const item of items) expect(item.querySelector(".truncate"), item.textContent ?? "").not.toBeNull();
    expect(within(open()).queryByText(/What happened in scene/)).not.toBeInTheDocument();
    // The newest first, as the feed has always been.
    expect(items[0]).toHaveTextContent("Writing scene 40 of chapter 4");
  });

  it("leads to the whole of it on the page of the autopilot, which shows every book", () => {
    seedRun({ ...RUNNING, ...finished(40) });
    show("/app/books", "live");
    expect(within(open()).getAllByRole("link", { name: t("autopilot.openPage") }).map((link) => link.getAttribute("href"))).toContain("/app/autopilot");
  });

  describe("on the pages that list the events themselves", () => {
    const OTHER = { ...LOCAL_BOOK, id: "book-2", name: "The Lighthouse Ledger" };
    const withOtherBook = () => {
      seedRun({ ...RUNNING, ...finished(5) });
      const other = finishedEvent(activityOf("write", { id: "other-1", title: "Writing scene 1 of chapter 9", chapterNumber: 9, sceneNumber: 1 }), 900, "book-2");
      act(() => {
        useSettingsStore.setState((state) => ({ settings: { ...state.settings, books: [...state.settings.books, OTHER] } }));
        useAutopilotStore.setState((state) => ({ feed: [...state.feed, { event: other, bookTitle: OTHER.name }] }));
        useAutopilotStore.getState().setPageDockOpen(true);
      });
    };

    it("leaves out the events of the book whose page it is on, which the page lists, and says so", () => {
      withOtherBook();
      show("/app/books/book-1/autopilot", "live");
      expect(within(open()).queryByText(/Writing scene 3 of chapter 4/)).not.toBeInTheDocument();
      // The events of the other books are still its business.
      expect(within(open()).getByText(/Writing scene 1 of chapter 9/)).toBeInTheDocument();
    });

    it("says the page lists the events when there is nothing else to show", () => {
      seedRun({ ...RUNNING, ...finished(5) });
      act(() => { useAutopilotStore.getState().setPageDockOpen(true); });
      show("/app/books/book-1/autopilot", "live");
      expect(within(open()).getByText(t("autopilot.dock.pageLists"))).toBeInTheDocument();
      expect(feedItems(open())).toHaveLength(0);
    });

    it("leaves out everything on the page of all the books, which lists every event", () => {
      withOtherBook();
      show("/app/autopilot", "live");
      expect(within(open()).getByText(t("autopilot.dock.pageListsAll"))).toBeInTheDocument();
      expect(feedItems(open())).toHaveLength(0);
    });

    it("lists them as ever on the pages that do not", () => {
      withOtherBook();
      act(() => { useAutopilotStore.getState().setDockOpen(true); });
      show("/app/books/book-1", "live");
      expect(within(open()).getByText(/Writing scene 3 of chapter 4/)).toBeInTheDocument();
      expect(within(open()).getByText(/Writing scene 1 of chapter 9/)).toBeInTheDocument();
      expect(within(open()).queryByText(t("autopilot.dock.pageLists"))).not.toBeInTheDocument();
    });
  });

  it("has no box of “now” of its own for the book of the page: it is in the other tab, with the commands", () => {
    seedRun(RUNNING);
    show("/app/books/book-1", "live");
    expect(screen.queryAllByText(new RegExp(`^${t("autopilot.feed.now")}$`))).toHaveLength(0);
  });
});

