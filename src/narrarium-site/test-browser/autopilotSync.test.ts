import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { ServerRequestError } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown }));

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
import { autopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { syncStatusText } from "@/autopilot/format";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { dropSyncBaseDatabase, readRawSyncBase } from "./helpers/rawSyncBase";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const SERVER_ID = "server-1";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const LEGACY_KEY = `narrarium-server-sync-base-v1:${SERVER_ID}:${BOOK.id}`;

let server: FakeBookServer;
let local: MemoryBookStore;

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const view = () => useAutopilotStore.getState().views[BOOK.id];
const sync = () => autopilotRuntime.syncWithServer(BOOK.id);
const sizeOf = (text: string) => new TextEncoder().encode(text).length;
const choose = (choice: "local" | "remote", ...paths: string[]) => Object.fromEntries(paths.map((path) => [path, choice]));

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await dropSyncBaseDatabase();
  localStorage.clear();
  server = new FakeBookServer();
  local = new MemoryBookStore();
  mocks.server = server;
  mocks.local = local;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) } });
});

afterEach(() => {
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("what a sync tells", () => {
  it("is 'synced' when files travelled, with how many in each direction", async () => {
    local.write("chapters/001/a.md", "from this device");
    local.write("chapters/001/c.md", "also from this device");
    server.store.write("chapters/001/b.md", "from the server");

    const outcome = await sync();
    expect(outcome).toMatchObject({ ok: true, kind: "synced", conflicts: [], conflictDetails: [], uploaded: 2, downloaded: 1, baseSaved: true });
    expect(server.store.files.get("chapters/001/a.md")).toBe("from this device");
    expect(local.files.get("chapters/001/b.md")).toBe("from the server");
    expect(view().sync).toMatchObject({ ok: true, kind: "synced", uploaded: 2, downloaded: 1 });
    expect(Date.parse(view().sync!.at)).not.toBeNaN();
    expect(syncStatusText(t as never, view().sync)).toBe(t("autopilot.where.synced"));
  });

  it("is 'up to date' when there was nothing to send or receive, not a 'synced' that did nothing", async () => {
    local.write("book.md", "same");
    server.store.write("book.md", "same");
    await sync();

    const outcome = await sync();
    expect(outcome).toMatchObject({ ok: true, kind: "up-to-date", uploaded: 0, downloaded: 0, firstSync: false });
    expect(syncStatusText(t as never, view().sync)).toBe(t("autopilot.where.upToDate"));
    expect(t("autopilot.where.upToDate")).not.toBe(t("autopilot.where.synced"));
  });

  it("is a first sync, and says so, only while no base was ever saved", async () => {
    local.write("book.md", "one");
    expect((await sync()).firstSync).toBe(true);
    expect((await sync()).firstSync).toBe(false);
  });

  it("lists the files that changed on both sides instead of calling it 'synced', and touches neither version", async () => {
    local.write("plot.md", "plot v1");
    server.store.write("plot.md", "plot v1");
    await sync();
    local.write("plot.md", "plot, edited on this device");
    server.store.write("plot.md", "plot, edited by the autopilot on the server");
    local.write("notes.md", "a note I deleted elsewhere");
    server.store.write("notes.md", "a note I deleted elsewhere");
    await sync();
    local.write("notes.md", "a note I changed here");
    server.store.write("notes.md", null);

    const outcome = await sync();
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe("conflicts");
    expect(outcome.conflicts).toEqual(["notes.md", "plot.md"]);
    expect(outcome.conflictDetails).toEqual([
      { path: "notes.md", local: "modified", remote: "deleted", localBytes: sizeOf("a note I changed here") },
      { path: "plot.md", local: "modified", remote: "modified", localBytes: sizeOf("plot, edited on this device"), remoteBytes: sizeOf("plot, edited by the autopilot on the server") },
    ]);
    expect(local.files.get("plot.md")).toBe("plot, edited on this device");
    expect(server.store.files.get("plot.md")).toBe("plot, edited by the autopilot on the server");
    expect(view().sync).toMatchObject({ ok: false, kind: "conflicts", conflicts: ["notes.md", "plot.md"] });
    expect(syncStatusText(t as never, view().sync)).not.toBe(t("autopilot.where.synced"));
  });

  it("keeps the conflict when it is synced again without a choice", async () => {
    local.write("plot.md", "mine");
    server.store.write("plot.md", "theirs");
    const first = await sync();
    const second = await sync();
    expect(first.conflicts).toEqual(["plot.md"]);
    expect(second.conflicts).toEqual(["plot.md"]);
    expect(second.kind).toBe("conflicts");
  });

  it("is an error, in words, when the server cannot be reached, and it can also be thrown", async () => {
    server.failures.manifest = new ServerRequestError("The personal server is not reachable.", 0, "unreachable");
    const outcome = await sync();
    expect(outcome).toMatchObject({ ok: false, kind: "error", conflicts: [] });
    expect(outcome.message).toBe(t("autopilot.serverOffline"));
    expect(view().sync).toMatchObject({ ok: false, kind: "error", message: t("autopilot.serverOffline") });
    expect(syncStatusText(t as never, view().sync)).toBe(t("autopilot.serverOffline"));

    await expect(autopilotRuntime.syncWithServer(BOOK.id, { throwOnError: true })).rejects.toBeInstanceOf(ServerRequestError);
  });

  it("has a different text for each of the outcomes", () => {
    const base = { at: "2026-11-21T10:00:00.000Z", ok: true, message: "", conflicts: [], conflictDetails: [], firstSync: false, uploaded: 0, downloaded: 0, baseSaved: true };
    const kinds = ["synced", "up-to-date", "published", "local-changes", "conflicts"] as const;
    const texts = kinds.map((kind) => syncStatusText(t as never, { ...base, kind } as never));
    expect(new Set(texts).size).toBe(kinds.length);
    expect(syncStatusText(t as never, { ...base, kind: "error", ok: false, message: "HTTP 500" } as never)).toBe("HTTP 500");
    expect(syncStatusText(t as never, null)).toBeNull();
  });
});

describe("settling the conflicts", () => {
  async function conflictOn(...paths: string[]) {
    for (const path of paths) {
      local.write(path, `${path}: mine`);
      server.store.write(path, `${path}: theirs`);
    }
    return sync();
  }

  it("keeps this device's version of the files it is asked to, and the server's of the others", async () => {
    await conflictOn("a.md", "b.md", "c.md");
    const outcome = await autopilotRuntime.resolveSyncConflicts(BOOK.id, { ...choose("local", "a.md"), ...choose("remote", "b.md", "c.md") });

    expect(outcome).toMatchObject({ ok: true, kind: "synced", conflicts: [] });
    expect(server.store.files.get("a.md")).toBe("a.md: mine");
    expect(local.files.get("b.md")).toBe("b.md: theirs");
    expect(local.files.get("c.md")).toBe("c.md: theirs");
    expect(view().sync?.conflicts).toEqual([]);
    expect(syncStatusText(t as never, view().sync)).toBe(t("autopilot.where.synced"));
  });

  it("leaves in conflict what was not chosen, as it was", async () => {
    await conflictOn("a.md", "b.md");
    const outcome = await autopilotRuntime.resolveSyncConflicts(BOOK.id, choose("local", "a.md"));
    expect(outcome.kind).toBe("conflicts");
    expect(outcome.conflicts).toEqual(["b.md"]);
    expect(local.files.get("b.md")).toBe("b.md: mine");
    expect(server.store.files.get("b.md")).toBe("b.md: theirs");
    expect(server.store.files.get("a.md")).toBe("a.md: mine");
  });

  it("settles a deletion that conflicts with an edit, whichever side wins", async () => {
    local.write("notes.md", "v1");
    server.store.write("notes.md", "v1");
    await sync();
    local.write("notes.md", "edited here");
    server.store.write("notes.md", null);
    expect((await sync()).conflictDetails[0]).toMatchObject({ path: "notes.md", local: "modified", remote: "deleted" });

    await autopilotRuntime.resolveSyncConflicts(BOOK.id, choose("remote", "notes.md"));
    expect(local.files.has("notes.md")).toBe(false);
  });

  it("settles thousands of conflicts in one go", async () => {
    const paths = Array.from({ length: 2_500 }, (_, index) => `notes/n-${String(index).padStart(4, "0")}.md`);
    await conflictOn(...paths);
    const outcome = await autopilotRuntime.resolveSyncConflicts(BOOK.id, choose("local", ...paths));
    expect(outcome).toMatchObject({ ok: true, kind: "synced", conflicts: [] });
    expect(server.store.files.size).toBe(2_500);
    expect(server.store.files.get(paths[2_499])).toBe(`${paths[2_499]}: mine`);
  }, 60_000);
});

describe("the base of the sync", () => {
  it("is written to IndexedDB after the sync, and never to localStorage", async () => {
    local.write("book.md", "one");
    server.store.write("plot.md", "two");
    await sync();

    const base = await readRawSyncBase(SERVER_ID, BOOK.id);
    expect([...(base ?? new Map()).keys()].sort()).toEqual(["book.md", "plot.md"]);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("narrarium-server-sync-base"))).toEqual([]);
  });

  it("makes a deletion travel to the other side", async () => {
    local.write("notes.md", "v1");
    server.store.write("notes.md", "v1");
    await sync();
    local.write("notes.md", null);

    const outcome = await sync();
    expect(outcome).toMatchObject({ ok: true, kind: "synced", uploaded: 1 });
    expect(server.store.files.has("notes.md")).toBe(false);
  });

  it("never deletes anything without a base: what is missing on one side comes back from the other", async () => {
    server.store.write("chapters/001/old.md", "the author deleted it here, long ago");
    server.store.write("book.md", "same");
    local.write("book.md", "same");

    const outcome = await sync();
    expect(outcome.firstSync).toBe(true);
    expect(local.files.get("chapters/001/old.md")).toBe("the author deleted it here, long ago");
    expect(server.store.files.has("chapters/001/old.md")).toBe(true);
  });

  it("reads the base that earlier versions kept in localStorage, then moves it", async () => {
    local.write("notes.md", "v1");
    server.store.write("notes.md", "v1");
    await sync();
    const saved = await readRawSyncBase(SERVER_ID, BOOK.id);
    // Put the base back where earlier versions had it.
    await dropSyncBaseDatabase();
    localStorage.setItem(LEGACY_KEY, JSON.stringify([...(saved ?? new Map()).entries()]));
    local.write("notes.md", null);

    const outcome = await sync();
    expect(outcome.firstSync).toBe(false);
    expect(outcome.uploaded).toBe(1);
    expect(server.store.files.has("notes.md")).toBe(false);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect((await readRawSyncBase(SERVER_ID, BOOK.id))?.has("notes.md")).toBe(false);
  });

  it("is a visible error when it cannot be saved: the files travelled, but 'synced' would be a lie", async () => {
    local.write("book.md", "one");
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); });

    const outcome = await sync();
    expect(server.store.files.get("book.md")).toBe("one");
    expect(outcome).toMatchObject({ ok: false, kind: "error", baseSaved: false, uploaded: 1 });
    expect(outcome.message).toBe(t("autopilot.errors.baseSaveFailed"));
    expect(view().sync).toMatchObject({ ok: false, kind: "error", baseSaved: false });
    expect(syncStatusText(t as never, view().sync)).toBe(t("autopilot.errors.baseSaveFailed"));
  });

  it("carries a book of thousands of files, and remembers every one of them", async () => {
    for (let index = 0; index < 4_000; index += 1) local.write(`chapters/${String(index).padStart(5, "0")}/scene.md`, `scene ${index}`);
    const outcome = await sync();
    expect(outcome).toMatchObject({ ok: true, kind: "synced", uploaded: 4_000 });
    expect((await readRawSyncBase(SERVER_ID, BOOK.id))?.size).toBe(4_000);
    expect((await sync()).kind).toBe("up-to-date");
  }, 60_000);
});
