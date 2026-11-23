import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, stores: new Map<string, unknown>(), runtime: null as unknown }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: (book: { id: string }) => mocks.stores.get(book.id),
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => createFakeAutopilotAi() }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { useAutopilotStore } from "@/autopilot/store";
import { AutopilotHubPage } from "@/pages/AutopilotHubPage";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const ON_SERVER: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const UNREADABLE: BookEntry = { ...ON_SERVER, id: "book-2", repo: "book-2", name: "The Salt Wall", autopilotHost: "browser" };
const named = (label: string, book: BookEntry) => t("autopilot.quick.named", { label, context: book.name });
const card = (book: BookEntry) => screen.getByRole("article", { name: book.name });

/** A working copy that cannot be read: the book's card says so, and the others do not mind. */
function brokenStore() {
  const fail = async () => { throw new Error("The local working copy of this book is damaged."); };
  return { list: fail, read: fail, readMany: fail, commit: fail };
}

let server: FakeBookServer;
let runtime: BrowserAutopilotRuntime;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  server = new FakeBookServer();
  server.running = true;
  mocks.server = server;
  mocks.stores = new Map<string, unknown>([[ON_SERVER.id, new MemoryBookStore({})], [UNREADABLE.id, brokenStore()]]);
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null });
  // The stream of the server's events is not what is tested here: the page asks for it, and the server's state is set below.
  runtime.ensureServerStream = () => undefined;
  mocks.runtime = runtime;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [ON_SERVER, UNREADABLE], aiIntegrations: [{ id: "ai-1" } as never], personalServer: CONNECTION } });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "online", info: server.info(), message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(() => {
  cleanup();
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("the quick actions of a card, for a book that runs on the personal server", () => {
  it("pause the run through the server, as the book's own page does, and a book that cannot be read does not stop them", async () => {
    render(<MemoryRouter initialEntries={["/app/autopilot"]}><AutopilotHubPage /></MemoryRouter>);
    const pause = await within(card(ON_SERVER)).findByRole("button", { name: named(t("autopilot.actions.pause"), ON_SERVER) });
    expect(within(card(ON_SERVER)).getByText(t("autopilot.hub.state.running"))).toBeInTheDocument();
    await waitFor(() => expect(within(card(UNREADABLE)).getByText(t("autopilot.hub.failed"))).toBeInTheDocument());
    expect(within(card(UNREADABLE)).getByText(/damaged/)).toBeInTheDocument();

    fireEvent.click(pause);
    await waitFor(() => expect(server.paused).toEqual(["after-step"]));
  });

  it("start a stopped run on the server again with Resume", async () => {
    server.stop("paused");
    render(<MemoryRouter initialEntries={["/app/autopilot"]}><AutopilotHubPage /></MemoryRouter>);
    const resume = await within(card(ON_SERVER)).findByRole("button", { name: named(t("autopilot.actions.resume"), ON_SERVER) });
    expect(within(card(ON_SERVER)).getByText(t("autopilot.hub.state.paused"))).toBeInTheDocument();
    await act(async () => { fireEvent.click(resume); });
    await waitFor(() => expect(server.started).toEqual([{}]));
    await waitFor(() => expect(within(card(ON_SERVER)).getByText(t("autopilot.hub.state.running"))).toBeInTheDocument());
  });
});
