import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BRIEF, DEFAULT_OPTIONS, createAutopilotState, normalizeOptions, type AutopilotEvent, type AutopilotState, type AutopilotStateSummary } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  server: null as unknown as { verified: () => unknown },
  local: null as unknown,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn() }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { SetupCard } from "@/components/autopilot/config/SetupCard";
import { EMPTY_OUTLINE_BRIEF } from "@/autopilot/outlineBrief";
const FORM = { outline: { brief: EMPTY_OUTLINE_BRIEF, chapters: 2, lastChapter: 2, readable: true, loaded: true, reload: vi.fn() }, tab: "review", onTab: vi.fn(), onReset: vi.fn(), profiles: null };

import { autopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const T0 = "2026-11-21T10:00:00.000Z";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: T0 };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const runtime = { start: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
const run = vi.fn(async (_name: string, action: (runtime: unknown, bookId: string) => Promise<unknown>) => {
  await action(runtime, BOOK.id);
  return true;
});

function openForm(state: AutopilotState | null = null) {
  render(<MemoryRouter><SetupCard book={BOOK} state={state} {...FORM} running={false} busy={false} disabled={false} run={run as never} /></MemoryRouter>);
}

const existing = (options: Record<string, unknown> = {}) => ({ ...createAutopilotState(new Date(T0), { ...DEFAULT_BRIEF, idea: "A glass harbor" }), options: { ...DEFAULT_OPTIONS, ...options } }) as AutopilotState;
const tokensField = () => screen.getByLabelText(t("autopilot.setup.budgetTokens")) as HTMLInputElement;
const moneyField = () => screen.getByLabelText(t("autopilot.setup.budget")) as HTMLInputElement;

const escaped = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** What a person does: the field gets every keystroke, then loses the focus. */
function type(field: HTMLInputElement, text: string) {
  for (let length = 1; length <= text.length; length += 1) fireEvent.change(field, { target: { value: text.slice(0, length) } });
  fireEvent.blur(field);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  runtime.start.mockClear();
  runtime.configure.mockClear();
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the token budget in the form of the autopilot", () => {
  it("is a field next to the money budget, with no limit as its starting value", () => {
    openForm();
    expect(tokensField()).toHaveValue(0);
    expect(tokensField()).toHaveAttribute("min", "0");
    expect(moneyField().compareDocumentPosition(tokensField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(moneyField().parentElement?.parentElement, "the two budgets are in the same row").toBe(tokensField().parentElement?.parentElement);
  });

  it("is explained: it works with every model, the money budget needs prices", () => {
    openForm();
    const hint = t("autopilot.setup.budgetTokensHint");
    expect(tokensField()).toHaveAccessibleDescription(escaped(hint));
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(t("autopilot.setup.budgetHint")).toMatch(/prices/);
    expect(hint).toMatch(/every model/);
    expect(hint).toMatch(/without prices/);
  });

  it("starts the autopilot with the tokens typed, as a whole number", async () => {
    openForm();
    type(tokensField(), "250000");
    expect(tokensField().value).toBe("250000");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
    expect(runtime.start).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ budgetTokens: 250000, budgetLimit: 0 }) });
    const [, started] = runtime.start.mock.calls[0] as unknown as [string, { options: Parameters<typeof normalizeOptions>[0] }];
    expect(normalizeOptions(started.options).budgetTokens, "the engine keeps it as it is").toBe(250000);
  });

  it("takes a budget of millions of tokens, and never a negative one", () => {
    openForm();
    type(tokensField(), "40000000");
    expect(tokensField().value).toBe("40000000");
    type(tokensField(), "-5");
    expect(tokensField().value).toBe("0");
  });

  it("keeps the money budget and the token budget apart", async () => {
    openForm();
    type(moneyField(), "12.5");
    type(tokensField(), "90000");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
    expect(runtime.start).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ budgetLimit: 12.5, budgetTokens: 90000 }) });
  });

  it("shows what the autopilot has saved, and saves a change with its settings", async () => {
    openForm(existing({ budgetTokens: 50000 }));
    expect(tokensField()).toHaveValue(50000);
    type(tokensField(), "75000");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    expect(runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ budgetTokens: 75000 }) });
  });

  it("reads a state saved before there was a token budget as no limit, and does not invent one when other settings are saved", async () => {
    const old = existing();
    delete (old.options as { budgetTokens?: number }).budgetTokens;
    openForm(old);
    expect(tokensField()).toHaveValue(0);
    type(moneyField(), "3");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    const [, saved] = runtime.configure.mock.calls[0] as unknown as [string, { options: { budgetTokens?: number; budgetLimit: number } }];
    expect(saved.options.budgetLimit).toBe(3);
    expect(saved.options.budgetTokens ?? 0).toBe(0);
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    openForm();
    expect(screen.getByLabelText("Budget in token per libro (0 = nessun limite)")).toBeInTheDocument();
    expect(screen.getByText(/Vale con qualsiasi modello, anche senza prezzi/)).toBeInTheDocument();
  });

  it("is locked while the autopilot runs, like the rest of the settings", () => {
    render(<MemoryRouter><SetupCard book={BOOK} state={existing({ budgetTokens: 1000 })} {...FORM} running busy={false} disabled={false} run={run as never} /></MemoryRouter>);
    expect(tokensField()).toBeDisabled();
  });
});

describe("the token budget reaches the autopilot that runs the book", () => {
  beforeEach(async () => {
    localStorage.clear();
    mocks.local = new MemoryBookStore();
    mocks.server = new FakeBookServer();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
    useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) } });
  });

  afterEach(() => {
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    autopilotRuntime.ensureServerStream();
    useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  });

  it("is saved in the state of a book that runs in the browser", async () => {
    await autopilotRuntime.configure(BOOK.id, { options: { budgetTokens: 50000 } });
    const saved = JSON.parse((mocks.local as MemoryBookStore).files.get("autopilot/state.json") ?? "{}");
    expect(saved.options.budgetTokens).toBe(50000);
    const snapshot = await autopilotRuntime.refresh(BOOK.id);
    expect(snapshot?.state?.options.budgetTokens).toBe(50000);
  });

  it("is sent to the server that runs the book, with the rest of the options", async () => {
    mocks.book = SERVER_BOOK;
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
    const server = mocks.server as FakeBookServer;
    await autopilotRuntime.configure(BOOK.id, { options: { ...DEFAULT_OPTIONS, budgetTokens: 50000 } });
    expect(server.configured).toEqual([{ options: expect.objectContaining({ budgetTokens: 50000, budgetLimit: 0 }) }]);
  });

  it("is sent to the server when the autopilot of the book is started there", async () => {
    mocks.book = SERVER_BOOK;
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
    const server = mocks.server as FakeBookServer;
    await autopilotRuntime.start(BOOK.id, { brief: { idea: "A harbor built on glass." }, options: { ...DEFAULT_OPTIONS, budgetTokens: 7000, budgetLimit: 2.5 } });
    expect(server.started).toEqual([{ brief: { idea: "A harbor built on glass." }, options: expect.objectContaining({ budgetTokens: 7000, budgetLimit: 2.5 }) }]);
  });
});

function summaryOf(stats: Partial<AutopilotStateSummary["stats"]>): AutopilotStateSummary {
  return {
    status: "paused",
    phase: "write",
    message: null,
    progress: { chapters: 3, chaptersDone: 1, scenes: 9, scenesWritten: 4, words: 5200 },
    question: null,
    lastError: null,
    runner: null,
    stats: { tasks: 30, aiCalls: 40, inputTokens: 90_000, outputTokens: 20_000, cost: 0.5, currency: "USD", failures: 0, ...stats },
    pendingNotes: 0,
    constraints: 0,
    updatedAt: T0,
  };
}

describe("the line of the cost and the use, when some calls cannot be counted", () => {
  function Page() {
    return (
      <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
        <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
      </MemoryRouter>
    );
  }

  function seed(stats: Partial<AutopilotStateSummary["stats"]>) {
    mocks.book = SERVER_BOOK;
    mocks.runtime = { refresh: vi.fn(async () => null), describeError: vi.fn(String) };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK] } });
    const state: AutopilotState = { ...createAutopilotState(new Date(T0)), status: "paused", phase: "write", updatedAt: T0, stats: summaryOf(stats).stats };
    useAutopilotStore.setState({
      views: { [BOOK.id]: { ...emptyView(BOOK.id), snapshot: { bookId: BOOK.id, state, activities: [], live: null, running: false, host: "server" } } },
      summaries: {},
      live: {},
      feed: [],
    });
  }

  afterEach(() => {
    useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it("says how many calls have no token count and how many have no measured cost (no price, or tokens estimated), with a short reason for each", () => {
    seed({ usageUnknownCalls: 3, costUnknownCalls: 2 });
    render(<Page />);
    expect(screen.getByText("3 calls without a token count")).toBeInTheDocument();
    expect(screen.getByText("2 calls without a measured cost")).toBeInTheDocument();
    expect(screen.getByText(t("autopilot.progress.usageUnknownHint"))).toBeInTheDocument();
    expect(screen.getByText(t("autopilot.progress.costUnknownHint"))).toBeInTheDocument();
  });

  it("says one call in the singular", () => {
    seed({ usageUnknownCalls: 1, costUnknownCalls: 1 });
    render(<Page />);
    expect(screen.getByText("1 call without a token count")).toBeInTheDocument();
    expect(screen.getByText("1 call without a measured cost")).toBeInTheDocument();
  });

  it("says it in Italian, one or many", async () => {
    await i18n.changeLanguage("it");
    seed({ usageUnknownCalls: 1, costUnknownCalls: 5 });
    render(<Page />);
    expect(screen.getByText("1 chiamata senza conteggio dei token")).toBeInTheDocument();
    expect(screen.getByText("5 chiamate senza costo misurato")).toBeInTheDocument();
  });

  it("writes a large number with the separators of the language", async () => {
    seed({ usageUnknownCalls: 15000, costUnknownCalls: 0 });
    render(<Page />);
    expect(screen.getByText("15,000 calls without a token count")).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage("it");
    render(<Page />);
    expect(screen.getByText("15.000 chiamate senza conteggio dei token")).toBeInTheDocument();
  });

  it("shows only the one that is more than zero", () => {
    seed({ usageUnknownCalls: 0, costUnknownCalls: 4 });
    render(<Page />);
    expect(screen.queryByText(/without a token count/)).not.toBeInTheDocument();
    expect(screen.getByText("4 calls without a measured cost")).toBeInTheDocument();
  });

  it("shows nothing when every call is counted, or when the state does not say", () => {
    seed({ usageUnknownCalls: 0, costUnknownCalls: 0 });
    const view = render(<Page />);
    expect(screen.queryByText(/without a token count|without a measured cost/)).not.toBeInTheDocument();
    view.unmount();
    seed({});
    render(<Page />);
    expect(screen.queryByText(/without a token count|without a measured cost/)).not.toBeInTheDocument();
  });

  it("follows the live summaries of the run", async () => {
    seed({});
    render(<Page />);
    expect(screen.queryByText(/without a measured cost/)).not.toBeInTheDocument();
    const live = { ...summaryOf({ costUnknownCalls: 2 }), updatedAt: "2026-11-21T10:05:00.000Z" };
    await act(async () => { useAutopilotStore.getState().ingest({ bookId: BOOK.id, at: live.updatedAt, seq: 1, type: "state", state: live } as AutopilotEvent, BOOK.name); });
    const band = document.querySelector("[data-autopilot-band]") as HTMLElement;
    expect(within(band).getByText("2 calls without a measured cost")).toBeInTheDocument();
  });
});
