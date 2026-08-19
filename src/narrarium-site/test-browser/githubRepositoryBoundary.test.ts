import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

const octokitMocks = vi.hoisted(() => ({
  createOrUpdateFileContents: vi.fn(),
  getBranch: vi.fn(),
  compareCommitsWithBasehead: vi.fn(),
  deleteFile: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
  getTree: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      repos: { createOrUpdateFileContents: octokitMocks.createOrUpdateFileContents, getBranch: octokitMocks.getBranch, compareCommitsWithBasehead: octokitMocks.compareCommitsWithBasehead, deleteFile: octokitMocks.deleteFile },
      git: { createTree: octokitMocks.createTree, createCommit: octokitMocks.createCommit, updateRef: octokitMocks.updateRef, getTree: octokitMocks.getTree },
    };
  },
}));

import {
  createFileIfAbsent,
  createOrUpdateBinaryFile,
  createOrUpdateTextFile,
  compareBranches,
  loadBinaryFileContent,
  readFileWithSha,
  renameAndUpdateFile,
  reorderParagraphsInChapter,
  revertFileToRef,
} from "@/github/githubClient";
import {
  classifyRepositoryError,
  isRepositoryError,
  optionalRepositoryRead,
  RepositoryError,
} from "@/repository/repositoryError";
import { useAuthStore } from "@/store/authStore";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function expectReadError(response: Response, kind: RepositoryError["kind"], status?: number): Promise<void> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const error = await readFileWithSha("token", "owner", "repo", "main", "book.md").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RepositoryError);
  expect(error).toMatchObject({ kind, operation: "read", status });
}

beforeEach(() => {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  vi.unstubAllGlobals();
  octokitMocks.createOrUpdateFileContents.mockReset();
  octokitMocks.getBranch.mockReset();
  octokitMocks.compareCommitsWithBasehead.mockReset();
  octokitMocks.deleteFile.mockReset();
  octokitMocks.createTree.mockReset();
  octokitMocks.createCommit.mockReset();
  octokitMocks.updateRef.mockReset();
  octokitMocks.getTree.mockReset();
});

describe("GitHub repository error classification", () => {
  it.each([
    [404, {}, "not-found"],
    [401, {}, "credential-invalid"],
    [403, {}, "permission-unverified"],
    [403, { "x-ratelimit-remaining": "0" }, "rate-limit"],
    [429, {}, "rate-limit"],
    [409, {}, "conflict"],
    [500, {}, "service-unavailable"],
  ] as const)("classifies HTTP %s as %s", async (status, headers, kind) => {
    await expectReadError(new Response("", { status, headers }), kind, status);
  });

  it("classifies fetch failures as network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const error = await readFileWithSha("token", "owner", "repo", "main", "book.md").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "network", operation: "read" });
  });

  it("classifies aborted reads as abort errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")));
    const error = await readFileWithSha("token", "owner", "repo", "main", "book.md").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "abort", operation: "read" });
  });

  it("classifies invalid JSON as malformed", async () => {
    await expectReadError(new Response("{", { status: 200 }), "malformed", 200);
  });

  it("treats only typed not-found errors as optional", async () => {
    await expect(optionalRepositoryRead(async () => {
      throw new RepositoryError("missing", "not-found", "read", 404);
    })).resolves.toBeNull();

    const untyped = new Error("GitHub content load book.md: 404");
    await expect(optionalRepositoryRead(async () => { throw untyped; })).rejects.toBe(untyped);
    expect(isRepositoryError(untyped, "not-found")).toBe(false);
  });

  it.each([
    [{ status: 401 }, "read", "credential-invalid"],
    [{ status: 429 }, "list", "rate-limit"],
    [{ status: 409 }, "update", "conflict"],
    [{ status: 412 }, "delete", "conflict"],
    [{ status: 422 }, "create", "conflict"],
    [{ status: 503 }, "list", "service-unavailable"],
    [new TypeError("offline"), "create", "network"],
    [new DOMException("Aborted", "AbortError"), "delete", "abort"],
    [{ status: 500 }, "compare", "service-unavailable"],
    [{ status: 404 }, "revert", "conflict"],
  ] as const)("classifies repository operation errors", (error, operation, kind) => {
    expect(classifyRepositoryError(error, operation, "book.md")).toMatchObject({ kind, operation });
  });

  it("classifies an incomplete file payload as malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ sha: "sha-only" })));
    await expect(readFileWithSha("token", "owner", "repo", "main", "book.md")).rejects.toMatchObject({ kind: "malformed", operation: "read" });
  });

  it("types binary body read failures", async () => {
    const response = new Response(new ReadableStream({ pull() { throw new DOMException("Aborted", "AbortError"); } }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(loadBinaryFileContent("token", "owner", "repo", "asset.png", "main")).rejects.toMatchObject({ kind: "abort", operation: "read" });
  });

  it("decodes a JSON contents envelope returned to a raw binary request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ content: btoa("binary-data"), encoding: "base64" })));
    expect(Array.from(await loadBinaryFileContent("token", "owner", "repo", "asset.png", "main"))).toEqual(Array.from(new TextEncoder().encode("binary-data")));
  });

  it("rejects valid JSON that is not a binary contents envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "not raw content" })));
    await expect(loadBinaryFileContent("token", "owner", "repo", "asset.png", "main")).rejects.toMatchObject({ kind: "malformed", operation: "read" });
  });
});

describe("GitHub compound operation boundaries", () => {
  it("types rename failures before creating a tree", async () => {
    octokitMocks.getBranch.mockRejectedValue({ status: 401 });
    await expect(renameAndUpdateFile("token", "owner", "repo", "main", "old.md", "new.md", "body", "rename")).rejects.toMatchObject({ kind: "credential-invalid", operation: "update" });
    expect(octokitMocks.createTree).not.toHaveBeenCalled();
  });

  it("types compare failures", async () => {
    octokitMocks.compareCommitsWithBasehead.mockRejectedValue({ status: 503 });
    await expect(compareBranches("token", "owner", "repo", "main", "draft")).rejects.toMatchObject({ kind: "service-unavailable", operation: "compare" });
  });

  it("does not mutate a revert after an unconfirmed read failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    await expect(revertFileToRef("token", "owner", "repo", "main", "book.md", "base")).rejects.toMatchObject({ kind: "permission-unverified", operation: "read" });
    expect(octokitMocks.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(octokitMocks.deleteFile).not.toHaveBeenCalled();
  });

  it("refuses a truncated tree before a paragraph reorder mutation", async () => {
    octokitMocks.getBranch.mockResolvedValue({ data: { commit: { sha: "commit", commit: { tree: { sha: "tree" } } } } });
    octokitMocks.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });
    const paragraph = { number: "002", title: "Two", path: "chapters/001-start/002-two.md" } as any;
    await expect(reorderParagraphsInChapter("token", "owner", "repo", "main", "chapters/001-start", [paragraph], [paragraph], "reorder")).rejects.toMatchObject({ kind: "malformed", operation: "update" });
    expect(octokitMocks.createTree).not.toHaveBeenCalled();
  });

  it("rejects paragraph deletion when the branch head changed after confirmation", async () => {
    octokitMocks.getBranch.mockResolvedValue({ data: { commit: { sha: "collaborator-head", commit: { tree: { sha: "tree" } } } } });
    const paragraph = { number: "001", title: "One", path: "chapters/001-start/001-one.md", revision: "loaded-blob" } as any;
    await expect(reorderParagraphsInChapter("token", "owner", "repo", "main", "chapters/001-start", [paragraph], [], "delete", { expectedRemoteHeadSha: "confirmed-head", expectedParagraphHashes: { [paragraph.path]: "loaded-blob" } })).rejects.toMatchObject({ kind: "conflict", operation: "update" });
    expect(octokitMocks.getTree).not.toHaveBeenCalled();
  });
});

describe("GitHub upsert read safety", () => {
  it.each([
    ["text upsert", () => createOrUpdateTextFile("token", "owner", "repo", "main", "book.md", "new", "save")],
    ["binary upsert", () => createOrUpdateBinaryFile("token", "owner", "repo", "main", "cover.png", new Uint8Array([1]), "save")],
    ["create-if-absent", () => createFileIfAbsent("token", "owner", "repo", "main", "book.md", "new", "save")],
  ])("does not write when the %s read fails without a 404", async (_name, operation) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    await expect(operation()).rejects.toMatchObject({ kind: "credential-invalid", operation: "read" });
    expect(octokitMocks.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("creates only after a confirmed 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    octokitMocks.createOrUpdateFileContents.mockResolvedValue({ data: { content: { sha: "new-sha" } } });

    await expect(createOrUpdateTextFile("token", "owner", "repo", "main", "book.md", "new", "save")).resolves.toBe("new-sha");
    expect(octokitMocks.createOrUpdateFileContents).toHaveBeenCalledOnce();
    expect(octokitMocks.createOrUpdateFileContents.mock.calls[0][0]).not.toHaveProperty("sha");
  });

  it("does not retry a failed update as a create", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ content: btoa("old"), sha: "old-sha" })));
    octokitMocks.createOrUpdateFileContents.mockRejectedValue(new Error("update failed"));

    await expect(createOrUpdateTextFile("token", "owner", "repo", "main", "book.md", "new", "save")).rejects.toMatchObject({ kind: "unknown", operation: "update" });
    expect(octokitMocks.createOrUpdateFileContents).toHaveBeenCalledOnce();
    expect(octokitMocks.createOrUpdateFileContents.mock.calls[0][0]).toMatchObject({ sha: "old-sha" });
  });

  it("updates an existing binary without decoding its Contents payload as text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ content: btoa("x".repeat(300 * 1024)), sha: "binary-sha" })));
    octokitMocks.createOrUpdateFileContents.mockResolvedValue({ data: { content: { sha: "updated-sha" } } });
    await expect(createOrUpdateBinaryFile("token", "owner", "repo", "main", "cover.png", new Uint8Array([1, 2]), "save")).resolves.toBe("updated-sha");
    expect(octokitMocks.createOrUpdateFileContents.mock.calls[0][0]).toMatchObject({ sha: "binary-sha" });
  });
});
