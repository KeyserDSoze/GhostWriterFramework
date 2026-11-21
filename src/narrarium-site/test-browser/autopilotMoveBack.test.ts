import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { ServerRequestError } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, verify: null as null | (() => Promise<unknown>) }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => (mocks.verify ? mocks.verify() : mocks.server.verified()),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime } from "@/autopilot/runtime";
import { ServerIdentityError } from "@/autopilot/serverIdentity";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { dropSyncBaseDatabase } from "./helpers/rawSyncBase";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const CONSENT = { sendAiConfiguration: false, sendGitHubToken: false };

let server: FakeBookServer;
let local: MemoryBookStore;

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const view = () => useAutopilotStore.getState().views[BOOK.id];
const moveBack = (options?: { discardServerWork?: boolean }) => autopilotRuntime.moveToBrowser(BOOK.id, options);
const hostedByTheServer = () => useAutopilotStore.getState().patchView(BOOK.id, { server: server.summary(BOOK.id) });

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
  mocks.verify = null;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) } });
});

afterEach(() => {
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("bringing a book back to this browser", () => {
  beforeEach(hostedByTheServer);

  it("downloads the server's work first, and only then lets the server go", async () => {
    server.store.write("chapters/001/001-scene.md", "written by the autopilot on the server");
    local.write("book.md", "the book");
    server.store.write("book.md", "the book");

    await expect(moveBack()).resolves.toBeUndefined();
    expect(local.files.get("chapters/001/001-scene.md")).toBe("written by the autopilot on the server");
    expect(view().server).toBeNull();
    expect(view().sync).toMatchObject({ ok: true, kind: "synced", downloaded: 1 });
  });

  it("keeps the book on the server when the server cannot be reached", async () => {
    server.failures.autopilot = new ServerRequestError("The personal server is not reachable.", 0, "unreachable");
    await expect(moveBack()).rejects.toBeInstanceOf(ServerRequestError);
    expect(view().server).not.toBeNull();
    expect(local.files.size).toBe(0);
  });

  it("keeps the book on the server when it cannot prove its identity, and sends nothing to it", async () => {
    mocks.verify = async () => { throw new ServerIdentityError("changed"); };
    await expect(moveBack()).rejects.toBeInstanceOf(ServerIdentityError);
    expect(view().server).not.toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("keeps the book on the server while a run is still active there, and downloads nothing", async () => {
    server.running = true;
    server.store.write("chapters/001/001-scene.md", "being written");
    const refused = await moveBack().catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotBusyError");
    expect(autopilotRuntime.describeError(refused)).toBe(t("autopilot.errors.busy", { label: t("autopilot.host.server") }));
    expect(view().server).not.toBeNull();
    expect(local.files.size).toBe(0);
    expect(server.count("readFiles")).toBe(0);
  });

  it("keeps the book on the server when the download fails halfway", async () => {
    server.store.write("chapters/001/001-scene.md", "written on the server");
    server.failures.readFiles = new Error("The disk is full.");
    await expect(moveBack()).rejects.toThrow("The disk is full.");
    expect(view().server).not.toBeNull();
    expect(view().sync).toMatchObject({ ok: false, kind: "error" });
  });

  it("keeps the book on the server when files changed on both sides, shows which, and lets the author settle them", async () => {
    local.write("plot.md", "plot, edited here");
    server.store.write("plot.md", "plot, edited on the server");
    server.store.write("chapters/001/001-scene.md", "a new scene");

    const refused = await moveBack().catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotSyncConflictsError");
    expect((refused as { conflicts: string[] }).conflicts).toEqual(["plot.md"]);
    expect((refused as Error).message).toBe(t("autopilot.errors.conflictsMoveBack", { count: 1 }));
    expect(view().server).not.toBeNull();
    expect(view().sync).toMatchObject({ kind: "conflicts", conflicts: ["plot.md"] });
    // Nothing was overwritten while the author decides.
    expect(local.files.get("plot.md")).toBe("plot, edited here");
    expect(server.store.files.get("plot.md")).toBe("plot, edited on the server");

    await autopilotRuntime.resolveSyncConflicts(BOOK.id, { "plot.md": "remote" });
    await expect(moveBack()).resolves.toBeUndefined();
    expect(local.files.get("plot.md")).toBe("plot, edited on the server");
    expect(view().server).toBeNull();
  });

  it("lets a book go that is not on the server any more", async () => {
    server.bookMissing = true;
    await expect(moveBack()).resolves.toBeUndefined();
    expect(view().server).toBeNull();
    expect(server.count("manifest")).toBe(0);
  });

  it("lets the author leave a server that cannot be reached, but only when they say so", async () => {
    server.failures.autopilot = new ServerRequestError("The personal server is not reachable.", 0, "unreachable");
    await expect(moveBack()).rejects.toBeInstanceOf(ServerRequestError);
    expect(view().server).not.toBeNull();

    await expect(moveBack({ discardServerWork: true })).resolves.toBeUndefined();
    expect(view().server).toBeNull();
    expect(server.count("readFiles")).toBe(0);
  });

  it("does not let the author leave a server that is running the book, even without downloading", async () => {
    server.running = true;
    await expect(moveBack({ discardServerWork: true })).rejects.toMatchObject({ name: "AutopilotBusyError" });
    expect(view().server).not.toBeNull();
  });

  it("cannot download without a server at all: it asks to connect one, unless the author goes without downloading", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
    await expect(moveBack()).rejects.toMatchObject({ code: "no-server" });
    expect(view().server).not.toBeNull();
    await expect(moveBack({ discardServerWork: true })).resolves.toBeUndefined();
    expect(view().server).toBeNull();
  });
});

describe("moving a book to the server when the server already has files of it", () => {
  function ready() {
    local.write("plot.md", "plot, written here");
    local.write("book.md", "the book");
    server.store.write("plot.md", "plot, written on the server");
    server.store.write("chapters/001/001-scene.md", "a scene the server has");
  }

  it("goes through the list of conflicts instead of overwriting the server's version", async () => {
    ready();
    const refused = await autopilotRuntime.moveToServer(BOOK.id, CONSENT).catch((error: unknown) => error);

    expect((refused as Error).name).toBe("AutopilotSyncConflictsError");
    expect((refused as { conflicts: string[] }).conflicts).toEqual(["plot.md"]);
    expect((refused as Error).message).toBe(t("autopilot.errors.conflictsMoveToServer", { count: 1 }));
    expect(server.store.files.get("plot.md")).toBe("plot, written on the server");
    expect(local.files.get("plot.md")).toBe("plot, written here");
    expect(view().sync).toMatchObject({ kind: "conflicts", conflicts: ["plot.md"] });
    expect(view().sync?.conflictDetails).toEqual([expect.objectContaining({ path: "plot.md", local: "added", remote: "added" })]);
    // The book was not handed over: it is still where it was.
    expect(view().server).toBeNull();
  });

  it("completes once the conflicts are settled, with the author's choices", async () => {
    ready();
    await autopilotRuntime.moveToServer(BOOK.id, CONSENT).catch(() => undefined);
    await autopilotRuntime.resolveSyncConflicts(BOOK.id, { "plot.md": "local" });
    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).resolves.toBeUndefined();

    expect(server.store.files.get("plot.md")).toBe("plot, written here");
    expect(server.store.files.get("book.md")).toBe("the book");
    expect(local.files.get("chapters/001/001-scene.md")).toBe("a scene the server has");
    expect(view().server).not.toBeNull();
  });

  it("uploads a book the server does not have yet, without any question", async () => {
    local.write("book.md", "the book");
    await expect(autopilotRuntime.moveToServer(BOOK.id, CONSENT)).resolves.toBeUndefined();
    expect(server.store.files.get("book.md")).toBe("the book");
    expect(view().server).not.toBeNull();
  });
});

describe("the texts of the hand-over", () => {
  it.each(["en", "it"])("exist in %s", (lng) => {
    for (const key of ["autopilot.errors.busy", "autopilot.errors.moveBack.local-changes", "autopilot.errors.moveBack.server-publish", "autopilot.where.discardServerWork", "autopilot.where.discardConfirm"]) {
      expect(i18n.exists(key, { lng }), key).toBe(true);
    }
    for (const key of ["autopilot.errors.conflictsMoveBack", "autopilot.errors.conflictsMoveToServer"]) {
      expect(i18n.exists(`${key}_one`, { lng }), `${key}_one`).toBe(true);
      expect(i18n.exists(`${key}_other`, { lng }), `${key}_other`).toBe(true);
    }
  });

  it("speaks of one file or of several", () => {
    expect(t("autopilot.errors.conflictsMoveBack", { count: 1 })).not.toBe(t("autopilot.errors.conflictsMoveBack", { count: 2 }));
    expect(t("autopilot.errors.conflictsMoveBack", { count: 3 })).toContain("3");
  });
});
