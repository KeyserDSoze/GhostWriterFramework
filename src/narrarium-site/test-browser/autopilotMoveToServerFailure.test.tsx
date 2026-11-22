import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { ServerRequestError } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, save: vi.fn(async () => true), toast: vi.fn() }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { WhereCard } from "@/pages/AutopilotPage";
import { autopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { readSyncBase } from "@/autopilot/syncBase";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN, SERVER_INFO } from "./helpers/fakeBookServer";
import { dropSyncBaseDatabase } from "./helpers/rawSyncBase";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const CONSENT = { sendAiConfiguration: false, sendGitHubToken: false };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

let server: FakeBookServer;
let local: MemoryBookStore;

const view = () => useAutopilotStore.getState().views[BOOK.id];
const hostOf = () => useSettingsStore.getState().settings.books[0].autopilotHost;
const listed = () => useAutopilotStore.getState().server.books;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await dropSyncBaseDatabase();
  localStorage.clear();
  server = new FakeBookServer();
  local = new MemoryBookStore({ "book.md": "the book", "chapters/001/001-scene.md": "a scene written here" });
  mocks.server = server;
  mocks.local = local;
  mocks.save.mockClear();
  mocks.toast.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: CONNECTION } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, server: { status: "online", info: SERVER_INFO, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("a registration of the book on the server that fails", () => {
  it("leaves nothing that says the book is on the server, and uploads nothing", async () => {
    server.failures.registerBook = new ServerRequestError("The server could not take the book.", 502, "repository_unavailable");
    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).rejects.toThrow("The server could not take the book.");

    expect(view().server, "no summary of the book on the server").toBeNull();
    expect(view().sync, "no sync was made: nothing was exchanged").toBeNull();
    expect(view().operation).toBeNull();
    expect(listed(), "the list of the server's books is the server's to say").toEqual([]);
    expect(server.registered).toEqual([]);
    expect(server.calls).not.toContain("commitFiles");
    expect(server.calls).not.toContain("manifest");
    expect((await readSyncBase(SERVER_INFO.serverId, BOOK.id)).found, "no record of a sync with this server was kept").toBe(false);
  });

  it("can be tried again as it was the first time, and then the book is on the server", async () => {
    server.failures.registerBook = new Error("The server is on fire.");
    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).rejects.toThrow("The server is on fire.");
    server.failures.registerBook = undefined;

    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).resolves.toBeUndefined();
    expect(view().server).toMatchObject({ bookId: BOOK.id });
    expect(server.store.files.get("chapters/001/001-scene.md")).toBe("a scene written here");
  });

  it("leaves the book in this browser for the page too: it is not marked as hosted by the server, and nothing is saved", async () => {
    server.failures.registerBook = new ServerRequestError("This server hosts at most 50 books: remove one before adding another.", 409, "too_many_books");
    render(<MemoryRouter><WhereCard book={BOOK} running={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.server") }));
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.move") }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "This server hosts at most 50 books: remove one before adding another.", variant: "destructive" })));
    expect(hostOf()).toBeUndefined();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(view().server).toBeNull();
    expect(screen.queryByText(t("autopilot.where.serverBook", { status: t("autopilot.notStarted") }))).not.toBeInTheDocument();
    expect(mocks.toast).not.toHaveBeenCalledWith({ title: t("autopilot.where.moved") });
  });
});

describe("a move that fails after the registration, while the files are sent", () => {
  it("does not say the book is on the server either, and tells the author why", async () => {
    server.failures.commitFiles = new ServerRequestError("The personal server answered HTTP 503.", 503, "busy");
    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).rejects.toThrow("The personal server answered HTTP 503.");

    expect(view().server, "not hosted: the move did not finish").toBeNull();
    expect(view().sync).toMatchObject({ ok: false, kind: "error", message: "The personal server answered HTTP 503." });
    expect((await readSyncBase(SERVER_INFO.serverId, BOOK.id)).found, "a sync that did not finish is not remembered as one").toBe(false);
    expect(view().operation).toBeNull();
  });

  it("is completed by a second try, which sends the files again", async () => {
    server.failures.commitFiles = new ServerRequestError("The personal server answered HTTP 503.", 503, "busy");
    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).rejects.toThrow();
    server.failures.commitFiles = undefined;
    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).resolves.toBeUndefined();
    expect(view().server).toMatchObject({ bookId: BOOK.id });
    expect(server.store.files.get("book.md")).toBe("the book");
  });
});
