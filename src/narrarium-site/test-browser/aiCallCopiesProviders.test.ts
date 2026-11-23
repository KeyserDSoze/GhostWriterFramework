import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const barrier = vi.hoisted(() => ({ registered: [] as string[], leases: 0, released: 0 }));
vi.mock("@/drive/cloudWriteBarrier", () => ({
  registerCloudAccount: (provider: string, _token: string, identity: string) => { barrier.registered.push(`${provider}:${identity}`); },
  beginCloudWrite: async () => { barrier.leases += 1; return async () => { barrier.released += 1; }; },
  fencedCloudMutation: (_provider: string, _token: string, input: RequestInfo | URL, init: RequestInit) => fetch(input, init),
}));
const msFolder = vi.hoisted(() => ({ ensured: [] as string[] }));
vi.mock("@/drive/jsonFile", () => ({ ensureMsFolder: async (token: string) => { msFolder.ensured.push(token); } }));
const octokit = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]>, fail: new Map<string, unknown>() }));
vi.mock("@/github/githubClient", () => {
  const call = (name: string, result: unknown) => async (input: unknown) => {
    octokit.calls.push([name, input]);
    const failure = octokit.fail.get(name);
    if (failure) throw failure;
    return result;
  };
  return {
    createGitHubClient: () => ({
      rest: {
        repos: { get: call("repos.get", { data: { private: true } }) },
        git: {
          getRef: call("git.getRef", { data: { object: { sha: "c1" } } }),
          getCommit: call("git.getCommit", { data: { tree: { sha: "t1" } } }),
          createBlob: call("git.createBlob", { data: { sha: "b1" } }),
          createTree: call("git.createTree", { data: { sha: "t2" } }),
          createCommit: call("git.createCommit", { data: { sha: "c2" } }),
          createRef: call("git.createRef", { data: {} }),
          updateRef: call("git.updateRef", { data: {} }),
          deleteRef: call("git.deleteRef", { data: {} }),
        },
      },
    }),
  };
});

import { GoogleDriveFetchApi } from "@/autopilot/calls/copies/targets/googleFetch";
import { GraphFetchApi } from "@/autopilot/calls/copies/targets/graphFetch";
import { OctokitGitHubApi } from "@/autopilot/calls/copies/targets/githubOctokit";
import { classifyCopyFailure, CopyHttpError } from "@/autopilot/calls/copies/classify";
import { CopyError } from "@/autopilot/calls/copies/types";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
let handlers: Handler[] = [];
let requests: Array<{ method: string; url: URL; init: RequestInit }> = [];

beforeEach(() => {
  handlers = [];
  requests = [];
  barrier.registered.length = 0;
  barrier.leases = 0;
  barrier.released = 0;
  msFolder.ensured.length = 0;
  octokit.calls.length = 0;
  octokit.fail.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ method: init.method ?? "GET", url, init });
    for (const handler of handlers) { const answer = await handler(url, init); if (answer) return answer; }
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const last = <T,>(items: T[], from = 1): T => items[items.length - from];
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });

describe("Google Drive over fetch", () => {
  it("makes the folders in the hidden app-data folder, under the account's write lease, with the connection's token", async () => {
    let created = 0;
    handlers.push((url, init) => {
      if (url.pathname === "/drive/v3/files" && (init.method ?? "GET") === "GET") return json({ files: [] });
      if (url.pathname === "/drive/v3/files" && init.method === "POST") { created += 1; return json({ id: `f${created}` }); }
      return undefined;
    });
    const api = new GoogleDriveFetchApi("tok", "g-1");
    expect(barrier.registered).toEqual(["google:g-1"]);
    const id = await api.session(() => api.ensureFolder(["ai-calls", "book-1"]));
    expect(id).toBe("f2");
    expect(barrier.leases).toBe(1);
    expect(barrier.released).toBe(1);
    const lookups = requests.filter((request) => request.method === "GET");
    expect(lookups[0].url.searchParams.get("spaces")).toBe("appDataFolder");
    expect(lookups[0].url.searchParams.get("q")).toContain("'appDataFolder' in parents");
    const posts = requests.filter((request) => request.method === "POST");
    expect(JSON.parse(String(posts[0].init.body))).toMatchObject({ name: "ai-calls", mimeType: "application/vnd.google-apps.folder", parents: ["appDataFolder"] });
    expect(JSON.parse(String(posts[1].init.body))).toMatchObject({ name: "book-1", parents: ["f1"] });
    expect((posts[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("finds a folder that exists and uploads a small file as multipart, a large one as a resumable upload", async () => {
    handlers.push((url, init) => {
      if (url.pathname === "/drive/v3/files" && !init.method) return json({ files: [{ id: "existing" }] });
      if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "multipart") return json({ id: "new" });
      if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") return new Response("", { status: 200, headers: { location: "https://upload.example/session-1" } });
      if (url.host === "upload.example") return json({ id: "big" });
      return undefined;
    });
    const api = new GoogleDriveFetchApi("tok", "g-1");
    expect(await api.findFolder(["ai-calls"])).toBe("existing");
    expect(await api.fileExists("existing", "a.ndjson.gz")).toBe(true);
    await api.upload("existing", "a.ndjson.gz", new Uint8Array(10));
    expect(last(requests, 1).url.searchParams.get("uploadType")).toBe("multipart");
    expect(last(requests, 1).init.body).toBeInstanceOf(FormData);
    await api.upload("existing", "b.ndjson.gz", new Uint8Array(5 * 1024 * 1024));
    expect(last(requests, 2).url.searchParams.get("uploadType")).toBe("resumable");
    expect(last(requests)).toMatchObject({ method: "PUT" });
    expect(last(requests, 1).url.href).toBe("https://upload.example/session-1");
  });

  it("deletes a folder, tolerates one that is gone, and says what failed with its status", async () => {
    handlers.push((url, init) => (init.method === "DELETE" ? (url.pathname.endsWith("/gone") ? new Response("", { status: 404 }) : new Response(null, { status: 204 })) : undefined));
    const api = new GoogleDriveFetchApi("tok", "g-1");
    await api.deleteItem("x");
    await api.deleteItem("gone");
    handlers.unshift(() => json({}, 401));
    const failure = await api.findFolder(["ai-calls"]).catch((error) => error);
    expect(failure).toBeInstanceOf(CopyHttpError);
    expect(classifyCopyFailure(failure, true).code).toBe("reconnect");
    handlers.unshift(() => json({}, 429, { "retry-after": "30" }));
    const limited = classifyCopyFailure(await api.findFolder(["ai-calls"]).catch((error) => error), true);
    expect(limited).toMatchObject({ code: "rate-limited", retryAfterMs: 30_000 });
  });
});

describe("OneDrive over Graph", () => {
  it("makes the app folder first, writes by path with the connection's token, and replaces a file of the same name", async () => {
    handlers.push((url, init) => (init.method === "PUT" ? json({ id: "i1" }, 201) : undefined));
    const api = new GraphFetchApi("ms-token", "home-1");
    expect(barrier.registered).toEqual(["microsoft:home-1"]);
    await api.ensureAppFolder();
    expect(msFolder.ensured).toEqual(["ms-token"]);
    await api.put("Apps/Narrarium/ai-calls/book 1/2026/11/10/100000-a.ndjson.gz", new Uint8Array(3));
    const put = last(requests, 1);
    expect(put.url.pathname).toBe("/v1.0/me/drive/root:/Apps/Narrarium/ai-calls/book%201/2026/11/10/100000-a.ndjson.gz:/content");
    expect(put.url.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("replace");
    expect((put.init.headers as Record<string, string>).Authorization).toBe("Bearer ms-token");
  });

  it("looks a file up, deletes a folder, and tolerates a missing one", async () => {
    handlers.push((url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: url.pathname.includes("gone") ? 404 : 204 });
      return url.pathname.includes("present") ? json({ id: "x" }) : new Response("", { status: 404 });
    });
    const api = new GraphFetchApi("t", "h");
    expect(await api.exists("Apps/Narrarium/present")).toBe(true);
    expect(await api.exists("Apps/Narrarium/absent")).toBe(false);
    await api.remove("Apps/Narrarium/ai-calls/b");
    await api.remove("Apps/Narrarium/gone");
    handlers.unshift(() => new Response("", { status: 503, headers: { "retry-after": "7" } }));
    const failure = await api.remove("Apps/Narrarium/x").catch((error) => error);
    expect(failure).toBeInstanceOf(CopyHttpError);
    expect(failure.retryAfterMs).toBe(7000);
    expect(classifyCopyFailure(failure, true).code).toBe("failed");
  });
});

describe("GitHub over the site's client", () => {
  it("reads the visibility of the repository and the head of the branch, and says a missing branch is null", async () => {
    const api = new OctokitGitHubApi("gh", "me", "book");
    expect(await api.getRepository()).toEqual({ private: true });
    expect(await api.getBranchHead("narrarium-ai-calls")).toEqual({ commitSha: "c1", treeSha: "t1" });
    octokit.fail.set("git.getRef", Object.assign(new Error("Not Found"), { status: 404 }));
    expect(await api.getBranchHead("narrarium-ai-calls")).toBeNull();
    expect(octokit.calls[1]).toEqual(["git.getRef", { owner: "me", repo: "book", ref: "heads/narrarium-ai-calls" }]);
  });

  it("writes an orphan branch: blob as base64, a tree without a base, a commit without a parent, a ref", async () => {
    const api = new OctokitGitHubApi("gh", "me", "book");
    expect(await api.createBlob(new Uint8Array([104, 105]))).toBe("b1");
    expect(last(octokit.calls, 1)[1]).toMatchObject({ content: "aGk=", encoding: "base64" });
    await api.createTree(null, [{ path: "calls/x", blobSha: "b1" }]);
    expect(last(octokit.calls, 1)[1]).not.toHaveProperty("base_tree");
    await api.createTree("t1", [{ path: "calls/x", blobSha: "b1" }]);
    expect(last(octokit.calls, 1)[1]).toMatchObject({ base_tree: "t1", tree: [{ path: "calls/x", mode: "100644", type: "blob", sha: "b1" }] });
    await api.createCommit("m", "t2", []);
    expect(last(octokit.calls, 1)[1]).toMatchObject({ parents: [] });
    await api.createBranch("narrarium-ai-calls", "c2");
    expect(last(octokit.calls, 1)[1]).toMatchObject({ ref: "refs/heads/narrarium-ai-calls", sha: "c2" });
    await api.updateBranch("narrarium-ai-calls", "c3");
    expect(last(octokit.calls, 1)[1]).toMatchObject({ ref: "heads/narrarium-ai-calls", force: false });
  });

  it("says an empty repository in words, passes the status and the wait of the others, and tolerates a branch already deleted", async () => {
    const api = new OctokitGitHubApi("gh", "me", "book");
    octokit.fail.set("git.createBlob", Object.assign(new Error("Git Repository is empty."), { status: 409 }));
    const empty = await api.createBlob(new Uint8Array(1)).catch((error) => error);
    expect(empty).toBeInstanceOf(CopyError);
    expect(empty.code).toBe("unavailable");
    octokit.fail.set("git.createBlob", Object.assign(new Error("API rate limit exceeded"), { status: 403, response: { headers: { "retry-after": "60" } } }));
    expect(classifyCopyFailure(await api.createBlob(new Uint8Array(1)).catch((error) => error), true)).toMatchObject({ code: "rate-limited", retryAfterMs: 60_000 });
    octokit.fail.set("git.deleteRef", Object.assign(new Error("Reference does not exist"), { status: 422 }));
    await expect(api.deleteBranch("narrarium-ai-calls")).resolves.toBeUndefined();
  });
});
