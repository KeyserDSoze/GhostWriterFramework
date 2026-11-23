import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity, AutopilotState, AutopilotStateSummary, DirectorQuestion, PlannedChapter } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
  summarize: { calls: 0 },
}));

vi.mock("narrarium-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("narrarium-engine")>();
  return {
    ...original,
    summarizeAutopilotState: (...args: Parameters<typeof original.summarizeAutopilotState>) => {
      mocks.summarize.calls += 1;
      return original.summarizeAutopilotState(...args);
    },
  };
});
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import { createAutopilotState, summarizeAutopilotState } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotHubPage } from "@/pages/AutopilotHubPage";
import { emptyView, useAutopilotStore, type BookAutopilotView, type LivePreview } from "@/autopilot/store";
import { formatAgo, formatCost, formatCount } from "@/autopilot/format";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { makeRuntime } from "./helpers/quickCommands";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const T0 = "2026-11-22T09:00:00.000Z";
const named = (label: string, book: BookEntry) => t("autopilot.quick.named", { label, context: book.name });
const plain = (text: string) => text.replace(/\s+/g, " ").trim();

const book = (number: number, name: string, patch: Partial<BookEntry> = {}): BookEntry => ({ id: `book-${number}`, owner: "local", repo: `book-${number}`, name, tokenIndex: null, storageMode: "local-only", addedAt: T0, ...patch });

function chapters(total: number, done: number, rounds: PlannedChapter["rounds"] = []): PlannedChapter[] {
  return Array.from({ length: total }, (_, index) => ({
    number: index + 1, title: `Chapter ${index + 1}`, slug: `${String(index + 1).padStart(3, "0")}-chapter`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], scenes: [],
    status: index < done ? "done" : index === done ? "writing" : "planned",
    ...(index === done - 1 && rounds?.length ? { rounds } : {}),
  }) as PlannedChapter);
}

interface Seed {
  book: BookEntry;
  /** `null`: the autopilot never started (the book was read, there is no state); `undefined`: the book has not been read yet. */
  state?: Partial<AutopilotState> | null;
  summary?: Partial<AutopilotStateSummary>;
  activities?: AutopilotActivity[];
  live?: LivePreview;
  running?: boolean;
  error?: string;
}

function stateOf(patch: Partial<AutopilotState>): AutopilotState {
  return { ...createAutopilotState(new Date(T0)), phase: "write", updatedAt: T0, ...patch } as AutopilotState;
}

function seedHub(seeds: Seed[]) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: seeds.map((seed) => seed.book), aiIntegrations: [{ id: "ai-1" } as never] } });
  const views: Record<string, BookAutopilotView> = {};
  const summaries: Record<string, AutopilotStateSummary> = {};
  const live: Record<string, LivePreview | null> = {};
  for (const seed of seeds) {
    const id = seed.book.id;
    if (seed.error !== undefined) {
      views[id] = { ...emptyView(id), error: seed.error };
      continue;
    }
    if (seed.state === undefined) continue;
    const state = seed.state === null ? null : stateOf(seed.state);
    const summary = state ? { ...summarizeAutopilotState(state), ...seed.summary } : null;
    views[id] = { ...emptyView(id), snapshot: { bookId: id, state, ...(summary ? { summary } : {}), activities: seed.activities ?? [], live: null, running: seed.running ?? false, host: null } };
    if (summary) summaries[id] = summary;
    if (seed.live) live[id] = seed.live;
  }
  useAutopilotStore.setState({ views, summaries, live, feed: [], dockOpen: false, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
}

function activity(patch: Partial<AutopilotActivity>): AutopilotActivity {
  return { id: `a-${Math.random()}`, runId: "run-1", task: "write", phase: "write", title: "Writing scene 2 of chapter 5", reason: "", next: "", status: "succeeded", startedAt: T0, ...patch } as AutopilotActivity;
}

const QUESTION: DirectorQuestion = { id: "q-1", kind: "director", question: "Should Mira lie to her father?", context: "", options: ["Yes", "No"], askedAt: T0 };

function Hub() {
  return <MemoryRouter initialEntries={["/app/autopilot"]}><AutopilotHubPage /></MemoryRouter>;
}

const card = (target: BookEntry) => screen.getByRole("article", { name: target.name });
const order = () => screen.getAllByRole("article").map((element) => element.getAttribute("data-hub-book"));

function setMobile(mobile: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: mobile && query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })) as unknown as typeof window.matchMedia;
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  setMobile(false);
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
  mocks.summarize.calls = 0;
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe.each<Language>(["en", "it"])("the card of a book on the Autopilot page (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("of a run that goes on: how far it is, beside a ring, in words with an icon, the step it does now, its cost against the budget, and a pause", () => {
    const harbor = book(1, "The Glass Harbor");
    seedHub([{
      book: harbor, running: true,
      state: { status: "running", plan: { chapters: chapters(12, 4), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false }, options: { ...createAutopilotState(new Date(T0)).options, budgetLimit: 5 }, stats: { ...createAutopilotState(new Date(T0)).stats, cost: 1.2, currency: "EUR" } },
      live: { activity: activity({ status: "running", title: "Writing scene 2 of chapter 5" }), characters: 120, preview: "The tide came in" },
    }]);
    render(<Hub />);
    const ours = card(harbor);
    expect(within(ours).getByText(t("autopilot.hub.progress.chapters", { done: 4, count: 12 }))).toBeInTheDocument();
    expect(ours.querySelector("[data-hub-ring]")).toHaveAttribute("aria-hidden", "true");
    expect(within(ours).getByText(t("autopilot.hub.state.running"))).toBeInTheDocument();
    expect(ours.querySelector("[data-hub-state] svg")).not.toBeNull();
    expect(within(ours).getByText(t("autopilot.hub.now", { step: "Writing scene 2 of chapter 5" }))).toBeInTheDocument();
    // The page's text is compared with its spaces made plain: a price in Italian has a no-break space before the euro.
    expect(within(ours).getByText(plain(t("autopilot.hub.costOf", { value: formatCost(1.2, "EUR"), budget: formatCost(5, "EUR") })))).toBeInTheDocument();
    expect(within(ours).getByRole("button", { name: named(t("autopilot.actions.pause"), harbor) })).toBeEnabled();
    expect(within(ours).getByRole("link", { name: named(t("autopilot.hub.openLive"), harbor) })).toHaveAttribute("href", "/app/books/book-1/autopilot");
    expect(t("autopilot.hub.progress.chapters", { done: 4, count: 12 })).toBe(language === "en" ? "4 of 12 chapters" : "4 di 12 capitoli");
  });

  it("of a run that waits for an answer: the way to the question, and the last vote of the director and of the readers", () => {
    const harbor = book(1, "The Glass Harbor");
    seedHub([{
      book: harbor,
      state: { status: "waiting-author", question: QUESTION, plan: { chapters: chapters(12, 3, [{ director: 6, readers: 6.8, verdict: "revise" }, { director: 7.5, verdict: "approve" }]), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } },
    }]);
    render(<Hub />);
    const ours = card(harbor);
    expect(within(ours).getByText(t("autopilot.hub.state.question"))).toBeInTheDocument();
    expect(within(ours).getByRole("link", { name: named(t("autopilot.quick.run.answer"), harbor) })).toHaveAttribute("href", "/app/books/book-1/autopilot#autopilot-question");
    expect(within(ours).getByText(`${t("autopilot.hub.voteChapter", { score: formatCount(7.5), number: 3 })} · ${t("autopilot.hub.voteReaders", { score: formatCount(6.8) })}`)).toBeInTheDocument();
    expect(t("autopilot.hub.state.question")).toBe(language === "en" ? "Waiting for your answer" : "Aspetta una tua risposta");
  });

  it("of a plan that waits to be approved, with the approval as its action", () => {
    const harbor = book(1, "The Glass Harbor");
    seedHub([{ book: harbor, state: { status: "paused", phase: "plan", plan: { chapters: chapters(8, 0), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true } } }]);
    render(<Hub />);
    const ours = card(harbor);
    expect(within(ours).getByText(t("autopilot.hub.state.plan"))).toBeInTheDocument();
    expect(within(ours).getByRole("button", { name: named(t("autopilot.actions.approvePlan"), harbor) })).toBeEnabled();
  });

  it("of a run stopped by an error, and of one that waits to try again", () => {
    const harbor = book(1, "The Glass Harbor");
    const wall = book(2, "The Salt Wall");
    seedHub([
      { book: harbor, state: { status: "error", message: "401 Unauthorized", lastError: { message: "401 Unauthorized", at: T0, task: "write", errorKind: "auth" } } },
      { book: wall, running: true, state: { status: "running" }, summary: { retry: { at: new Date(Date.now() + 30_000).toISOString(), attempt: 1, retries: 3 } } },
    ]);
    render(<Hub />);
    expect(within(card(harbor)).getByText(t("autopilot.hub.state.error"))).toBeInTheDocument();
    expect(within(card(harbor)).getByRole("button", { name: named(t("autopilot.actions.retry"), harbor) })).toBeEnabled();
    expect(within(card(harbor)).getByRole("alert")).toHaveTextContent("401 Unauthorized");
    expect(within(card(wall)).getByText(t("autopilot.hub.state.retrying"))).toBeInTheDocument();
  });

  it("of a finished book: the director's vote on the whole book, and the way to the result", () => {
    const harbor = book(1, "The Glass Harbor");
    seedHub([{ book: harbor, state: { status: "completed", phase: "completed", brief: { ...createAutopilotState(new Date(T0)).brief, targetChapters: 6 }, plan: { chapters: chapters(6, 6), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false }, finalDone: true, finalReview: { verdict: "approve", score: 8, text: "Good.", at: T0 } } }]);
    render(<Hub />);
    const ours = card(harbor);
    expect(within(ours).getByText(t("autopilot.hub.state.completed"))).toBeInTheDocument();
    expect(within(ours).getByText(t("autopilot.hub.progress.chapters", { done: 6, count: 6 }))).toBeInTheDocument();
    expect(within(ours).getByText(t("autopilot.hub.voteBook", { score: formatCount(8) }))).toBeInTheDocument();
    expect(within(ours).getByRole("link", { name: named(t("autopilot.hub.openResult"), harbor) })).toHaveAttribute("href", "/app/books/book-1/autopilot");
  });

  it("of a book whose autopilot never started: says so, and leads to its configuration to start it", () => {
    const harbor = book(1, "The Glass Harbor");
    seedHub([{ book: harbor, state: null }]);
    render(<Hub />);
    const ours = card(harbor);
    expect(within(ours).getByText(t("autopilot.hub.state.new"))).toBeInTheDocument();
    expect(within(ours).getByText(t("autopilot.hub.progress.noPlan"))).toBeInTheDocument();
    expect(within(ours).getByRole("link", { name: named(t("autopilot.hub.start"), harbor) })).toHaveAttribute("href", "/app/books/book-1/autopilot/settings");
    expect(within(ours).queryByRole("group", { name: t("autopilot.quick.groupLabel", { context: harbor.name }) })).not.toBeInTheDocument();
  });

  it("of a paused run: the last step and when, and a resume", () => {
    const harbor = book(1, "The Glass Harbor");
    const ended = new Date(Date.now() - 5 * 60_000).toISOString();
    seedHub([{ book: harbor, state: { status: "paused" }, activities: [activity({ title: "Readers of chapter 2", endedAt: T0 }), activity({ title: "Director's review of chapter 2", endedAt: ended })] }]);
    render(<Hub />);
    const ours = card(harbor);
    expect(within(ours).getByText(t("autopilot.hub.state.paused"))).toBeInTheDocument();
    expect(within(ours).getByText(t("autopilot.hub.ago", { step: "Director's review of chapter 2", ago: formatAgo(5 * 60_000) }))).toBeInTheDocument();
    expect(within(ours).getByRole("button", { name: named(t("autopilot.actions.resume"), harbor) })).toBeEnabled();
  });
});

describe("the cards of the Autopilot page", () => {
  it("put first the books that ask something of the author, then the ones that run, then the others, each group in the order of the library", () => {
    seedHub([
      { book: book(1, "Paused"), state: { status: "paused" } },
      { book: book(2, "Running"), running: true, state: { status: "running" } },
      { book: book(3, "Question"), state: { status: "waiting-author", question: QUESTION } },
      { book: book(4, "Finished"), state: { status: "completed" } },
      { book: book(5, "Error"), state: { status: "error", lastError: { message: "boom", at: T0, task: "write" } } },
      { book: book(6, "Plan"), state: { status: "paused", plan: { chapters: chapters(3, 0), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true } } },
      { book: book(7, "Never"), state: null },
    ]);
    render(<Hub />);
    expect(order()).toEqual(["book-3", "book-5", "book-6", "book-2", "book-1", "book-4", "book-7"]);
  });

  it("move a book to the top as soon as it asks something", () => {
    seedHub([{ book: book(1, "First"), state: { status: "paused" } }, { book: book(2, "Second"), state: { status: "paused" } }]);
    render(<Hub />);
    expect(order()).toEqual(["book-1", "book-2"]);
    act(() => {
      useAutopilotStore.setState((store) => ({ summaries: { ...store.summaries, "book-2": { ...store.summaries["book-2"], status: "waiting-author", question: QUESTION, updatedAt: "2026-11-22T10:00:00.000Z" } } }));
    });
    expect(order()).toEqual(["book-2", "book-1"]);
  });

  it("are read one by one: a book still being read, or that cannot be read, has a card that says so, and the others are drawn as usual", async () => {
    const pending = book(1, "Still reading");
    const broken = book(2, "Broken");
    const fine = book(3, "Fine");
    seedHub([{ book: pending }, { book: broken, error: "The local working copy is missing." }, { book: fine, state: { status: "paused" } }]);
    render(<Hub />);
    expect(card(pending)).toHaveAttribute("aria-busy", "true");
    expect(within(card(pending)).getByText(t("autopilot.hub.loading"))).toBeInTheDocument();
    expect(within(card(broken)).getByText(t("autopilot.hub.failed"))).toBeInTheDocument();
    expect(within(card(broken)).getByText("The local working copy is missing.")).toBeInTheDocument();
    expect(within(card(fine)).getByText(t("autopilot.hub.state.paused"))).toBeInTheDocument();
    await waitFor(() => expect(mocks.runtime.refresh).toHaveBeenCalledTimes(3));
    mocks.runtime.refresh.mockClear();
    fireEvent.click(within(card(broken)).getByRole("button", { name: named(t("autopilot.hub.retry"), broken) }));
    await waitFor(() => expect(mocks.runtime.refresh).toHaveBeenCalledWith("book-2"));
    expect(mocks.runtime.refresh).toHaveBeenCalledTimes(1);
  });

  it("read every book of the library when the page opens, a few at a time, and keep the server's stream open", async () => {
    const books = Array.from({ length: 12 }, (_, index) => book(index + 1, `Book ${index + 1}`));
    seedHub(books.map((entry) => ({ book: entry })));
    let inFlight = 0;
    let most = 0;
    mocks.runtime.refresh.mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    });
    render(<Hub />);
    await waitFor(() => expect(mocks.runtime.refresh).toHaveBeenCalledTimes(12));
    expect(mocks.runtime.refresh.mock.calls.map(([id]) => id).sort()).toEqual(books.map((entry) => entry.id).sort());
    expect(mocks.runtime.refresh).toHaveBeenCalledWith("book-1", { join: true });
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
    expect(mocks.runtime.ensureServerStream).toHaveBeenCalled();
  });

  it("stay light with 50 books: the text a run streams draws again only its own card, and no state is summarized again for it", () => {
    const books = Array.from({ length: 50 }, (_, index) => book(index + 1, `Book ${index + 1}`));
    seedHub(books.map((entry, index) => ({ book: entry, running: index === 0, state: { status: index === 0 ? "running" : "paused", plan: { chapters: chapters(300, 120), approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } } })));
    render(<Hub />);
    expect(screen.getAllByRole("article")).toHaveLength(50);
    mocks.summarize.calls = 0;
    for (let chunk = 0; chunk < 40; chunk += 1) {
      act(() => {
        useAutopilotStore.setState((store) => ({ live: { ...store.live, "book-1": { activity: activity({ id: "step-1", status: "running", title: "Writing scene 1 of chapter 121" }), characters: chunk * 10, preview: `word ${chunk}` } } }));
      });
    }
    expect(mocks.summarize.calls).toBe(0);
    expect(within(card(books[0])).getByText(t("autopilot.hub.now", { step: "Writing scene 1 of chapter 121" }))).toBeInTheDocument();
  });

  it("offer a filter by title when there are more than ten books, which finds titles in any script", () => {
    const books = [...Array.from({ length: 10 }, (_, index) => book(index + 1, `Book ${index + 1}`)), book(11, "Città di vetro"), book(12, "Стеклянная гавань")];
    seedHub(books.map((entry) => ({ book: entry, state: { status: "paused" } })));
    render(<Hub />);
    const filter = screen.getByRole("searchbox", { name: t("autopilot.hub.filter") });
    fireEvent.change(filter, { target: { value: "citta" } });
    expect(order()).toEqual(["book-11"]);
    expect(filter).toHaveAccessibleDescription(t("autopilot.hub.filterCount", { shown: 1, count: 12 }));
    fireEvent.change(filter, { target: { value: "гавань" } });
    expect(order()).toEqual(["book-12"]);
    fireEvent.change(filter, { target: { value: "nothing like this" } });
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText(t("autopilot.hub.filterNone"))).toBeInTheDocument();
  });

  it("have no filter for a short library", () => {
    seedHub(Array.from({ length: 10 }, (_, index) => ({ book: book(index + 1, `Book ${index + 1}`), state: { status: "paused" } })));
    render(<Hub />);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("what happens in every book, on the Autopilot page", () => {
  const toggle = () => screen.getByRole("button", { name: t("autopilot.dockTitle") });

  it("is open on a wide screen, and can be closed: the page remembers it", () => {
    seedHub([{ book: book(1, "One"), state: { status: "paused" } }]);
    const view = render(<Hub />);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle().getAttribute("aria-controls")!)).toBeVisible();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    view.unmount();
    render(<Hub />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("is closed on a phone until the author opens it, and then stays open", () => {
    setMobile(true);
    seedHub([{ book: book(1, "One"), state: { status: "paused" } }]);
    const view = render(<Hub />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle());
    view.unmount();
    render(<Hub />);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("does not announce the step that runs: the cards say it, and its text changes several times a second", () => {
    seedHub([{ book: book(1, "One"), running: true, state: { status: "running" }, live: { activity: activity({ status: "running" }), characters: 10, preview: "The tide" } }]);
    render(<Hub />);
    const step = screen.getByText(t("autopilot.hub.now", { step: "Writing scene 2 of chapter 5" }));
    expect(step.closest("[aria-live]:not([aria-live=off]), [role=status], [role=log], [role=alert], [role=timer]")).toBeNull();
    // The feed does not draw the step a second time, with its timer and its text.
    expect(screen.queryByText(t("autopilot.feed.now"))).not.toBeInTheDocument();
    expect(screen.queryByText("The tide")).not.toBeInTheDocument();
  });
});
