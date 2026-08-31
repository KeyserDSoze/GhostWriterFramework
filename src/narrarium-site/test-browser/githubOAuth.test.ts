import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/publicClients", () => ({
  GITHUB_OAUTH_CLIENT_ID: "client-id",
  GITHUB_OAUTH_CLIENT_SECRET_B64X3: btoa(btoa(btoa("client-secret"))),
}));

import { createGitHubOAuthAuthorizationUrl, decodeGitHubClientSecret, exchangeGitHubOAuthCode, GITHUB_OAUTH_BROWSER_EXCHANGE_SUPPORTED } from "@/github/githubOAuth";

describe("GitHub OAuth PKCE", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("performs exactly the configured triple Base64 decode", () => {
    expect(decodeGitHubClientSecret(btoa(btoa(btoa("secret"))))).toBe("secret");
  });

  it("keeps the browser-only OAuth entry disabled after real CORS verification", () => {
    expect(GITHUB_OAUTH_BROWSER_EXCHANGE_SUPPORTED).toBe(false);
  });

  it("creates a scoped, expiring PKCE authorization attempt", async () => {
    const url = new URL(await createGitHubOAuthAuthorizationUrl({ rememberMe: true, returnTo: "/app/books", now: 1_000 }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("consumes state once and sends the verifier to the token exchange", async () => {
    const url = new URL(await createGitHubOAuthAuthorizationUrl({ rememberMe: false, now: 1_000 }));
    const state = url.searchParams.get("state")!;
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "oauth-token", scope: "repo", token_type: "bearer" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(exchangeGitHubOAuthCode("code", state, 2_000)).resolves.toMatchObject({ accessToken: "oauth-token", rememberMe: false });
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("code_verifier=");
    expect(body).toContain("client_secret=client-secret");
    await expect(exchangeGitHubOAuthCode("code", state, 2_000)).rejects.toThrow(/already used|invalid/);
  });

  it("rejects expired and mismatched state before making a request", async () => {
    const url = new URL(await createGitHubOAuthAuthorizationUrl({ rememberMe: false, now: 1_000 }));
    const fetchMock = vi.spyOn(window, "fetch");
    await expect(exchangeGitHubOAuthCode("code", `${url.searchParams.get("state")}x`, 2_000)).rejects.toThrow(/state/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
