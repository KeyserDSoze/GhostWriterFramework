import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/publicClients", () => ({ GITHUB_APP_CLIENT_ID: "Iv1.client-id", GITHUB_APP_SLUG: "narrarium" }));

import { consumeGitHubAuthorization, createGitHubAppAuthorizationUrl } from "@/github/githubOAuth";

// Updated on purpose: the browser-only OAuth flow (a client secret decoded from the bundle, sent to github.com, scopes `repo ...`) is gone. What is kept is
// the PKCE attempt; the exchange is the broker's, tested in githubBrokerConnect.test.ts.
describe("the authorization request of the GitHub App", () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

  it("is an expiring PKCE request for the app, with no scope and no secret", async () => {
    const url = new URL(await createGitHubAppAuthorizationUrl({ rememberMe: true, returnTo: "/app/books", now: 1_000 }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/auth\/github\/callback$/);
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "state"]);
    expect(url.href).not.toMatch(/secret/i);
  });

  it("keeps the verifier and the redirect address only in this tab, and gives them back once for the right state", async () => {
    const url = new URL(await createGitHubAppAuthorizationUrl({ rememberMe: false, returnTo: "/app/books", now: 1_000 }));
    const state = url.searchParams.get("state")!;
    expect(localStorage.length).toBe(0);
    const authorization = consumeGitHubAuthorization(state, 2_000);
    expect(authorization).toMatchObject({ rememberMe: false, returnTo: "/app/books", redirectUri: url.searchParams.get("redirect_uri") });
    expect(authorization.codeVerifier).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(() => consumeGitHubAuthorization(state, 2_000)).toThrow(/invalid|already used/);
  });

  it("refuses an expired, a wrong or an empty state, and a return address outside the app", async () => {
    const make = async () => new URL(await createGitHubAppAuthorizationUrl({ rememberMe: false, returnTo: "//evil.example", now: 1_000 })).searchParams.get("state")!;
    expect(() => consumeGitHubAuthorization("", 2_000)).toThrow();
    const state = await make();
    expect(() => consumeGitHubAuthorization(`${state}x`, 2_000)).toThrow(/state/);
    const again = await make();
    expect(() => consumeGitHubAuthorization(again, 1_000 + 10 * 60_000)).toThrow(/expired|invalid/);
    const last = await make();
    expect(consumeGitHubAuthorization(last, 2_000).returnTo).toBe("/app/account-sync");
  });

  it("makes no request at all: the page leaves for GitHub, and the code is swapped by the broker", async () => {
    const fetchMock = vi.spyOn(window, "fetch");
    await createGitHubAppAuthorizationUrl({ rememberMe: true, now: 1_000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
