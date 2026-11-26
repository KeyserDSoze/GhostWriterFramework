import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import type { AiPort, AiRequest } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, ai: null as unknown, publish: vi.fn(async (..._args: unknown[]) => ({ committed: 1, pulled: 0 })) }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => mocks.ai }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/repositoryService")>()),
  syncFullRepository: (...args: unknown[]) => mocks.publish(...args),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { appliedCapOf } from "@/costs/budgetCaps";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type CostBudgets } from "@/types/settings";
import { markGitHubCredentialRejected } from "@/github/remoteAvailability";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const GITHUB_BOOK: BookEntry = { ...BOOK, storageMode: "github", owner: "acme", repo: "glass-harbor" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const BRIEF = { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

let runtime: BrowserAutopilotRuntime;
let server: FakeBookServer;
let local: MemoryBookStore;
let gate: { hold: Promise<void> | null; release: () => void };

/** The engine's deterministic fake AI, which can be held back: a request waits for the gate, and a pause that abandons it is heard. */
function gatedAi(): AiPort {
  const inner = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120 });
  return { async complete(request: AiRequest) {
    const held = gate.hold;
    if (held) {
      await new Promise<void>((resolve, reject) => {
        void held.then(resolve);
        const abandon = () => reject(request.signal?.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"));
        if (request.signal?.aborted) abandon();
        else request.signal?.addEventListener("abort", abandon, { once: true });
      });
    }
    request.signal?.throwIfAborted();
    return inner.complete(request);
  } };
}

function hold(): () => void {
  gate.hold = new Promise<void>((resolve) => { gate.release = () => { gate.hold = null; resolve(); }; });
  return gate.release;
}

const summary = (bookId = BOOK.id) => useAutopilotStore.getState().summaries[bookId];
const stopped = () => vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 20_000 });
const savedState = () => JSON.parse(local.files.get("autopilot/state.json") ?? "null");

function useBook(book: BookEntry, patch: Record<string, unknown> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], aiIntegrations: [{ id: "ai-1" } as never], defaultGitHubToken: "ghp_token", personalServer: CONNECTION, ...patch } });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  server = new FakeBookServer();
  local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  gate = { hold: null, release: () => undefined };
  mocks.server = server;
  mocks.local = local;
  mocks.ai = gatedAi();
  mocks.publish.mockClear();
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  // A runtime of its own for each test: it keeps the sessions of the books it ran, with the stores they were made with.
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null });
  useBook(BOOK);
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [], server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(async () => {
  cleanup();
  await runtime.pause(BOOK.id, "now").catch(() => undefined);
  gate.release();
  await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 20_000 }).catch(() => undefined);
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  runtime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});


function budgets(costBudgets: CostBudgets, rows: Array<{ bookId: string; source: string; cost: number }> = []) {
  useBook(BOOK, { costBudgets, costCurrency: "USD" });
  const deltas: UsageDelta[] = rows.map((entry) => ({ key: { period: localDay(new Date()), bookId: entry.bookId, source: entry.source, capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "USD" }, counters: { calls: 1, tasks: 1, cost: entry.cost } }));
  const file = { ...emptyCostsFile(), ledger: addToLedger(undefined, WRITER, deltas, new Date(), "USD") };
  useCostsStore.setState({ file, persisted: file });
}

describe("a budget stops the autopilot through the engine's own cap", () => {
  it("pauses the run in this browser before the step that would pass what the budgets leave, with the reason panel of every cap", async () => {
    // 0.096 of 0.10 this month are spent by the Copilot of another book: 0.004 are left for the autopilot of this one (the whole fake book costs 0.01).
    budgets({ global: { USD: { month: 0.1 } } }, [{ bookId: "book-2", source: "copilot", cost: 0.096 }]);
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await stopped();
    const state = savedState();
    expect(state.options.budgetLimit, "the cost the book has (none yet) and what is left").toBeCloseTo(0.004, 6);
    expect(state.status).toBe("paused");
    expect(state.limitReached).toMatchObject({ kind: "money", limit: state.options.budgetLimit, currency: "USD" });
    expect(state.limitReached.used).toBeGreaterThanOrEqual(0.004);
    expect(state.limitReached.used, "paused before the next step: not the whole book (0.01) past the cap").toBeLessThan(0.0095);
    expect(appliedCapOf(BOOK.id)).toMatchObject({ applied: state.options.budgetLimit, own: 0, binding: { scope: "global", period: "month", limit: 0.1 } });
    expect(summary()?.limitReached?.kind).toBe("money");
  });

  it("goes on past the budgets when the person chose to, for that start only", async () => {
    budgets({ global: { USD: { month: 0.1 } } }, [{ bookId: "book-2", source: "copilot", cost: 0.096 }]);
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await stopped();
    const stoppedAt = savedState().stats.cost;
    runtime.allowBudgetOverrun(BOOK.id);
    await runtime.start(BOOK.id, {});
    await stopped();
    const after = savedState();
    expect(after.stats.cost, "it went on").toBeGreaterThan(stoppedAt);
    expect(after.options.budgetLimit, "with no cap of the budgets: the person's own, none").toBe(0);
    expect(after.limitReached).toBeUndefined();
    expect(appliedCapOf(BOOK.id)).toBeNull();
  });

  it("refuses to start a book that has spent nothing when the budgets are used up, and starts it when the person goes on anyway", async () => {
    budgets({ global: { USD: { month: 0.1 } } }, [{ bookId: "book-2", source: "copilot", cost: 0.1 }]);
    const refused = await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS }).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe("budget-used-up");
    expect(runtime.describeError(refused)).toMatch(/budget/i);
    expect(savedState()).toBeNull();
    runtime.allowBudgetOverrun(BOOK.id);
    await runtime.start(BOOK.id, { brief: BRIEF, options: { ...OPTIONS, budgetLimit: 0.01 } });
    await stopped();
    expect(savedState().options.budgetLimit).toBe(0.01);
  });

  it("sends the cap through the options of the start to a book that runs on the personal server", async () => {
    budgets({ books: { [BOOK.id]: { USD: { total: 5 } } } }, [{ bookId: BOOK.id, source: "autopilot", cost: 1.5 }]);
    useBook(SERVER_BOOK, { costBudgets: { books: { [BOOK.id]: { USD: { total: 5 } } } }, costCurrency: "USD" });
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    const sent = server.started[0] as { options?: { budgetLimit?: number; readers?: boolean } };
    expect(sent.options?.budgetLimit, "what the ledger says is left, 3.5, added to the 0 the book has cost for the autopilot").toBe(3.5);
    expect(sent.options?.readers, "the other options go as they were").toBe(false);
  });
});
