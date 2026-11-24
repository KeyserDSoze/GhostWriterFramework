import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListingError, LISTING_PAGE_SIZE, fetchListingPage, inspectRepository, listingSources, mapRepository, repositoryNameIsFree } from "@/github/repositoryListing";

// The reads of the repository picker against a fake `fetch` (nothing reaches GitHub, no token is real).

type Call = { url: string; auth: string | null };
let calls: Call[] = [];

function reply(handler: (url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url: `${url.pathname}${url.search}`, auth: new Headers(init?.headers).get("authorization") });
    const answer = handler(url);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers });
  }));
}

const raw = (owner: string, name: string, extra: Record<string, unknown> = {}) => ({ id: owner.length * 1000 + name.length, name, full_name: `${owner}/${name}`, owner: { login: owner }, private: true, permissions: { push: true }, pushed_at: "2026-11-20T10:00:00Z", description: null, default_branch: "main", archived: false, ...extra });
const many = (count: number, owner = "ada") => Array.from({ length: count }, (_, index) => raw(owner, `repo-${index}`, { id: index + 1 }));

beforeEach(() => { calls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("where the repositories are read from", () => {
  it("lists the user repositories of a token (owner, collaborator, organization member), the most recently pushed first", () => {
    expect(listingSources({ app: false, login: "ada", scope: "" })).toEqual([{ path: "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc" }]);
  });
  it("lists only the account's own, or one organization's, when an owner is chosen", () => {
    expect(listingSources({ app: false, login: "ada", scope: "ADA" })[0].path).toContain("affiliation=owner&");
    expect(listingSources({ app: false, login: "ada", scope: "acme" })[0].path).toBe("/orgs/acme/repos?type=all&sort=pushed&direction=desc");
  });
  it("lists, for the app, the repositories of each installation that is not suspended: the app reaches only those", () => {
    const installations = [{ id: 7, account: "ada" }, { id: 9, account: "acme" }, { id: 11, account: "old", suspended: true }];
    expect(listingSources({ app: true, login: "ada", scope: "", installations })).toEqual([{ path: "/user/installations/7/repositories", field: "repositories" }, { path: "/user/installations/9/repositories", field: "repositories" }]);
    expect(listingSources({ app: true, login: "ada", scope: "ACME", installations })).toEqual([{ path: "/user/installations/9/repositories", field: "repositories" }]);
    expect(listingSources({ app: true, login: "ada", scope: "", installations: [] })).toEqual([]);
  });
});

describe("a page at a time", () => {
  it("reads the first page only, with the size of a page, and says whether there is more", async () => {
    reply(() => ({ body: many(LISTING_PAGE_SIZE), headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } }));
    const page = await fetchListingPage("ghp_x", listingSources({ app: false, login: "ada", scope: "" }), null);
    expect(page.items).toHaveLength(LISTING_PAGE_SIZE);
    expect(page.cursor).toEqual({ source: 0, page: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`per_page=${LISTING_PAGE_SIZE}&page=1`);
    expect(calls[0].auth).toBe("Bearer ghp_x");
  });
  it("goes on from the cursor, and ends when there is no next page", async () => {
    reply(() => ({ body: many(3) }));
    const page = await fetchListingPage("ghp_x", [{ path: "/user/repos?x=1" }], { source: 0, page: 2 });
    expect(calls[0].url).toContain("page=2");
    expect(page.cursor).toBeNull();
  });
  it("maps what GitHub says: who may write, when it was last pushed, whether it is private or archived", async () => {
    reply(() => ({ body: [raw("ada", "book", { private: false, archived: true, permissions: { push: false }, description: "A book", default_branch: "trunk" }), raw("ada", "nopermission", { permissions: undefined }), { id: "bad" }] }));
    const page = await fetchListingPage("ghp_x", [{ path: "/user/repos" }], null);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ owner: "ada", name: "book", fullName: "ada/book", private: false, archived: true, canPush: false, description: "A book", defaultBranch: "trunk", pushedAt: "2026-11-20T10:00:00Z" });
    expect(page.items[1].canPush).toBeNull();
  });
  it("moves on to the next installation when the first has no more, without asking for a page that is not needed", async () => {
    reply((url) => ({ body: { total_count: 1, repositories: url.pathname.includes("/7/") ? [raw("ada", "one")] : [raw("acme", "two")] } }));
    const sources = listingSources({ app: true, login: "ada", scope: "", installations: [{ id: 7, account: "ada" }, { id: 9, account: "acme" }] });
    const first = await fetchListingPage("ghu_x", sources, null);
    expect(first.items.map((item) => item.fullName)).toEqual(["ada/one"]);
    expect(first.cursor).toEqual({ source: 1, page: 1 });
    const second = await fetchListingPage("ghu_x", sources, first.cursor);
    expect(second.items.map((item) => item.fullName)).toEqual(["acme/two"]);
    expect(second.cursor).toBeNull();
    expect(calls.map((call) => call.url.split("?")[0])).toEqual(["/user/installations/7/repositories", "/user/installations/9/repositories"]);
  });
  it("skips an empty source to the next that has something", async () => {
    reply((url) => ({ body: { repositories: url.pathname.includes("/7/") ? [] : [raw("acme", "two")] } }));
    const sources = listingSources({ app: true, login: "ada", scope: "", installations: [{ id: 7, account: "ada" }, { id: 9, account: "acme" }] });
    const page = await fetchListingPage("ghu_x", sources, null);
    expect(page.items.map((item) => item.fullName)).toEqual(["acme/two"]);
  });
  it("reads nothing when there is nowhere to read from", async () => {
    reply(() => ({}));
    expect(await fetchListingPage("ghu_x", [], null)).toEqual({ items: [], cursor: null });
    expect(calls).toEqual([]);
  });
  it("tells a repository from a record that has no id or no owner", () => {
    expect(mapRepository({ id: 1, name: "x" })).toBeNull();
    expect(mapRepository({ name: "x", owner: { login: "a" } })).toBeNull();
  });
});

describe("what goes wrong", () => {
  const failure = async (answer: { status: number; body?: unknown; headers?: Record<string, string> }) => {
    reply(() => answer);
    return fetchListingPage("ghp_x", [{ path: "/user/repos" }], null).catch((error) => error as ListingError);
  };
  it("says the credential must be reconnected on 401", async () => {
    expect(await failure({ status: 401, body: { message: "Bad credentials" } })).toMatchObject({ reason: "reconnect", status: 401 });
  });
  it("says GitHub's limit was reached, with the time it ends, on 403 with no requests left or on 429 or on a secondary limit", async () => {
    expect(await failure({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } })).toMatchObject({ reason: "rate-limit", resetAt: "2030-01-01T00:00:00.000Z" });
    expect(await failure({ status: 429, headers: { "retry-after": "30" } })).toMatchObject({ reason: "rate-limit" });
    expect(await failure({ status: 403, body: { message: "You have exceeded a secondary rate limit." } })).toMatchObject({ reason: "rate-limit" });
  });
  it("says an organization asks for single sign-on, and a token that may not list, and the network, and the rest", async () => {
    expect(await failure({ status: 403, body: { message: "Resource protected by organization SAML enforcement" }, headers: { "x-github-sso": "required" } })).toMatchObject({ reason: "sso" });
    expect(await failure({ status: 403, body: { message: "Resource not accessible by personal access token" } })).toMatchObject({ reason: "forbidden" });
    expect(await failure({ status: 500 })).toMatchObject({ reason: "unknown", status: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await fetchListingPage("ghp_x", [{ path: "/user/repos" }], null).catch((error) => error)).toMatchObject({ reason: "network" });
  });
  it("lets an abort through as an abort, not as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }));
    await expect(fetchListingPage("ghp_x", [{ path: "/user/repos" }], null)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("what a repository holds", () => {
  const target = { owner: "ada", repo: "book", defaultBranch: "main" };
  it("is a book when book.md is at its root", async () => {
    reply((url) => (url.pathname.endsWith("/contents/book.md") ? { body: { name: "book.md" } } : { status: 500 }));
    expect(await inspectRepository("ghp_x", target)).toBe("book");
    expect(calls).toHaveLength(1);
  });
  it("is empty when there is no book.md and no branch", async () => {
    reply((url) => (url.pathname.endsWith("/contents/book.md") ? { status: 404, body: { message: "This repository is empty." } } : { status: 409, body: { message: "Git Repository is empty." } }));
    expect(await inspectRepository("ghp_x", target)).toBe("empty");
  });
  it("is something else when it has a branch but no book.md", async () => {
    reply((url) => (url.pathname.endsWith("/contents/book.md") ? { status: 404 } : { body: { object: { sha: "a" } } }));
    expect(await inspectRepository("ghp_x", target)).toBe("other");
    expect(calls[1].url).toBe("/repos/ada/book/git/ref/heads/main");
  });
  it("passes a refusal on instead of guessing", async () => {
    reply(() => ({ status: 403, body: { message: "Resource not accessible" } }));
    await expect(inspectRepository("ghp_x", target)).rejects.toMatchObject({ reason: "forbidden" });
  });
});

describe("whether a name is free", () => {
  it("is free when GitHub answers 404, taken when it answers with the repository", async () => {
    reply(() => ({ status: 404 }));
    expect(await repositoryNameIsFree("ghp_x", "ada", "grande-libro")).toBe(true);
    reply(() => ({ body: { id: 1 } }));
    expect(await repositoryNameIsFree("ghp_x", "ada", "grande-libro")).toBe(false);
    expect(calls[0].url).toBe("/repos/ada/grande-libro");
  });
});
