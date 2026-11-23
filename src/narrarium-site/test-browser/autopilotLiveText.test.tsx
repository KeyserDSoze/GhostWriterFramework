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
import { LastDone } from "@/components/autopilot/live/LastDone";
import { LiveAnnouncer, TextDetailToggle } from "@/components/autopilot/live/LiveControls";
import { StreamLines, cutAtTop } from "@/components/autopilot/live/StreamLines";
import { ModelAnswering } from "@/components/autopilot/band/parts";
import { PoliteAnnouncer, STREAM_CHARACTERS, latestFinished, streamTail, taskElementId, taskHref, taskIdOfHash } from "@/autopilot/liveText";
import { formatAgo } from "@/autopilot/format";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { activityOf, eventOf, finishedEvent, ingest, runningStep, seedRun } from "./helpers/autopilotBand";
import { makeRuntime, t } from "./helpers/quickCommands";

const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const TEXT = "The keeper climbed the stairs counting the steps under his breath.\nOn the third floor the door to the gallery stood ajar.";

/** A screen of the width the media queries are asked about: a phone (two lines, the sheet) or not. */
function screenIs(phone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: phone && /max-width|max-height/.test(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })) as unknown as typeof window.matchMedia;
}

const finishedAt = (seconds: number) => new Date(Date.parse("2026-11-21T10:00:00.000Z") + seconds * 1000).toISOString();
function done(id: string, title: string, seconds: number, patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  return activityOf("write", { id, title, startedAt: finishedAt(seconds - 30), endedAt: finishedAt(seconds), ...patch });
}

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  screenIs(false);
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ autopilotText: "full" });
  await i18n.changeLanguage("en");
});

describe("the address of a step", () => {
  it("is the live page of its book with the anchor of the step, which the page reads back", () => {
    expect(taskHref("book 1", "activity_42")).toBe("/app/books/book%201/autopilot#task-activity_42");
    expect(taskElementId("activity_42")).toBe("task-activity_42");
    expect(taskIdOfHash("#task-activity_42")).toBe("activity_42");
    expect(taskIdOfHash("task-activity_42")).toBe("activity_42");
    expect(taskIdOfHash("#autopilot-where")).toBeNull();
    expect(taskIdOfHash("#task-")).toBeNull();
    expect(taskIdOfHash("#task-%E0%A4%A")).toBeNull();
  });
});

describe("the last steps that are over", () => {
  it("are the newest three, from the log and from the feed, and never the step that runs or one an interrupted run left running", () => {
    const log = [done("a", "Plan", 10), done("b", "Readers", 20, { status: "failed", error: "429" }), done("c", "Director", 30, { status: "cancelled" }), activityOf("write", { id: "stale", title: "Interrupted", status: "running", endedAt: undefined })];
    const feed = [finishedEvent(done("d", "Scene 1", 0), 1)];
    // The feed's copy of a step is the newer one: «d» ended after everything in the log.
    expect(latestFinished(log, feed, { runningId: "live" }).map((activity) => activity.id)).toEqual(["d", "c", "b"]);
    expect(latestFinished(log, [], { runningId: "c" }).map((activity) => activity.id)).toEqual(["b", "a"]);
    expect(latestFinished(log, [], { limit: 0 })).toEqual([]);
  });

  it("are in the order of the log when they ended in the same second", () => {
    const same = ["x", "y", "z"].map((id) => done(id, id, 50));
    expect(latestFinished(same, []).map((activity) => activity.id)).toEqual(["z", "y", "x"]);
  });
});

describe("the end of the text as the lines show it", () => {
  it("is the whole text when it is short and whole, with its line breaks", () => {
    expect(streamTail(`  ${TEXT}  `)).toBe(TEXT);
    expect(streamTail("   ")).toBe("");
  });

  it("begins at a whole word after an ellipsis when it is the end of a longer text, and holds at most the characters of the lines", () => {
    expect(streamTail("ing the steps under his breath.", 400)).toBe("…the steps under his breath.");
    const long = "word ".repeat(200).trim();
    const tail = streamTail(long);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(STREAM_CHARACTERS + 1);
    expect(tail.endsWith("word")).toBe(true);
  });
});

describe("the fade at the top of the lines", () => {
  /** A box `room` pixels tall inside its padding, holding a text `tall` pixels tall: the box keeps the end of the text at its bottom. */
  function boxOf(room: number, tall: number, padding = 0) {
    const box = document.createElement("p");
    box.style.padding = `${padding}px`;
    const text = document.createElement("span");
    box.appendChild(text);
    Object.defineProperty(box, "clientHeight", { value: room + padding * 2 });
    text.getBoundingClientRect = () => ({ height: tall, width: 100, top: 0, left: 0, right: 100, bottom: tall, x: 0, y: 0, toJSON: () => ({}) });
    return box;
  }

  it("is there when the text goes on above the box, where the box's scroll height does not count it, and only then", () => {
    expect(cutAtTop(boxOf(60, 100))).toBe(true);
    expect(cutAtTop(boxOf(60, 60))).toBe(false);
    expect(cutAtTop(boxOf(60, 40))).toBe(false);
    // The padding of the box is not room for the text.
    expect(cutAtTop(boxOf(144, 150, 8))).toBe(true);
    expect(cutAtTop(boxOf(144, 144, 8))).toBe(false);
    expect(cutAtTop(null)).toBe(false);
    expect(cutAtTop(document.createElement("p"))).toBe(false);
  });
});

describe("one polite voice, at most once every ten seconds", () => {
  it("says the first thing at once, keeps what comes while it waits (the most important, the newest among equals) and says it when the time comes", () => {
    vi.useFakeTimers();
    let now = 0;
    const said: string[] = [];
    const voice = new PoliteAnnouncer((text) => said.push(text), 10_000, () => now);
    voice.push("Answering", 1);
    expect(said).toEqual(["Answering"]);
    now = 2_000;
    voice.push("Done: scene 1.", 2);
    voice.push("Answering", 1);
    now = 3_000;
    voice.push("Done: scene 2.", 2);
    expect(said).toHaveLength(1);
    now = 10_000;
    vi.advanceTimersByTime(8_000);
    expect(said).toEqual(["Answering", "Done: scene 2."]);
    now = 12_000;
    voice.push("Failed: scene 3.", 3);
    voice.push("Answering", 1);
    now = 20_000;
    vi.advanceTimersByTime(8_000);
    expect(said).toEqual(["Answering", "Done: scene 2.", "Failed: scene 3."]);
    // Gone with its region: what waited is never said.
    voice.push("Answering", 1);
    voice.dispose();
    vi.advanceTimersByTime(20_000);
    expect(said).toHaveLength(3);
  });
});

function Lines({ lines }: { lines?: 2 | 3 }) {
  return <MemoryRouter><StreamLines bookId="book-1" lines={lines} /><ModelAnswering bookId="book-1" short /></MemoryRouter>;
}

describe("the last lines of the text that streams", () => {
  it("are three lines on a large screen, the end of the text at the bottom, as a way to the step that runs", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: TEXT.length, preview: TEXT } });
    render(<Lines />);
    const link = screen.getByRole("link", { name: t("autopilot.liveText.open", { step: LIVE.title }) });
    expect(link).toHaveAttribute("href", `/app/books/book-1/autopilot#task-${LIVE.id}`);
    expect(link).toHaveAttribute("data-stream-lines", "3");
    const text = link.querySelector("[data-stream-text]") as HTMLElement;
    expect(text.className).toMatch(/max-h-\[3\.75rem\]/);
    expect(text.className).toMatch(/\bjustify-end\b/);
    expect(text.className).toMatch(/whitespace-pre-line/);
    expect(text).toHaveTextContent("the door to the gallery stood ajar.");
    expect(link).toHaveTextContent(t("autopilot.characters", { count: TEXT.length }));
  });

  it("are two lines on a phone", () => {
    screenIs(true);
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: TEXT.length, preview: TEXT } });
    render(<Lines />);
    const link = screen.getByRole("link", { name: t("autopilot.liveText.open", { step: LIVE.title }) });
    expect(link).toHaveAttribute("data-stream-lines", "2");
    expect((link.querySelector("[data-stream-text]") as HTMLElement).className).toMatch(/\bmax-h-10\b/);
  });

  it("are never a live region", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: TEXT.length, preview: TEXT } });
    const { container } = render(<Lines />);
    expect(container.querySelector("[data-stream-lines]")!.closest('[aria-live], [role="status"], [role="log"], [role="alert"], [role="marquee"]')).toBeNull();
    expect(container.querySelector('[aria-live], [role="status"]')).toBeNull();
  });

  it("give way to «Answering… 12 KB» while a step answers with a value, which has no prose", async () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: TEXT.length, preview: TEXT } });
    const { container } = render(<Lines />);
    await ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: 300, bytes: 12_288, preview: "" }, 5));
    expect(container.querySelector("[data-stream-lines]")).toBeNull();
    expect(container.querySelector("[data-band-progress]")).toHaveTextContent("Answering… 12 KB");
  });

  it("are not there before the step says anything, nor when nothing runs", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: 0, preview: "" } });
    const first = render(<Lines />);
    expect(first.container.querySelector("[data-stream-lines]")).toBeNull();
    first.unmount();
    seedRun({ status: "paused", live: null });
    expect(render(<Lines />).container.querySelector("[data-stream-lines]")).toBeNull();
  });

  it("follow the text at most four times a second, and draw the last chunk once the quarter of a second is over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: TEXT.length, preview: TEXT } });
    const { container } = render(<Lines />);
    const box = () => container.querySelector("[data-stream-text]") as HTMLElement;
    const drawn: string[] = [];
    const observer = new MutationObserver(() => drawn.push(box()?.textContent ?? ""));
    observer.observe(container, { subtree: true, characterData: true, childList: true });
    // Twenty chunks in one second, one every fifty milliseconds.
    for (let chunk = 1; chunk <= 20; chunk += 1) {
      act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: TEXT.length + chunk, preview: `${TEXT} chunk ${chunk}` }, 10 + chunk), "The Glass Harbor"); });
      await act(async () => { vi.advanceTimersByTime(50); });
    }
    await act(async () => { vi.advanceTimersByTime(300); });
    observer.disconnect();
    expect(box()).toHaveTextContent("chunk 20");
    const changes = new Set(drawn).size;
    expect(changes, `drawn ${changes} times for twenty chunks`).toBeLessThanOrEqual(6);
    expect(changes).toBeGreaterThanOrEqual(3);
  });
});

function Done({ bookId = "book-1" }: { bookId?: string }) {
  return <MemoryRouter><LastDone bookId={bookId} /></MemoryRouter>;
}

describe("«Last done»", () => {
  it("lists the last three steps that are over, the newest first: an icon for how each ended with the word for a screen reader, the title in words, how long ago, and a link to it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(finishedAt(400)));
    const steps = [done("s1", "Writing scene 1 of chapter 4", 100), done("s2", "Ada reads chapter 4", 200, { task: "reader" }), done("s3", "Specialists review chapter 4", 280, { task: "specialists", status: "failed", error: "429" }), done("s4", "Director's review of chapter 4", 340, { task: "director-review", status: "cancelled" })];
    seedRun({ status: "paused", activities: steps });
    render(<Done />);
    const list = screen.getByRole("list", { name: t("autopilot.liveText.lastDone") });
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["s4", "s3", "s2"].map((id) => `/app/books/book-1/autopilot#task-${id}`));
    expect(links.map((link) => link.getAttribute("data-last-done-item"))).toEqual(["cancelled", "failed", "succeeded"]);
    expect(links[0]).toHaveTextContent(`${t("autopilot.activity.status.cancelled")}: Director's review of chapter 4`);
    expect(links[1]).toHaveTextContent(`${t("autopilot.activity.status.failed")}: Specialists review chapter 4`);
    expect(links[0]).toHaveTextContent(formatAgo(60_000));
    for (const link of links) expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("adds the steps the feed finished that the log does not have yet, and leaves out the one that runs", async () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: 10, preview: "Something" }, activities: [done("s1", "Writing scene 1 of chapter 5", 10)] });
    render(<Done />);
    expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(1);
    await ingest(finishedEvent(LIVE, 20));
    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links[0]).toHaveTextContent(LIVE.title);
    expect(links).toHaveLength(2);
  });

  it("is not there before a step is over", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE }, activities: [] });
    const { container } = render(<Done />);
    expect(container.querySelector("[data-last-done]")).toBeNull();
  });

  it("is in Italian «Ultime cose fatte», with the words of how each ended", async () => {
    await i18n.changeLanguage("it");
    seedRun({ status: "paused", activities: [done("s1", "Scrittura della scena 1", 100, { status: "failed" })] });
    render(<Done />);
    const list = screen.getByRole("list", { name: "Ultime cose fatte" });
    expect(within(list).getByRole("link")).toHaveTextContent(`${t("autopilot.activity.status.failed")}: Scrittura della scena 1`);
  });
});

describe("«Show the text»", () => {
  const readStored = () => JSON.parse(localStorage.getItem("narrarium-ui-state") ?? "{}").state?.autopilotText;

  it("is pressed by default and, released, keeps the mini-player as it was: no lines, no list; pressed again, they are back. The choice is kept on this device", () => {
    seedRun({ status: "running", running: true, dockOpen: true, live: { activity: LIVE, characters: TEXT.length, preview: TEXT }, activities: [done("s1", "Writing scene 1 of chapter 5", 100)] });
    useAutopilotStore.setState({ dockTab: "book" });
    render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
    const panel = screen.getByRole("region", { name: t("autopilot.dockTitle") });
    const toggle = within(panel).getByRole("button", { name: t("autopilot.band.named", { label: t("autopilot.liveText.toggle"), context: t("autopilot.dockTitle") }) });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(panel.querySelector("[data-stream-lines]")).not.toBeNull();
    expect(within(panel).getByRole("list", { name: t("autopilot.liveText.lastDone") })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(panel.querySelector("[data-stream-lines]")).toBeNull();
    expect(within(panel).queryByRole("list", { name: t("autopilot.liveText.lastDone") })).not.toBeInTheDocument();
    // What stays is the mini-player of before: the step, its time and the commands.
    expect(within(panel).getByText(LIVE.title)).toBeInTheDocument();
    expect(readStored()).toBe("compact");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(panel.querySelector("[data-stream-lines]")).not.toBeNull();
    expect(readStored()).toBe("full");
  });

  it("is a button with its name in words, labelled in the band and an icon elsewhere, and says what it does when pointed at", () => {
    render(<><TextDetailToggle labelled /><TextDetailToggle /></>);
    const [band, icon] = screen.getAllByRole("button", { name: t("autopilot.liveText.toggle") });
    expect(band).toHaveTextContent(t("autopilot.liveText.toggle"));
    expect(icon.textContent).toBe(t("autopilot.liveText.toggle"));
    expect(icon.querySelector(".sr-only")).not.toBeNull();
    for (const button of [band, icon]) expect(button).toHaveAttribute("title", t("autopilot.liveText.toggleHint"));
  });

  it("reads a stored value it does not know as the default", async () => {
    localStorage.setItem("narrarium-ui-state", JSON.stringify({ state: { autopilotText: "everything" }, version: 1 }));
    await act(async () => { await useUiStore.persist.rehydrate(); });
    expect(useUiStore.getState().autopilotText).toBe("full");
  });
});

describe("what a screen reader is told", () => {
  function Voice() {
    return <LiveAnnouncer bookIds={["book-1"]} />;
  }
  const voice = () => document.querySelector("[data-live-announcer]") as HTMLElement;
  const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

  it("is one polite status that says when the model answers, then that the answer is complete with its characters and the step done; never a word of the text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: 0, preview: "" } });
    render(<Voice />);
    expect(voice()).toHaveAttribute("role", "status");
    expect(voice()).toHaveAttribute("aria-live", "polite");
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: 50, preview: "The keeper climbed" }, 2), "x"); });
    await settle(100);
    expect(voice()).toHaveTextContent(t("autopilot.liveText.say.answering"));
    expect(voice().textContent).not.toContain("keeper");
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: 12_345, preview: "…a long scene" }, 3), "x"); });
    act(() => { useAutopilotStore.getState().ingest(finishedEvent(LIVE, 4), "x"); });
    // Within ten seconds of «Answering» nothing more is said; then the end of the step.
    await settle(5_000);
    expect(voice()).toHaveTextContent(t("autopilot.liveText.say.answering"));
    await settle(5_100);
    expect(voice()).toHaveTextContent(`${t("autopilot.liveText.say.complete", { count: 12_345, value: "12,345" })} ${t("autopilot.liveText.say.done", { step: LIVE.title })}`);
  });

  it("says a failure, before what came with it, at most once every ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const second = runningStep("reader", "Ada reads chapter 5", { id: "live-reader", chapterNumber: 5 });
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: 10, preview: "x" } });
    render(<Voice />);
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-finished", activity: { ...LIVE, status: "failed", endedAt: "2026-11-21T10:01:00.000Z", error: "429" } }, 5), "x"); });
    await settle(100);
    expect(voice()).toHaveTextContent(t("autopilot.liveText.say.failed", { step: LIVE.title }));
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-started", activity: second }, 6), "x"); });
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-progress", activityId: second.id, characters: 30, preview: "Ada" }, 7), "x"); });
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-finished", activity: { ...second, status: "cancelled", endedAt: "2026-11-21T10:02:00.000Z" } }, 8), "x"); });
    await settle(2_000);
    expect(voice()).toHaveTextContent(t("autopilot.liveText.say.failed", { step: LIVE.title }));
    await settle(8_100);
    expect(voice()).toHaveTextContent(t("autopilot.liveText.say.cancelled", { step: "Ada reads chapter 5" }));
  });

  it("names the book where it follows several (the page of every book)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: 0, preview: "" } });
    render(<LiveAnnouncer bookIds={["book-1", "book-2"]} nameOf={(id) => (id === "book-1" ? "The Glass Harbor" : "Other")} />);
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: 5, preview: "x" }, 2), "x"); });
    await settle(100);
    expect(voice()).toHaveTextContent(t("autopilot.liveText.say.book", { book: "The Glass Harbor", message: t("autopilot.liveText.say.answering") }));
  });

  it("is said in Italian", async () => {
    await i18n.changeLanguage("it");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    seedRun({ status: "running", running: true, live: { activity: LIVE, characters: 0, preview: "" } });
    render(<Voice />);
    act(() => { useAutopilotStore.getState().ingest(eventOf({ type: "task-progress", activityId: LIVE.id, characters: 1200, preview: "x" }, 2), "x"); });
    await settle(100);
    expect(voice()).toHaveTextContent("Sta rispondendo");
    act(() => { useAutopilotStore.getState().ingest(finishedEvent(LIVE, 3), "x"); });
    await settle(10_100);
    expect(voice()).toHaveTextContent(`Risposta completa: ${new Intl.NumberFormat("it").format(1200)} caratteri. Fatto: ${LIVE.title}.`);
  });
});
