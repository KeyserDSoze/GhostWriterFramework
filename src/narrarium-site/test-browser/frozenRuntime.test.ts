import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { AUTOPILOT_STATE_FILE, SERVER_FEATURE_AUTOPILOT_FROZEN, createAutopilotState, freezeChapterChanges, frozenChanges, loadBookSnapshot, parseChapterFreeze, parseMarkdown, type AiPort, type AiRequest, type AutopilotState } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ local: null as unknown, server: null as unknown as { verified: () => unknown }, ai: null as unknown }));

vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => mocks.ai ?? { complete: async () => { throw new Error("no AI in this test: deciding about a frozen chapter calls no model"); } } }));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { AutopilotFrozenUnsupportedError, FROZEN_SERVER_VERSION, frozenErrorCode } from "@/autopilot/frozenChapters";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeBroadcastBus } from "./helpers/fakeBroadcastChannel";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const SLUG = "001-the-key";
const CHAPTER = `chapters/${SLUG}/chapter.md`;
const SCENE = `chapters/${SLUG}/001-the-pier.md`;

const scene = (text: string) => `---\ntype: paragraph\nid: paragraph:${SLUG}:001-the-pier\nchapter: chapter:${SLUG}\nnumber: 1\ntitle: The pier\n---\n\n${text}\n`;

/** A book whose first chapter the autopilot wrote and approved (it is in the plan, closed). */
function state(): AutopilotState {
  const base = createAutopilotState(new Date("2026-11-21T10:00:00.000Z"), { idea: "A harbor of glass.", targetChapters: 1 });
  return {
    ...base,
    status: "paused",
    frozenSince: "2026-11-21T10:00:00.000Z",
    plan: { chapters: [{ number: 1, title: "The key", slug: SLUG, summary: "Mira finds the key.", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [] }], approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false },
  } as AutopilotState;
}

/** The book, with the autopilot that wrote its first chapter, or without any autopilot (the author wrote it and froze it by hand). */
function bookFiles(withAutopilot = true): Record<string, string> {
  return {
    ...seedBookFiles(),
    [CHAPTER]: `---\ntype: chapter\nid: chapter:${SLUG}\nnumber: 1\ntitle: The key\n---\n\n# The key\n`,
    [SCENE]: scene("Mira finds the key under the pier."),
    ...(withAutopilot ? { [AUTOPILOT_STATE_FILE]: JSON.stringify(state()) } : {}),
  };
}

/** The same files with the chapter frozen, as the engine writes the record when the director approves it (or the author freezes it). */
async function frozenBookFiles(withAutopilot = true): Promise<Record<string, string>> {
  const store = new MemoryBookStore(bookFiles(withAutopilot));
  const [change] = freezeChapterChanges(await loadBookSnapshot(store), SLUG, withAutopilot ? "autopilot" : "author", "2026-11-21T11:00:00.000Z");
  return { ...bookFiles(withAutopilot), [CHAPTER]: change.content! };
}

const recordOf = (store: MemoryBookStore) => parseChapterFreeze(parseMarkdown(store.files.get(CHAPTER) ?? "").frontmatter.frozen).freeze ?? null;
const changesOf = async (store: MemoryBookStore) => frozenChanges(await loadBookSnapshot(store));
const pendingOf = (store: MemoryBookStore) => (JSON.parse(store.files.get(AUTOPILOT_STATE_FILE) ?? "null") as AutopilotState | null)?.pendingReviews ?? [];
const edit = (store: MemoryBookStore) => store.commit([{ path: SCENE, content: scene("Mira finds the key under the pier, and hides it.") }], "The author's edit");

let local: MemoryBookStore;
let runtime: BrowserAutopilotRuntime;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  mocks.ai = null;
  installNavigatorLocks(new FakeLockRegistry().forTab("this-tab") as never);
  runtime = new BrowserAutopilotRuntime({ channel: () => null });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
});

afterEach(() => {
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("the frozen chapters of a book that runs in this browser", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
  });

  it("freezes a chapter by hand, as it is now, and unfreezes it", async () => {
    local = new MemoryBookStore(bookFiles());
    mocks.local = local;
    await runtime.setChapterFrozen(BOOK.id, SLUG, true);
    expect(recordOf(local)).toMatchObject({ by: "author" });
    expect(await changesOf(local)).toEqual([]);
    await runtime.setChapterFrozen(BOOK.id, SLUG, false);
    expect(parseMarkdown(local.files.get(CHAPTER) ?? "").frontmatter.frozen).toBeUndefined();
  });

  it("tells the change of a frozen chapter, with what can be done with it", async () => {
    local = new MemoryBookStore(await frozenBookFiles());
    mocks.local = local;
    await edit(local);
    const status = await runtime.frozenStatus(BOOK.id);
    expect(status.mode).toBe("ask");
    expect(status.changes).toEqual([expect.objectContaining({ kind: "frozen", number: 1, slug: SLUG, actions: ["review-and-update", "review-only", "mark-reviewed"] })]);
  });

  it("marks a change as reviewed at once, without the model: the chapter is frozen again as it is", async () => {
    local = new MemoryBookStore(await frozenBookFiles());
    mocks.local = local;
    await edit(local);
    const before = recordOf(local);
    const status = await runtime.resolveFrozenChange(BOOK.id, 1, "mark-reviewed");
    expect(status.changes).toEqual([]);
    expect(await changesOf(local)).toEqual([]);
    expect(recordOf(local)?.files["001-the-pier.md"]).not.toBe(before?.files["001-the-pier.md"]);
    expect(recordOf(local)?.by).toBe("autopilot");
  });

  it("records a review for the next run, and the page sees it waiting", async () => {
    local = new MemoryBookStore(await frozenBookFiles());
    mocks.local = local;
    await edit(local);
    const status = await runtime.resolveFrozenChange(BOOK.id, 1, "review-and-update", { note: "Keep the hidden key." });
    expect(pendingOf(local)).toEqual([expect.objectContaining({ kind: "frozen", number: 1, action: "review-and-update", note: "Keep the hidden key." })]);
    expect(status.changes[0]?.pending).toMatchObject({ action: "review-and-update" });
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.state?.pendingReviews).toEqual([expect.objectContaining({ number: 1, action: "review-and-update" })]);
    // The text stays as the author wrote it: nothing is rewritten before the run.
    expect(await changesOf(local)).toHaveLength(1);
  });

  it("offers only marking as reviewed in a book the autopilot never worked on, and keeps the engine's code when refused", async () => {
    local = new MemoryBookStore(await frozenBookFiles(false));
    mocks.local = local;
    await edit(local);
    expect((await runtime.frozenStatus(BOOK.id)).changes[0]?.actions).toEqual(["mark-reviewed"]);
    const refused = await runtime.resolveFrozenChange(BOOK.id, 1, "review-only").catch((error: unknown) => error);
    expect(frozenErrorCode(refused)).toBe("invalid_action");
    expect(frozenErrorCode(await runtime.resolveFrozenChange(BOOK.id, 7, "mark-reviewed").catch((error: unknown) => error))).toBe("chapter_not_found");
  });
});

describe("a decision taken in a tab while another tab of this browser runs the book", () => {
  let bus: FakeBroadcastBus;
  let locks: FakeLockRegistry;
  let release: () => void;
  let tabA: BrowserAutopilotRuntime;
  let tabB: BrowserAutopilotRuntime;

  const openTab = (name: string) => {
    const channel = bus.channel(name);
    return new BrowserAutopilotRuntime({ locks: () => locks.forTab(name) as never, channel: () => channel as never });
  };
  const posted = () => bus.posted.filter((entry) => (entry.data as { kind?: string }).kind === "command").map((entry) => (entry.data as { command: { type: string } }).command);

  beforeEach(async () => {
    bus = new FakeBroadcastBus();
    locks = new FakeLockRegistry();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
    local = new MemoryBookStore(await frozenBookFiles(false));
    mocks.local = local;
    // The run of the tab A waits in its first step until the test lets it go.
    const held = new Promise<void>((resolve) => { release = resolve; });
    const inner = createFakeAutopilotAi({ chapters: 2, scenes: 1, words: 120 });
    mocks.ai = { async complete(request: AiRequest) {
      await new Promise<void>((resolve, reject) => {
        void held.then(resolve);
        request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return inner.complete(request);
    } } satisfies AiPort;
    tabA = openTab("A");
    tabB = openTab("B");
    await tabA.start(BOOK.id, { brief: { idea: "A harbor of glass.", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: true } });
  });

  afterEach(async () => {
    await tabA.pause(BOOK.id, "now").catch(() => undefined);
    release();
    await vi.waitFor(() => expect(tabA.isRunningHere(BOOK.id)).toBe(false), { timeout: 3000 }).catch(() => undefined);
  });

  it("is sent to the tab that runs it, which marks the change as reviewed", async () => {
    await edit(local);
    expect(await changesOf(local)).toHaveLength(1);
    await tabB.resolveFrozenChange(BOOK.id, 1, "mark-reviewed");
    expect(posted()).toEqual([{ type: "resolve-frozen", number: 1, action: "mark-reviewed", options: {} }]);
    expect(await changesOf(local)).toEqual([]);
    expect(tabA.isRunningHere(BOOK.id)).toBe(true);
  });

  it("is sent to the tab that runs it to freeze or unfreeze a chapter", async () => {
    await tabB.setChapterFrozen(BOOK.id, SLUG, false);
    expect(posted()).toEqual([{ type: "set-frozen", slug: SLUG, frozen: false }]);
    expect(parseMarkdown(local.files.get(CHAPTER) ?? "").frontmatter.frozen).toBeUndefined();
  });
});

describe("the frozen chapters of a book that runs on the personal server", () => {
  let server: FakeBookServer;

  beforeEach(async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK], aiIntegrations: [{ id: "ai-1" } as never], personalServer: CONNECTION } });
    const files = await frozenBookFiles();
    local = new MemoryBookStore(files);
    mocks.local = local;
    server = new FakeBookServer(files);
    server.frozen = true;
    mocks.server = server;
    // The two copies have been synced once: what each side changes afterwards is told from that base.
    await runtime.syncWithServer(BOOK.id);
    server.calls.length = 0;
  });

  it("hands the author's edit to the server before deciding, and brings back the chapter the server froze again", async () => {
    await edit(local);
    const status = await runtime.resolveFrozenChange(BOOK.id, 1, "mark-reviewed");
    expect(status.changes).toEqual([]);
    expect(server.calls.indexOf("commitFiles")).toBeGreaterThanOrEqual(0);
    expect(server.calls.indexOf("commitFiles")).toBeLessThan(server.calls.indexOf("resolveFrozenChange"));
    expect(server.store.files.get(SCENE)).toBe(local.files.get(SCENE));
    // The record the server wrote is in this browser now: the change is gone here too.
    expect(local.files.get(CHAPTER)).toBe(server.store.files.get(CHAPTER));
    expect(await changesOf(local)).toEqual([]);
  });

  it("records a review on the server, for its next run", async () => {
    await edit(local);
    await runtime.resolveFrozenChange(BOOK.id, 1, "review-only");
    expect(pendingOf(server.store)).toEqual([expect.objectContaining({ number: 1, action: "review-only" })]);
  });

  it("freezes and unfreezes a chapter there, and the record comes back", async () => {
    await runtime.setChapterFrozen(BOOK.id, SLUG, false);
    expect(parseMarkdown(local.files.get(CHAPTER) ?? "").frontmatter.frozen).toBeUndefined();
    await runtime.setChapterFrozen(BOOK.id, SLUG, true);
    expect(recordOf(local)).toMatchObject({ by: "author" });
    expect(server.calls.filter((call) => call === "freezeChapter")).toHaveLength(2);
  });

  it("asks the server which chapters changed", async () => {
    await edit(server.store);
    const status = await runtime.frozenStatus(BOOK.id);
    expect(status.changes).toEqual([expect.objectContaining({ number: 1, kind: "frozen" })]);
    expect(server.calls).toContain("frozenStatus");
  });

  it("changes what the autopilot does with a changed frozen chapter on the server, also during a run", async () => {
    await runtime.updateOptions(BOOK.id, { frozenEdits: "auto" });
    expect(server.optionsUpdated).toEqual([{ frozenEdits: "auto" }]);
  });

  it("does not send that setting to a server that predates the frozen chapters: it would refuse the whole request", async () => {
    server.frozen = false;
    const error = await runtime.updateOptions(BOOK.id, { frozenEdits: "auto", pauseAfterEachChapter: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutopilotFrozenUnsupportedError);
    expect(server.optionsUpdated).toEqual([]);
    await runtime.updateOptions(BOOK.id, { pauseAfterEachChapter: true });
    expect(server.optionsUpdated).toEqual([{ pauseAfterEachChapter: true }]);
  });

  it("is not asked of a server that predates the frozen chapters: nothing is sent, and the author is told to update it", async () => {
    server.frozen = false;
    await edit(local);
    for (const attempt of [
      () => runtime.resolveFrozenChange(BOOK.id, 1, "mark-reviewed"),
      () => runtime.setChapterFrozen(BOOK.id, SLUG, false),
      () => runtime.frozenStatus(BOOK.id),
    ]) {
      const error = await attempt().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AutopilotFrozenUnsupportedError);
      expect((error as Error).message).toContain(FROZEN_SERVER_VERSION);
    }
    expect(server.calls.filter((call) => ["manifest", "commitFiles", "resolveFrozenChange", "freezeChapter", "frozenStatus"].includes(call))).toEqual([]);
  });
});

describe("what the page knows of the server", () => {
  it("is whether it announces the frozen chapters", () => {
    const server = new FakeBookServer();
    expect(server.info().features).not.toContain(SERVER_FEATURE_AUTOPILOT_FROZEN);
    server.frozen = true;
    expect(server.info().features).toContain(SERVER_FEATURE_AUTOPILOT_FROZEN);
  });
});
