import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeGitServer } from "./helpers/fakeGitServer";

const github = vi.hoisted(() => ({ server: null as FakeGitServer | null }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    get rest() { return github.server!.rest; }
    request = (route: string, params: Record<string, unknown>) => github.server!.request(route, params as never);
  },
}));

import { createFakeGitServer } from "./helpers/fakeGitServer";
import { cachedRemoteBranches, listRemoteBranches, rememberRemoteHead } from "@/branches/remoteBranches";

const input = { token: "ghp_list", owner: "writer", repo: "novel", accountIdentity: "workspace:lister" };

beforeEach(() => { localStorage.clear(); github.server = createFakeGitServer(); });
afterEach(() => vi.restoreAllMocks());

describe("the list of the branches of GitHub", () => {
  it("is asked with a condition the first time too, so the browser never answers it from its cache, and gives every head and what is left of the hour", async () => {
    const server = github.server!;
    server.createBranch("draft");
    const listing = await listRemoteBranches(input);
    expect([...listing.heads.keys()]).toEqual(["draft", "main"]);
    expect(listing).toMatchObject({ complete: true, unchanged: false, rate: { remaining: server.rate.remaining, resetAt: server.rate.reset * 1000 } });
    expect(server.calls[0].params.headers).toEqual({ "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" });
  });

  it("costs nothing of the hour when nothing changed (304), and is asked in full again once a branch moved", async () => {
    const server = github.server!;
    await listRemoteBranches(input);
    const remaining = server.rate.remaining;
    const again = await listRemoteBranches(input);
    expect(again).toMatchObject({ unchanged: true, complete: true });
    expect(server.rate.remaining).toBe(remaining);
    const moved = server.commitOn("main", { "book.md": "changed" });
    const after = await listRemoteBranches(input);
    expect(after.unchanged).toBe(false);
    expect(after.heads.get("main")).toBe(moved);
  });

  it("reads every page of a long list, each with its own ETag, and says when it is cut short", async () => {
    const server = github.server!;
    for (let index = 0; index < 150; index += 1) server.createBranch(`b${String(index).padStart(3, "0")}`);
    const listing = await listRemoteBranches(input);
    expect(listing.heads.size).toBe(151);
    expect(server.calls.map((call) => call.params.page)).toEqual([1, 2]);
    server.reset();
    expect((await listRemoteBranches(input)).unchanged).toBe(true);
    expect(server.calls.map((call) => (call.params.headers as Record<string, string>)["if-none-match"])).toEqual([expect.stringMatching(/^W\//), expect.stringMatching(/^W\//)]);
    for (let index = 150; index < 1100; index += 1) server.createBranch(`c${String(index).padStart(4, "0")}`);
    const long = await listRemoteBranches(input);
    expect(long.complete).toBe(false);
    expect(long.heads.size).toBe(1000);
  });

  it("is kept on this device, per account, for the switcher to show at once; what was just published is in it until GitHub is asked again", async () => {
    const server = github.server!;
    await listRemoteBranches(input);
    expect([...cachedRemoteBranches(input.accountIdentity, "writer", "novel")!.heads.keys()]).toEqual(["main"]);
    expect(cachedRemoteBranches("workspace:someone-else", "writer", "novel")).toBeNull();
    rememberRemoteHead(input.accountIdentity, "writer", "novel", "draft/new", "sha-new");
    expect(cachedRemoteBranches(input.accountIdentity, "writer", "novel")!.heads.get("draft/new")).toBe("sha-new");
    // The page that changed is asked in full next time, and GitHub's answer replaces the guess.
    server.reset();
    const listing = await listRemoteBranches(input);
    expect(server.calls[0].params.headers).toEqual({ "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" });
    expect(listing.heads.has("draft/new")).toBe(false);
  });

  it("fails as a repository error GitHub's answer says", async () => {
    vi.spyOn(github.server!, "request").mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401, response: { status: 401, headers: {} } }));
    await expect(listRemoteBranches(input)).rejects.toMatchObject({ kind: "credential-invalid" });
  });
});
