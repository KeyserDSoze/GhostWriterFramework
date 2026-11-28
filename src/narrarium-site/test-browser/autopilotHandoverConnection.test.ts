import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { ServerRequestError, type ServerGitHubConnection } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, publish: vi.fn(async (..._args: unknown[]) => ({ committed: 1, pulled: 0 })), save: vi.fn(async () => true) }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/repositoryService")>()),
  syncFullRepository: (...args: unknown[]) => mocks.publish(...args),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { HandoverConsentError, isHandoverConsentError } from "@/autopilot/handover";
import { AutopilotSetupError, BrowserAutopilotRuntime, describeAutopilotError } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";
import { dropSyncBaseDatabase } from "./helpers/rawSyncBase";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "acme", repo: "glass-harbor", name: "The Glass Harbor", tokenIndex: null, storageMode: "github", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const CONNECTED: ServerGitHubConnection = { state: "connected", login: "octocat", broker: "https://auth.example.com", accessTokenExpiresAt: "2026-11-29T02:00:00.000Z" };
const ON_CONNECTION = { githubAuth: "connection" as const };
const CONSENT = { sendAiConfiguration: false, sendGitHubToken: false };

let runtime: BrowserAutopilotRuntime;
let server: FakeBookServer;
let local: MemoryBookStore;

const t = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options as never));
const view = () => useAutopilotStore.getState().views[BOOK.id];
const plan = () => view()?.handover ?? null;
const hostOf = () => useSettingsStore.getState().settings.books[0].autopilotHost ?? "browser";

function useBook(patch: Partial<typeof DEFAULT_SETTINGS> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never], defaultGitHubToken: "ghp_token", personalServer: CONNECTION, ...patch } });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await dropSyncBaseDatabase();
  localStorage.clear();
  server = new FakeBookServer();
  server.githubConnectionFeature = true;
  server.githubConnection = CONNECTED;
  server.hasGithubToken = false;
  local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  mocks.server = server;
  mocks.local = local;
  mocks.publish.mockClear();
  mocks.save.mockClear();
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null, handover: { pollMs: 40, doneVisibleMs: 60_000 } });
  useBook();
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [], server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(() => {
  cleanup();
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  runtime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("moving a GitHub book to the server with the server's own GitHub connection", () => {
  it("publishes the book with the token of this device, registers it with `githubAuth: connection`, and sends no token at all", async () => {
    await runtime.moveToServer(BOOK.id, { ...CONSENT, ...ON_CONNECTION });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(server.registered).toHaveLength(1);
    expect(server.registered[0].input).toMatchObject({ storage: { kind: "github", owner: "acme", repo: "glass-harbor" }, githubAuth: "connection" });
    expect(server.registered[0].input).not.toHaveProperty("githubToken");
    expect(JSON.stringify(server.registered)).not.toContain("ghp_token");
    expect(view().server?.githubAuth).toBe("connection");
  });

  it("sends the token, and not the choice of the connection, when that is what the author consents to", async () => {
    await runtime.moveToServer(BOOK.id, { sendAiConfiguration: false, sendGitHubToken: true });
    expect(server.registered[0].input).toMatchObject({ githubToken: "ghp_token" });
    expect(server.registered[0].input).not.toHaveProperty("githubAuth");
  });

  it("is told by the server that it is not connected (it can have been lost since the card looked), says so in words of this site, and leaves the book where it was", async () => {
    server.githubConnection = { state: "needs-reconnect", login: "octocat", broker: "https://auth.example.com", problem: { code: "renewal-failed", message: "THE SERVER'S ENGLISH" } };
    const refused = await runtime.moveToServer(BOOK.id, { ...CONSENT, ...ON_CONNECTION }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServerRequestError);
    expect((refused as ServerRequestError).code).toBe("github_connection_required");
    expect(describeAutopilotError(refused)).toBe(t("autopilot.errors.githubConnectionRequired"));
    expect(describeAutopilotError(refused)).toContain("Settings → Personal server");
    expect(server.registered).toEqual([]);
    expect(hostOf()).toBe("browser");
  });

  it("says in Italian too that the connection is missing", async () => {
    await i18n.changeLanguage("it");
    try {
      expect(describeAutopilotError(new ServerRequestError("x", 412, "github_connection_required"))).toBe(t("autopilot.errors.githubConnectionRequired"));
      expect(describeAutopilotError(new ServerRequestError("x", 502, "github_connection_unavailable"))).toBe(t("autopilot.errors.githubConnectionUnavailable"));
      expect(t("autopilot.errors.githubConnectionRequired")).toMatch(/Impostazioni → Server personale/);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("a plan that moves the book (the flow of «Where it runs», and the quick switch)", () => {
  it("moves a stopped GitHub book on the connection when the author chose it: the server is asked if it is connected, and the registration carries the choice and no token", async () => {
    await runtime.armHandover(BOOK.id, { to: "server", consent: { sendAiConfiguration: true, sendGitHubToken: false, githubAuth: "connection" } }, { saveSettings: mocks.save });
    await vi.waitFor(() => expect(plan()?.phase).toBe("done"), { timeout: 20_000 });
    expect(server.count("githubConnection")).toBeGreaterThan(0);
    expect(server.registered[0].input).toMatchObject({ githubAuth: "connection" });
    expect(server.registered[0].input).not.toHaveProperty("githubToken");
    expect(hostOf()).toBe("server");
    expect(useAutopilotStore.getState().server.githubConnection).toEqual(CONNECTED);
  });

  it("is refused before anything is published when the server is not connected, saying what is missing (the connection), and offering the way out", async () => {
    server.githubConnection = { state: "disconnected" };
    const refused = await runtime.armHandover(BOOK.id, { to: "server", consent: { sendAiConfiguration: true, sendGitHubToken: false, githubAuth: "connection" } }).catch((error: unknown) => error);
    expect(isHandoverConsentError(refused)).toBe(true);
    expect(refused).toBeInstanceOf(HandoverConsentError);
    expect((refused as HandoverConsentError).missing).toBe("github-connection");
    expect((refused as Error).message).toBe(t("autopilot.quick.handover.consent.githubConnection"));
    expect((refused as Error).message).toContain("Settings → Personal server");
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(server.registered).toEqual([]);
    expect(plan()).toBeNull();
    expect(useAutopilotStore.getState().server.githubConnection).toEqual({ state: "disconnected" });
  });

  it("is refused the same way when the server does not announce the feature at all (an older server)", async () => {
    server.githubConnectionFeature = false;
    const refused = await runtime.armHandover(BOOK.id, { to: "server", consent: { sendAiConfiguration: true, sendGitHubToken: false, githubAuth: "connection" } }).catch((error: unknown) => error);
    expect((refused as HandoverConsentError).missing).toBe("github-connection");
    expect(server.count("githubConnection")).toBe(0);
    expect(server.registered).toEqual([]);
  });

  it("still needs a GitHub credential on this device: the book is published from here before it moves", async () => {
    useBook({ defaultGitHubToken: "" });
    const refused = await runtime.armHandover(BOOK.id, { to: "server", consent: { sendAiConfiguration: true, sendGitHubToken: false, githubAuth: "connection" } }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AutopilotSetupError);
    expect((refused as AutopilotSetupError).code).toBe("github-token");
    expect(server.registered).toEqual([]);
  });

  it("takes a book that the server already holds on its connection with no consent at all (a quick switch back to the server), when the server is connected: the registration keeps the way it signs in", async () => {
    useAutopilotStore.getState().patchView(BOOK.id, { server: { ...server.summary(BOOK.id), hasGithubToken: false, githubAuth: "connection" } });
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await vi.waitFor(() => expect(plan()?.phase).toBe("done"), { timeout: 20_000 });
    expect(server.registered[0].input).not.toHaveProperty("githubToken");
    expect(hostOf()).toBe("server");
  });

  it("refuses that quick switch, saying what is missing, when the connection of the server was lost since", async () => {
    useAutopilotStore.getState().patchView(BOOK.id, { server: { ...server.summary(BOOK.id), hasGithubToken: false, githubAuth: "connection" } });
    server.githubConnection = { state: "needs-reconnect", broker: "https://auth.example.com" };
    const refused = await runtime.armHandover(BOOK.id, { to: "server" }).catch((error: unknown) => error);
    expect((refused as HandoverConsentError).missing).toBe("github-connection");
    expect(server.registered).toEqual([]);
  });

  it("lets the author go from the connection to a token: consenting to send the token needs no connection", async () => {
    server.githubConnection = { state: "disconnected" };
    useAutopilotStore.getState().patchView(BOOK.id, { server: { ...server.summary(BOOK.id), hasGithubToken: false, githubAuth: "connection" } });
    await runtime.armHandover(BOOK.id, { to: "server", consent: { sendAiConfiguration: true, sendGitHubToken: true } }, { saveSettings: mocks.save });
    await vi.waitFor(() => expect(plan()?.phase).toBe("done"), { timeout: 20_000 });
    expect(server.registered[0].input).toMatchObject({ githubToken: "ghp_token" });
    expect(server.count("githubConnection")).toBe(0);
  });

  it("leaves a plain GitHub book as it was: with no connection chosen the server is not asked about its connection", async () => {
    server.hasGithubToken = true;
    useAutopilotStore.getState().patchView(BOOK.id, { server: { ...server.summary(BOOK.id), hasGithubToken: true } });
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await vi.waitFor(() => expect(plan()?.phase).toBe("done"), { timeout: 20_000 });
    expect(server.count("githubConnection")).toBe(0);
    expect(server.registered[0].input).not.toHaveProperty("githubAuth");
  });
});
