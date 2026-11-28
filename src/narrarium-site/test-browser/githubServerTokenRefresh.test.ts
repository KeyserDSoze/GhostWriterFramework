import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autopilotRuntime } from "@/autopilot/runtime";
import { useAutopilotStore } from "@/autopilot/store";
import { setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const book = (patch: Partial<BookEntry> = {}): BookEntry => ({ id: "b1", owner: "me", repo: "one", name: "One", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", autopilotHost: "server", ...patch });
const registerBook = vi.fn(async (_id: string, _body: Record<string, unknown>) => ({}));

function arrange(books: BookEntry[], summaries: Record<string, boolean>, settings: Record<string, unknown> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books, personalServer: { url: "http://127.0.0.1:8787", token: "client-token" } as never, ...settings } });
  for (const [id, hasGithubToken] of Object.entries(summaries)) useAutopilotStore.getState().patchView(id, { server: { hasGithubToken } as never });
  vi.spyOn(autopilotRuntime as unknown as { requireServer: () => Promise<unknown> }, "requireServer").mockResolvedValue({ client: { registerBook } });
}

beforeEach(() => { registerBook.mockClear(); setConnectedGitHubToken("ghu_app", "app"); });
afterEach(() => { setConnectedGitHubToken(undefined); useSettingsStore.setState({ settings: DEFAULT_SETTINGS }); useAutopilotStore.setState({ views: {} }); vi.restoreAllMocks(); });

describe("the server's copy of a book's GitHub token follows the app's renewals", () => {
  it("re-sends the fresh token for a server-run GitHub book on the app token, to a server that already holds a token for it, and nothing else", async () => {
    arrange([book()], { b1: true });
    await autopilotRuntime.refreshServerGitHubToken("ghu_fresh");
    expect(registerBook).toHaveBeenCalledTimes(1);
    expect(registerBook.mock.calls[0][0]).toBe("b1");
    expect(registerBook.mock.calls[0][1]).toMatchObject({ title: "One", storage: { kind: "github", owner: "me", repo: "one" }, githubToken: "ghu_fresh" });
    expect(Object.keys(registerBook.mock.calls[0][1]).sort()).toEqual(["githubToken", "storage", "title"]);
  });

  it("never sends the refresh token: the only secret in the body is the access token it was given", async () => {
    arrange([book()], { b1: true });
    await autopilotRuntime.refreshServerGitHubToken("ghu_fresh");
    expect(JSON.stringify(registerBook.mock.calls)).not.toMatch(/refresh/i);
  });

  it("leaves alone a book the server holds no token for (no consent was given), a book in the browser, a PAT book and a local book", async () => {
    arrange([book(), book({ id: "b2", repo: "two", autopilotHost: "browser" }), book({ id: "b3", repo: "three", bookToken: "ghp_own" }), book({ id: "b4", repo: "", storageMode: "local-only" })], { b1: false, b2: true, b3: true, b4: true });
    await autopilotRuntime.refreshServerGitHubToken("ghu_fresh");
    expect(registerBook).not.toHaveBeenCalled();
  });

  it("leaves alone a book that the server runs on its own GitHub connection: it holds no copy of a token, so there is nothing to keep fresh and nothing to send", async () => {
    arrange([book(), book({ id: "b2", repo: "two" })], { b1: true, b2: true });
    useAutopilotStore.getState().patchView("b1", { server: { hasGithubToken: false, githubAuth: "connection" } as never });
    // A server that says both (it should not) is still not sent a token for a book that is on the connection.
    useAutopilotStore.getState().patchView("b2", { server: { hasGithubToken: true, githubAuth: "connection" } as never });
    await autopilotRuntime.refreshServerGitHubToken("ghu_fresh");
    expect(registerBook).not.toHaveBeenCalled();
  });

  it("still keeps fresh the copy of a book that the server holds a token for", async () => {
    arrange([book()], { b1: true });
    useAutopilotStore.getState().patchView("b1", { server: { hasGithubToken: true, githubAuth: "token" } as never });
    await autopilotRuntime.refreshServerGitHubToken("ghu_fresh");
    expect(registerBook).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a personal server, without a token, or when the connection is not the app's", async () => {
    arrange([book()], { b1: true });
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, personalServer: undefined } });
    await autopilotRuntime.refreshServerGitHubToken("ghu_fresh");
    expect(registerBook).not.toHaveBeenCalled();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, personalServer: { url: "http://127.0.0.1:8787", token: "t" } as never } });
    await autopilotRuntime.refreshServerGitHubToken("");
    setConnectedGitHubToken("ghp_conn", "connected-pat");
    await autopilotRuntime.refreshServerGitHubToken("ghu_fresh");
    expect(registerBook).not.toHaveBeenCalled();
  });

  it("a server that cannot be reached never fails the renewal, and the other books are still tried", async () => {
    arrange([book(), book({ id: "b2", repo: "two" })], { b1: true, b2: true });
    registerBook.mockRejectedValueOnce(new Error("offline"));
    await expect(autopilotRuntime.refreshServerGitHubToken("ghu_fresh")).resolves.toBeUndefined();
    expect(registerBook).toHaveBeenCalledTimes(2);
  });
});

describe("a renewal of the app's token reaches the server's copy", () => {
  it("through the broker's rotation: only when a book is run by the server, and the runtime is loaded only then", async () => {
    vi.resetModules();
    const { useConnectionStore } = await import("@/account/connectionStore");
    const { acquireGitHubAppToken, resetGitHubAppTokenForTests } = await import("@/account/githubAppToken");
    const { useSettingsStore: settingsStore } = await import("@/store/settingsStore");
    const { autopilotRuntime: runtime } = await import("@/autopilot/runtime");
    const spy = vi.spyOn(runtime, "refreshServerGitHubToken").mockResolvedValue(undefined);
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "http://127.0.0.1:8787");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: "ghu_renewed", expiresIn: 28_800, refreshToken: "ghr_rotated" }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const connect = () => useConnectionStore.getState().connectGitHub({ method: "github-app", credentialKind: "app", identity: { provider: "github", providerAccountId: "4242", displayName: "W", username: "w" }, token: "ghu_old", accessTokenExpiry: Date.now() - 1_000, refreshToken: "ghr_old", rememberMe: false, accountSyncEnabled: false, repositoryOwner: "w" });
    useConnectionStore.setState({ hydrated: true, configuration: {} });
    settingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book({ autopilotHost: "browser" })] } });
    await connect();
    await acquireGitHubAppToken();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).not.toHaveBeenCalled();
    settingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book()] } });
    useConnectionStore.setState({ configuration: { github: { ...useConnectionStore.getState().configuration.github!, accessTokenExpiry: Date.now() - 1_000 } } });
    await acquireGitHubAppToken();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("ghu_renewed"));
    resetGitHubAppTokenForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
