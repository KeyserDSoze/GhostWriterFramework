import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  save: vi.fn(async () => true),
  toast: vi.fn(),
}));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { WhereCard } from "@/pages/AutopilotPage";
import { emptyView, useAutopilotStore, type BookSyncStatus, type SyncConflict } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const PIN = "a".repeat(64);
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const conflict = (path: string, patch: Partial<SyncConflict> = {}): SyncConflict => ({ path, local: "modified", remote: "modified", localBytes: 1_200, remoteBytes: 2_048, ...patch });

function status(patch: Partial<BookSyncStatus> = {}): BookSyncStatus {
  return { at: "2026-11-21T10:00:00.000Z", ok: true, kind: "synced", message: "", conflicts: [], conflictDetails: [], firstSync: false, uploaded: 0, downloaded: 0, baseSaved: true, ...patch };
}

function open(sync: BookSyncStatus | null, options: { book?: BookEntry; online?: boolean } = {}) {
  const book = options.book ?? BOOK;
  const connection = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], personalServer: connection } });
  useAutopilotStore.setState({
    server: { status: options.online === false ? "offline" : "online", info: null, message: null, books: [], updates: null, connection },
    views: { [book.id]: { ...emptyView(book.id), sync } },
  });
  return render(<MemoryRouter><WhereCard book={book} running={false} /></MemoryRouter>);
}

const conflictsOf = (...paths: string[]) => status({ ok: false, kind: "conflicts", conflicts: paths, conflictDetails: paths.map((path) => conflict(path)) });
const keepLocal = (path: string) => screen.getByRole("button", { name: t("autopilot.where.keepLocalFor", { path }) });
const keepRemote = (path: string) => screen.getByRole("button", { name: t("autopilot.where.keepRemoteFor", { path }) });

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.runtime = {
    moveToServer: vi.fn(async () => undefined),
    moveToBrowser: vi.fn(async () => undefined),
    syncWithServer: vi.fn(async () => status()),
    resolveSyncConflicts: vi.fn(async () => status()),
    describeError: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
  };
  mocks.save.mockClear();
  mocks.toast.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("the files that changed on both sides", () => {
  it("are listed with what happened to each on the two sides", () => {
    open(status({
      ok: false,
      kind: "conflicts",
      conflicts: ["plot.md", "notes.md"],
      conflictDetails: [conflict("plot.md"), conflict("notes.md", { remote: "deleted", remoteBytes: undefined, localBytes: 300 })],
    }));

    const list = screen.getByRole("list", { name: t("autopilot.where.conflictsTitle", { count: 2 }) });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("plot.md")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent(t("autopilot.where.conflictLine", { local: t("autopilot.where.sideSize", { state: t("autopilot.where.side.modified"), size: "1.2 KB" }), remote: t("autopilot.where.sideSize", { state: t("autopilot.where.side.modified"), size: "2 KB" }) }));
    expect(items[1]).toHaveTextContent(t("autopilot.where.side.deleted"));
  });

  it("never read “synced” while they are open", () => {
    open(conflictsOf("plot.md"));
    expect(screen.queryByText(t("autopilot.where.synced"))).not.toBeInTheDocument();
    expect(screen.getByText(t("autopilot.where.conflicts", { count: 1 }), { exact: false })).toBeInTheDocument();
  });

  it("are not listed once there are none", () => {
    open(status());
    expect(screen.queryByRole("list", { name: /./ })).not.toBeInTheDocument();
    expect(screen.getByText(t("autopilot.where.synced"), { exact: false })).toBeInTheDocument();
  });

  it("are listed also when the move of the book was stopped by them, before the book is hosted anywhere else", () => {
    open(conflictsOf("plot.md"), { book: { ...BOOK, autopilotHost: undefined } });
    expect(screen.getByRole("list", { name: t("autopilot.where.conflictsTitle", { count: 1 }) })).toBeInTheDocument();
  });

  it("let the author keep this device's version of one file, and settle only that file", async () => {
    open(conflictsOf("plot.md", "notes.md"));
    fireEvent.click(keepLocal("plot.md"));
    await waitFor(() => expect(mocks.runtime.resolveSyncConflicts).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.resolveSyncConflicts).toHaveBeenCalledWith(BOOK.id, { "plot.md": "local" });
  });

  it("let the author keep the server's version of one file", async () => {
    open(conflictsOf("plot.md", "notes.md"));
    fireEvent.click(keepRemote("notes.md"));
    await waitFor(() => expect(mocks.runtime.resolveSyncConflicts).toHaveBeenCalledWith(BOOK.id, { "notes.md": "remote" }));
  });

  it("let the author settle all of them in one choice, after asking", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    open(conflictsOf("plot.md", "notes.md", "book.md"));

    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.keepRemoteAll", { count: 3 }) }));
    expect(mocks.runtime.resolveSyncConflicts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.keepRemoteAll", { count: 3 }) }));
    await waitFor(() => expect(mocks.runtime.resolveSyncConflicts).toHaveBeenCalledWith(BOOK.id, { "plot.md": "remote", "notes.md": "remote", "book.md": "remote" }));
    expect(confirm).toHaveBeenCalledTimes(2);

    mocks.runtime.resolveSyncConflicts.mockClear();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.keepLocalAll", { count: 3 }) }));
    await waitFor(() => expect(mocks.runtime.resolveSyncConflicts).toHaveBeenCalledWith(BOOK.id, { "plot.md": "local", "notes.md": "local", "book.md": "local" }));
  });

  it("are listed fifty at a time when they are thousands, and the choice for all still covers every one", async () => {
    const paths = Array.from({ length: 1_200 }, (_, index) => `notes/n-${String(index).padStart(4, "0")}.md`);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open(conflictsOf(...paths));

    const list = screen.getByRole("list", { name: t("autopilot.where.conflictsTitle", { count: 1_200 }) });
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.plan.run.showMore", { count: 50 }) }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(100);

    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.keepLocalAll", { count: 1_200 }) }));
    await waitFor(() => expect(mocks.runtime.resolveSyncConflicts).toHaveBeenCalledTimes(1));
    expect(Object.keys(mocks.runtime.resolveSyncConflicts.mock.calls[0][1] as object)).toHaveLength(1_200);
  });

  it("are not settled while another operation holds the book", () => {
    open(conflictsOf("plot.md"));
    act(() => useAutopilotStore.getState().patchView(BOOK.id, { operation: { kind: "sync", since: new Date().toISOString() } }));
    expect(keepLocal("plot.md")).toBeDisabled();
    expect(keepRemote("plot.md")).toBeDisabled();
  });
});

describe("what a sync says", () => {
  it("is an error, in the colour-independent words of the message, when it failed", () => {
    open(status({ ok: false, kind: "error", message: "Your personal server is not reachable right now." }));
    expect(screen.getByText("Your personal server is not reachable right now.", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.where.synced"))).not.toBeInTheDocument();
  });

  it("says that nothing was needed rather than “synced”", () => {
    open(status({ kind: "up-to-date" }));
    expect(screen.getByText(t("autopilot.where.upToDate"), { exact: false })).toBeInTheDocument();
  });

  it("says when it was a first sync, and what that means for deleted files", () => {
    open(status({ firstSync: true }));
    expect(screen.getByText(t("autopilot.where.firstSync"), { exact: false })).toBeInTheDocument();
  });

  it("warns, visibly, when this device could not remember the sync", () => {
    open(status({ ok: false, kind: "error", message: t("autopilot.errors.baseSaveFailed"), baseSaved: false }));
    expect(screen.getAllByText(t("autopilot.errors.baseSaveFailed"), { exact: false }).length).toBeGreaterThan(0);
  });

  it("tells the author what happened with a toast that fits the outcome of “Sync now”", async () => {
    open(status());
    const sync = async () => {
      const button = screen.getByRole("button", { name: t("autopilot.where.sync") });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
    };

    mocks.runtime.syncWithServer.mockResolvedValueOnce(status({ kind: "synced" }));
    await sync();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.synced") }));

    mocks.runtime.syncWithServer.mockResolvedValueOnce(status({ kind: "up-to-date" }));
    await sync();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.upToDate") }));

    mocks.runtime.syncWithServer.mockResolvedValueOnce(status({ ok: false, kind: "conflicts", conflicts: ["a.md"], conflictDetails: [conflict("a.md")] }));
    await sync();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("autopilot.where.conflicts", { count: 1 }), variant: "destructive" })));

    mocks.runtime.syncWithServer.mockResolvedValueOnce(status({ ok: false, kind: "local-changes" }));
    await sync();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("autopilot.where.localChanges"), variant: "destructive" })));

    mocks.runtime.syncWithServer.mockResolvedValueOnce(status({ kind: "published" }));
    await sync();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.published") }));
  });
});

describe("bringing the book back", () => {
  it("is offered, without downloading, when the server is not reachable, after asking", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    open(null, { online: false });
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.browser") }));

    const discard = screen.getByRole("button", { name: t("autopilot.where.discardServerWork") });
    fireEvent.click(discard);
    expect(mocks.runtime.moveToBrowser).not.toHaveBeenCalled();
    fireEvent.click(discard);
    await waitFor(() => expect(mocks.runtime.moveToBrowser).toHaveBeenCalledWith(BOOK.id, { discardServerWork: true }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("is not offered while the server is there to download from", () => {
    open(null, { online: true });
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.browser") }));
    expect(screen.queryByRole("button", { name: t("autopilot.where.discardServerWork") })).not.toBeInTheDocument();
  });

  it("downloads first: the plain button asks for no discarding", async () => {
    open(null, { online: true });
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.browser") }));
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.moveBack") }));
    await waitFor(() => expect(mocks.runtime.moveToBrowser).toHaveBeenCalledWith(BOOK.id));
  });

  it("keeps the book on the server, and says why, when it cannot be brought back", async () => {
    mocks.runtime.moveToBrowser.mockRejectedValue(new Error("Some files changed on both sides."));
    open(null, { online: true });
    fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.browser") }));
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.moveBack") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "Some files changed on both sides.", variant: "destructive" })));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith({ title: t("autopilot.where.movedBack") });
  });
});

describe("the texts of the conflicts", () => {
  const KEYS = ["conflictsTitle_one", "conflictsTitle_other", "conflicts_one", "conflicts_other", "keepLocal", "keepRemote", "keepLocalFor", "keepRemoteFor", "keepLocalAll", "keepRemoteAll", "keepLocalAllConfirm", "keepRemoteAllConfirm", "conflictLine", "sideSize", "side.modified", "side.added", "side.deleted", "upToDate", "firstSync", "discardServerWork", "discardConfirm", "conflictsHint"];
  it.each(["en", "it"])("exist in %s, and the Italian is not the English", (lng) => {
    for (const key of KEYS) {
      expect(i18n.exists(`autopilot.where.${key}`, { lng }), key).toBe(true);
    }
    for (const key of ["keepLocal", "keepRemote", "upToDate", "firstSync", "discardServerWork"]) {
      expect(i18n.t(`autopilot.where.${key}`, { lng: "it" }), key).not.toBe(i18n.t(`autopilot.where.${key}`, { lng: "en" }));
    }
  });
});
