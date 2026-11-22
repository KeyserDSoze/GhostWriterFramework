import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { installProactiveCredentialRefresh, renewLongLivedCredentials, resetProactiveCredentialRefreshForTests } from "@/account/proactiveCredentialRefresh";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, jsonResponse, type FakeNetwork } from "./oauthTestKit";

const scheduled = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock("@/account/accountSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/account/accountSync")>()),
  scheduleAccountSync: scheduled.schedule,
}));

const GOOGLE_REFRESH = `${BROKER_BASE}/oauth/google/refresh`;
const MICROSOFT_REFRESH = `${BROKER_BASE}/oauth/microsoft/refresh`;
const HOME = "11111111-2222-3333-4444-555555555555.9188040d-6c67-4c5b-b112-36a304b66dad";
let net: FakeNetwork;

const connectGoogle = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectGoogle({
  identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" },
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() - 1_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});
const connectMicrosoft = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectMicrosoft({
  identity: { provider: "microsoft", providerAccountId: HOME, displayName: "Writer" },
  homeAccountId: HOME,
  localAccountId: HOME.split(".")[0],
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() - 1_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});
const google = () => useConnectionStore.getState().configuration.google!;
const answer = { accessToken: SECRETS.accessFresh, expiresIn: 3599 };
const setVisibility = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  resetBrokerAvailabilityForTests();
  resetTokenRefreshLockForTests();
  resetProactiveCredentialRefreshForTests();
  scheduled.schedule.mockReset();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
});

afterEach(() => {
  resetProactiveCredentialRefreshForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  closeCredentialVaultForTests();
});

describe("renewing long-lived credentials ahead of time", () => {
  it("renews a token that has expired, quietly, without ever opening a window", async () => {
    const open = vi.spyOn(window, "open");
    net.reply("POST", GOOGLE_REFRESH, answer);
    await connectGoogle();

    await renewLongLivedCredentials("start");

    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
    expect(google().accessToken).toBe(SECRETS.accessFresh);
    expect(open).not.toHaveBeenCalled();
  });

  it("renews a token that is about to expire, but not one that has plenty of time left", async () => {
    net.reply("POST", GOOGLE_REFRESH, answer);
    await connectGoogle({ accessTokenExpiry: Date.now() + 2 * 60_000 });
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);

    await connectGoogle({ accessTokenExpiry: Date.now() + 40 * 60_000 });
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
  });

  it("renews OneDrive too, rotating its refresh token", async () => {
    net.reply("POST", MICROSOFT_REFRESH, { ...answer, refreshToken: SECRETS.refreshRotated });
    await connectMicrosoft();
    await renewLongLivedCredentials("start");
    expect(useConnectionStore.getState().configuration.microsoft?.refreshToken).toBe(SECRETS.refreshRotated);
    await expect(loadRefreshToken("microsoft", HOME)).resolves.toBe(SECRETS.refreshRotated);
  });

  it("leaves alone what it must not touch: no refresh token, sync turned off, offline", async () => {
    await connectGoogle({ refreshToken: undefined });
    await renewLongLivedCredentials("start");
    await connectGoogle({ replica: { enabled: false, status: "disabled" } });
    await renewLongLivedCredentials("start");
    expect(net.calls).toHaveLength(0);

    await connectGoogle();
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await renewLongLivedCredentials("visible");
    expect(net.calls).toHaveLength(0);
  });

  it("retries the sync in this session when the replica was waiting for the login, and not when everything was fine", async () => {
    net.reply("POST", GOOGLE_REFRESH, answer);
    await connectGoogle({ replica: { enabled: true, status: "needs-auth", errorKind: "credential-expired" } });
    await renewLongLivedCredentials("visible");
    expect(scheduled.schedule).toHaveBeenCalledTimes(1);

    scheduled.schedule.mockClear();
    await connectGoogle({ accessTokenExpiry: Date.now() + 60_000, replica: { enabled: true, status: "idle" } });
    await renewLongLivedCredentials("visible");
    expect(scheduled.schedule).not.toHaveBeenCalled();
  });

  it("renews once when several triggers fire together", async () => {
    net.on("POST", GOOGLE_REFRESH, async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return jsonResponse(answer); });
    await connectGoogle();
    await Promise.all([renewLongLivedCredentials("start"), renewLongLivedCredentials("visible"), renewLongLivedCredentials("visible")]);
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
  });
});

describe("when it does not work", () => {
  it("marks the replica as needing the login on invalid_grant, so the header indicator says so, and stops asking", async () => {
    net.reply("POST", GOOGLE_REFRESH, { error: "invalid_grant", message: "x" }, 400);
    await connectGoogle();

    await renewLongLivedCredentials("visible");
    expect(google().replica).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
    expect(google().refreshToken).toBeUndefined();

    net.reset();
    await renewLongLivedCredentials("visible");
    expect(net.calls).toHaveLength(0);
  });

  it("does not turn a passing problem into a failure of the replica", async () => {
    await connectGoogle();
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
    expect(google().replica.status).toBe("dirty");
    expect(google().refreshToken).toBe(SECRETS.refresh);
  });

  it("waits longer and longer between attempts instead of retrying in a tight loop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
    await connectGoogle({ accessTokenExpiry: Date.now() - 1_000 });

    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);

    for (const seconds of [1, 10, 15]) {
      vi.advanceTimersByTime(seconds * 1_000);
      await renewLongLivedCredentials("visible");
    }
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(2);

    vi.advanceTimersByTime(40_000);
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(2);

    vi.advanceTimersByTime(120_000);
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(3);
  });

  it("never waits more than a quarter of an hour, however often it failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
    await connectGoogle({ accessTokenExpiry: Date.now() - 1_000 });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await renewLongLivedCredentials("visible");
      vi.advanceTimersByTime(16 * 60_000);
    }
    expect(net.broker("/oauth/google/refresh")).toHaveLength(12);
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(13);
  });

  it("honours how long the broker asked to wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
    net.reply("POST", GOOGLE_REFRESH, { error: "rate_limited", message: "x" }, 429, { "Retry-After": "300" });
    await connectGoogle({ accessTokenExpiry: Date.now() - 1_000 });

    await renewLongLivedCredentials("visible");
    vi.advanceTimersByTime(120_000);
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);

    vi.advanceTimersByTime(200_000);
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(2);
  });

  it("starts over after a success", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
    await connectGoogle({ accessTokenExpiry: Date.now() - 1_000 });
    await renewLongLivedCredentials("visible");
    vi.advanceTimersByTime(31_000);
    net.reply("POST", GOOGLE_REFRESH, answer);
    await renewLongLivedCredentials("visible");
    expect(google().accessToken).toBe(SECRETS.accessFresh);

    await connectGoogle({ accessTokenExpiry: Date.now() - 1_000 });
    await renewLongLivedCredentials("visible");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(3);
  });
});

describe("when it runs", () => {
  it("runs at once when the connections were already loaded by the time it is installed", async () => {
    net.reply("POST", GOOGLE_REFRESH, answer);
    await connectGoogle();
    installProactiveCredentialRefresh();
    await vi.waitFor(() => expect(net.broker("/oauth/google/refresh")).toHaveLength(1));
  });

  it("runs once the connections have been loaded at start, or at once if they already are", async () => {
    net.reply("POST", GOOGLE_REFRESH, answer);
    useConnectionStore.setState({ hydrated: false, configuration: {} });
    installProactiveCredentialRefresh();
    expect(net.calls).toHaveLength(0);

    await connectGoogle();
    useConnectionStore.setState({ hydrated: true });
    await vi.waitFor(() => expect(net.broker("/oauth/google/refresh")).toHaveLength(1));
  });

  it("runs when the tab becomes visible again, not when it is hidden, and installing twice does not double it", async () => {
    net.reply("POST", GOOGLE_REFRESH, answer);
    await connectGoogle();
    useConnectionStore.setState({ hydrated: false });
    installProactiveCredentialRefresh();
    installProactiveCredentialRefresh();
    useConnectionStore.setState({ hydrated: true });
    await vi.waitFor(() => expect(net.broker("/oauth/google/refresh")).toHaveLength(1));

    await connectGoogle();
    net.reset();
    net.reply("POST", GOOGLE_REFRESH, answer);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(net.calls).toHaveLength(0);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(net.broker("/oauth/google/refresh")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
  });
});

describe("where it is installed", () => {
  it("starts with the other app-wide listeners, and leaves the start-up wiring of the connections as it was", () => {
    const route = readFileSync(resolve(process.cwd(), "src/routes/AppShellRoute.tsx"), "utf8");
    expect(route).toContain('import { installProactiveCredentialRefresh } from "@/account/proactiveCredentialRefresh";');
    expect(route).toMatch(/installAutomaticAccountSync\(\);\s*installProactiveCredentialRefresh\(\);/);
    const shell = readFileSync(resolve(process.cwd(), "src/components/layout/Shell.tsx"), "utf8");
    expect(shell).toContain("hydrateConnections().then(() => scheduleAccountSync(250))");
  });
});
