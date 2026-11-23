import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { createAutopilotState, type AutopilotActivity, type AutopilotPlan, type PlannedChapter } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
  save: vi.fn(async () => true),
  store: null as unknown,
  rest: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.store,
}));
vi.mock("@/autopilot/runEstimate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/autopilot/runEstimate")>();
  return {
    ...original,
    estimateRest: (...args: Parameters<typeof original.estimateRest>) => {
      mocks.rest(...args);
      return original.estimateRest(...args);
    },
  };
});

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { chapter, planOf } from "./helpers/autopilotFixtures";
import { activityOf, seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, T0, makeRuntime, t } from "./helpers/quickCommands";
import { CLOUD, withAi } from "./helpers/setupEstimate";

const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const IDEA = "A harbor town built on glass hides a lie.";
const LOGLINE = "A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.";

const CHAPTERS: PlannedChapter[] = [
  chapter(1, "planned", { title: "The key", summary: "Mira finds the key under the pier.", goal: "Set the lie in motion." }),
  chapter(2, "planned", { title: "The wall", summary: "The sea wall cracks during the night tide.", goal: "Raise the stakes." }),
  chapter(3, "planned", { title: "The light", summary: "The lighthouse goes dark.", goal: "Close the first movement." }),
];

const CONCEPT = activityOf("concept", { id: "concept", phase: "concept", summary: `${LOGLINE} — 1 characters.`, changedPaths: ["story-design.md"], startedAt: at(0), endedAt: at(30) });
const PLANNED = activityOf("plan", { id: "plan", phase: "plan", summary: "1. The key; 2. The wall; 3. The light", startedAt: at(30), endedAt: at(60) });
const APPROVED = activityOf("plan-review", { id: "review-100", phase: "plan", summary: "approve 8/10 — A solid plan.", startedAt: at(100), endedAt: at(120) });

function seedWaiting({ chapters = CHAPTERS, plan = {}, activities = [CONCEPT, PLANNED, APPROVED] }: { chapters?: PlannedChapter[]; plan?: Partial<AutopilotPlan>; activities?: AutopilotActivity[] } = {}) {
  const base = createAutopilotState(new Date(T0), { idea: IDEA, targetChapters: chapters.length });
  return seedRun({
    status: "paused",
    phase: "plan",
    chapters,
    message: "The plan is ready: read it and resume when you want.",
    activities,
    statePatch: {
      brief: base.brief,
      concept: { done: true, generated: true, secrets: [], logline: LOGLINE },
      plan: { ...planOf(chapters), approved: true, awaitingAuthor: true, readerReactions: [], ...plan },
    },
  });
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const approval = () => document.querySelector<HTMLElement>("[data-plan-approval]") as HTMLElement;
const card = () => document.querySelector<HTMLElement>("[data-plan-rest]") as HTMLElement;
const ready = () => waitFor(() => expect(document.querySelector("[data-plan-rest][data-state='ready']")).not.toBeNull());
const follows = (later: Node, earlier: Node) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeAll(async () => {
  await loadAutopilotTranslations();
  await import("@/autopilot/browserStore");
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), intervene: vi.fn(async () => undefined), frozenStatus: vi.fn(async () => ({ mode: "ask", changes: [], pending: [], warnings: [] })) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = { chapters: [], characters: [], ghostwriters: [] };
  mocks.store = new MemoryBookStore({});
  mocks.rest.mockReset();
  useBooksStore.setState({ structures: { [LOCAL_BOOK.id]: mocks.structure as never } });
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useBooksStore.setState({ structures: {} });
  await i18n.changeLanguage("en");
});

describe("what the rest will cost, on the screen that approves the plan", () => {
  it("is at the end of the screen: after the sentence that says it is the whole plan, and before the button that approves it", async () => {
    seedWaiting();
    withAi([CLOUD]);
    render(<Page />);
    const footer = approval().querySelector("footer") as HTMLElement;
    const end = within(footer).getByText(t("autopilot.approval.end"));
    const approve = within(footer).getByRole("button", { name: t("autopilot.actions.approvePlan") });
    expect(footer.contains(card())).toBe(true);
    expect(follows(card(), end)).toBe(true);
    expect(follows(approve, card())).toBe(true);
    // The headings of the screen: the card is a part of it, one level under its title.
    expect(within(approval()).getByRole("heading", { level: 3, name: t("autopilot.approval.rest.title") })).toBeInTheDocument();
  });

  it("does not hold the screen back: the plan and the button that approves are there in the first draw, and the figures come after", async () => {
    seedWaiting();
    withAi([CLOUD]);
    render(<Page />);
    expect(within(approval()).getByRole("button", { name: t("autopilot.actions.approvePlan") })).toBeEnabled();
    expect(within(approval()).getAllByRole("heading", { level: 4 })).toHaveLength(3);
    expect(card()).toHaveAttribute("data-state", "working");
    expect(mocks.rest).not.toHaveBeenCalled();
    await ready();
    expect(within(card()).getByText(/3 chapters, about/)).toBeInTheDocument();
  });

  it("is in the language of the page", async () => {
    await i18n.changeLanguage("it");
    seedWaiting();
    withAi([CLOUD]);
    render(<Page />);
    await ready();
    expect(within(approval()).getByRole("heading", { level: 3, name: "Quanto costerà il resto" })).toBeInTheDocument();
    expect(card()).toHaveTextContent("Chiamate all'AI");
    expect(card()).toHaveTextContent("Vedi la stima completa nella Configurazione");
  });

  it("is made once for a plan, and not again when the page reads the log again", async () => {
    seedWaiting();
    withAi([CLOUD]);
    render(<Page />);
    await ready();
    expect(mocks.rest).toHaveBeenCalledTimes(1);
    act(() => {
      useAutopilotStore.setState((store) => {
        const view = store.views[LOCAL_BOOK.id];
        return { views: { ...store.views, [LOCAL_BOOK.id]: { ...view, snapshot: { ...view.snapshot!, activities: [...view.snapshot!.activities], state: { ...view.snapshot!.state! } } } } };
      });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(mocks.rest).toHaveBeenCalledTimes(1);
  });

  it("stays at the end of the screen of a plan that is to be made again, and says so", async () => {
    seedWaiting({ plan: { approved: false, awaitingAuthor: false, revisionNotes: ["Chapter 2 «The wall»: The wall should crack in chapter 3 instead."] } });
    withAi([CLOUD]);
    render(<Page />);
    await ready();
    expect(within(approval()).getByRole("heading", { level: 2, name: t("autopilot.approval.reviseTitle") })).toBeInTheDocument();
    expect(within(card()).getByText(t("autopilot.approval.rest.again"))).toBeInTheDocument();
    expect(approval().querySelector("footer")!.contains(card())).toBe(true);
  });

  it("is not there when no plan waits for the author", async () => {
    seedWaiting({ plan: { awaitingAuthor: false } });
    withAi([CLOUD]);
    render(<Page />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(document.querySelector("[data-plan-approval]")).toBeNull();
    expect(document.querySelector("[data-plan-rest]")).toBeNull();
    expect(mocks.rest).not.toHaveBeenCalled();
    expect(screen.queryByText(t("autopilot.approval.rest.title"))).toBeNull();
  });
});
