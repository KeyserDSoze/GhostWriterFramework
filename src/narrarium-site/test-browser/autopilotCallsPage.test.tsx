import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAiCallStore, aiCallIdOf, type AutopilotActivity } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { provideCallsSources } from "@/autopilot/calls/sourceHook";
import { getAiCallStore, resetAiCallStoreForTests } from "@/autopilot/calls/wire";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { callElementId } from "@/components/autopilot/calls/anchors";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { ingest, runningStep, seedRun, stubWidth } from "./helpers/autopilotBand";
import { chapterFlow, eventAt, resetIds, resetSeq } from "./helpers/autopilotTimeline";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";
import { beginRecord, recordCall, saveTask, storeAsSource } from "./helpers/aiCalls";

const PREVIEW = "The keeper climbed the stairs counting the steps under his breath, and on every landing the wind changed its note.";

function history() {
  resetIds();
  resetSeq();
  const four = chapterFlow(4, { from: 0, rounds: 1 });
  const five = chapterFlow(5, { from: four.end + 10, rounds: 1, closed: false });
  return { four: four.activities, five: five.activities, activities: [...four.activities, ...five.activities] };
}

function Page({ hash = "" }: { hash?: string }) {
  return (
    <MemoryRouter initialEntries={[`/app/books/book-1/autopilot${hash}`]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const summaryOf = (id: string) => document.getElementById(`task-${id}`) as HTMLElement;
const viewOf = (row: HTMLElement) => row.closest("details")!.querySelector<HTMLElement>("[data-task-calls]");

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
  provideCallsSources(null);
  (await getAiCallStore())?.close();
  resetAiCallStoreForTests();
  useCallsView.setState({ raw: false, open: {}, live: {}, epoch: 0 });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ autopilotText: "full" });
  await i18n.changeLanguage("en");
});

describe("the messages of a step in the history", () => {
  it("are under the step once it is opened, in their own view", async () => {
    const { store } = storeAsSource(new MemoryAiCallStore());
    const { five, activities } = history();
    const step = five.find((activity) => activity.task === "write") as AutopilotActivity;
    await recordCall(store, step.id, { label: "Write scene 1", texts: ["The keeper climbed the stairs."] });
    seedRun({ status: "paused", activities });
    render(<Page />);
    const row = summaryOf(step.id);
    expect(viewOf(row)).toBeNull();
    fireEvent.click(row);
    expect(await within(row.closest("details") as HTMLElement).findByRole("heading", { name: t("autopilot.calls.title") })).toBeInTheDocument();
    expect(await within(viewOf(row)!).findByText("The keeper climbed the stairs.")).toBeInTheDocument();
    // The status line of the history is still the only one in it.
    expect(document.querySelectorAll("[data-autopilot-timeline] [role='status']")).toHaveLength(1);
  });

  it("are read from this browser's store when nothing else is put in its place: a step that has none says so in words, and the step that runs has its button", async () => {
    const { five, activities } = history();
    const step = five.find((activity) => activity.task === "write") as AutopilotActivity;
    seedRun({ status: "paused", activities });
    const paused = render(<Page />);
    fireEvent.click(summaryOf(step.id));
    await screen.findAllByText(/what happens in scene 1/);
    await waitFor(() => expect(document.querySelector("[data-task-calls]")).not.toBeNull());
    expect(await screen.findByText(t("autopilot.calls.empty"))).toBeInTheDocument();
    paused.unmount();
    seedRun({ status: "running", running: true, activities, live: { activity: runningStep("write", "Writing scene 3 of chapter 5", { id: "live-step", chapterNumber: 5, sceneNumber: 3 }), characters: PREVIEW.length, preview: PREVIEW } });
    render(<Page />);
    expect(document.querySelector("[data-timeline-live]")).not.toBeNull();
    expect(await screen.findByRole("button", { name: t("autopilot.calls.show") })).toBeInTheDocument();
  });
});

describe("a link to a call (#call-<id>)", () => {
  it("opens the Timeline tab on a page that has tabs, opens the step and the call, and gives the call the focus", async () => {
    stubWidth(700);
    const { store } = storeAsSource(new MemoryAiCallStore());
    const { four, activities } = history();
    const step = four.find((activity) => activity.task === "write" && activity.sceneNumber === 2) as AutopilotActivity;
    const first = await recordCall(store, step.id, { seq: 1, label: "Plan the scene", texts: ["A plan."] });
    await recordCall(store, step.id, { seq: 2, label: "Write the scene", texts: ["The scene."] });
    seedRun({ status: "paused", activities });
    render(<Page hash={`#${callElementId(first.callId)}`} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: t("autopilot.tabs.timeline") })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(document.activeElement?.id).toBe(callElementId(first.callId)));
    expect(summaryOf(step.id).closest("details")).toHaveAttribute("open");
    expect(await within(document.activeElement as HTMLElement).findByText("A plan.")).toBeInTheDocument();
  });
});

describe("the messages of the step that runs", () => {
  const LIVE = () => runningStep("write", "Writing scene 3 of chapter 5", { id: "live-step", chapterNumber: 5, sceneNumber: 3 });

  it("are behind a button of its block, and follow its answer once they are open", async () => {
    const { store } = storeAsSource(new MemoryAiCallStore());
    const { activities } = history();
    const started = beginRecord("live-step", { label: "Write scene 3" });
    await store.begin(started);
    await store.append(started.record.callId, 1, 0, "The keeper climbed the stairs counting the steps under his breath");
    seedRun({ status: "running", running: true, activities, live: { activity: LIVE(), characters: PREVIEW.length, preview: PREVIEW } });
    render(<Page />);
    const block = document.querySelector("[data-timeline-live]") as HTMLElement;
    const toggle = within(block).getByRole("button", { name: t("autopilot.calls.show") });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(block.querySelector("[data-task-calls]")).toBeNull();
    fireEvent.click(toggle);
    expect(within(block).getByRole("button", { name: t("autopilot.calls.hide") })).toHaveAttribute("aria-expanded", "true");
    const region = await waitFor(() => {
      const found = block.querySelector<HTMLElement>("[data-call-pane='response'] [role='region']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(region).toHaveAttribute("aria-busy", "true");
    // The record and then the end of the live events, past where the record stops.
    await waitFor(() => expect(region.textContent).toBe(PREVIEW));
  });

  it("open themselves for a link to one of its calls", async () => {
    const { store } = storeAsSource(new MemoryAiCallStore());
    const { activities } = history();
    const started = beginRecord("live-step");
    await store.begin(started);
    seedRun({ status: "running", running: true, activities, live: { activity: LIVE(), characters: PREVIEW.length, preview: PREVIEW } });
    render(<Page hash={`#${callElementId(aiCallIdOf("live-step", 1))}`} />);
    await waitFor(() => expect(document.activeElement?.id).toBe(callElementId(started.record.callId)));
    expect(document.querySelector("[data-timeline-live]")).toContainElement(document.activeElement as HTMLElement);
  });

  it("stay open when the step ends: its row opens on them", async () => {
    const { store } = storeAsSource(new MemoryAiCallStore());
    const { activities } = history();
    const live = LIVE();
    const started = beginRecord("live-step", { label: "Write scene 3" });
    await store.begin(started);
    await store.append(started.record.callId, 1, 0, "The keeper climbed.");
    seedRun({ status: "running", running: true, activities, live: { activity: live, characters: PREVIEW.length, preview: PREVIEW } });
    render(<Page />);
    fireEvent.click(within(document.querySelector("[data-timeline-live]") as HTMLElement).getByRole("button", { name: t("autopilot.calls.show") }));
    await waitFor(() => expect(document.querySelector("[data-timeline-live] [data-call]")).not.toBeNull());
    await saveTask(store, "live-step", "done");
    await ingest(eventAt(9_000, { type: "task-finished", activity: { ...live, status: "succeeded", endedAt: new Date(Date.parse(live.startedAt) + 60_000).toISOString() } }));
    await waitFor(() => expect(summaryOf("live-step").closest("details")).toHaveAttribute("open"));
    const view = await waitFor(() => {
      const found = viewOf(summaryOf("live-step"));
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(await within(view).findByText("The keeper climbed.")).toBeInTheDocument();
    expect(within(view).getAllByRole("button", { expanded: true }).some((button) => button.textContent?.startsWith("Write scene 3"))).toBe(true);
  });
});

describe("the texts of the messages", () => {
  it("are said in Italian too", async () => {
    await i18n.changeLanguage("it");
    const { store } = storeAsSource(new MemoryAiCallStore());
    const { five, activities } = history();
    const step = five.find((activity) => activity.task === "write") as AutopilotActivity;
    await recordCall(store, step.id, { texts: ["Il guardiano salì le scale."] });
    seedRun({ status: "paused", activities });
    render(<Page />);
    fireEvent.click(summaryOf(step.id));
    const view = await screen.findByRole("heading", { name: "Messaggi all'IA" });
    const section = view.closest("[data-task-calls]") as HTMLElement;
    expect(await within(section).findByText("Il guardiano salì le scale.")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Tieni" })).toHaveAttribute("aria-pressed", "false");
    expect(within(section).getByRole("button", { name: "Grezzo" })).toHaveAttribute("aria-pressed", "false");
    expect(within(section).getByRole("region", { name: /^Risposta di «/ })).toBeInTheDocument();
  });
});
