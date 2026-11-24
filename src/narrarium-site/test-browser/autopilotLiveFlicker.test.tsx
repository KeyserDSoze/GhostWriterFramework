import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAiCallStore, createAutopilotState, type AutopilotSnapshot } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { TimelineLive } from "@/components/autopilot/timeline/Live";
import TaskCalls from "@/components/autopilot/calls/TaskCalls";
import { LiveAnnouncer } from "@/components/autopilot/live/LiveControls";
import { localCallsSource } from "@/autopilot/calls/sourceLocal";
import { provideCallsSources } from "@/autopilot/calls/sourceHook";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { STREAM_CHARACTERS } from "@/autopilot/liveText";
import { useAutopilotStore, type LivePreview } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { eventOf, finishedEvent, runningStep, seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";
import { STEP, beginRecord, saveTask } from "./helpers/aiCalls";

// The text of the step that runs, as the panels showed it while a structured step streamed (the concept of the book): its JSON and its numbers came
// in turns, and the panels drew the tail, then «answering», then the tail again, with two different counts. The events below are the ones a real run
// sends (the 0.1.14 runner, which an older personal server still runs, and the 0.1.15 one), replayed through the real store at their own pace.

const BOOK = LOCAL_BOOK.id;
const CONCEPT = runningStep("concept", "Designing the concept of the book", { id: STEP, phase: "concept" });
const SCENE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { id: "live-write", chapterNumber: 5, sceneNumber: 2 });
const CONCEPT_JSON = JSON.stringify({
  logline: "A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.",
  premise: "In a harbor town built on glass, Mira discovers that the lighthouse keeps a secret, and that the council profits from the silence of everyone who works the furnaces along the quay. When her father is blamed for the cracked beacon, she follows the money into the council's archive.",
  themes: ["truth", "inheritance", "silence"],
  tone: "Melancholic, tense",
  conflict: "Mira against the council that profits from the lie.",
  ending: "The beacon is lit with her father's glass.",
});
const SCENE_TEXT = "The keeper climbed the stairs counting the steps under his breath, and on every landing the wind changed its note. At the top the lantern room was cold.";
const SUMMARY_JSON = JSON.stringify({ summary: "The keeper climbs to the lantern room and finds it cold: someone has let the fire die." });

type Runner = "0.1.14" | "0.1.15";

/** An event at its moment (milliseconds from the start of the replay), with the call of the step it belongs to. */
interface Timed {
  at: number;
  call: number;
  body: Record<string, unknown>;
}

const tailOf = (text: string) => text.slice(-700);
const last = <T,>(list: readonly T[]): T | undefined => list[list.length - 1];

/**
 * The progress of one structured call as a runner says it, from `from` for `duration` milliseconds: the client hands the runner a chunk every 50 ms
 * (the JSON so far and how much has arrived), after `lead` milliseconds in which the model only thinks. The runner says the JSON at most every 350 ms
 * and the numbers once a second. The 0.1.14 runner names a call only by its record (`callId`), keeps one tail for the whole step (the numbers of a
 * later call carry the tail of the call before, `carried`) and says the client's own count in its numbers, which counts more than the JSON; the
 * 0.1.15 runner names every call and says the JSON's count.
 */
function structuredCall({ runner, json, from = 0, duration, lead = 0, call = 1, callId, carried = "" }: { runner: Runner; json: string; from?: number; duration: number; lead?: number; call?: number; callId?: string; carried?: string }): Timed[] {
  const events: Timed[] = [];
  const names = runner === "0.1.15" ? { callSeq: call, ...(callId ? { callId } : {}) } : callId ? { callId } : {};
  let tail = runner === "0.1.14" ? carried : "";
  let length: number | undefined;
  let lastJson = Number.NEGATIVE_INFINITY;
  let lastNumbers = Number.NEGATIVE_INFINITY;
  for (let at = 50; at <= duration; at += 50) {
    const share = at <= lead ? 0 : (at - lead) / (duration - lead);
    const written = json.slice(0, Math.round(json.length * share));
    if (written.length > (length ?? 0)) {
      tail = tailOf(written);
      length = written.length;
      if (at - lastJson >= 350) {
        lastJson = at;
        events.push({ at: from + at, call, body: { type: "task-progress", activityId: CONCEPT.id, ...names, kind: "json", characters: written.length, preview: tail } });
      }
    }
    if (at - lastNumbers >= 1000) {
      lastNumbers = at;
      const client = written.length + 24;
      events.push({ at: from + at, call, body: { type: "task-progress", activityId: CONCEPT.id, ...names, bytes: 64 + written.length * 3, characters: runner === "0.1.15" ? length ?? client : client, preview: tail } });
    }
  }
  return events;
}

/** A prose call (a scene) as a runner says it: its text so far, at most every 350 ms, the whole of it at the end. */
function proseCall({ runner, activityId, text, from = 0, duration, call = 1 }: { runner: Runner; activityId: string; text: string; from?: number; duration: number; call?: number }): Timed[] {
  const events: Timed[] = [];
  for (let step = 1; step <= Math.ceil(duration / 350); step += 1) {
    const at = Math.min(step * 350, duration);
    const written = text.slice(0, Math.round((text.length * at) / duration));
    events.push({ at: from + at, call, body: { type: "task-progress", activityId, ...(runner === "0.1.15" ? { callSeq: call } : {}), characters: written.length, preview: tailOf(written) } });
  }
  return events;
}

/** The last JSON a call said: what its tail ends with (the runner says it at most every 350 ms, so not always the whole reply). */
function lastJson(events: Timed[]): { preview: string; characters: number } {
  const body = last(events.filter((event) => event.body.kind === "json"))!.body;
  return { preview: body.preview as string, characters: body.characters as number };
}

/** What a person sees of the step that runs: its text, «answering» with the bytes of the reply, or nothing. */
const seen = (live: LivePreview | null | undefined) => (!live ? "nothing" : live.preview ? "text" : live.bytes !== undefined ? "answering" : "nothing");

/** The events through the store, one after the other: every state the panels draw from, with the call it belongs to. */
function replayInStore(events: Timed[]): Array<{ call: number; live: LivePreview | null | undefined }> {
  return events.map(({ body, call }, index) => {
    useAutopilotStore.getState().ingest(eventOf(body, 100 + index), LOCAL_BOOK.name);
    return { call, live: useAutopilotStore.getState().live[BOOK] };
  });
}

/** Within each call: once its text is shown it never goes away, «answering» never takes its place, and its count never goes down. */
function expectSteady(states: Array<{ call: number; live: LivePreview | null | undefined }>) {
  const calls = [...new Set(states.map((state) => state.call))];
  for (const call of calls) {
    const own = states.filter((state) => state.call === call);
    const first = own.findIndex((state) => seen(state.live) === "text");
    expect(first, `call ${call} shows its text`).toBeGreaterThanOrEqual(0);
    own.slice(first).forEach((state, index) => {
      expect(seen(state.live), `call ${call}, state ${first + index}: the text stays`).toBe("text");
      if (index > 0) expect(state.live!.characters, `call ${call}, state ${first + index}: the count never goes down`).toBeGreaterThanOrEqual(own[first + index - 1].live!.characters);
    });
  }
}

const start = (activity = CONCEPT) => useAutopilotStore.getState().ingest(eventOf({ type: "task-started", activity }, 1), LOCAL_BOOK.name);

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  provideCallsSources(null);
  useCallsView.setState({ raw: false, open: {}, live: {}, epoch: 0 });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ autopilotText: "full" });
});

describe("what the store keeps of a structured step that streams, replayed from a real run", () => {
  it.each<Runner>(["0.1.14", "0.1.15"])("ten seconds of the concept from the %s runner: once the JSON is shown it stays, with one count that never goes down, and its bytes", (runner) => {
    start();
    const events = structuredCall({ runner, json: CONCEPT_JSON, duration: 10_000, lead: 1_500 });
    const states = replayInStore(events);
    expect(seen(states[0].live), "the model thinks first: «answering»").toBe("answering");
    expectSteady(states);
    const end = last(states)!.live!;
    expect(end).toMatchObject({ ...lastJson(events), json: true });
    expect(end.bytes).toBeGreaterThan(0);
    // One count, the JSON's: never the client's larger one of the numbers events.
    expect(states.every((state) => state.live!.characters <= CONCEPT_JSON.length)).toBe(true);
  });

  it.each<{ runner: Runner; records: boolean }>([
    { runner: "0.1.14", records: true },
    { runner: "0.1.14", records: false },
    { runner: "0.1.15", records: true },
    { runner: "0.1.15", records: false },
  ])("a step that asks again (a new call of the same step, $runner, records: $records): nothing of the first call is shown as the second's, and the second's count never goes down", ({ runner, records }) => {
    start();
    const first = structuredCall({ runner, json: CONCEPT_JSON, duration: 4_000, call: 1, ...(records ? { callId: `${CONCEPT.id}-0001` } : {}) });
    const again = CONCEPT_JSON.replace("glassmaker's daughter", "lens grinder's son");
    const second = structuredCall({ runner, json: again, from: 4_100, duration: 4_000, lead: 1_200, call: 2, ...(records ? { callId: `${CONCEPT.id}-0002` } : {}), carried: tailOf(CONCEPT_JSON) });
    const states = replayInStore([...first, ...second]);
    expectSteady(states);
    for (const state of states.filter((entry) => entry.call === 2)) {
      expect(state.live!.preview, "nothing of the first call during the second").not.toContain("glassmaker's daughter");
    }
    expect(states.filter((entry) => entry.call === 2).map((state) => seen(state.live))[0], "the second call says «answering» until it writes").toBe("answering");
    expect(last(states)!.live!.preview).toBe(lastJson(second).preview);
  });

  it.each<Runner>(["0.1.14", "0.1.15"])("a client that falls back to another model in the middle of a call (%s): the text of the first attempt stays until the second writes, then the second takes its place", (runner) => {
    start();
    const first = structuredCall({ runner, json: CONCEPT_JSON, duration: 3_000, callId: `${CONCEPT.id}-0001` });
    const names = runner === "0.1.15" ? { callSeq: 1, callId: `${CONCEPT.id}-0001` } : { callId: `${CONCEPT.id}-0001` };
    const restart: Timed = { at: 3_050, call: 1, body: { type: "task-progress", activityId: CONCEPT.id, ...names, kind: "json", characters: 0, preview: "" } };
    const second = structuredCall({ runner, json: CONCEPT_JSON.replace("glassmaker's", "potter's"), from: 3_100, duration: 3_000, callId: `${CONCEPT.id}-0001` });
    const states = replayInStore([...first, restart, ...second]);
    const shown = states.findIndex((state) => seen(state.live) === "text");
    expect(states.slice(shown).every((state) => seen(state.live) === "text"), "never nothing on screen, the restart included").toBe(true);
    expect(last(states)!.live!.preview).toContain("potter's");
  });

  it.each<Runner>(["0.1.14", "0.1.15"])("a scene and then its summary, in the same step (%s): the scene is not shown as the summary's text, and the summary's JSON is", (runner) => {
    start(SCENE);
    const prose = proseCall({ runner, activityId: SCENE.id, text: SCENE_TEXT, duration: 3_000, call: 1 });
    const summary = structuredCall({ runner, json: SUMMARY_JSON, from: 3_100, duration: 3_000, lead: 1_100, call: 2 }).map((event) => ({ ...event, body: { ...event.body, activityId: SCENE.id } }));
    const states = replayInStore([...prose, ...summary]);
    expectSteady(states);
    for (const state of states.filter((entry) => entry.call === 2)) {
      expect(state.live!.preview, "nothing of the scene while its summary streams").not.toContain("keeper climbed");
    }
    expect(states.filter((entry) => entry.call === 2).map((state) => seen(state.live))[0]).toBe("answering");
    expect(last(states)!.live).toMatchObject({ ...lastJson(summary), json: true });
  });

  it("a scene, then the concept of another step: the new step starts from nothing", () => {
    start(SCENE);
    replayInStore(proseCall({ runner: "0.1.15", activityId: SCENE.id, text: SCENE_TEXT, duration: 2_000 }));
    useAutopilotStore.getState().ingest(finishedEvent(SCENE, 50), LOCAL_BOOK.name);
    start();
    expect(useAutopilotStore.getState().live[BOOK]).toEqual({ activity: CONCEPT, characters: 0, preview: "" });
    const states = replayInStore(structuredCall({ runner: "0.1.15", json: CONCEPT_JSON, duration: 3_000, lead: 1_000 }));
    expect(states.every((state) => !state.live!.preview.includes("keeper"))).toBe(true);
    expectSteady(states);
  });

  it("a `state` event in the middle changes nothing of what is shown", () => {
    start();
    replayInStore(structuredCall({ runner: "0.1.15", json: CONCEPT_JSON, duration: 3_000 }));
    const before = useAutopilotStore.getState().live[BOOK];
    const summary = { ...useAutopilotStore.getState().summaries[BOOK], status: "running" };
    useAutopilotStore.getState().ingest(eventOf({ type: "state", state: summary }, 90), LOCAL_BOOK.name);
    expect(useAutopilotStore.getState().live[BOOK]).toBe(before);
  });
});

describe("the step a snapshot says runs, where the panels follow none", () => {
  const snapshotOf = (live: unknown, running = true): AutopilotSnapshot => ({ bookId: BOOK, state: createAutopilotState(new Date("2026-11-21T10:00:00.000Z")), activities: [], live: live as AutopilotSnapshot["live"], running, host: "server" });
  const SO_FAR = CONCEPT_JSON.slice(0, 180);

  it("is shown at once (a page opened while it runs, a connection that came back), and the events go on from it", () => {
    useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshotOf({ activity: CONCEPT, characters: SO_FAR.length, preview: SO_FAR, json: true, bytes: 600, callSeq: 1 }) });
    expect(useAutopilotStore.getState().live[BOOK]).toEqual({ activity: CONCEPT, characters: SO_FAR.length, preview: SO_FAR, json: true, bytes: 600, callSeq: 1 });
    const events = structuredCall({ runner: "0.1.15", json: CONCEPT_JSON, duration: 3_000 }).filter((event) => (event.body.characters as number) >= SO_FAR.length);
    const states = replayInStore(events);
    expect(states.every((state) => seen(state.live) === "text")).toBe(true);
    expect(last(states)!.live!.preview).toBe(lastJson(events).preview);
  });

  it("reads what an older server says (no names, no mark of the JSON) as it is", () => {
    useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshotOf({ activity: CONCEPT, characters: 90, preview: "{\"logline\"", bytes: 300, extra: "dropped" }) });
    expect(useAutopilotStore.getState().live[BOOK]).toEqual({ activity: CONCEPT, characters: 90, preview: "{\"logline\"", bytes: 300 });
  });

  it("is not brought back when nothing runs, when the events said the step ended, or over the step the panels follow", () => {
    const live = { activity: CONCEPT, characters: SO_FAR.length, preview: SO_FAR, json: true, callSeq: 1 };
    useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshotOf(live, false) });
    expect(useAutopilotStore.getState().live[BOOK]).toBeUndefined();
    useAutopilotStore.getState().ingest(finishedEvent(CONCEPT, 7), LOCAL_BOOK.name);
    useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshotOf(live) });
    expect(useAutopilotStore.getState().live[BOOK]).toBeNull();
    useAutopilotStore.setState({ feed: [] });
    start(SCENE);
    useAutopilotStore.getState().patchView(BOOK, { snapshot: snapshotOf(live) });
    expect(useAutopilotStore.getState().live[BOOK]).toEqual({ activity: SCENE, characters: 0, preview: "" });
  });
});

// ─── What the panels draw, recorded at every change of the page ────────────────────────────────────────────────

/**
 * Plays `events` through the store at their moments on the fake clock, 50 ms at a time, and records what `read` finds on the page at every change of
 * the page (a mutation observer) and every 50 ms: what a person would have seen, frame by frame.
 */
async function record<T>(events: Timed[], read: () => T, until = (last(events)?.at ?? 0) + 500): Promise<T[]> {
  const frames: T[] = [read()];
  const observer = new MutationObserver(() => frames.push(read()));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  let next = 0;
  for (let now = 0; now <= until; now += 50) {
    while (next < events.length && events[next].at <= now) {
      const { body } = events[next];
      act(() => { useAutopilotStore.getState().ingest(eventOf(body, 100 + next), LOCAL_BOOK.name); });
      next += 1;
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    frames.push(read());
  }
  observer.disconnect();
  return frames;
}

const countIn = (text: string) => {
  const found = /([\d,]+) characters?/.exec(text)?.[1];
  return found ? Number(found.replace(/,/g, "")) : null;
};

/** Once the text is on the page it stays in every frame, with a count that never goes down, and «answering» never comes back. */
function expectNoFlicker(frames: Array<{ text: string; characters: number | null; answering: boolean }>, where: string) {
  const first = frames.findIndex((frame) => frame.text !== "");
  expect(first, `${where} shows the JSON`).toBeGreaterThanOrEqual(0);
  const after = frames.slice(first);
  const gone = after.filter((frame) => frame.text === "").length;
  expect(gone, `${where}: frames without the text once it was shown`).toBe(0);
  expect(after.filter((frame) => frame.answering).length, `${where}: frames that said «answering» again`).toBe(0);
  const counts = after.map((frame) => frame.characters).filter((value): value is number => value !== null);
  const drops = counts.filter((value, index) => index > 0 && value < counts[index - 1]);
  expect(drops, `${where}: the count went down`).toEqual([]);
}

describe("what the panels draw while the concept streams", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:01:26.000Z"));
  });

  it.each<Runner>(["0.1.14", "0.1.15"])("the mini-player (%s): «answering» while the model thinks, then the lines of the JSON, which stay, in a fixed-width font, with one count that never goes down", async (runner) => {
    seedRun({ status: "running", running: true, dockOpen: true, live: { activity: CONCEPT } });
    useAutopilotStore.setState({ dockTab: "book" });
    render(<MemoryRouter initialEntries={[`/app/books/${BOOK}`]}><AutopilotDock /></MemoryRouter>);
    const panel = screen.getByRole("region", { name: t("autopilot.dockTitle") });
    const read = () => {
      const lines = panel.querySelector("[data-stream-lines]");
      return { text: lines?.querySelector("[data-stream-text]")?.textContent ?? "", characters: countIn(lines?.textContent ?? ""), answering: Boolean(panel.querySelector("[data-band-progress]")) };
    };
    const events = structuredCall({ runner, json: CONCEPT_JSON, duration: 10_000, lead: 1_500 });
    const frames = await record(events, read);
    expect(frames.slice(0, 20).some((frame) => frame.answering && frame.text === ""), "«answering» before the JSON").toBe(true);
    expectNoFlicker(frames, "the mini-player");
    expect(panel.querySelector("[data-stream-text]")).toHaveAttribute("data-stream-json");
    expect((panel.querySelector("[data-stream-text]") as HTMLElement).className).toMatch(/\bfont-mono\b/);
    expect(last(frames)!.characters).toBe(lastJson(events).characters);
  });

  it.each<Runner>(["0.1.14", "0.1.15"])("the in-progress card of the Autopilot page (%s): its JSON and its count stay once it has more than the band shows", async (runner) => {
    seedRun({ status: "running", running: true, live: { activity: CONCEPT } });
    render(<MemoryRouter><TimelineLive bookId={BOOK} shownAbove={STREAM_CHARACTERS} /></MemoryRouter>);
    const read = () => {
      const card = document.querySelector("[data-timeline-live]");
      const text = [...(card?.querySelectorAll("p") ?? [])].find((paragraph) => paragraph.textContent?.startsWith("{"))?.textContent ?? "";
      return { text, characters: countIn(card?.textContent ?? ""), answering: Boolean(card?.querySelector("[data-band-progress]")) };
    };
    const events = structuredCall({ runner, json: CONCEPT_JSON, duration: 10_000, lead: 1_500 });
    const frames = await record(events, read);
    expectNoFlicker(frames, "the card");
    expect(last(frames)).toEqual({ text: lastJson(events).preview, characters: lastJson(events).characters, answering: false });
  });

  it("the response of the call, in the messages of the step: the end of the live JSON stays after what the record has, with a counter that never goes down", async () => {
    const calls = new MemoryAiCallStore();
    const source = { ...localCallsSource(calls), pollMs: 1_000 };
    provideCallsSources(() => source);
    const started = beginRecord(STEP, { structured: true, tool: "book_concept", label: "Design the concept" });
    await calls.begin(started);
    await saveTask(calls, STEP, "running", CONCEPT.title);
    seedRun({ status: "running", running: true, live: { activity: CONCEPT } });
    render(<MemoryRouter initialEntries={[`/app/books/${BOOK}/autopilot`]}><TaskCalls bookId={BOOK} activityIds={[STEP]} running announce={vi.fn()} /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const pane = () => document.querySelector<HTMLElement>("[data-call-pane=\"response\"]");
    const read = () => {
      const region = pane()?.querySelector("[role=\"region\"]");
      const text = region?.textContent?.startsWith("{") ? region.textContent : "";
      return { text, characters: countIn(pane()?.querySelector("h6 + span")?.textContent ?? ""), answering: false };
    };
    // The record is behind the live events, as it is from a personal server: it has, once a second, what the JSON was half a second before.
    const events = structuredCall({ runner: "0.1.15", json: CONCEPT_JSON, duration: 10_000, lead: 1_000, callId: started.record.callId });
    let kept = "";
    const behind: Timed[] = [];
    for (let at = 1_000; at <= 10_000; at += 1_000) {
      const then = last(events.filter((event) => event.at <= at - 500 && event.body.kind === "json"));
      if (then) behind.push({ at, call: 1, body: { type: "record", text: CONCEPT_JSON.slice(0, then.body.characters as number) } });
    }
    const timeline = [...events, ...behind].sort((a, b) => a.at - b.at);
    const frames: Array<ReturnType<typeof read>> = [read()];
    const observer = new MutationObserver(() => frames.push(read()));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    let next = 0;
    for (let now = 0; now <= 10_500; now += 50) {
      while (next < timeline.length && timeline[next].at <= now) {
        const { body } = timeline[next];
        if (body.type === "record") {
          const text = body.text as string;
          await calls.append(started.record.callId, 1, new TextEncoder().encode(kept).length, text.slice(kept.length));
          kept = text;
        } else {
          act(() => { useAutopilotStore.getState().ingest(eventOf(body, 100 + next), LOCAL_BOOK.name); });
        }
        next += 1;
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      frames.push(read());
    }
    observer.disconnect();
    const first = frames.findIndex((frame) => frame.text !== "");
    expect(first).toBeGreaterThanOrEqual(0);
    const after = frames.slice(first);
    expect(after.filter((frame) => frame.text === "").length, "frames without the JSON once it was shown").toBe(0);
    const shorter = after.filter((frame, index) => index > 0 && frame.text.length < after[index - 1].text.length);
    expect(shorter.map((frame) => frame.text.length), "the text went back").toEqual([]);
    const counts = after.map((frame) => frame.characters).filter((value): value is number => value !== null);
    expect(counts.filter((value, index) => index > 0 && value < counts[index - 1]), "the counter went down").toEqual([]);
    expect(last(after)!.text).toBe(lastJson(events).preview);
  });

  it("the polite voice says «answering» once for the step, and its end with the most it wrote: the scene, not the summary that followed it", async () => {
    seedRun({ status: "running", running: true, live: { activity: SCENE } });
    render(<LiveAnnouncer bookIds={[BOOK]} />);
    const voice = () => document.querySelector("[data-live-announcer]") as HTMLElement;
    const said: string[] = [];
    const observer = new MutationObserver(() => { if (voice().textContent) said.push(voice().textContent!); });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    const prose = proseCall({ runner: "0.1.15", activityId: SCENE.id, text: SCENE_TEXT, duration: 3_000, call: 1 });
    const summary = structuredCall({ runner: "0.1.15", json: SUMMARY_JSON, from: 3_100, duration: 3_000, lead: 1_100, call: 2 }).map((event) => ({ ...event, body: { ...event.body, activityId: SCENE.id } }));
    await record([...prose, ...summary, { at: 6_200, call: 2, body: finishedEvent(SCENE, 99) as unknown as Record<string, unknown> }], () => null, 20_000);
    observer.disconnect();
    expect(said.filter((text) => text === t("autopilot.liveText.say.answering"))).toHaveLength(1);
    expect(last(said)).toBe(`${t("autopilot.liveText.say.complete", { count: SCENE_TEXT.length, value: String(SCENE_TEXT.length) })} ${t("autopilot.liveText.say.done", { step: SCENE.title })}`);
  });
});
