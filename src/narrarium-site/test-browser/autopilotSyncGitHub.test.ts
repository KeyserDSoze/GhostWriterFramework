import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  server: null as unknown as { verified: () => unknown },
  getLocalRepository: vi.fn(),
  localStatus: vi.fn(),
  syncFullRepository: vi.fn(),
  pullRemoteChanges: vi.fn(),
}));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/repository/localRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/localRepository")>()),
  getLocalRepository: mocks.getLocalRepository,
  localStatus: mocks.localStatus,
}));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/repositoryService")>()),
  syncFullRepository: mocks.syncFullRepository,
  pullRemoteChanges: mocks.pullRemoteChanges,
  getExistingLocalBookStructure: async () => null,
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

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "writer", repo: "glass-harbor", name: "The Glass Harbor", tokenIndex: null, bookToken: "ghp_book_token", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const META = { id: "repo-1", bookId: BOOK.id, owner: BOOK.owner, repo: BOOK.repo, branch: "main", cloneComplete: true };
const CLEAN = { clean: 4, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: 0 };

let server: FakeBookServer;

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const view = () => useAutopilotStore.getState().views[BOOK.id];

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  server = new FakeBookServer();
  mocks.server = server;
  mocks.getLocalRepository.mockReset().mockResolvedValue(META);
  mocks.localStatus.mockReset().mockResolvedValue(CLEAN);
  mocks.syncFullRepository.mockReset().mockResolvedValue({ pulled: 0, committed: 1 });
  mocks.pullRemoteChanges.mockReset().mockResolvedValue({ updated: 2, remoteHeadSha: "abc" });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) } });
  useAutopilotStore.getState().patchView(BOOK.id, { server: server.summary(BOOK.id) });
});

afterEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("a GitHub book and the server", () => {
  it("pulls the server's work with a safe pull, and says it is synced", async () => {
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(mocks.pullRemoteChanges).toHaveBeenCalledWith(expect.objectContaining({ bookId: BOOK.id, owner: BOOK.owner, repo: BOOK.repo, branch: "main", mode: "safe" }));
    expect(outcome).toMatchObject({ ok: true, kind: "synced", downloaded: 2, conflicts: [] });
    expect(view().sync).toMatchObject({ ok: true, kind: "synced" });
  });

  it("says it was already up to date when the pull brought nothing", async () => {
    mocks.pullRemoteChanges.mockResolvedValue({ updated: 0, remoteHeadSha: "abc" });
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(outcome).toMatchObject({ ok: true, kind: "up-to-date", downloaded: 0 });
  });

  it("publishes the local commits first when asked to, then has the server pull them: 'published'", async () => {
    mocks.localStatus.mockResolvedValue({ ...CLEAN, dirty: 1, modified: 1, ahead: 2 });
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id, { push: true });
    expect(mocks.syncFullRepository).toHaveBeenCalledTimes(1);
    expect(server.count("syncGitHub")).toBe(1);
    expect(mocks.pullRemoteChanges).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: true, kind: "published" });
    expect(syncStatusText(t as never, view().sync)).toBe(t("autopilot.where.published"));
  });

  it("does not pull over local changes, and says they have to be published first: 'local changes'", async () => {
    mocks.localStatus.mockResolvedValue({ ...CLEAN, dirty: 3, modified: 3, ahead: 0 });
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(mocks.pullRemoteChanges).not.toHaveBeenCalled();
    expect(mocks.syncFullRepository).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, kind: "local-changes", conflicts: [] });
    expect(syncStatusText(t as never, view().sync)).toBe(t("autopilot.where.localChanges"));
  });

  it("is an error, with its reason, when the pull fails", async () => {
    mocks.pullRemoteChanges.mockRejectedValue(new Error("GitHub is down."));
    const outcome = await autopilotRuntime.syncWithServer(BOOK.id);
    expect(outcome).toMatchObject({ ok: false, kind: "error", message: "GitHub is down." });
    await expect(autopilotRuntime.syncWithServer(BOOK.id, { throwOnError: true })).rejects.toThrow("GitHub is down.");
  });

  it("is an error, not a silent 'synced', when the book has no local working copy or no token", async () => {
    mocks.getLocalRepository.mockResolvedValue(null);
    expect(await autopilotRuntime.syncWithServer(BOOK.id)).toMatchObject({ ok: false, kind: "error", message: t("autopilot.errors.workingCopy") });
    expect(mocks.pullRemoteChanges).not.toHaveBeenCalled();

    mocks.getLocalRepository.mockResolvedValue(META);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ ...BOOK, bookToken: undefined }], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
    expect(await autopilotRuntime.syncWithServer(BOOK.id)).toMatchObject({ ok: false, kind: "error", message: t("autopilot.errors.githubToken") });
  });
});

describe("bringing a GitHub book back to this browser", () => {
  it("has the server publish what it wrote, pulls it safely, and only then lets the server go", async () => {
    await expect(autopilotRuntime.moveToBrowser(BOOK.id)).resolves.toBeUndefined();
    expect(server.count("syncGitHub")).toBe(1);
    expect(mocks.pullRemoteChanges).toHaveBeenCalledWith(expect.objectContaining({ mode: "safe" }));
    expect(server.calls.indexOf("syncGitHub")).toBeLessThan(server.calls.length);
    expect(view().server).toBeNull();
  });

  it("keeps the book on the server when the pull fails", async () => {
    mocks.pullRemoteChanges.mockRejectedValue(new Error("GitHub is down."));
    await expect(autopilotRuntime.moveToBrowser(BOOK.id)).rejects.toThrow("GitHub is down.");
    expect(view().server).not.toBeNull();
  });

  it("keeps the book on the server when the server could not publish its work", async () => {
    server.failures.syncGitHub = new Error("push rejected");
    const refused = await autopilotRuntime.moveToBrowser(BOOK.id).catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotMoveBackError");
    expect((refused as { code: string }).code).toBe("server-publish");
    expect((refused as Error).message).toBe(t("autopilot.errors.moveBack.server-publish", { reason: "push rejected" }));
    expect(mocks.pullRemoteChanges).not.toHaveBeenCalled();
    expect(view().server).not.toBeNull();
  });

  it("keeps the book on the server while there are local changes that a pull would not accept, and says what to do", async () => {
    mocks.localStatus.mockResolvedValue({ ...CLEAN, dirty: 2, modified: 2, ahead: 1 });
    const refused = await autopilotRuntime.moveToBrowser(BOOK.id).catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotMoveBackError");
    expect((refused as { code: string }).code).toBe("local-changes");
    expect((refused as Error).message).toBe(t("autopilot.errors.moveBack.local-changes"));
    expect(mocks.pullRemoteChanges).not.toHaveBeenCalled();
    expect(view().server).not.toBeNull();
    expect(view().sync).toMatchObject({ ok: false, kind: "local-changes" });
  });

  it("keeps the book on the server while a run is still active there", async () => {
    server.running = true;
    await expect(autopilotRuntime.moveToBrowser(BOOK.id)).rejects.toMatchObject({ name: "AutopilotBusyError" });
    expect(server.count("syncGitHub")).toBe(0);
    expect(mocks.pullRemoteChanges).not.toHaveBeenCalled();
    expect(view().server).not.toBeNull();
  });
});
