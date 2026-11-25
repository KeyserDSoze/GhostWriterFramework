import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotAttemptInfo } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { AttemptNow } from "@/components/autopilot/band/Attempt";
import { TimelineLive } from "@/components/autopilot/timeline/Live";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { provideCallsSources } from "@/autopilot/calls/sourceHook";
import { formatCost } from "@/autopilot/format";
import { useStreamAnnouncements } from "@/autopilot/useLiveText";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { eventOf, finishedEvent, ingest, runningStep, seedRun, stubWidth } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";

// Which candidate of the AI Router the step that runs asks now, in the band, the live panel and the card of the step in the history. The engine says it as each request is sent
// (`call-attempt`, kept in `live.trying`); a primary that failed at once is already the fallback on screen. A host that does not say it (a personal server older than that engine)
// shows nothing, and no placeholder.

const BOOK = LOCAL_BOOK.id;
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const SECOND = runningStep("reader", "Ada reads chapter 5", { id: "live-reader", chapterNumber: 5 });
const PRIMARY: AutopilotAttemptInfo = { attempt: 1, attempts: 3, candidateIndex: 0, candidateCount: 3, fallback: false, integrationId: "azure", integrationName: "AzureOpenAi-GW", provider: "azure_openai", model: "gpt-6-luna", thinking: "high", streamMode: "auto" };
const FALLBACK: AutopilotAttemptInfo = { ...PRIMARY, attempt: 2, candidateIndex: 1, fallback: true, integrationId: "proxy", integrationName: "LlmProxy", provider: "openai", model: "muse-glimmer-30b", thinking: "medium" };
const RUNNING = { status: "running", running: true } as const;
const withTrying = (trying?: AutopilotAttemptInfo, activity = LIVE) => ({ ...RUNNING, live: { activity, characters: 0, preview: "", ...(trying ? { trying } : {}) } });
const attemptOf = (trying: AutopilotAttemptInfo, seq: number, callSeq = 1, activityId = LIVE.id) => eventOf({ type: "call-attempt", activityId, callSeq, ...trying }, seq);
const progressOf = (extra: Record<string, unknown>, seq: number, callSeq = 1) => eventOf({ type: "task-progress", activityId: LIVE.id, callSeq, ...extra }, seq);
const live = () => useAutopilotStore.getState().live[BOOK];

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const lineOf = (root: ParentNode = document) => root.querySelector<HTMLElement>("[data-band-attempt]");
const dock = () => screen.getByRole("region", { name: t("autopilot.dockTitle") });

class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", Quiet);
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.book = LOCAL_BOOK;
  provideCallsSources(null);
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ autopilotText: "full" });
  await i18n.changeLanguage("en");
});

describe("the store follows what the engine says of the call by the engine's rule", () => {
  it("keeps the candidate through the text and the numbers of the call, replaces it with the next attempt of the call, and gives it up for the text of another call", () => {
    seedRun(withTrying());
    expect(live()?.trying).toBeUndefined();
    ingest(attemptOf(PRIMARY, 10));
    expect(live()?.trying).toEqual(PRIMARY);
    expect(live()?.callSeq).toBe(1);
    ingest(progressOf({ kind: "json", characters: 20, preview: "{\"logline\": \"A glassmaker's" }, 11));
    ingest(progressOf({ bytes: 4000, characters: 24, preview: "{\"logline\": \"A glassmaker's" }, 12));
    ingest(progressOf({ kind: "json", characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" }, 13));
    expect(live()?.trying).toEqual(PRIMARY);
    // The first candidate failed: the next attempt of the same call replaces it, and the text of the attempt before stays until the new one writes.
    ingest(progressOf({ kind: "json", characters: 0, preview: "" }, 14));
    ingest(attemptOf(FALLBACK, 15));
    expect(live()?.trying).toEqual(FALLBACK);
    expect(live()?.preview).toBe("{\"logline\": \"A glassmaker's daughter\"");
    // Another call writes without saying a candidate (a host that does not say it): nothing of the call before is its own.
    ingest(progressOf({ characters: 3, preview: "The" }, 16, 2));
    expect(live()?.trying).toBeUndefined();
    expect(live()?.preview).toBe("The");
  });

  it("is not an entry of the feed, as the text that streams is not: it only changes the live part", () => {
    seedRun({ ...withTrying(), feed: [] });
    ingest(attemptOf(PRIMARY, 10));
    ingest(attemptOf(FALLBACK, 11));
    expect(useAutopilotStore.getState().feed).toEqual([]);
  });

  it("ignores an attempt of a step that is not the one that runs, and one that does not say which model it is", () => {
    seedRun(withTrying(PRIMARY));
    const before = live();
    ingest(attemptOf(FALLBACK, 10, 1, "another-step"));
    expect(live()).toBe(before);
    ingest(eventOf({ type: "call-attempt", activityId: LIVE.id, callSeq: 1, attempt: 2 }, 11));
    expect(live()).toBe(before);
  });

  it("is shown at once by a client that connects in the middle of the step: the snapshot of a host carries it; a host that does not say it carries nothing", () => {
    const snapshot = (trying?: AutopilotAttemptInfo) => ({ bookId: BOOK, state: null, activities: [], live: { activity: LIVE, characters: 120, preview: "The keeper climbed", callSeq: 3, ...(trying ? { trying } : {}) }, running: true, host: "server" as const });
    act(() => useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshot(FALLBACK) }));
    expect(live()?.trying).toEqual(FALLBACK);
    expect(live()?.callSeq).toBe(3);
    // The same step on a server that is older: the text is shown, and the candidate is not said.
    useAutopilotStore.setState({ live: {} });
    act(() => useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshot() }));
    expect(live()?.preview).toBe("The keeper climbed");
    expect(live()?.trying).toBeUndefined();
    // And what a host sends that is not what it should is cut: a model name of a page, a flag that is not the place of the candidate.
    useAutopilotStore.setState({ live: {} });
    act(() => useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshot({ ...FALLBACK, model: "m".repeat(500), fallback: false }) }));
    expect(live()?.trying?.model).toHaveLength(160);
    expect(live()?.trying?.fallback).toBe(true);
  });
});

describe("the line that says which candidate the step asks now", () => {
  it("says the primary with its model, its integration and its thinking, and no attempt number for the first request", () => {
    seedRun(withTrying({ ...PRIMARY, attempts: 3 }));
    render(<AttemptNow bookId={BOOK} />);
    const line = lineOf() as HTMLElement;
    expect(line.querySelector("[data-attempt-badge]")).toHaveTextContent("Primary");
    expect(line.querySelector("[data-attempt-model]")).toHaveTextContent("gpt-6-luna");
    expect(line.querySelector("[data-attempt-integration]")).toHaveTextContent("AzureOpenAi-GW");
    expect(line.querySelector("[data-attempt-thinking]")).toHaveTextContent("Thinking: High");
    expect(line.querySelector("[data-attempt-count]")).toBeNull();
    expect(line).not.toHaveAttribute("data-attempt-fallback");
  });

  it("says a fallback by its words and its arrow, not by its colour alone, with the number of the request when the call went on", () => {
    seedRun(withTrying(FALLBACK));
    render(<AttemptNow bookId={BOOK} />);
    const line = lineOf() as HTMLElement;
    const badge = line.querySelector("[data-attempt-badge]") as HTMLElement;
    expect(badge).toHaveTextContent("Fallback 1");
    expect(badge.className).toMatch(/amber/);
    expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(badge).toHaveAttribute("title", t("autopilot.band.attempt.fallbackHint", { number: 1 }));
    expect(line).toHaveAttribute("data-attempt-fallback");
    expect(line.querySelector("[data-attempt-model]")).toHaveTextContent("muse-glimmer-30b");
    expect(line.querySelector("[data-attempt-integration]")).toHaveTextContent("LlmProxy");
    expect(line.querySelector("[data-attempt-thinking]")).toHaveTextContent("Thinking: Medium");
    expect(line.querySelector("[data-attempt-count]")).toHaveTextContent("attempt 2/3");
    // The primary is not amber.
    cleanup();
    seedRun(withTrying(PRIMARY));
    render(<AttemptNow bookId={BOOK} />);
    expect((lineOf()?.querySelector("[data-attempt-badge]") as HTMLElement).className).not.toMatch(/amber/);
  });

  it.each([
    ["low", "Thinking: Low"],
    ["medium", "Thinking: Medium"],
    ["high", "Thinking: High"],
    ["xhigh", "Thinking: Extra high"],
    ["automatic", "Thinking: automatic"],
    ["not-sent", "Thinking: not sent"],
    ["minimal", "Thinking: minimal"],
  ])("says the thinking %s as «%s»: the level that was sent, or that none was chosen, or that the model does not take it, or a level it does not know as it is", (thinking, words) => {
    seedRun(withTrying({ ...PRIMARY, thinking: thinking as AutopilotAttemptInfo["thinking"] }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")).toHaveTextContent(words);
  });

  it("says why a level that was chosen is not sent when it is the tools that decide: «Thinking: not sent (tools)», and plain «not sent» for a model that does not take a level at all", async () => {
    seedRun(withTrying({ ...PRIMARY, thinking: "not-sent", thinkingWhy: "tools" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")).toHaveTextContent("Thinking: not sent (tools)");
    cleanup();
    seedRun(withTrying({ ...PRIMARY, thinking: "not-sent" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")?.textContent).toBe("Thinking: not sent");
    cleanup();
    // The reason says nothing about a level that is sent: it is never shown next to one.
    seedRun(withTrying({ ...PRIMARY, thinking: "high", thinkingWhy: "tools" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")?.textContent).toBe("Thinking: High");
    cleanup();
    await i18n.changeLanguage("it");
    seedRun(withTrying({ ...PRIMARY, thinking: "not-sent", thinkingWhy: "tools" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")).toHaveTextContent("Thinking: non inviato (tool)");
  });

  it("says «Thinking: off (tools)» when the model is sent none because that is the one value it takes with tools, and «off» alone for none that nothing decided, in both languages", async () => {
    seedRun(withTrying({ ...PRIMARY, thinking: "none", thinkingWhy: "tools" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")?.textContent).toBe("Thinking: off (tools)");
    cleanup();
    seedRun(withTrying({ ...PRIMARY, thinking: "none" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")?.textContent).toBe("Thinking: off");
    cleanup();
    await i18n.changeLanguage("it");
    seedRun(withTrying({ ...PRIMARY, thinking: "none", thinkingWhy: "tools" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-thinking]")?.textContent).toBe("Thinking: disattivato (tool)");
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    seedRun(withTrying(FALLBACK));
    render(<AttemptNow bookId={BOOK} />);
    const line = lineOf() as HTMLElement;
    expect(line.querySelector("[data-attempt-badge]")).toHaveTextContent("Fallback 1");
    expect(line.querySelector("[data-attempt-thinking]")).toHaveTextContent("Thinking: Medium");
    expect(line.querySelector("[data-attempt-count]")).toHaveTextContent("tentativo 2/3");
    expect(line).toHaveTextContent("Sto interrogando:");
    cleanup();
    seedRun(withTrying({ ...PRIMARY, thinking: "automatic" }));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()?.querySelector("[data-attempt-badge]")).toHaveTextContent("Primario");
    expect(lineOf()?.querySelector("[data-attempt-thinking]")).toHaveTextContent("Thinking: automatico");
  });

  it("shows nothing, and no placeholder, for a step on a host that does not say it", () => {
    seedRun(withTrying());
    const { container } = render(<AttemptNow bookId={BOOK} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps its place when a step ends and the next one has not asked yet, so that what is under it does not jump, and comes back with the next attempt", () => {
    seedRun(withTrying(FALLBACK));
    render(<AttemptNow bookId={BOOK} />);
    expect(lineOf()).toHaveTextContent("muse-glimmer-30b");
    ingest(finishedEvent(LIVE, 20));
    expect(lineOf(), "the step is over: the place stays").toBeInTheDocument();
    expect(lineOf()?.textContent).toBe("");
    expect(lineOf()?.className).toMatch(/min-h-5/);
    ingest(eventOf({ type: "task-started", activity: SECOND }, 21));
    expect(lineOf()?.textContent).toBe("");
    ingest(attemptOf(PRIMARY, 22, 1, SECOND.id));
    expect(lineOf()).toHaveTextContent("gpt-6-luna");
  });

  it("is read as text in its order, without the dots, and it is not a live region: the status of the surface says a fallback", () => {
    seedRun(withTrying(FALLBACK));
    render(<AttemptNow bookId={BOOK} />);
    const line = lineOf() as HTMLElement;
    expect(line.textContent).toBe(`${t("autopilot.band.attempt.label")} Fallback 1muse-glimmer-30b·LlmProxy·Thinking: Medium·attempt 2/3`);
    for (const dot of [...line.querySelectorAll("span")].filter((span) => span.textContent === "·")) expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(line.querySelector(".sr-only")).toHaveTextContent(t("autopilot.band.attempt.label"));
    expect(line.closest("[aria-live]")).toBeNull();
    expect(line.querySelector("[aria-live], [role=status]")).toBeNull();
  });

  it("is drawn again for a new attempt and not for the text that streams", () => {
    seedRun(withTrying());
    ingest(attemptOf(PRIMARY, 29));
    const renders = vi.fn();
    function Counted() {
      const trying = useAutopilotStore((state) => state.live[BOOK]?.trying);
      useEffect(() => { renders(trying?.model); });
      return <AttemptNow bookId={BOOK} />;
    }
    render(<Counted />);
    const before = renders.mock.calls.length;
    for (let step = 0; step < 6; step += 1) ingest(progressOf({ kind: "json", characters: step * 10 + 1, preview: `{"a${step}` }, 30 + step));
    expect(renders.mock.calls.length).toBe(before);
    ingest(attemptOf(FALLBACK, 40));
    expect(lineOf()).toHaveTextContent("muse-glimmer-30b");
  });
});

describe("where the line is", () => {
  it("is beside the cost in the full band: the line just before the cost line, and not under the step", () => {
    stubWidth(1200);
    seedRun(withTrying(FALLBACK));
    render(<Page />);
    const band = bandOf();
    const line = lineOf(band) as HTMLElement;
    expect(line).toHaveTextContent("Fallback 1");
    expect(band.querySelector("[data-band-now]")?.contains(line)).toBe(false);
    expect(line.nextElementSibling).toBe(band.querySelector("[data-band-usage]"));
    expect(band.querySelectorAll("[data-band-attempt]")).toHaveLength(1);
  });

  it("is under the step in the band of a page with less room, once", () => {
    stubWidth(700);
    seedRun(withTrying(FALLBACK));
    render(<Page />);
    const line = lineOf(bandOf()) as HTMLElement;
    expect(line).toHaveTextContent("Fallback 1");
    expect(bandOf().querySelector("[data-band-now]")?.contains(line)).toBe(true);
    expect(bandOf().querySelectorAll("[data-band-attempt]")).toHaveLength(1);
  });

  it("is under the step in the band of a phone, in two lines at most", () => {
    stubWidth(400);
    seedRun(withTrying(FALLBACK));
    render(<Page />);
    const line = lineOf(bandOf()) as HTMLElement;
    expect(line).toHaveTextContent("muse-glimmer-30b");
    expect(bandOf().querySelector("[data-band-now]")?.contains(line)).toBe(true);
    expect(line.className).toMatch(/line-clamp-2/);
  });

  it("shows nothing in the band of a book on a server that does not say it", () => {
    stubWidth(1200);
    mocks.book = { ...LOCAL_BOOK, autopilotHost: "server" };
    seedRun(withTrying());
    render(<Page />);
    expect(lineOf(bandOf())).toBeNull();
    expect(bandOf().querySelector("[data-band-usage]")).toBeInTheDocument();
  });

  it("is in the card of the step that runs, in the history", () => {
    seedRun(withTrying(FALLBACK));
    render(<MemoryRouter><TimelineLive bookId={BOOK} /></MemoryRouter>);
    const card = document.querySelector("[data-timeline-live]") as HTMLElement;
    expect(lineOf(card)).toHaveTextContent("Fallback 1");
    expect(lineOf(card)).toHaveTextContent("muse-glimmer-30b");
  });

  it("is in the live panel: in the card of every book whose autopilot is active, and in the tab of the book of the page", () => {
    seedRun({ ...withTrying(FALLBACK), dockOpen: true });
    useAutopilotStore.setState({ dockTab: "live" });
    render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
    expect(lineOf(dock().querySelector(`[data-dock-book="${BOOK}"]`) as HTMLElement)).toHaveTextContent("Fallback 1");
    cleanup();
    useAutopilotStore.setState({ dockTab: "book" });
    render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
    expect(lineOf(dock())).toHaveTextContent("muse-glimmer-30b");
    expect(lineOf(dock())?.className).toMatch(/line-clamp-2/);
  });

  it("shows nothing in the live panel for a step whose host does not say it", () => {
    seedRun({ ...withTrying(), dockOpen: true });
    render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
    expect(lineOf(dock())).toBeNull();
  });
});

describe("what the cost line says of the step that runs", () => {
  it("shows what the step has spent beside the total when its activity says it, and nothing when it does not: the engine says it when the step ends", () => {
    stubWidth(1200);
    seedRun({ ...RUNNING, live: { activity: { ...LIVE, cost: 0.0123 }, characters: 0, preview: "" } });
    render(<Page />);
    const usage = bandOf().querySelector("[data-band-usage]") as HTMLElement;
    expect(usage.querySelector("[data-band-step-cost]")).toHaveTextContent(`(${t("autopilot.band.usage.step", { value: formatCost(0.0123, "USD") })})`);
    expect(usage).toHaveTextContent(formatCost(0.5, "USD"));
    cleanup();
    seedRun(withTrying());
    render(<Page />);
    expect(bandOf().querySelector("[data-band-usage]")).toBeInTheDocument();
    expect(bandOf().querySelector("[data-band-step-cost]")).toBeNull();
  });
});

describe("what a screen reader is told", () => {
  /** What the polite status of the surface said, each time it said something. */
  function listen() {
    const said: string[] = [];
    function Spy() {
      const message = useStreamAnnouncements([BOOK]);
      useEffect(() => { said.push(message); }, [message]);
      return null;
    }
    render(<Spy />);
    return { said, sentences: () => said.filter(Boolean) };
  }
  const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
  const sentence = (trying: AutopilotAttemptInfo) => t("autopilot.liveText.say.fallback", { number: trying.candidateIndex, model: trying.model, integration: trying.integrationName });

  it("says a call that goes on to a fallback, once, and never the primary that is asked at every call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    seedRun(withTrying());
    const voice = listen();
    ingest(attemptOf(PRIMARY, 10));
    await settle(100);
    expect(voice.sentences()).toEqual([]);
    ingest(attemptOf(FALLBACK, 11));
    await settle(100);
    expect(voice.sentences()).toEqual([sentence(FALLBACK)]);
    expect(sentence(FALLBACK)).toBe("Trying Fallback 1: muse-glimmer-30b (LlmProxy).");
    // The next calls of the step ask the primary first and go on to the same fallback: it is not said again, however long after.
    for (const call of [2, 3, 4]) {
      ingest(attemptOf(PRIMARY, 20 + call * 2, call));
      await settle(11_000);
      ingest(attemptOf(FALLBACK, 21 + call * 2, call));
      await settle(11_000);
    }
    expect(voice.sentences()).toEqual([sentence(FALLBACK)]);
  });

  it("says another fallback of the same step, and the same fallback in the next step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    seedRun(withTrying());
    const voice = listen();
    const SECOND_FALLBACK = { ...FALLBACK, attempt: 3, candidateIndex: 2, integrationId: "other", integrationName: "Other", model: "other-model" };
    ingest(attemptOf(FALLBACK, 10));
    await settle(100);
    ingest(attemptOf(SECOND_FALLBACK, 11));
    await settle(10_100);
    expect(voice.sentences()).toEqual([sentence(FALLBACK), sentence(SECOND_FALLBACK)]);
    // The next step: its first request is the fallback (the primary is left out for it), and a step is said by its own.
    ingest(finishedEvent(LIVE, 12));
    ingest(eventOf({ type: "task-started", activity: SECOND }, 13));
    ingest(attemptOf({ ...FALLBACK, attempt: 1 }, 14, 1, SECOND.id));
    await settle(10_100);
    expect(voice.sentences().filter((text) => text === sentence(FALLBACK))).toHaveLength(2);
  });

  it("says it in Italian, at the pace of the other messages: never twice within ten seconds", async () => {
    await i18n.changeLanguage("it");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    seedRun(withTrying());
    const voice = listen();
    ingest(progressOf({ characters: 50, preview: "La" }, 9));
    await settle(100);
    ingest(attemptOf(FALLBACK, 10));
    await settle(2_000);
    expect(voice.sentences()).toEqual(["Sta rispondendo"]);
    await settle(8_100);
    expect(voice.sentences()).toEqual(["Sta rispondendo", "Provo il Fallback 1: muse-glimmer-30b (LlmProxy)."]);
  });
});
