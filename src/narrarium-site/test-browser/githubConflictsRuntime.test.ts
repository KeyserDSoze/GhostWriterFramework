import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerRequestError, type GithubConflict } from "narrarium-engine";

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
import { autopilotRuntime, describeAutopilotError } from "@/autopilot/runtime";
import { AutopilotOperationBusyError } from "@/autopilot/operations";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "writer", repo: "glass-harbor", name: "The Glass Harbor", tokenIndex: null, bookToken: "ghp_book_token", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const META = { id: "repo-1", bookId: BOOK.id, owner: BOOK.owner, repo: BOOK.repo, branch: "main", cloneComplete: true };
const CLEAN = { clean: 4, modified: 0, new: 0, deleted: 0, dirty: 0, ahead: 0 };
const CONFLICT_MESSAGE = "The book changed on GitHub in a way that conflicts with the server's work (3 files). Resolve it in the app (Where it runs, or the error panel), then resume.";

let server: FakeBookServer;

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const view = () => useAutopilotStore.getState().views[BOOK.id];
const conflict = (path: string, patch: Partial<GithubConflict> = {}): GithubConflict => ({ path, server: "modified", github: "modified", serverBytes: 1_200, githubBytes: 2_048, resolvable: true, ...patch });
const files = (count: number) => Array.from({ length: count }, (_, index) => conflict(`chapters/${String(index).padStart(4, "0")}.md`));

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  server = new FakeBookServer();
  server.githubConflicts = true;
  server.conflicts = files(3);
  mocks.server = server;
  mocks.getLocalRepository.mockReset().mockResolvedValue(META);
  mocks.localStatus.mockReset().mockResolvedValue(CLEAN);
  mocks.syncFullRepository.mockReset().mockResolvedValue({ pulled: 0, committed: 1 });
  mocks.pullRemoteChanges.mockReset().mockResolvedValue({ updated: 0, remoteHeadSha: "abc" });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) } });
  useAutopilotStore.getState().patchView(BOOK.id, { server: server.summary(BOOK.id) });
});

afterEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("reading the conflicts with GitHub from the server", () => {
  it("asks for the page it is given, and gives the server's list as it is", async () => {
    server.conflicts = files(120);
    const page = await autopilotRuntime.githubConflicts(BOOK.id, { offset: 50, limit: 50 });

    expect(server.listed).toEqual([{ offset: 50, limit: 50 }]);
    expect(page).toMatchObject({ total: 120, offset: 50, limit: 50, fingerprint: server.fingerprint() });
    expect(page.conflicts.map((entry) => entry.path)).toEqual(files(120).slice(50, 100).map((entry) => entry.path));
  });

  it("does not hold the book: looking changes nothing, and the author can go on with everything else", async () => {
    let release!: () => void;
    server.gates.listGithubConflicts = new Promise<void>((resolve) => { release = resolve; });
    const reading = autopilotRuntime.githubConflicts(BOOK.id, { limit: 50 });
    await vi.waitFor(() => expect(server.count("listGithubConflicts")).toBe(1));

    expect(view().operation).toBeNull();
    release();
    await reading;
  });

  it("refuses a server that does not have the feature before it sends anything: it would answer 404", async () => {
    server.githubConflicts = false;

    const refused = await autopilotRuntime.githubConflicts(BOOK.id, { limit: 50 }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ServerRequestError);
    expect(refused).toMatchObject({ status: 501, code: "feature_unavailable" });
    expect(server.calls).toEqual([]);
    await expect(autopilotRuntime.resolveGithubConflicts(BOOK.id, { default: "server" })).rejects.toMatchObject({ code: "feature_unavailable" });
    expect(server.calls).toEqual([]);
  });

  it("passes on what the server refused, with what it said besides: a book that is not on GitHub, a git that failed", async () => {
    server.noRemote = true;
    await expect(autopilotRuntime.githubConflicts(BOOK.id, {})).rejects.toMatchObject({ status: 409, code: "no_remote" });
    server.noRemote = false;
    server.gitFailure = "fatal: unable to access 'https://github.com/writer/glass-harbor.git/'";
    await expect(autopilotRuntime.githubConflicts(BOOK.id, {})).rejects.toMatchObject({ status: 502, code: "git_failed" });
  });

  it("is a server that cannot be reached, as everything else the server is asked for", async () => {
    server.offline = true;
    await expect(autopilotRuntime.githubConflicts(BOOK.id, {})).rejects.toMatchObject({ status: 0, code: "unreachable" });
  });
});

describe("resolving them", () => {
  it("sends what it is given, and gives the server's answer", async () => {
    const listing = await autopilotRuntime.githubConflicts(BOOK.id, { limit: 50 });
    const answer = await autopilotRuntime.resolveGithubConflicts(BOOK.id, { fingerprint: listing.fingerprint, default: "github", choices: { [files(3)[0].path]: "server" } });

    expect(server.resolutions).toEqual([{ fingerprint: listing.fingerprint, default: "github", choices: { [files(3)[0].path]: "server" } }]);
    expect(answer).toMatchObject({ pushed: true, counts: { total: 3, server: 1, github: 2, ignored: 0, unresolvable: 0 } });
    expect(server.conflicts).toEqual([]);
  });

  it("holds the book while it works, and every other operation of the author's is refused in words, until it is over", async () => {
    let release!: () => void;
    server.gates.resolveGithubConflicts = new Promise<void>((resolve) => { release = resolve; });
    const listing = await autopilotRuntime.githubConflicts(BOOK.id, { limit: 50 });
    const resolving = autopilotRuntime.resolveGithubConflicts(BOOK.id, { fingerprint: listing.fingerprint, default: "server" });
    await vi.waitFor(() => expect(view().operation?.kind).toBe("githubConflicts"));

    const refused = await autopilotRuntime.syncWithServer(BOOK.id, { throwOnError: true }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AutopilotOperationBusyError);
    expect((refused as Error).message).toBe(t("autopilot.errors.busyWith.githubConflicts"));
    expect(t("autopilot.operation.githubConflicts")).not.toBe("autopilot.operation.githubConflicts");

    release();
    await resolving;
    expect(view().operation).toBeNull();
  });

  it("frees the book when the server refuses", async () => {
    server.running = true;
    const refused = await autopilotRuntime.resolveGithubConflicts(BOOK.id, { default: "server", fingerprint: "x" }).catch((error: unknown) => error);

    expect(refused).toMatchObject({ status: 409, code: "busy" });
    expect(view().operation).toBeNull();
  });

  it("keeps the details of a refusal: the new list of conflicts that changed, the files without a choice", async () => {
    const listing = await autopilotRuntime.githubConflicts(BOOK.id, { limit: 50 });
    server.moveGithub();
    const changed = await autopilotRuntime.resolveGithubConflicts(BOOK.id, { fingerprint: listing.fingerprint, default: "server" }).catch((error: unknown) => error);
    expect(changed).toMatchObject({ status: 409, code: "conflicts_changed" });
    expect((changed as ServerRequestError).details).toMatchObject({ total: 3, offset: 0, fingerprint: server.fingerprint() });

    const missing = await autopilotRuntime.resolveGithubConflicts(BOOK.id, { fingerprint: server.fingerprint(), choices: { [files(3)[0].path]: "server" } }).catch((error: unknown) => error);
    expect(missing).toMatchObject({ status: 400, code: "choice_missing" });
    expect((missing as ServerRequestError).details).toMatchObject({ missing: 2, paths: [files(3)[1].path, files(3)[2].path] });
    expect(server.resolutions).toEqual([]);
  });

  it("brings the summary of the book on the server up to date, so that the notice of the conflicts goes away without waiting for the stream", async () => {
    server.lastSync = { at: "2026-11-21T10:00:00.000Z", ok: false, message: CONFLICT_MESSAGE, conflicts: 3 };
    useAutopilotStore.getState().patchView(BOOK.id, { server: server.summary(BOOK.id) });
    expect(view().server?.lastSync?.conflicts).toBe(3);

    const listing = await autopilotRuntime.githubConflicts(BOOK.id, { limit: 50 });
    await autopilotRuntime.resolveGithubConflicts(BOOK.id, { fingerprint: listing.fingerprint, default: "github" });

    expect(view().server?.lastSync).toMatchObject({ ok: true });
    expect(view().server?.lastSync?.conflicts).toBeUndefined();
  });

  it("does not take the run up again: the author resumes it", async () => {
    const listing = await autopilotRuntime.githubConflicts(BOOK.id, { limit: 50 });
    await autopilotRuntime.resolveGithubConflicts(BOOK.id, { fingerprint: listing.fingerprint, default: "github" });

    expect(server.count("startAutopilot")).toBe(0);
    expect(server.running).toBe(false);
  });
});

describe("a manual sync that the server answers with a conflict with GitHub", () => {
  const conflictAnswer = () => new ServerRequestError(CONFLICT_MESSAGE, 409, "github_conflict", { conflicts: 3 });

  it("is told in words, with the number of files, and is not read as a sync that went well", async () => {
    server.failures.syncGitHub = conflictAnswer();
    const refused = await autopilotRuntime.publishNow(BOOK.id).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ServerRequestError);
    expect(describeAutopilotError(refused)).toBe(t("autopilot.errors.githubConflict", { count: 3 }));
    expect(describeAutopilotError(refused)).toContain("3");
    expect(describeAutopilotError(refused)).not.toContain("GitHub in a way that conflicts");
  });

  it("is kept in the summary of the book on the server, as the server's own `lastSync` says it: that is what «Where it runs» reads", async () => {
    server.failures.syncGitHub = conflictAnswer();
    await autopilotRuntime.publishNow(BOOK.id).catch(() => undefined);

    expect(view().server?.lastSync).toMatchObject({ ok: false, conflicts: 3, message: CONFLICT_MESSAGE });
  });

  it("is told also when it is the sync of «Sync now», which used to leave the server's answer unsaid", async () => {
    mocks.localStatus.mockResolvedValue({ ...CLEAN, dirty: 1, modified: 1, ahead: 2 });
    server.failures.syncGitHub = conflictAnswer();

    // «Sync now» asks to be told of a failure (the page says it in a toast), and the status of the sync says it too.
    const refused = await autopilotRuntime.syncWithServer(BOOK.id, { push: true }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServerRequestError);
    expect(describeAutopilotError(refused)).toBe(t("autopilot.errors.githubConflict", { count: 3 }));
    expect(view().sync).toMatchObject({ ok: false, kind: "error", message: t("autopilot.errors.githubConflict", { count: 3 }) });
    expect(view().server?.lastSync).toMatchObject({ conflicts: 3 });

    const outcome = await autopilotRuntime.syncWithServer(BOOK.id, { push: true, throwOnError: false });
    expect(outcome).toMatchObject({ ok: false, kind: "error", message: t("autopilot.errors.githubConflict", { count: 3 }) });
  });

  it("leaves the best effort of «Sync now» as it was for every other failure of the server: the browser published, and that is what is said", async () => {
    mocks.localStatus.mockResolvedValue({ ...CLEAN, dirty: 1, modified: 1, ahead: 2 });
    server.failures.syncGitHub = new ServerRequestError("push rejected", 409, "sync_failed");

    await expect(autopilotRuntime.syncWithServer(BOOK.id, { push: true })).resolves.toMatchObject({ ok: true, kind: "published" });
  });

  it("is kept when it stopped the move of the book back to this browser, which stays on the server", async () => {
    server.failures.syncGitHub = conflictAnswer();
    const refused = await autopilotRuntime.moveToBrowser(BOOK.id).catch((error: unknown) => error);

    expect((refused as Error).name).toBe("AutopilotMoveBackError");
    expect((refused as Error).message).toContain(t("autopilot.errors.githubConflict", { count: 3 }));
    expect(view().server?.lastSync).toMatchObject({ conflicts: 3 });
    expect(mocks.pullRemoteChanges).not.toHaveBeenCalled();
  });

  it("is not made into a conflict when the server says no number: the words of the server are all there is", async () => {
    server.failures.syncGitHub = new ServerRequestError("The server could not sync.", 409, "github_conflict");
    await autopilotRuntime.publishNow(BOOK.id).catch(() => undefined);

    expect(view().server?.lastSync?.conflicts).toBeUndefined();
  });

  it("leaves every other failure of the server as it was: said as the server says it, and never a conflict", async () => {
    server.failures.syncGitHub = new ServerRequestError("push rejected", 409, "sync_failed");
    const refused = await autopilotRuntime.publishNow(BOOK.id).catch((error: unknown) => error);

    expect(describeAutopilotError(refused)).toBe("push rejected");
    expect(view().server?.lastSync?.conflicts).toBeUndefined();
  });

  it("says it in Italian too", async () => {
    await i18n.changeLanguage("it");
    try {
      const text = describeAutopilotError(conflictAnswer());
      expect(text).toBe(i18n.t("autopilot.errors.githubConflict", { count: 3, lng: "it" }));
      expect(text).not.toBe(i18n.t("autopilot.errors.githubConflict", { count: 3, lng: "en" }));
      expect(text).toMatch(/GitHub/);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

