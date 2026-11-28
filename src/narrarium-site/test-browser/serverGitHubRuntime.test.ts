import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, clientId: "Iv1.0123456789abcdef" }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/config/publicClients", () => ({ get GITHUB_APP_CLIENT_ID() { return mocks.clientId; } }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotSetupError, BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";

const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
let runtime: BrowserAutopilotRuntime;
let server: FakeBookServer;

const status = () => useAutopilotStore.getState().server.githubConnection;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  server = new FakeBookServer();
  server.githubConnectionFeature = true;
  mocks.server = server;
  mocks.clientId = "Iv1.0123456789abcdef";
  vi.stubEnv("VITE_AUTH_BROKER_BASE", "https://auth.example.com");
  runtime = new BrowserAutopilotRuntime({ locks: () => undefined as never, channel: () => null });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [], personalServer: CONNECTION } });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("reading the server's own connection to GitHub", () => {
  it("asks the server and keeps what it says in the store, where the book flow reads it", async () => {
    expect(status()).toBeUndefined();
    server.githubConnection = { state: "connected", login: "octocat", broker: "https://auth.example.com", connectedAt: "2026-11-28T10:00:00.000Z" };
    expect(await runtime.readServerGitHub()).toEqual(server.githubConnection);
    expect(status()).toEqual(server.githubConnection);
    expect(server.count("githubConnection")).toBe(1);
  });

  it("does not ask a server that does not announce the feature: nothing is sent, and the status is null", async () => {
    server.githubConnectionFeature = false;
    expect(await runtime.readServerGitHub()).toBeNull();
    expect(status()).toBeNull();
    expect(server.count("githubConnection")).toBe(0);
  });

  it("is forgotten when the settings follow another server, so that one is never shown with the status of the other", () => {
    useAutopilotStore.getState().setServer({ githubConnection: { state: "connected", login: "octocat" } });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [], personalServer: { ...CONNECTION, url: "http://127.0.0.1:24999", token: "nrs_other" } } });
    runtime.ensureServerStream();
    expect(status()).toBeUndefined();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [] } });
    useAutopilotStore.getState().setServer({ githubConnection: { state: "pending" } });
    runtime.ensureServerStream();
    expect(status()).toBeUndefined();
  });
});

describe("connecting and disconnecting", () => {
  it("starts the connection with the Client ID of the app and the broker of the build, and nothing of this browser's own GitHub sign-in", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [], personalServer: CONNECTION, defaultGitHubToken: "ghp_browser_token_0123456789" } });
    const answer = await runtime.connectServerGitHub();
    expect(answer.state).toBe("pending");
    expect(server.connectRequests).toEqual([{ clientId: "Iv1.0123456789abcdef", broker: "https://auth.example.com" }]);
    expect(JSON.stringify(server.connectRequests)).not.toContain("ghp_");
    expect(status()).toEqual(answer);
  });

  it("is refused here, before anything is sent, when the build has no app or no broker", async () => {
    mocks.clientId = "";
    await expect(runtime.connectServerGitHub()).rejects.toBeInstanceOf(AutopilotSetupError);
    await expect(runtime.connectServerGitHub()).rejects.toThrow(/no GitHub App or no sign-in broker/);
    expect(server.count("connectGitHub")).toBe(0);
  });

  it("keeps the refusal of the server as it is: a connection that exists is not started again", async () => {
    await runtime.connectServerGitHub();
    await expect(runtime.connectServerGitHub()).rejects.toMatchObject({ code: "github_connection_exists", status: 409 });
    expect(status()?.state).toBe("pending");
  });

  it("a refusal of GitHub comes back as a status with its problem, which the store keeps", async () => {
    server.connectAnswer = { state: "disconnected", problem: { code: "device-flow-disabled", message: "Device flow is switched off." } };
    const answer = await runtime.connectServerGitHub();
    expect(answer).toEqual(server.connectAnswer);
    expect(status()?.problem?.code).toBe("device-flow-disabled");
  });

  it("disconnects, and the store says so", async () => {
    await runtime.connectServerGitHub();
    const answer = await runtime.disconnectServerGitHub();
    expect(answer).toEqual({ state: "disconnected" });
    expect(status()).toEqual({ state: "disconnected" });
    expect(server.count("disconnectGitHub")).toBe(1);
  });

  it("is refused before it is sent by a server that does not announce the feature", async () => {
    server.githubConnectionFeature = false;
    await expect(runtime.connectServerGitHub()).rejects.toMatchObject({ code: "feature_unavailable" });
    await expect(runtime.disconnectServerGitHub()).rejects.toMatchObject({ code: "feature_unavailable" });
  });
});
