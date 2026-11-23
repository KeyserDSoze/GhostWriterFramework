import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { AUTOPILOT_STATE_FILE, createAutopilotState, type AiPort, type AiRequest, type AutopilotState } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ local: null as unknown, ai: null as unknown, runtime: null as unknown, book: null as unknown, toast: vi.fn() }));

vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => mocks.ai }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: { chapters: [], characters: [], ghostwriters: [] }, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

let local: MemoryBookStore;
let runtime: BrowserAutopilotRuntime;
let ai: AiPort & { calls: AiRequest[] };

const stored = () => JSON.parse(local.files.get(AUTOPILOT_STATE_FILE) ?? "null") as AutopilotState;
const approval = () => document.querySelector<HTMLElement>("[data-plan-approval]") as HTMLElement;
const chapterOf = (number: number) => approval().querySelector<HTMLElement>(`[data-plan-approval-chapter="${number}"]`) as HTMLElement;

/** The run stops by itself: the plan waits for the author, as `pauseAfterPlan` asks. */
async function untilThePlanWaits(): Promise<void> {
  await vi.waitFor(() => {
    expect(stored().plan?.awaitingAuthor).toBe(true);
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
  }, { timeout: 15_000, interval: 20 });
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  const state = createAutopilotState(new Date("2026-11-21T10:00:00.000Z"), { idea: "A harbor town built on glass hides a lie.", wordsPerScene: 300 }, { pauseAfterPlan: true, readersOnPlan: true, maxReaders: 2 });
  local = new MemoryBookStore({ ...seedBookFiles({ chapters: 3 }), [AUTOPILOT_STATE_FILE]: JSON.stringify(state) });
  mocks.local = local;
  ai = createFakeAutopilotAi({ chapters: 3 });
  mocks.ai = ai;
  mocks.book = BOOK;
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null });
  mocks.runtime = runtime;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
});

afterEach(async () => {
  cleanup();
  await runtime.pause(BOOK.id, "now").catch(() => undefined);
  await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 5000 }).catch(() => undefined);
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
});

describe("the approval of a plan the engine made in this browser", () => {
  it("shows what the engine made, and a change asked for a chapter reopens the plan, which the engine makes again with the author's words", async () => {
    await runtime.start(BOOK.id);
    await untilThePlanWaits();
    render(<Page />);

    // What the run wrote: the concept, the cast, the readers' reactions, the director's vote and the chapters.
    await screen.findByRole("heading", { level: 2, name: t("autopilot.approval.title") }, { timeout: 5000 });
    expect(approval()).toHaveTextContent("A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.");
    expect(await within(approval()).findByText("Mira, a glassmaker's daughter, uncovers the harbor's oldest lie.")).toBeInTheDocument();
    const cast = within(approval()).getByRole("region", { name: t("autopilot.approval.cast.title") });
    await within(cast).findByText("Mira Vale");
    expect(cast).toHaveTextContent("Orrin Hale");
    expect(cast).toHaveTextContent("A stubborn young glassmaker.");
    const readers = within(approval()).getByRole("region", { name: t("autopilot.approval.readers.title") });
    const cards = within(readers).getAllByRole("article");
    expect(cards.length).toBe(stored().plan!.readerReactions.length);
    expect(cards[0]).toHaveTextContent("I would read it.");
    expect(cards[0]).toHaveTextContent(t("autopilot.approval.readers.interest", { score: 7 }));
    const vote = within(approval()).getByRole("region", { name: t("autopilot.approval.director.title") });
    expect(within(vote).getByText("8", { selector: "[data-plan-score]" })).toBeInTheDocument();
    expect(vote).toHaveTextContent("A solid plan.");
    expect(within(chapterOf(2)).getByRole("heading", { level: 4 })).toHaveTextContent("2. Chapter Title 2");
    expect(chapterOf(2)).toHaveTextContent("Summary of chapter 2.");
    expect(chapterOf(2)).toHaveTextContent("Event 2");

    // The author asks for a change of the second chapter.
    fireEvent.click(within(chapterOf(2)).getByRole("button", { name: t("autopilot.approval.change.ask", { number: 2 }) }));
    fireEvent.change(within(chapterOf(2)).getByRole("textbox"), { target: { value: "Move the crack of the wall to the last chapter." } });
    fireEvent.click(within(chapterOf(2)).getByRole("button", { name: t("autopilot.approval.change.send") }));

    // It is the intervention that rewrites, with the effect it always had: a rule, and the plan reopened with the note.
    const note = "Chapter 2 «Chapter Title 2»: Move the crack of the wall to the last chapter.";
    await vi.waitFor(() => {
      const state = stored();
      expect(state.plan?.approved).toBe(false);
      expect(state.plan?.awaitingAuthor).toBe(false);
      expect(state.plan?.revisionNotes).toEqual([note]);
      expect(state.constraints).toContain(note);
      expect(state.interventions[state.interventions.length - 1]).toMatchObject({ scope: "rewrite", text: note, status: "applied" });
    }, { timeout: 5000 });
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);

    // The screen stays, with the change, until the author goes on.
    await screen.findByRole("heading", { level: 2, name: t("autopilot.approval.reviseTitle") }, { timeout: 5000 });
    expect(within(approval()).getByRole("list", { name: t("autopilot.approval.changes") })).toHaveTextContent(note);
    const calls = ai.calls.length;
    fireEvent.click(within(approval()).getByRole("button", { name: t("autopilot.approval.reviseAction") }));
    await untilThePlanWaits();

    // The engine made the plan again with the author's words, and the director reviewed it again.
    const replanned = ai.calls.slice(calls).find((call) => call.json?.name === "chapter_plan");
    expect(replanned?.user).toContain("Revise the chapter plan");
    expect(replanned?.user).toContain(note);
    expect(ai.calls.slice(calls).some((call) => call.json?.name === "plan_review")).toBe(true);
    expect(stored().plan?.revisionNotes).toEqual([]);
    await screen.findByRole("heading", { level: 2, name: t("autopilot.approval.title") }, { timeout: 5000 });
    const reviews = within(approval()).getByRole("list", { name: t("autopilot.approval.director.reviews") });
    expect(within(reviews).getAllByRole("listitem")).toHaveLength(2);
  }, 40_000);
});
