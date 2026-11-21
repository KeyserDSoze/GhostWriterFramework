import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";

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
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { dropSyncBaseDatabase } from "./helpers/rawSyncBase";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

let server: FakeBookServer;
let local: MemoryBookStore;

const hostOf = () => useSettingsStore.getState().settings.books[0].autopilotHost;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await dropSyncBaseDatabase();
  localStorage.clear();
  server = new FakeBookServer({ "plot.md": "plot, written on the server", "chapters/001/001-scene.md": "a scene the server has" });
  local = new MemoryBookStore({ "plot.md": "plot, written here", "book.md": "the book" });
  mocks.server = server;
  mocks.local = local;
  mocks.save.mockClear();
  mocks.toast.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: CONNECTION } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("moving a book to a server that already has other versions of its files, as the author goes through it", () => {
  it("stops at the list of conflicts, lets the author choose, and then completes the move", async () => {
    const view = render(<MemoryRouter><WhereCard book={BOOK} running={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.server") }));
    fireEvent.click(screen.getByLabelText(t("autopilot.where.consentAi")));

    // 1. The move meets a file that differs on the server: nothing is overwritten, nothing is handed over.
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.move") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: t("autopilot.errors.conflictsMoveToServer", { count: 1 }), variant: "destructive" })));
    expect(hostOf()).toBeUndefined();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(server.store.files.get("plot.md")).toBe("plot, written on the server");
    const list = await screen.findByRole("list", { name: t("autopilot.where.conflictsTitle", { count: 1 }) });
    expect(within(list).getByText("plot.md")).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.where.synced"), { exact: false })).not.toBeInTheDocument();

    // 2. The author keeps this device's version: it is sent, the list goes, and the sync says what it did.
    const keep = screen.getByRole("button", { name: t("autopilot.where.keepLocalFor", { path: "plot.md" }) });
    keep.focus();
    fireEvent.click(keep);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.synced") }));
    expect(server.store.files.get("plot.md")).toBe("plot, written here");
    await waitFor(() => expect(screen.queryByRole("list", { name: /./ })).not.toBeInTheDocument());
    // The button went with its file: the focus is not lost, it moves to where the result is announced.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));

    // 3. Now the move goes through, and the book is hosted by the server.
    mocks.toast.mockClear();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.move") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.moved") }));
    expect(hostOf()).toBe("server");
    expect(mocks.save).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("keeps the book on the server when it cannot be brought back, and brings it back once the files are settled", async () => {
    const hosted: BookEntry = { ...BOOK, autopilotHost: "server" };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [hosted], personalServer: CONNECTION } });
    useAutopilotStore.getState().patchView(BOOK.id, { server: server.summary(BOOK.id) });
    render(<MemoryRouter><WhereCard book={hosted} running={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.browser") }));

    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.moveBack") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: t("autopilot.errors.conflictsMoveBack", { count: 1 }), variant: "destructive" })));
    expect(hostOf()).toBe("server");
    expect(useAutopilotStore.getState().views[BOOK.id].server).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: t("autopilot.where.keepRemoteFor", { path: "plot.md" }) }));
    await waitFor(() => expect(local.files.get("plot.md")).toBe("plot, written on the server"));
    await waitFor(() => expect(screen.queryByRole("list", { name: /./ })).not.toBeInTheDocument());
    // The sync that settles the conflict is an operation of the book: it must be over before the next one starts.
    await waitFor(() => expect(useAutopilotStore.getState().views[BOOK.id].operation).toBeNull(), { timeout: 8000 });

    mocks.toast.mockClear();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.moveBack") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.movedBack") }), { timeout: 8000 });
    expect(hostOf()).toBeUndefined();
    expect(useAutopilotStore.getState().views[BOOK.id].server).toBeNull();
  });
});
