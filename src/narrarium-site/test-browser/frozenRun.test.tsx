import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { AUTOPILOT_STATE_FILE, createAutopilotState, frozenChanges, loadBookSnapshot, parseChapterFreeze, parseMarkdown, type AiPort, type AiRequest, type AutopilotState } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ local: null as unknown, ai: null as unknown }));

vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => mocks.ai }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { QuestionCard } from "@/components/autopilot/QuestionCard";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SLUG = "001-the-key";
const CHAPTER = `chapters/${SLUG}/chapter.md`;
const SCENE = `chapters/${SLUG}/001-the-pier.md`;
const scene = (text: string) => `---\ntype: paragraph\nid: paragraph:${SLUG}:001-the-pier\nchapter: chapter:${SLUG}\nnumber: 1\ntitle: The pier\n---\n\n${text}\n`;

/** A book of one chapter that the autopilot wrote and approved (before chapters were frozen by it), and nothing else to write. */
function bookFiles(): Record<string, string> {
  const state: AutopilotState = {
    ...createAutopilotState(new Date("2026-11-21T10:00:00.000Z"), { idea: "A harbor town built on glass hides a lie.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }),
    status: "paused",
    phase: "write",
    frozenSince: "2026-11-21T10:00:00.000Z",
    plan: { chapters: [{ number: 1, title: "The key", slug: SLUG, summary: "Mira finds the key under the pier.", goal: "Find the key.", pov: [], keyEvents: ["Mira finds the key"], reveals: [], status: "done", scenes: [] }], approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false },
  } as AutopilotState;
  state.options = { ...state.options, readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
  return {
    ...seedBookFiles(),
    [CHAPTER]: `---\ntype: chapter\nid: chapter:${SLUG}\nnumber: 1\ntitle: The key\nsummary: Mira finds the key under the pier.\n---\n\n# The key\n`,
    [SCENE]: scene("Mira finds the key under the pier, wrapped in her father's scarf."),
    [AUTOPILOT_STATE_FILE]: JSON.stringify(state),
  };
}

let local: MemoryBookStore;
let runtime: BrowserAutopilotRuntime;
let calls: number;
let held: Promise<void> | null;
let release: () => void;

/** The fake model of the engine's tests, counted, and held back when the test asks. */
function countedAi(): AiPort {
  const inner = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120 });
  return {
    async complete(request: AiRequest) {
      calls += 1;
      if (held) await held;
      return inner.complete(request);
    },
  };
}

const record = () => parseChapterFreeze(parseMarkdown(local.files.get(CHAPTER) ?? "").frontmatter.frozen).freeze ?? null;
const stored = () => JSON.parse(local.files.get(AUTOPILOT_STATE_FILE) ?? "null") as AutopilotState;
const summary = () => useAutopilotStore.getState().summaries[BOOK.id];

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  local = new MemoryBookStore(bookFiles());
  mocks.local = local;
  calls = 0;
  held = null;
  release = () => undefined;
  mocks.ai = countedAi();
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
});

afterEach(async () => {
  cleanup();
  release();
  await runtime.pause(BOOK.id, "now").catch(() => undefined);
  await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 5000 }).catch(() => undefined);
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
});

describe("a frozen chapter the author changes, in a book the autopilot runs in this browser", () => {
  it("is asked about before anything is spent, the answer is queued, and the chapter is reviewed and frozen again", async () => {
    // The author freezes the chapter by hand, then changes one of its scenes.
    await runtime.setChapterFrozen(BOOK.id, SLUG, true);
    expect(record()).toMatchObject({ by: "author" });
    await local.commit([{ path: SCENE, content: scene("Mira finds the key under the pier, and hides it in the lighthouse.") }], "The author's edit");

    // The autopilot starts: before its first step it notices the change and stops with the question, having called no model.
    await runtime.start(BOOK.id);
    await waitFor(() => expect(summary()?.question?.kind).toBe("frozen-change"), { timeout: 5000 });
    await waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false));
    expect(summary()?.status).toBe("waiting-author");
    expect(calls).toBe(0);

    // The question on the Live page: the author chooses "Only a review of the chapter".
    held = new Promise<void>((resolve) => { release = resolve; });
    const run = async (_name: string, action: (runtime: never, bookId: string) => Promise<unknown>) => {
      await action(runtime as never, BOOK.id);
      return true;
    };
    render(<MemoryRouter><QuestionCard bookId={BOOK.id} question={summary()!.question!} disabled={false} run={run as never} /></MemoryRouter>);
    const card = screen.getByRole("region", { name: i18n.t("autopilot.question.kinds.frozen-change") });
    fireEvent.click(within(card).getByRole("button", { name: i18n.t("frozen.actions.review-only") }));

    // The decision is queued in the state of the book, and the run that starts takes it first (the model is held back here).
    await waitFor(() => expect(stored().pendingReviews).toEqual([expect.objectContaining({ kind: "frozen", number: 1, action: "review-only" })]), { timeout: 5000 });
    expect(stored().question).toBeNull();
    await waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(true));

    // Once the model answers, the director reviews the chapter, it is closed and frozen again as the author left it.
    release();
    held = null;
    await waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 15_000 });
    expect(stored().pendingReviews ?? []).toEqual([]);
    expect(frozenChanges(await loadBookSnapshot(local))).toEqual([]);
    expect(record()).toMatchObject({ by: "author" });
    expect(local.files.get(SCENE)).toContain("hides it in the lighthouse");
    expect(useAutopilotStore.getState().feed.some((entry) => entry.event.type === "insight" && entry.event.code === "frozenReviewed" && entry.event.chapterNumber === 1)).toBe(true);
    expect(calls).toBeGreaterThan(0);
  }, 30_000);
});
