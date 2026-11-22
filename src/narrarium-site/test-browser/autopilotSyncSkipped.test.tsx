import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { SYNC_MAX_FILE_BYTES } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  server: null as unknown as { verified: () => unknown },
  local: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  useRealRuntime: true,
  save: vi.fn(async () => true),
  toast: vi.fn(),
}));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/loader", async (importOriginal) => ({
  loadAutopilotRuntime: async () => (mocks.useRealRuntime ? (await importOriginal<typeof import("@/autopilot/loader")>()).loadAutopilotRuntime() : mocks.runtime),
}));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { WhereCard } from "@/pages/AutopilotPage";
import { autopilotRuntime } from "@/autopilot/runtime";
import { syncStatusText } from "@/autopilot/format";
import { emptyView, useAutopilotStore, type BookSyncStatus } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN, SERVER_INFO } from "./helpers/fakeBookServer";
import { dropSyncBaseDatabase } from "./helpers/rawSyncBase";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const MIB = 1024 * 1024;

let server: FakeBookServer;
let local: MemoryBookStore;

const view = () => useAutopilotStore.getState().views[BOOK.id];

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await dropSyncBaseDatabase();
  localStorage.clear();
  mocks.useRealRuntime = true;
  server = new FakeBookServer();
  local = new MemoryBookStore({ "book.md": "the book" });
  mocks.server = server;
  mocks.local = local;
  mocks.save.mockClear();
  mocks.toast.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: CONNECTION } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, server: { status: "online", info: SERVER_INFO, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  await i18n.changeLanguage("en");
});

describe("a sync that leaves files out", () => {
  it("is not 'all synced': it says it did not move some files, lists them, and still moves the rest", async () => {
    local.write("chapters/001/001-big.md", "x".repeat(SYNC_MAX_FILE_BYTES + 1));
    server.store.write("assets/cover.png", "binary bytes");
    server.store.write("../outside.md", "a path that leaves the book");

    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);

    expect(outcome.ok, "not a success").toBe(false);
    expect(outcome.kind).toBe("partial");
    expect(outcome.skipped).toEqual([
      { path: "../outside.md", reason: "unsafe-path" },
      { path: "assets/cover.png", reason: "not-text" },
      { path: "chapters/001/001-big.md", reason: "too-large", size: SYNC_MAX_FILE_BYTES + 1 },
    ]);
    expect(outcome.message).toBe(t("autopilot.where.partial"));
    expect(outcome.message).toBe("Synced, but some files were left out.");
    expect(outcome.uploaded, "what could be moved was").toBe(1);
    expect(server.store.files.get("book.md")).toBe("the book");
    expect(server.store.files.has("chapters/001/001-big.md")).toBe(false);
    expect(view().sync).toMatchObject({ ok: false, kind: "partial", skipped: outcome.skipped });
  }, 20000);

  it("is not 'already in sync' when the only difference is a file that was left out", async () => {
    server.store.write("assets/cover.png", "binary bytes");
    local.write("book.md", "the book");
    server.store.write("book.md", "the book");
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(outcome.kind).toBe("partial");
    expect(outcome.skipped).toEqual([{ path: "assets/cover.png", reason: "not-text" }]);
    expect(outcome.message).toBe(t("autopilot.where.partial"));
  });

  it("says it again at the next sync, until the file can be moved", async () => {
    server.store.write("assets/cover.png", "binary bytes");
    const first = await autopilotRuntime.syncWithServer(BOOK.id);
    const second = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(first.skipped).toEqual(second.skipped);
    expect(second.kind).toBe("partial");
    server.store.write("assets/cover.png", null);
    expect((await autopilotRuntime.syncWithServer(BOOK.id)).kind).toBe("up-to-date");
  });

  it("is a clean success, with nothing left out, when everything was moved", async () => {
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(outcome).toMatchObject({ ok: true, kind: "synced", skipped: [] });
    expect((await autopilotRuntime.syncWithServer(BOOK.id)).kind).toBe("up-to-date");
  });

  it("keeps the files left out next to the conflicts, which still come first", async () => {
    local.write("plot.md", "plot, written here");
    server.store.write("plot.md", "plot, written on the server");
    server.store.write("assets/cover.png", "binary bytes");
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(outcome.kind).toBe("conflicts");
    expect(outcome.ok).toBe(false);
    expect(outcome.conflicts).toEqual(["plot.md"]);
    expect(outcome.skipped).toEqual([{ path: "assets/cover.png", reason: "not-text" }]);
  });

  it("keeps a failure a failure: a sync that could not save its record is an error, whatever was left out", async () => {
    server.store.write("assets/cover.png", "binary bytes");
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(outcome.kind).not.toBe("error");
    expect(outcome.baseSaved).toBe(true);
  });
});

describe("the words for a sync that left files out", () => {
  const sync: BookSyncStatus = { at: "2026-11-21T10:00:00.000Z", ok: false, kind: "partial", conflicts: [], conflictDetails: [], skipped: [{ path: "assets/cover.png", reason: "not-text" }], message: "", firstSync: false, uploaded: 0, downloaded: 0, baseSaved: true };

  it.each([
    ["en", "Synced, but some files were left out."],
    ["it", "Sincronizzato, ma alcuni file sono stati lasciati fuori."],
  ])("in %s: “%s”", async (language, expected) => {
    await i18n.changeLanguage(language);
    expect(syncStatusText(i18n.t, sync)).toBe(expected);
  });

  it.each([
    ["en", 1, "1 file was not synced"],
    ["en", 4, "4 files were not synced"],
    ["it", 1, "1 file non è stato sincronizzato"],
    ["it", 4, "4 file non sono stati sincronizzati"],
  ])("counts them in %s: %i → “%s”", async (language, count, expected) => {
    await i18n.changeLanguage(language);
    expect(t("autopilot.where.skippedTitle", { count })).toBe(expected);
  });
});

describe("the card of where the book runs, after a sync that left files out", () => {
  const skipped = [
    { path: "chapters/001/001-big.md", reason: "too-large" as const, size: 10 * MIB },
    { path: "chapters/002/002-huge.md", reason: "too-large" as const },
    { path: "assets/cover.png", reason: "not-text" as const },
    { path: "../outside.md", reason: "unsafe-path" as const },
    { path: "notes/small.md", reason: "too-large" as const, size: 512 * 1024 },
  ];
  const status = (patch: Partial<BookSyncStatus> = {}): BookSyncStatus => ({ at: "2026-11-21T10:00:00.000Z", ok: false, kind: "partial", conflicts: [], conflictDetails: [], skipped, message: "", firstSync: false, uploaded: 1, downloaded: 0, baseSaved: true, ...patch });

  function open(sync: BookSyncStatus | null) {
    mocks.useRealRuntime = false;
    mocks.runtime = { syncWithServer: vi.fn(async () => status()), describeError: vi.fn(String), refresh: vi.fn(async () => null) };
    useAutopilotStore.setState({ views: { [BOOK.id]: { ...emptyView(BOOK.id), sync } } });
    return render(<MemoryRouter><WhereCard book={BOOK} running={false} /></MemoryRouter>);
  }

  const list = () => screen.getByRole("list", { name: t("autopilot.where.skippedTitle", { count: skipped.length }) });

  it("shows how many files were left out in an expandable element, and what to do about them", () => {
    open(status());
    const summary = screen.getByText(t("autopilot.where.skippedTitle", { count: 5 }));
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.open, "folded until the author asks").toBe(false);
    expect(within(details).getByText(t("autopilot.where.skippedHint"))).toBeInTheDocument();
    expect(t("autopilot.where.skippedHint")).toMatch(/smaller/);
    expect(t("autopilot.where.skippedHint")).toMatch(/move/);
    expect(t("autopilot.where.skippedHint")).toMatch(/leave/);
  });

  it("lists each file with its path, the reason in words, and its size in KiB or MiB", () => {
    open(status());
    const items = within(list()).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    const texts = items.map((item) => item.textContent ?? "");
    expect(texts[0]).toContain("chapters/001/001-big.md");
    expect(texts[0]).toContain(t("autopilot.where.skipReason.too-large", { limit: "8 MiB" }));
    expect(texts[0]).toContain("· 10 MiB");
    expect(texts[1], "a file a store refused to send has no size to give").toContain("chapters/002/002-huge.md");
    expect(texts[1]).toContain(t("autopilot.where.skipReason.too-large", { limit: "8 MiB" }));
    expect(texts[1]).not.toContain("·");
    expect(texts[2]).toContain(t("autopilot.where.skipReason.not-text"));
    expect(texts[3]).toContain(t("autopilot.where.skipReason.unsafe-path"));
    expect(texts[4]).toContain("· 512 KiB");
    expect(within(items[0]).getByText("chapters/001/001-big.md", { selector: "code" })).toBeInTheDocument();
  });

  it("says the limit, as the engine has it", () => {
    expect(t("autopilot.where.skipReason.too-large", { limit: "8 MiB" })).toContain("8 MiB");
    open(status());
    expect(list()).toHaveTextContent("8 MiB");
  });

  it("is announced with the status of the sync, not as a plain success", () => {
    open(status());
    const announced = screen.getByRole("status");
    expect(announced).toHaveTextContent(syncStatusText(i18n.t, status())!);
    expect(announced.textContent).not.toContain(t("autopilot.where.synced"));
    expect(announced.textContent).not.toContain(t("autopilot.where.upToDate"));
  });

  it("is shown together with the list of conflicts, which keeps working", () => {
    open(status({ kind: "conflicts", conflicts: ["plot.md"], conflictDetails: [{ path: "plot.md", local: "modified", remote: "modified" }] }));
    expect(screen.getByRole("list", { name: t("autopilot.where.conflictsTitle", { count: 1 }) })).toBeInTheDocument();
    expect(list()).toBeInTheDocument();
  });

  it("shows nothing for a sync that left nothing out, or one from before this was reported", () => {
    const view = open(status({ kind: "synced", ok: true, skipped: [] }));
    expect(screen.queryByText(/not synced/)).not.toBeInTheDocument();
    view.unmount();
    open(status({ kind: "synced", ok: true, skipped: undefined }));
    expect(screen.queryByText(/not synced/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists a long list a page at a time", () => {
    open(status({ skipped: Array.from({ length: 120 }, (_, index) => ({ path: `assets/image-${String(index).padStart(3, "0")}.png`, reason: "not-text" as const })) }));
    const names = () => within(screen.getByRole("list", { name: t("autopilot.where.skippedTitle", { count: 120 }) })).getAllByRole("listitem");
    expect(names()).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.plan.run.showMore", { count: 50 }) }));
    expect(names()).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.plan.run.showMore", { count: 20 }) }));
    expect(names()).toHaveLength(120);
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it("says it in Italian, with the sizes written as the language writes numbers", async () => {
    await i18n.changeLanguage("it");
    open(status({ skipped: [{ path: "chapters/001/001-big.md", reason: "too-large", size: Math.round(1.5 * MIB) }, { path: "assets/cover.png", reason: "not-text" }] }));
    expect(screen.getByText("2 file non sono stati sincronizzati")).toBeInTheDocument();
    const items = within(screen.getByRole("list", { name: "2 file non sono stati sincronizzati" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("1,5 MiB");
    expect(items[0]).toHaveTextContent("Troppo grande");
    expect(items[1]).toHaveTextContent("Non è un file di testo");
  });
});

describe("the toast after a sync that left files out", () => {
  it("is a warning, not a success, and says how many files were left out", async () => {
    local.write("book.md", "the book");
    server.store.write("assets/cover.png", "binary bytes");
    mocks.useRealRuntime = true;
    useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) } });
    render(<MemoryRouter><WhereCard book={BOOK} running={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.sync") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.partial"), variant: "destructive" });
    expect(mocks.toast).not.toHaveBeenCalledWith({ title: t("autopilot.where.synced") });
    expect(mocks.toast).not.toHaveBeenCalledWith({ title: t("autopilot.where.upToDate") });
  });
});
