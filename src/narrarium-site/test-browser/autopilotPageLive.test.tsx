import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutopilotState, type AutopilotActivity, type AutopilotEvent, type AutopilotState, type AutopilotStateSummary, type PlannedChapter } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ book: null as unknown, refresh: vi.fn(async () => null), toast: vi.fn(), save: vi.fn(), reload: vi.fn() }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ refresh: mocks.refresh, describeError: (error: unknown) => String(error) }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { countTitleReads, longPlan, planOf } from "./helpers/autopilotFixtures";
import { countActivityReads, richHistory } from "./helpers/autopilotTimeline";

const T0 = "2026-11-21T10:00:00.000Z";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: T0, autopilotHost: "server" };
const RUNNER = { host: "server" as const, label: "My server", runId: "run-1", startedAt: T0, heartbeatAt: T0 };
const STATS = { tasks: 5, aiCalls: 5, inputTokens: 100, outputTokens: 50, cost: 0, failures: 0 };

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

function stateOf(chapters: PlannedChapter[], patch: Partial<AutopilotState> = {}): AutopilotState {
  return {
    ...createAutopilotState(new Date(T0)),
    status: "running",
    phase: "write",
    plan: planOf(chapters),
    review: { chapterNumber: 1000 } as never,
    runner: RUNNER,
    stats: STATS,
    updatedAt: T0,
    ...patch,
  };
}

function seed(state: AutopilotState | null, running = true, activities: AutopilotActivity[] = []) {
  useAutopilotStore.setState({
    views: { [BOOK.id]: { ...emptyView(BOOK.id), snapshot: { bookId: BOOK.id, state, activities, live: null, running, host: "server" } } },
    summaries: {},
    live: {},
    feed: [],
  });
}

const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const event = (body: Record<string, unknown>, seq: number) => ({ bookId: BOOK.id, at: at(seq), seq, ...body }) as AutopilotEvent;
const ingest = (next: AutopilotEvent) => act(() => { useAutopilotStore.getState().ingest(next, BOOK.name); });

const started = event({ type: "task-started", activity: { id: "activity-1", runId: "run-1", task: "write", phase: "write", title: "Writing scene 1 of chapter 1000", reason: "", next: "", status: "running", startedAt: T0 } }, 1);
const progress = (step: number) => event({ type: "task-progress", activityId: "activity-1", characters: step * 10, preview: `Words streamed so far, step ${step}` }, 10 + step);

function summary(patch: Partial<AutopilotStateSummary> = {}, seconds = 60): AutopilotStateSummary {
  return {
    status: "running",
    phase: "write",
    message: null,
    progress: { chapters: 2000, chaptersDone: 999, scenes: 4000, scenesWritten: 1998, words: 1_400_000 },
    question: null,
    lastError: null,
    runner: RUNNER,
    stats: STATS,
    pendingNotes: 0,
    constraints: 0,
    updatedAt: at(seconds),
    ...patch,
  };
}
const stateEvent = (next: AutopilotStateSummary, seq: number) => event({ type: "state", state: next }, seq);

const total = (reads: Map<number, number>) => [...reads.values()].reduce((sum, count) => sum + count, 0);
// The figures of a run are in the control band: the progress bars of the chapters and the scenes, and the line of the cost and the use.
const bandOf = () => within(document.querySelector("[data-autopilot-band]") as HTMLElement);

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.refresh.mockClear();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
});

afterEach(() => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("a long plan while the autopilot streams its text", () => {
  it("is not drawn again for the live preview, that updates three times a second", async () => {
    const reads = new Map<number, number>();
    seed(stateOf(countTitleReads(longPlan(2000, 999), reads)));
    render(<Page />);
    await ingest(started);
    expect(reads.size).toBe(21);
    const drawn = total(reads);

    for (let step = 1; step <= 60; step += 1) await ingest(progress(step));
    expect(screen.getAllByText("Words streamed so far, step 60").length).toBeGreaterThan(0);
    expect(total(reads)).toBe(drawn);
  });

  it("is not drawn again for the summaries that come with every step", async () => {
    const reads = new Map<number, number>();
    seed(stateOf(countTitleReads(longPlan(2000, 999), reads)));
    render(<Page />);
    const drawn = total(reads);

    for (let step = 1; step <= 40; step += 1) await ingest(stateEvent(summary({ stats: { ...STATS, aiCalls: 5 + step } }, 10 + step), step));
    expect(bandOf().getByText("45 calls")).toBeInTheDocument();
    expect(total(reads)).toBe(drawn);
  });

  it("does not draw the rows of the history again for the live preview or for the summaries that come with every step", async () => {
    const reads = new Map<string, number>();
    seed(stateOf(longPlan(2000, 999)), true, countActivityReads(richHistory().activities, reads));
    render(<Page />);
    await ingest(started);
    const drawn = [...reads.values()].reduce((sum, count) => sum + count, 0);
    expect(drawn, "the rows of the group that is open are drawn").toBeGreaterThan(0);

    for (let step = 1; step <= 60; step += 1) await ingest(progress(step));
    for (let step = 1; step <= 40; step += 1) await ingest(stateEvent(summary({ stats: { ...STATS, aiCalls: 5 + step } }, 10 + step), 100 + step));
    expect(screen.getAllByText("Words streamed so far, step 60").length).toBeGreaterThan(0);
    expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBe(drawn);
  });

  it("draws only the chapters of the window again when a new download replaces the plan", async () => {
    const first = new Map<number, number>();
    seed(stateOf(countTitleReads(longPlan(2000, 999), first)));
    render(<Page />);
    expect(first.size).toBe(21);

    const second = new Map<number, number>();
    act(() => { seed(stateOf(countTitleReads(longPlan(2000, 1000), second), { updatedAt: at(90) })); });
    expect(second.size).toBe(21);
    expect(total(second)).toBe(21);
    expect(screen.getByText("Title 1001")).toBeInTheDocument();
  });
});

describe("the status and the statistics of a run", () => {
  it("follow the summary of the state event without a new download", async () => {
    seed(stateOf(longPlan(2000, 999), { status: "paused", phase: "write", runner: null }), false);
    render(<Page />);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(bandOf().getByText("999/2000")).toBeInTheDocument();
    expect(bandOf().getByText("5 calls")).toBeInTheDocument();

    await ingest(stateEvent(summary({ status: "running", phase: "review", progress: { chapters: 2000, chaptersDone: 1000, scenes: 4000, scenesWritten: 2000, words: 1_500_000 }, stats: { ...STATS, aiCalls: 42, inputTokens: 9000, outputTokens: 1000 } }), 5));
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
    expect(bandOf().getByText("1000/2000")).toBeInTheDocument();
    expect(bandOf().getByText("42 calls")).toBeInTheDocument();
    expect(bandOf().getByText(/^10.?000 tokens$/)).toBeInTheDocument();
    // The phase is in the list of phases of the band: the chapters, which is where writing and reviewing happen.
    expect(within(bandOf().getByRole("list", { name: "Phases" })).getByRole("listitem", { current: "step" })).toHaveTextContent("Chapters 1000/2000");
    expect(screen.getByText("The autopilot of this book is running on My server.")).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("show a question the director asks as soon as its summary arrives", async () => {
    seed(stateOf(longPlan(2000, 999)));
    render(<Page />);
    expect(screen.queryByText(i18n.t("autopilot.question.title"))).not.toBeInTheDocument();

    const question = { id: "question-1", kind: "director" as const, question: "Keep the ending open?", context: "", options: ["Yes", "No"], askedAt: at(70) };
    await ingest(stateEvent(summary({ status: "waiting-author", question }, 70), 6));
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
    expect(screen.getByText("Keep the ending open?")).toBeInTheDocument();
  });

  it("ignore a summary that is older than the state on the page", async () => {
    seed(stateOf(longPlan(2000, 999), { updatedAt: at(100), stats: { ...STATS, aiCalls: 77 } }));
    render(<Page />);
    await ingest(stateEvent(summary({ stats: { ...STATS, aiCalls: 5 } }, 50), 7));
    expect(bandOf().getByText("77 calls")).toBeInTheDocument();
    expect(bandOf().queryByText("5 calls")).not.toBeInTheDocument();
  });

  it("have nothing to show for an autopilot that was reset, whatever summary is left", async () => {
    seed(null, false);
    await ingest(stateEvent(summary({}, 80), 8));
    render(<Page />);
    // Changed on purpose (the menu in groups): a book that never started invites to the configuration instead of showing the form to start.
    expect(screen.getByText(i18n.t("autopilot.live.inviteTitle"))).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByText(/ calls$/)).not.toBeInTheDocument();
  });
});
