import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGitHubCredentialValue, setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { bookCredentialLines, githubSignInAvailable } from "@/github/githubAccessModel";
import { resolveGitHubCredential, resolveGitHubRemoteToken, DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";
import { migrateSettings } from "@/drive/cloudSettingsClient";

const book = (patch: Partial<BookEntry> = {}): BookEntry => ({ id: "b1", owner: "me", repo: "one", name: "One", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", ...patch });
const settings = (patch: Partial<AppSettings> = {}, books: BookEntry[] = [book()]): AppSettings => ({ ...DEFAULT_SETTINGS, books, ...patch });

beforeEach(() => setConnectedGitHubToken(undefined));
afterEach(() => setConnectedGitHubToken(undefined));

describe("which token a book uses", () => {
  it("the order is the book's own token, its named token, the default token, then the GitHub connection", () => {
    setConnectedGitHubToken("ghu_app", "app");
    const base = { extraTokens: [{ token: "ghp_named" }], defaultToken: "ghp_default" };
    expect(resolveGitHubCredentialValue({ ...base, bookToken: "ghp_book", tokenIndex: 0 })).toEqual({ token: "ghp_book", source: "book-pat" });
    expect(resolveGitHubCredentialValue({ ...base, tokenIndex: 0 })).toEqual({ token: "ghp_named", source: "named-pat" });
    expect(resolveGitHubCredentialValue({ ...base, tokenIndex: null })).toEqual({ token: "ghp_default", source: "default-pat" });
    expect(resolveGitHubCredentialValue({ ...base, defaultToken: "", tokenIndex: null })).toEqual({ token: "ghu_app", source: "app" });
    setConnectedGitHubToken(undefined);
    expect(resolveGitHubCredentialValue({ ...base, defaultToken: "", tokenIndex: null })).toBeNull();
  });

  it("a saved personal token still shadows the connected one, as it always did (today's behaviour is the default)", () => {
    setConnectedGitHubToken("ghu_app", "app");
    expect(resolveGitHubCredential(book(), settings({ defaultGitHubToken: "ghp_default" }))).toEqual({ token: "ghp_default", source: "default-pat" });
    expect(resolveGitHubRemoteToken(book(), settings({ defaultGitHubToken: "ghp_default" }))).toBe("ghp_default");
  });

  it("«Prefer the GitHub connection» puts the connection ahead of the DEFAULT token only", () => {
    setConnectedGitHubToken("ghu_app", "app");
    const prefer = { githubPreferConnection: true, defaultGitHubToken: "ghp_default", extraGitHubTokens: [{ label: "work", token: "ghp_named" }] };
    expect(resolveGitHubCredential(book(), settings(prefer))).toEqual({ token: "ghu_app", source: "app" });
    expect(resolveGitHubCredential(book({ tokenIndex: 0 }), settings(prefer))).toEqual({ token: "ghp_named", source: "named-pat" });
    expect(resolveGitHubCredential(book({ bookToken: "ghp_own" }), settings(prefer))).toEqual({ token: "ghp_own", source: "book-pat" });
  });

  it("the preference changes nothing without a connection, and falls back to the default token", () => {
    expect(resolveGitHubCredential(book(), settings({ githubPreferConnection: true, defaultGitHubToken: "ghp_default" }))).toEqual({ token: "ghp_default", source: "default-pat" });
  });

  it("a connection made with a personal access token is the connected-pat source", () => {
    setConnectedGitHubToken("ghp_conn", "connected-pat");
    expect(resolveGitHubCredential(book(), settings())).toEqual({ token: "ghp_conn", source: "connected-pat" });
  });

  it("the preference survives the settings migration (it is synced) and is dropped when it is not a flag", () => {
    expect(migrateSettings({ ...DEFAULT_SETTINGS, githubPreferConnection: true }).githubPreferConnection).toBe(true);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, githubPreferConnection: "yes" }).githubPreferConnection).toBeUndefined();
  });
});

describe("what the page says about each book", () => {
  it("lists the books on GitHub with the token each uses, and leaves local books out", () => {
    setConnectedGitHubToken("ghu_app", "app");
    const books = [book(), book({ id: "b2", repo: "two", name: "Two", bookToken: "ghp_own" }), book({ id: "b3", storageMode: "local-only", repo: "" })];
    const lines = bookCredentialLines(books, settings({}, books), null);
    expect(lines.map((line) => [line.name, line.source])).toEqual([["One", "app"], ["Two", "book-pat"]]);
  });

  it("marks a server-run book on the app token, and no other", () => {
    setConnectedGitHubToken("ghu_app", "app");
    const books = [book({ autopilotHost: "server" }), book({ id: "b2", repo: "two", autopilotHost: "server", bookToken: "ghp_own" }), book({ id: "b3", repo: "three" })];
    const lines = bookCredentialLines(books, settings({}, books), null);
    expect(lines.map((line) => line.serverWithAppToken)).toEqual([true, false, false]);
  });

  it("says whether the app reaches the repository only for a book that uses the app token", () => {
    setConnectedGitHubToken("ghu_app", "app");
    const installations = [{ id: 1, account: "me", accountType: "User" as const, selection: "selected" as const, repositories: ["me/one"], suspended: false, settingsUrl: "https://github.com/settings/installations/1" }];
    const books = [book(), book({ id: "b2", repo: "two" }), book({ id: "b3", repo: "three", bookToken: "ghp_own" })];
    const lines = bookCredentialLines(books, settings({}, books), installations, "me");
    expect(lines.map((line) => line.reach)).toEqual(["selected", "outside-selection", null]);
    expect(lines.every((line) => line.ownAccount)).toBe(true);
  });

  it("offers «Connect with GitHub» only when the broker says yes AND the build has the app's client id", () => {
    expect(githubSignInAvailable(true, "Iv1.x")).toBe(true);
    expect(githubSignInAvailable(true, "")).toBe(false);
    expect(githubSignInAvailable(false, "Iv1.x")).toBe(false);
    expect(githubSignInAvailable(null, "Iv1.x")).toBeNull();
    expect(githubSignInAvailable(null, "")).toBe(false);
  });
});
