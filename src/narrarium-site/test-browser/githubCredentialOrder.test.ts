import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGitHubCredentialValue, setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { bookCredentialLines, bookUsingConnection, canOfferConnection, defaultTokenRemovable, githubSignInAvailable } from "@/github/githubAccessModel";
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

describe("moving a book to the GitHub connection", () => {
  const install = (selection: "all" | "selected", repositories: string[] = [], suspended = false) => [{ id: 1, account: "me", accountType: "User" as const, selection, repositories, suspended, settingsUrl: "https://github.com/settings/installations/1" }];
  const lines = (books: BookEntry[], patch: Partial<AppSettings>, installations: ReturnType<typeof install> | null) => bookCredentialLines(books, settings(patch, books), installations, "me");
  beforeEach(() => setConnectedGitHubToken("ghu_app", "app"));

  it("a book on the default token, an own token or a named token is offered the connection when the installation covers its repository", () => {
    const books = [book(), book({ id: "b2", repo: "two", bookToken: "ghp_own" }), book({ id: "b3", repo: "three", tokenIndex: 0 })];
    const all = lines(books, { defaultGitHubToken: "ghp_default", extraGitHubTokens: [{ label: "work", token: "ghp_named" }] }, install("all"));
    expect(all.map((line) => [line.source, line.appReach, canOfferConnection(line)])).toEqual([["default-pat", "all", true], ["book-pat", "all", true], ["named-pat", "all", true]]);
    const some = lines(books, { defaultGitHubToken: "ghp_default", extraGitHubTokens: [{ label: "work", token: "ghp_named" }] }, install("selected", ["me/one", "me/three"]));
    expect(some.map((line) => [line.appReach, canOfferConnection(line)])).toEqual([["selected", true], ["outside-selection", false], ["selected", true]]);
  });

  it("is not offered when the app does not reach the repository, is suspended, or the installations are not known yet", () => {
    const books = [book({ repo: "one" }), book({ id: "b2", owner: "acme", repo: "two" })];
    const base = { defaultGitHubToken: "ghp_default" };
    expect(lines(books, base, install("all", [], true)).map(canOfferConnection)).toEqual([false, false]);
    expect(lines(books, base, install("all")).map(canOfferConnection)).toEqual([true, false]);
    expect(lines(books, base, null).map(canOfferConnection)).toEqual([false, false]);
  });

  it("is not offered to a book that already uses the connection, nor to one run by the personal server", () => {
    const books = [book({ useGitHubConnection: true }), book({ id: "b2", repo: "two", autopilotHost: "server" }), book({ id: "b3", repo: "three" })];
    const result = lines(books, { defaultGitHubToken: "ghp_default" }, install("all"));
    expect(result.map((line) => line.source)).toEqual(["app", "default-pat", "default-pat"]);
    expect(result.map(canOfferConnection)).toEqual([false, false, true]);
  });

  it("makes the book use the connection: no own token, no named token, the default token is not followed; the named token stays in the list", () => {
    const own = book({ bookToken: "ghp_own", bookTokenLabel: "one PAT", tokenIndex: 0 });
    const moved = bookUsingConnection(own);
    expect(moved).toMatchObject({ id: "b1", owner: "me", repo: "one", tokenIndex: null, useGitHubConnection: true });
    expect("bookToken" in moved).toBe(false);
    expect("bookTokenLabel" in moved).toBe(false);
    const withDefault = { defaultGitHubToken: "ghp_default", extraGitHubTokens: [{ label: "work", token: "ghp_named" }] };
    expect(resolveGitHubCredential(moved, settings(withDefault, [moved]))).toEqual({ token: "ghu_app", source: "app" });
    expect(resolveGitHubCredential(bookUsingConnection(book()), settings(withDefault))).toEqual({ token: "ghu_app", source: "app" });
    expect(settings(withDefault).extraGitHubTokens).toHaveLength(1);
  });

  it("the move is for that book only, and never outranks a token typed for the book afterwards", () => {
    const moved = bookUsingConnection(book());
    const other = book({ id: "b2", repo: "two" });
    const config = settings({ defaultGitHubToken: "ghp_default" }, [moved, other]);
    expect(resolveGitHubCredential(moved, config)?.source).toBe("app");
    expect(resolveGitHubCredential(other, config)?.source).toBe("default-pat");
    expect(resolveGitHubCredential({ ...moved, bookToken: "ghp_typed" }, config)?.source).toBe("book-pat");
  });

  it("falls back to the default token when the connection is gone", () => {
    setConnectedGitHubToken(undefined);
    expect(resolveGitHubCredential(bookUsingConnection(book()), settings({ defaultGitHubToken: "ghp_default" }))?.source).toBe("default-pat");
  });

  it("survives the settings being loaded again", () => {
    const migrated = migrateSettings({ ...DEFAULT_SETTINGS, books: [bookUsingConnection(book())] });
    expect(migrated.books[0].useGitHubConnection).toBe(true);
  });
});

describe("when the default token can be removed", () => {
  const installations = [{ id: 1, account: "me", accountType: "User" as const, selection: "all" as const, repositories: [], suspended: false, settingsUrl: "https://github.com/settings/installations/1" }];
  const check = (books: BookEntry[], patch: Partial<AppSettings>, known = installations) => {
    const config = settings({ defaultGitHubToken: "ghp_default", ...patch }, books);
    return defaultTokenRemovable(bookCredentialLines(books, config, known, "me"), config);
  };
  beforeEach(() => setConnectedGitHubToken("ghu_app", "app"));

  it("is suggested when every book uses the connection, and not before", () => {
    expect(check([bookUsingConnection(book()), bookUsingConnection(book({ id: "b2", repo: "two" }))], {})).toBe(true);
    expect(check([bookUsingConnection(book()), book({ id: "b2", repo: "two" })], {})).toBe(false);
  });

  it("is not suggested without a default token, without any book on the connection, or while the app does not reach a book on it", () => {
    expect(check([bookUsingConnection(book())], { defaultGitHubToken: "  " })).toBe(false);
    expect(check([], {})).toBe(false);
    expect(check([book({ bookToken: "ghp_own" })], {})).toBe(false);
    expect(check([bookUsingConnection(book()), bookUsingConnection(book({ id: "b2", owner: "acme", repo: "two" }))], {})).toBe(false);
    expect(check([bookUsingConnection(book())], {}, null as never)).toBe(false);
  });

  it("is suggested when the other books keep their own or a named token, which do not need the default one", () => {
    expect(check([bookUsingConnection(book()), book({ id: "b2", repo: "two", bookToken: "ghp_own" }), book({ id: "b3", repo: "three", tokenIndex: 0 })], { extraGitHubTokens: [{ label: "work", token: "ghp_named" }] })).toBe(true);
  });
});
