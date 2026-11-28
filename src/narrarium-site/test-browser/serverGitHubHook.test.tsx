import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerGitHubConnection, ServerInfo } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  read: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  connect: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  disconnect: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  clientId: "Iv1.0123456789abcdef",
}));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ readServerGitHub: mocks.read, connectServerGitHub: mocks.connect, disconnectServerGitHub: mocks.disconnect }) }));
vi.mock("@/config/publicClients", () => ({ get GITHUB_APP_CLIENT_ID() { return mocks.clientId; } }));

import i18n from "@/i18n";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useServerGitHub } from "@/autopilot/useServerGitHub";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type PersonalServerSettings } from "@/types/settings";

const PIN = "a".repeat(64);
const CONNECTION: PersonalServerSettings = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.23", engineVersion: "0.1.28", serverId: "s", label: "Home", git: true, features: ["github", "server-github-connection"] } as ServerInfo;
const PENDING: ServerGitHubConnection = { state: "pending", broker: "https://auth.example.com", pending: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: "2026-11-28T10:15:00.000Z", interval: 5 } };

function server(patch: Partial<ServerConnectionState> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: CONNECTION } });
  useAutopilotStore.setState({ server: { status: "online", info: INFO, message: null, books: [], updates: null, connection: CONNECTION, ...patch } });
}
const setStatus = (githubConnection: ServerGitHubConnection | null | undefined) => act(() => useAutopilotStore.getState().setServer({ githubConnection }));
const settled = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  mocks.read.mockReset().mockImplementation(async () => useAutopilotStore.getState().server.githubConnection ?? null);
  mocks.connect.mockReset().mockImplementation(async () => { useAutopilotStore.getState().setServer({ githubConnection: PENDING }); return PENDING; });
  mocks.disconnect.mockReset().mockImplementation(async () => { const status = { state: "disconnected" } as const; useAutopilotStore.getState().setServer({ githubConnection: status }); return status; });
  mocks.clientId = "Iv1.0123456789abcdef";
  vi.stubEnv("VITE_AUTH_BROKER_BASE", "https://auth.example.com");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  server();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("when the server's connection to GitHub is asked for", () => {
  it("asks the server once when the screen opens, and not before: a screen that is not active asks nothing", async () => {
    const view = renderHook(({ active }) => useServerGitHub({ active }), { initialProps: { active: false } });
    await settled();
    expect(mocks.read).not.toHaveBeenCalled();
    view.rerender({ active: true });
    await settled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(view.result.current.offer).toBe("ready");
  });

  it("asks nothing of a server that is not online or that does not announce the feature", async () => {
    server({ status: "offline" });
    const offline = renderHook(() => useServerGitHub({ active: true }));
    await settled();
    expect(offline.result.current.offer).toBe("unavailable");
    offline.unmount();
    server({ info: { ...INFO, features: ["github"] } });
    const old = renderHook(() => useServerGitHub({ active: true }));
    await settled();
    expect(old.result.current.offer).toBe("old-server");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("reads a build with no app too (a connection made elsewhere is still the server's, and its books can use it), and says that it cannot start one", async () => {
    mocks.clientId = "";
    const view = renderHook(() => useServerGitHub({ active: true }));
    await settled();
    expect(view.result.current.offer).toBe("no-site");
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("while the state is not pending the server is not asked again by itself: no timer runs", async () => {
    setStatus({ state: "connected", login: "octocat" });
    renderHook(() => useServerGitHub({ active: true }));
    await settled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("while the server waits for the owner to type the code", () => {
  it("asks again at the interval the server gives, and stops the moment the state is anything else", async () => {
    setStatus(PENDING);
    renderHook(() => useServerGitHub({ active: true }));
    await settled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.read).toHaveBeenCalledTimes(3);
    // The owner typed the code: the server says so, and nobody asks any more.
    await setStatus({ state: "connected", login: "octocat" });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });

  it("stops when the screen goes away", async () => {
    setStatus(PENDING);
    const view = renderHook(() => useServerGitHub({ active: true }));
    await settled();
    view.unmount();
    mocks.read.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops while the tab is hidden, and asks at once when it is in view again", async () => {
    setStatus(PENDING);
    renderHook(() => useServerGitHub({ active: true }));
    await settled();
    let state: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    mocks.read.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.read).not.toHaveBeenCalled();
    state = "visible";
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("waits longer after a failure, and says the failure, but keeps the last thing the server said", async () => {
    setStatus(PENDING);
    const view = renderHook(() => useServerGitHub({ active: true }));
    await settled();
    mocks.read.mockReset().mockRejectedValue(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(view.result.current.error).toBe("offline");
    expect(view.result.current.connection).toEqual(PENDING);
    // The next question comes after twice the wait.
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});

describe("the two actions", () => {
  it("connect and disconnect go through the runtime, say they are busy meanwhile, and say whether they worked", async () => {
    setStatus({ state: "disconnected" });
    const view = renderHook(() => useServerGitHub({ active: true }));
    await settled();
    let done = false;
    await act(async () => { done = await view.result.current.connect(); });
    expect(done).toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(view.result.current.connection?.state).toBe("pending");
    await act(async () => { done = await view.result.current.disconnect(); });
    expect(done).toBe(true);
    expect(view.result.current.connection?.state).toBe("disconnected");
    mocks.connect.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "github_connection_exists", status: 409, name: "ServerRequestError" }));
    await act(async () => { done = await view.result.current.connect(); });
    expect(done).toBe(false);
    expect(view.result.current.error).toBeTruthy();
    expect(view.result.current.busy).toBeNull();
  });
});
