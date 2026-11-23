import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { GROUP_ROWS } from "@/autopilot/timelineModel";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { ingest, runningStep, seedRun, stubWidth } from "./helpers/autopilotBand";
import { chapterFlow, eventAt, resetIds, resetSeq, stepOf } from "./helpers/autopilotTimeline";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";

const PREVIEW = "The keeper climbed the stairs counting the steps under his breath, and on every landing the wind changed its note.";

/** Two chapters of a book: the fourth, closed, and the fifth, in its first round. The group of chapter 5 is the one open by default. */
function history() {
  resetIds();
  resetSeq();
  const four = chapterFlow(4, { from: 0, rounds: 1 });
  const five = chapterFlow(5, { from: four.end + 10, rounds: 1, closed: false });
  return { four: four.activities, five: five.activities, activities: [...four.activities, ...five.activities] };
}

/** Where the page is, for the tests that follow a link and look at the address. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.hash}`}</output>;
}

function Page({ hash }: { hash: string }) {
  return (
    <MemoryRouter initialEntries={[`/app/books/book-1/autopilot${hash}`]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<><AutopilotPage /><Where /></>} /></Routes>
    </MemoryRouter>
  );
}

const focusedId = () => (document.activeElement as HTMLElement | null)?.id ?? "";
/** The button that opens and closes the group of a chapter and its round. */
const groupButton = (chapter: number, round = 1) => document.querySelector<HTMLElement>(`[data-timeline-group="chapter:${chapter}:${round}"] button[aria-expanded]`) as HTMLElement;
const summaryOf = (id: string) => document.getElementById(`task-${id}`) as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.book = LOCAL_BOOK;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ autopilotText: "full" });
  await i18n.changeLanguage("en");
});

describe("a link to a step of the history (#task-<id>)", () => {
  it("opens the Timeline tab on a page that has tabs, opens the group and the step, and gives it the focus", async () => {
    stubWidth(700);
    const { four, activities } = history();
    const target = four.find((activity) => activity.task === "write" && activity.sceneNumber === 2) as AutopilotActivity;
    seedRun({ status: "paused", activities });
    render(<Page hash={`#task-${target.id}`} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: t("autopilot.tabs.timeline") })).toHaveAttribute("aria-selected", "true"));
    // The group of chapter 4 is not the one open by default: it is opened for the step.
    await waitFor(() => expect(groupButton(4)).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(focusedId()).toBe(`task-${target.id}`));
    const summary = summaryOf(target.id);
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(summary).toHaveTextContent(target.title);
    // What the step holds is drawn, and the focus can be seen after a click too.
    expect(within(summary.closest("details") as HTMLElement).getByText(/what happens in scene 2/)).toBeInTheDocument();
    expect(summary.className).toMatch(/(^|\s)focus:ring-2(\s|$)/);
    // Scrolled to the top of the page, under the band that sticks there (the page scrolls its anchors clear of it), with a little room more for the ring.
    expect(summary.className).toMatch(/(^|\s)scroll-mt-8(\s|$)/);
  });

  it("shows the step on the wide page too, in the history beside the band", async () => {
    const { four, activities } = history();
    const target = four[0];
    seedRun({ status: "paused", activities });
    render(<Page hash={`#task-${target.id}`} />);
    await waitFor(() => expect(focusedId()).toBe(`task-${target.id}`));
    expect(document.querySelector("[data-autopilot-main]")).toContainElement(summaryOf(target.id));
  });

  it("takes back the filter that hides the step, and the list shows everything again", async () => {
    stubWidth(700);
    const { four, activities } = history();
    const target = four.find((activity) => activity.task === "write") as AutopilotActivity;
    sessionStorage.setItem("narrarium-autopilot-timeline-v1", JSON.stringify({ "book-1": { filter: "director", since: null } }));
    seedRun({ status: "paused", activities });
    render(<Page hash={`#task-${target.id}`} />);
    await waitFor(() => expect(focusedId()).toBe(`task-${target.id}`));
    expect(screen.getByRole("radio", { name: new RegExp(`^${t("autopilot.timeline.filter.all")}`) })).toBeChecked();
    expect(JSON.parse(sessionStorage.getItem("narrarium-autopilot-timeline-v1") ?? "{}")["book-1"].filter).toBe("all");
  });

  it("takes back «Hide until now» when it hides the step", async () => {
    const { four, activities } = history();
    const target = four[1];
    sessionStorage.setItem("narrarium-autopilot-timeline-v1", JSON.stringify({ "book-1": { filter: "all", since: new Date(Date.parse(activities[activities.length - 1].endedAt!) + 60_000).toISOString() } }));
    seedRun({ status: "paused", activities });
    render(<Page hash={`#task-${target.id}`} />);
    await waitFor(() => expect(focusedId()).toBe(`task-${target.id}`));
    expect(JSON.parse(sessionStorage.getItem("narrarium-autopilot-timeline-v1") ?? "{}")["book-1"].since).toBeNull();
  });

  it("opens a group the author closed", async () => {
    const { five, activities } = history();
    const target = five[1];
    seedRun({ status: "paused", activities });
    render(<Page hash="" />);
    const header = groupButton(5);
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    cleanup();
    render(<Page hash={`#task-${target.id}`} />);
    await waitFor(() => expect(focusedId()).toBe(`task-${target.id}`));
    expect(groupButton(5)).toHaveAttribute("aria-expanded", "true");
  });

  it("draws a step further down than the window of rows of its group", async () => {
    resetIds();
    resetSeq();
    const many = Array.from({ length: GROUP_ROWS + 20 }, (_, index) => stepOf("write", { from: index * 50, chapterNumber: 6, sceneNumber: index + 1, title: `Writing scene ${index + 1} of chapter 6` }));
    const target = many[2];
    seedRun({ status: "paused", activities: many });
    render(<Page hash={`#task-${target.id}`} />);
    await waitFor(() => expect(focusedId()).toBe(`task-${target.id}`));
    expect(summaryOf(target.id)).toHaveTextContent("Writing scene 3 of chapter 6");
  });

  it("lands on a later attempt of a step that was repeated, in the step it opens", async () => {
    resetIds();
    resetSeq();
    const failed = stepOf("write", { from: 0, length: 10, chapterNumber: 5, sceneNumber: 1, title: "Writing scene 1 of chapter 5", status: "failed", error: "The provider answered 429." });
    const worked = stepOf("write", { from: 40, chapterNumber: 5, sceneNumber: 1, title: "Writing scene 1 of chapter 5" });
    seedRun({ status: "paused", activities: [failed, worked] });
    render(<Page hash={`#task-${worked.id}`} />);
    await waitFor(() => expect(focusedId()).toBe(`task-${worked.id}`));
    const attempt = document.activeElement as HTMLElement;
    expect(attempt.tagName).toBe("LI");
    expect(attempt.className).toMatch(/(^|\s)scroll-mt-8(\s|$)/);
    expect(attempt).toHaveTextContent(t("autopilot.timeline.row.attempt", { number: 2 }));
    expect(attempt.closest("details")).toHaveAttribute("open");
    // The first attempt is the step itself.
    expect(summaryOf(failed.id).tagName).toBe("SUMMARY");
  });

  it("lands on the block of the step that runs, and gives the focus to its row when the step is over", async () => {
    const { activities } = history();
    const live = runningStep("write", "Writing scene 3 of chapter 5", { id: "live-step", chapterNumber: 5, sceneNumber: 3 });
    seedRun({ status: "running", running: true, activities, live: { activity: live, characters: PREVIEW.length, preview: PREVIEW } });
    render(<Page hash="#task-live-step" />);
    await waitFor(() => expect(focusedId()).toBe("task-live-step"));
    expect(document.activeElement).toHaveAttribute("data-timeline-live");
    expect((document.activeElement as HTMLElement).className).toMatch(/(^|\s)scroll-mt-8(\s|$)/);
    await ingest(eventAt(9_000, { type: "task-finished", activity: { ...live, status: "succeeded", endedAt: new Date(Date.parse(live.startedAt) + 60_000).toISOString() } }));
    await waitFor(() => expect(focusedId()).toBe("task-live-step"));
    expect((document.activeElement as HTMLElement).tagName).toBe("SUMMARY");
    expect(document.activeElement).toHaveTextContent("Writing scene 3 of chapter 5");
  });

  it("lands on the row of a step that was over before the page opened", async () => {
    const { five, activities } = history();
    const target = five[five.length - 1];
    seedRun({ status: "running", running: true, activities, live: { activity: runningStep("write", "Another step", { id: "other", chapterNumber: 5 }) } });
    render(<Page hash={`#task-${target.id}`} />);
    await waitFor(() => expect(focusedId()).toBe(`task-${target.id}`));
    expect(document.activeElement!.tagName).toBe("SUMMARY");
  });

  it("is followed from «Last done» in the band of the same page", async () => {
    const { activities } = history();
    const last = activities[activities.length - 1];
    seedRun({ status: "paused", activities });
    render(<Page hash="" />);
    const band = document.querySelector("[data-autopilot-band]") as HTMLElement;
    const link = within(within(band).getByRole("list", { name: t("autopilot.liveText.lastDone") })).getAllByRole("link")[0];
    expect(link).toHaveAttribute("href", `/app/books/book-1/autopilot#task-${last.id}`);
    fireEvent.click(link);
    await waitFor(() => expect(focusedId()).toBe(`task-${last.id}`));
    expect(screen.getByTestId("where")).toHaveTextContent(`#task-${last.id}`);
  });
});

describe("a link of the mini-player", () => {
  it("closes the sheet on a phone, goes to the step, and does not send the focus back to the button that opened the sheet", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: /max-width|max-height/.test(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    const { activities } = history();
    const last = activities[activities.length - 1];
    seedRun({ status: "paused", dockOpen: true, activities });
    useAutopilotStore.setState({ dockTab: "book" });
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.appendChild(opener);
    opener.focus();
    render(
      <MemoryRouter initialEntries={["/app/books/book-1"]}>
        <Routes><Route path="*" element={<><AutopilotDock /><Where /></>} /></Routes>
      </MemoryRouter>,
    );
    const sheet = await screen.findByRole("dialog");
    const link = within(within(sheet).getByRole("list", { name: t("autopilot.liveText.lastDone") })).getAllByRole("link")[0];
    expect(link.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("where")).toHaveTextContent(`/app/books/book-1/autopilot#task-${last.id}`);
    expect(document.activeElement).not.toBe(opener);
    opener.remove();
  });

  // Brought back on the configuration (a page of the autopilot that does not show the run, so the panel has the text), its link leads to the live page,
  // where the panel would cover the step it leads to.
  it("makes way when it was brought back on a page of the autopilot: a link to a step closes it", async () => {
    const { activities } = history();
    seedRun({ status: "running", running: true, activities, live: { activity: runningStep("write", "A step", { id: "live-a", chapterNumber: 5 }), characters: PREVIEW.length, preview: PREVIEW } });
    act(() => { useAutopilotStore.getState().setPageDockOpen(true); useAutopilotStore.setState({ dockTab: "book" }); });
    render(
      <MemoryRouter initialEntries={["/app/books/book-1/autopilot/settings"]}>
        <Routes><Route path="*" element={<><AutopilotDock /><Where /></>} /></Routes>
      </MemoryRouter>,
    );
    const dock = screen.getByRole("region", { name: t("autopilot.dockTitle") });
    const lines = dock.querySelector("[data-stream-lines]") as HTMLElement;
    expect(lines).toHaveAttribute("href", "/app/books/book-1/autopilot#task-live-a");
    fireEvent.click(lines);
    expect(useAutopilotStore.getState().pageDockOpen).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/autopilot#task-live-a");
  });
});

describe("«Show the text» on the Autopilot page", () => {
  const LIVE_STEP = runningStep("write", "Writing scene 3 of chapter 5", { id: "live-step", chapterNumber: 5, sceneNumber: 3 });
  const toggles = () => screen.getAllByRole("button", { name: t("autopilot.liveText.toggle") });
  const lastDone = (inside: HTMLElement) => within(inside).queryByRole("list", { name: t("autopilot.liveText.lastDone") });
  const seedRunning = () => {
    const { activities } = history();
    seedRun({ status: "running", running: true, activities, live: { activity: LIVE_STEP, characters: PREVIEW.length, preview: PREVIEW } });
  };

  it("is in the band of a large screen, which shows the lines and «Last done»; released, the band is as it was: its one line of text, no list", () => {
    seedRunning();
    render(<Page hash="" />);
    const band = document.querySelector("[data-autopilot-band]") as HTMLElement;
    const [toggle] = toggles();
    expect(band).toContainElement(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent(t("autopilot.liveText.toggle"));
    expect(band.querySelector("[data-stream-lines]")).not.toBeNull();
    expect(lastDone(band)).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(band.querySelector("[data-stream-lines]")).toBeNull();
    expect(lastDone(band)).toBeNull();
    expect(band.querySelector("[data-band-preview]")!.className).toMatch(/(^|\s)truncate(\s|$)/);
    expect(useUiStore.getState().autopilotText).toBe("compact");
  });

  it("is in the band of a tablet, and shows or hides the lines and the list of the Overview", () => {
    stubWidth(700);
    seedRunning();
    render(<Page hash="" />);
    const band = document.querySelector("[data-autopilot-band]") as HTMLElement;
    const details = document.querySelector("[data-band-details]") as HTMLElement;
    const [toggle] = toggles();
    expect(band).toContainElement(toggle);
    expect(details.querySelector("[data-stream-lines]")).not.toBeNull();
    expect(lastDone(details)).not.toBeNull();
    fireEvent.click(toggle);
    expect(details.querySelector("[data-stream-lines]")).toBeNull();
    expect(lastDone(details)).toBeNull();
    expect(details.querySelector("[data-band-preview]")).not.toBeNull();
  });

  it("is at the top of the Overview on a phone, over the lines and the list it shows, as big as a finger: the compact band stays as it was", () => {
    stubWidth(390);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: /max-width|max-height/.test(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    seedRunning();
    render(<Page hash="" />);
    const band = document.querySelector("[data-autopilot-band]") as HTMLElement;
    const details = document.querySelector("[data-band-details]") as HTMLElement;
    expect(toggles()).toHaveLength(1);
    const [toggle] = toggles();
    expect(band).not.toContainElement(toggle);
    expect(details).toContainElement(toggle);
    expect(toggle).toHaveTextContent(t("autopilot.liveText.toggle"));
    expect(toggle.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    // It comes before what it shows.
    expect(toggle.compareDocumentPosition(details.querySelector("[data-stream-lines]") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details.querySelector("[data-stream-lines]")).toHaveAttribute("data-stream-lines", "2");
    fireEvent.click(toggle);
    expect(details.querySelector("[data-stream-lines]")).toBeNull();
    expect(lastDone(details)).toBeNull();
  });
});
